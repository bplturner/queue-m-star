use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::fs;

/// Main configuration struct, loaded from config.toml
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    /// Path-related configuration
    pub paths: PathConfig,
    /// Web server configuration
    pub web_server: WebServerConfig,
    /// File handling limits
    pub file_handling: FileHandlingConfig,
    /// GPU selection thresholds
    pub gpu_selection: GpuSelectionConfig,
    /// Job queue settings
    #[serde(default)]
    pub queue: QueueConfig,
    /// Security settings
    #[serde(default)]
    pub security: SecurityConfig,
    /// AI training integration settings
    #[serde(default)]
    pub ai_training: AiTrainingConfig,
}

/// Paths for log files, executables, and directories
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PathConfig {
    /// Path to the application log file
    pub log_file: PathBuf,
    /// Directory to watch for incoming MSB files (file-watcher intake)
    pub queue_directory: PathBuf,
    /// Path to the default mstar-cfd-mgpu executable (legacy/fallback)
    pub mstar_executable: PathBuf,
    /// Root directory containing all M-Star installations (e.g., /opt/mstar)
    #[serde(default = "default_mstar_install_dir")]
    pub mstar_install_dir: PathBuf,
    /// Path to the SQLite database file
    #[serde(default = "default_database_file")]
    pub database_file: PathBuf,
    /// Directory for job working files (each job gets a subdirectory)
    #[serde(default = "default_jobs_directory")]
    pub jobs_directory: PathBuf,
    /// Directory for archived/completed job data
    #[serde(default = "default_archive_directory")]
    pub archive_directory: PathBuf,
    /// Path to the GPU metrics CSV log file
    #[serde(default = "default_gpu_metrics_log")]
    pub gpu_metrics_log: PathBuf,
    /// Root data directory — used as the security boundary for file browsing,
    /// copy-to destinations, and MSB source paths. All user-accessible paths
    /// must resolve under this directory.
    #[serde(default = "default_data_root")]
    pub data_root: PathBuf,
}

fn default_mstar_install_dir() -> PathBuf {
    PathBuf::from("/opt/mstar")
}

fn default_data_root() -> PathBuf {
    PathBuf::from("/opt/mstar_queue/data")
}

fn default_database_file() -> PathBuf {
    PathBuf::from("mstar_queue.db")
}

fn default_jobs_directory() -> PathBuf {
    PathBuf::from("jobs")
}

fn default_archive_directory() -> PathBuf {
    PathBuf::from("archive")
}

fn default_gpu_metrics_log() -> PathBuf {
    PathBuf::from("gpu_metrics.log")
}

/// Web server configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebServerConfig {
    /// Port for the web server to listen on
    pub port: u16,
    /// Maximum upload payload size in MB
    pub max_payload_size_mb: u64,
}

/// File handling limits
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileHandlingConfig {
    /// Maximum allowed MSB file size in MB
    pub max_file_size_mb: u64,
    /// List of allowed file extensions (e.g., ["msb"])
    pub allowed_file_types: Vec<String>,
}

/// GPU selection thresholds for determining GPU availability
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GpuSelectionConfig {
    /// Maximum utilization percentage for a reserved GPU to be considered free
    pub reserved_gpu_max_utilization: f32,
    /// Maximum memory usage percentage for a reserved GPU to be considered free
    pub reserved_gpu_max_memory_usage_percent: f32,
}

/// Security configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SecurityConfig {
    /// Restrict user registration to a specific email domain.
    /// If empty or "*", any email address is allowed.
    /// Example: "mycompany.com" only allows @mycompany.com addresses.
    #[serde(default)]
    pub allowed_email_domain: String,
}

impl Default for SecurityConfig {
    fn default() -> Self {
        SecurityConfig {
            allowed_email_domain: String::new(), // No restriction by default
        }
    }
}

/// Job queue configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueueConfig {
    /// Maximum number of jobs that can run concurrently
    #[serde(default = "default_max_concurrent")]
    pub max_concurrent_jobs: usize,
    /// Default M-Star version to use when not specified (e.g., "latest" or "4.4.9")
    #[serde(default = "default_mstar_version")]
    pub default_mstar_version: String,
    /// Number of days to retain job output files (0 = forever)
    #[serde(default)]
    pub job_output_retention_days: u32,
    /// Interval in seconds between queue polling cycles
    #[serde(default = "default_poll_interval")]
    pub poll_interval_secs: u64,
    /// Automatically re-queue jobs that were running when the daemon/machine stopped.
    /// When true: dead jobs are reset to "queued" and re-launched with --load-last.
    /// When false: dead jobs are marked "failed" (requires manual restart).
    #[serde(default = "default_true")]
    pub auto_requeue_on_restart: bool,
    /// Delay in seconds before the queue starts processing after daemon startup.
    /// Gives NFS mounts and GPUs time to initialize after a reboot.
    #[serde(default = "default_startup_delay")]
    pub startup_delay_secs: u64,
}

