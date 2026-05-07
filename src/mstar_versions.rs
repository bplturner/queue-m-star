use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::fs;

/// Represents an installed M-Star CFD version
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MstarVersion {
    /// Version string, e.g. "4.4.9"
    pub version: String,
    /// Major version number
    pub major: u32,
    /// Minor version number
    pub minor: u32,
    /// Patch version number
    pub patch: u32,
    /// Full path to the version installation directory
    pub install_dir: PathBuf,
    /// Path to the mstar-cfd-mgpu binary
    pub mgpu_binary: PathBuf,
    /// Path to the mstar.sh environment script
    pub env_script: PathBuf,
    /// Whether this is the 'latest' symlinked version
    pub is_latest: bool,
}

impl MstarVersion {
    /// Display-friendly label for the version
    pub fn label(&self) -> String {
        if self.is_latest {
            format!("{} (latest)", self.version)
        } else {
            self.version.clone()
        }
    }
}

/// Scan the M-Star install directory for available versions
///
/// Looks for directories matching `mstarcfd-*` pattern, validates they contain
/// the required `bin/mstar-cfd-mgpu` binary and `mstar.sh` script.
/// Returns versions sorted newest-first.
pub fn discover_versions(mstar_install_dir: &Path) -> Vec<MstarVersion> {
    let mut versions = Vec::new();

    // Determine which version the 'latest' symlink points to
    let latest_target = resolve_latest_symlink(mstar_install_dir);

    // Read the mstar install directory
    let entries = match fs::read_dir(mstar_install_dir) {
        Ok(entries) => entries,
        Err(e) => {
            eprintln!("Failed to read M-Star install directory {}: {}", mstar_install_dir.display(), e);
            return versions;
        }
    };

    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };

        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let dir_name = match path.file_name().and_then(|n| n.to_str()) {
            Some(name) => name.to_string(),
            None => continue,
        };

        // Match pattern: mstarcfd-X.Y.Z
        if !dir_name.starts_with("mstarcfd-") {
            continue;
        }

        let version_str = &dir_name["mstarcfd-".len()..];

        // Parse version components
        let parts: Vec<&str> = version_str.split('.').collect();
        if parts.len() != 3 {
            continue;
        }

        let major = match parts[0].parse::<u32>() {
            Ok(v) => v,
            Err(_) => continue,
        };
        let minor = match parts[1].parse::<u32>() {
            Ok(v) => v,
            Err(_) => continue,
        };
        let patch = match parts[2].parse::<u32>() {
            Ok(v) => v,
            Err(_) => continue,
        };

        // Validate required files exist
        let mgpu_binary = path.join("bin").join("mstar-cfd-mgpu");
        let env_script = path.join("mstar.sh");

        if !mgpu_binary.exists() {
            eprintln!("Warning: M-Star version {} missing bin/mstar-cfd-mgpu, skipping", version_str);
            continue;
        }

        if !env_script.exists() {
            eprintln!("Warning: M-Star version {} missing mstar.sh, skipping", version_str);
            continue;
        }

        let is_latest = latest_target.as_ref()
            .map(|lt| lt == &dir_name)
            .unwrap_or(false);

        versions.push(MstarVersion {
            version: version_str.to_string(),
            major,
            minor,
            patch,
            install_dir: path.clone(),
            mgpu_binary,
            env_script,
            is_latest,
        });
    }

    // Sort descending by version (newest first)
    versions.sort_by(|a, b| {
        b.major.cmp(&a.major)
            .then(b.minor.cmp(&a.minor))
            .then(b.patch.cmp(&a.patch))
    });

    versions
}

/// Resolve which version is "latest" by checking multiple sources:
/// 1. Parse the `mstar-latest` script (most reliable — updated by the admin update script)
/// 2. Fall back to the `mstarcfd-latest` symlink
/// 3. Fall back to None (caller will use highest numeric version)
fn resolve_latest_symlink(mstar_install_dir: &Path) -> Option<String> {
    // Strategy 1: Parse the mstar-latest wrapper script.
    // It contains a line like:  source "/opt/mstar/mstarcfd-4.4.9/mstar.sh"
    let script_path = mstar_install_dir.join("mstar-latest");
    if script_path.exists() && !script_path.is_symlink() {
        if let Ok(contents) = fs::read_to_string(&script_path) {
            for line in contents.lines() {
                let trimmed = line.trim();
                if trimmed.starts_with("source ") && trimmed.contains("mstarcfd-") {
                    // Extract the directory name: mstarcfd-X.Y.Z
                    if let Some(start) = trimmed.find("mstarcfd-") {
                        // Find the end: either / or " after the version dir name
                        let rest = &trimmed[start..];
                        let end = rest.find('/').unwrap_or(rest.len());
                        let dir_name = &rest[..end];
                        return Some(dir_name.to_string());
                    }
                }
            }
        }
    }

    // Strategy 2: Follow the mstarcfd-latest symlink
    let symlink_path = mstar_install_dir.join("mstarcfd-latest");
    if let Ok(target) = fs::read_link(&symlink_path) {
        if let Some(name) = target.file_name().and_then(|n| n.to_str()) {
            return Some(name.to_string());
        }
    }

    // Strategy 3: None — the caller will use the first (highest numeric) version
    None
}

/// Resolve a version identifier to an MstarVersion
///
/// `version_id` can be:
/// - "latest" — resolves to the version marked as latest, or the newest version
/// - A specific version string like "4.4.9"
pub fn resolve_version<'a>(versions: &'a [MstarVersion], version_id: &str) -> Option<&'a MstarVersion> {
    if version_id == "latest" {
        // First try the one marked as latest
        versions.iter().find(|v| v.is_latest)
            // Fall back to the first (newest) version
            .or_else(|| versions.first())
    } else {
        versions.iter().find(|v| v.version == version_id)
    }
}

/// Build the shell command to run mstar-cfd-mgpu with the proper environment
///
/// For single GPU: sources mstar.sh, runs mstar-cfd-mgpu directly
/// For multi-GPU: uses `mpirun -n <gpu_count>` matching the production pattern:
///   `mpirun -n 4 /opt/mstar/mstarcfd-X.Y.Z/bin/mstar-cfd-mgpu -i input.xml -o out --gpu-ids=4,5,6,7`
///
/// `--unified-memory` enables CPU RAM spill and is independent of GPU count.
/// `checkpoint` controls restart behavior:
///   - `None` → fresh run, uses `--force` to overwrite output
///   - `Some(-1)` → restart from latest checkpoint (`--load-last`)
///   - `Some(N)` → restart from specific checkpoint N (`-r out -l N`)
pub fn build_mstar_command(
    version: &MstarVersion,
    input_file: &str,
    output_prefix: &str,
    gpu_ids: &[i32],
    unified_memory: bool,
    checkpoint: Option<i64>,
) -> String {
    let gpu_ids_str: Vec<String> = gpu_ids.iter().map(|id| id.to_string()).collect();
    let gpu_count = gpu_ids.len();

    let mut flags = String::new();
    if unified_memory {
        flags.push_str(" --unified-memory");
    }
    match checkpoint {
        Some(n) if n >= 0 => {
            // Specific checkpoint: -r out -l N
            flags.push_str(&format!(" -r {} -l {}", output_prefix, n));
        }
        Some(_) => {
            // Negative or -1: load last checkpoint
            flags.push_str(" --load-last");
        }
        None => {
            // Fresh run
            flags.push_str(" --force");
        }
    }

    let binary = format!("\"{}\"", version.mgpu_binary.display());

    let core_args = format!(
        "-i {} -o {} --gpu-ids={}{}",
        input_file,
        output_prefix,
        gpu_ids_str.join(","),
        flags,
    );

    if gpu_count > 1 {
        // Multi-GPU: use mpirun -n <count>
        format!(
            "source \"{}\" && mpirun -n {} {} {}",
            version.env_script.display(),
            gpu_count,
            binary,
            core_args,
        )
    } else {
        // Single GPU: run directly
        format!(
            "source \"{}\" && {} {}",
            version.env_script.display(),
            binary,
            core_args,
        )
    }
}