fn default_max_concurrent() -> usize {
    8
}

fn default_mstar_version() -> String {
    "latest".to_string()
}

fn default_poll_interval() -> u64 {
    5
}

fn default_true() -> bool {
    true
}

fn default_startup_delay() -> u64 {
    10
}

impl Default for QueueConfig {
    fn default() -> Self {
        QueueConfig {
            max_concurrent_jobs: default_max_concurrent(),
            default_mstar_version: default_mstar_version(),
            job_output_retention_days: 0,
            poll_interval_secs: default_poll_interval(),
            auto_requeue_on_restart: default_true(),
            startup_delay_secs: default_startup_delay(),
        }
    }
}

/// AI Training integration configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiTrainingConfig {
    /// Master switch to enable/disable AI training features
    #[serde(default)]
    pub enabled: bool,
    /// Path to Python executable with PhysicsNeMo installed
    #[serde(default = "default_python_executable")]
    pub python_executable: String,
    /// Use NVIDIA container instead of local Python
    #[serde(default)]
    pub container_mode: bool,
    /// Container image for PhysicsNeMo
    #[serde(default = "default_container_image")]
    pub container_image: String,
    /// Root directory for cached/converted datasets (under data_root)
    #[serde(default = "default_cache_root")]
    pub cache_root: String,
    /// Root directory for training artifacts (under data_root)
    #[serde(default = "default_artifact_root")]
    pub artifact_root: String,
    /// Maximum concurrent training jobs
    #[serde(default = "default_max_training_jobs")]
    pub max_concurrent_training_jobs: usize,
    /// GPU selection policy: "least_utilized" or "explicit"
    #[serde(default = "default_gpu_policy")]
    pub gpu_selection_policy: String,
    /// Additional allowed directories for training data (beyond data_root)
    #[serde(default)]
    pub allowed_training_roots: Vec<String>,
    /// Default dataset output format: npz, zarr, hdf5, torch
    #[serde(default = "default_dataset_format")]
    pub default_dataset_format: String,
    /// Default model family: fno, unet, mlp
    #[serde(default = "default_model_family")]
    pub default_model_family: String,
    /// Default training batch size
    #[serde(default = "default_batch_size")]
    pub default_batch_size: u32,
    /// Default training epochs
    #[serde(default = "default_epochs")]
    pub default_epochs: u32,
    /// Default learning rate
    #[serde(default = "default_learning_rate")]
    pub default_learning_rate: f64,
    /// Checkpoint save interval in epochs
    #[serde(default = "default_checkpoint_interval")]
    pub checkpoint_interval_epochs: u32,
    /// Whether to allow custom Python entrypoints (security risk)
    #[serde(default)]
    pub allow_custom_entrypoints: bool,
    /// Directories allowed for custom entrypoints (if enabled)
    #[serde(default)]
    pub custom_entrypoint_roots: Vec<String>,
    /// Minimum free GPU VRAM (MB) for preflight checks
    #[serde(default = "default_min_vram")]
    pub min_gpu_free_vram_mb: u32,
    /// Minimum free disk space (GB) for preflight checks
    #[serde(default = "default_min_disk")]
    pub min_disk_free_gb: u32,
}

fn default_python_executable() -> String { "python3".to_string() }
fn default_container_image() -> String { "nvcr.io/nvidia/physicsnemo:latest".to_string() }
fn default_cache_root() -> String { "ai_cache".to_string() }
fn default_artifact_root() -> String { "ai_artifacts".to_string() }
fn default_max_training_jobs() -> usize { 2 }
fn default_gpu_policy() -> String { "least_utilized".to_string() }
fn default_dataset_format() -> String { "npz".to_string() }
fn default_model_family() -> String { "fno".to_string() }
fn default_batch_size() -> u32 { 8 }
fn default_epochs() -> u32 { 100 }
fn default_learning_rate() -> f64 { 0.001 }
fn default_checkpoint_interval() -> u32 { 10 }
fn default_min_vram() -> u32 { 2048 }
fn default_min_disk() -> u32 { 10 }

impl Default for AiTrainingConfig {
    fn default() -> Self {
        AiTrainingConfig {
            enabled: false,
            python_executable: default_python_executable(),
            container_mode: false,
            container_image: default_container_image(),
            cache_root: default_cache_root(),
            artifact_root: default_artifact_root(),
            max_concurrent_training_jobs: default_max_training_jobs(),
            gpu_selection_policy: default_gpu_policy(),
            allowed_training_roots: Vec::new(),
            default_dataset_format: default_dataset_format(),
            default_model_family: default_model_family(),
            default_batch_size: default_batch_size(),
            default_epochs: default_epochs(),
            default_learning_rate: default_learning_rate(),
            checkpoint_interval_epochs: default_checkpoint_interval(),
            allow_custom_entrypoints: false,
            custom_entrypoint_roots: Vec::new(),
            min_gpu_free_vram_mb: default_min_vram(),
            min_disk_free_gb: default_min_disk(),
        }
    }
}

impl Config {
    /// Load configuration from config.toml in the current working directory
    pub fn load() -> Result<Self, Box<dyn std::error::Error>> {
        let config_path = "config.toml";
        let config_content = fs::read_to_string(config_path)
            .map_err(|e| format!(
                "Failed to read config file at {}: {}. Please ensure the file exists and has correct permissions.",
                config_path, e
            ))?;
        let config: Config = toml::from_str(&config_content)
            .map_err(|e| format!(
                "Failed to parse config file {}: {}. Please check the file format.",
                config_path, e
            ))?;
        Ok(config)
    }

    /// Validate the loaded configuration
    pub fn validate(&self) -> Result<(), String> {
        // Path validations
        if self.paths.log_file.as_os_str().is_empty() {
            return Err("Log file path cannot be empty".to_string());
        }
        if self.paths.queue_directory.as_os_str().is_empty() {
            return Err("Queue directory path cannot be empty".to_string());
        }
        if self.paths.mstar_executable.as_os_str().is_empty() {
            return Err("MSTAR executable path cannot be empty".to_string());
        }
        if self.paths.mstar_install_dir.as_os_str().is_empty() {
            return Err("MSTAR install directory cannot be empty".to_string());
        }

        // Web server validation
        if self.web_server.port == 0 {
            return Err("Web server port cannot be 0".to_string());
        }

        // File handling validation
        if self.file_handling.max_file_size_mb == 0 {
            return Err("Max file size cannot be 0".to_string());
        }
        if self.file_handling.allowed_file_types.is_empty() {
            return Err("Allowed file types cannot be empty".to_string());
        }

        // GPU selection validation
        if self.gpu_selection.reserved_gpu_max_utilization < 0.0
            || self.gpu_selection.reserved_gpu_max_utilization > 100.0
        {
            return Err("Reserved GPU max utilization must be between 0.0 and 100.0".to_string());
        }
        if self.gpu_selection.reserved_gpu_max_memory_usage_percent < 0.0
            || self.gpu_selection.reserved_gpu_max_memory_usage_percent > 100.0
        {
            return Err("Reserved GPU max memory usage percent must be between 0.0 and 100.0".to_string());
        }

        // Queue validation
        if self.queue.max_concurrent_jobs == 0 {
            return Err("Max concurrent jobs must be at least 1".to_string());
        }

        // AI training validation (only when enabled)
        if self.ai_training.enabled {
            if self.ai_training.python_executable.is_empty() && !self.ai_training.container_mode {
                return Err("AI training: python_executable cannot be empty when container_mode is false".to_string());
            }
            if self.ai_training.container_mode && self.ai_training.container_image.is_empty() {
                return Err("AI training: container_image cannot be empty when container_mode is true".to_string());
            }
            if self.ai_training.max_concurrent_training_jobs == 0 {
                return Err("AI training: max_concurrent_training_jobs must be at least 1".to_string());
            }
            let valid_formats = ["npz", "zarr", "hdf5", "torch"];
            if !valid_formats.contains(&self.ai_training.default_dataset_format.as_str()) {
                return Err(format!("AI training: invalid default_dataset_format '{}'. Valid: {:?}",
                    self.ai_training.default_dataset_format, valid_formats));
            }
            let valid_families = ["fno", "unet", "mlp"];
            if !valid_families.contains(&self.ai_training.default_model_family.as_str()) {
                return Err(format!("AI training: invalid default_model_family '{}'. Valid: {:?}",
                    self.ai_training.default_model_family, valid_families));
            }
            if self.ai_training.default_learning_rate <= 0.0 {
                return Err("AI training: default_learning_rate must be positive".to_string());
            }
        }

        Ok(())
    }
}