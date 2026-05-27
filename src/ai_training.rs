//! AI Training orchestration — manages Python training subprocesses.
//!
//! This module bridges the Rust queue manager and the Python mstar-ai CLI.
//! It handles:
//! - Spawning training processes via the mstar-ai CLI
//! - GPU reservation coordination (checks both simulation + training reservations)
//! - Process lifecycle management (start, monitor, cancel)
//! - Training job status updates in the database

use crate::config::AiTrainingConfig;
use chrono::Utc;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

// ============================================================
// Data structures
// ============================================================

/// Status of an AI training job
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TrainingJobStatus {
    Queued,
    Preflight,
    Running,
    Completed,
    Failed,
    Cancelled,
}

impl TrainingJobStatus {
    pub fn as_str(&self) -> &str {
        match self {
            TrainingJobStatus::Queued => "queued",
            TrainingJobStatus::Preflight => "preflight",
            TrainingJobStatus::Running => "running",
            TrainingJobStatus::Completed => "completed",
            TrainingJobStatus::Failed => "failed",
            TrainingJobStatus::Cancelled => "cancelled",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "queued" => Some(TrainingJobStatus::Queued),
            "preflight" => Some(TrainingJobStatus::Preflight),
            "running" => Some(TrainingJobStatus::Running),
            "completed" => Some(TrainingJobStatus::Completed),
            "failed" => Some(TrainingJobStatus::Failed),
            "cancelled" => Some(TrainingJobStatus::Cancelled),
            _ => None,
        }
    }
}

/// Serializable AI training job record
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiTrainingJob {
    pub id: i64,
    pub dataset_id: i64,
    pub user_id: i64,
    pub run_name: String,
    pub model_family: String,
    pub status: String,
    pub gpu_ids: String,
    pub priority: i32,
    pub submitted_at: String,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub artifact_directory: Option<String>,
    pub config_json: Option<String>,
    pub failure_reason: Option<String>,
    pub pid: Option<i64>,
}

/// AI dataset record
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiDataset {
    pub id: i64,
    pub user_id: i64,
    pub name: String,
    pub sweep_root: String,
    pub dataset_mode: String,
    pub status: String,
    pub manifest_path: Option<String>,
    pub cache_path: Option<String>,
    pub warnings_json: Option<String>,
    pub config_json: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    // Inventory fields (Phase 9)
    pub stats_inventory_json: Option<String>,
    pub pvd_inventory_json: Option<String>,
    pub num_cases: i64,
    pub num_cases_with_output: i64,
    pub sweep_parameters_json: Option<String>,
    pub cases_json: Option<String>,
    pub source_msb: Option<String>,
    pub sweep_group_id: Option<String>,
    pub scan_completed_at: Option<String>,
}

// ============================================================
// GPU coordination
// ============================================================

/// Get the set of GPU IDs reserved by simulation jobs.
pub fn get_simulation_reserved_gpus(conn: &Connection) -> HashSet<i32> {
    let mut stmt = conn
        .prepare("SELECT gpu_id FROM gpu_reservations")
        .unwrap_or_else(|_| panic!("Failed to prepare GPU reservation query"));

    let gpus: Vec<i32> = stmt
        .query_map([], |row| row.get(0))
        .unwrap_or_else(|_| panic!("Failed to query GPU reservations"))
        .filter_map(|r| r.ok())
        .collect();

    gpus.into_iter().collect()
}

/// Get the set of GPU IDs reserved by AI training jobs.
pub fn get_training_reserved_gpus(conn: &Connection) -> HashSet<i32> {
    let mut stmt = conn
        .prepare("SELECT gpu_id FROM ai_gpu_reservations")
        .unwrap_or_else(|_| panic!("Failed to prepare AI GPU reservation query"));

    let gpus: Vec<i32> = stmt
        .query_map([], |row| row.get(0))
        .unwrap_or_else(|_| panic!("Failed to query AI GPU reservations"))
        .filter_map(|r| r.ok())
        .collect();

    gpus.into_iter().collect()
}

/// Get all GPU IDs that are currently reserved (simulation + training).
pub fn get_all_reserved_gpus(conn: &Connection) -> HashSet<i32> {
    let mut all = get_simulation_reserved_gpus(conn);
    all.extend(get_training_reserved_gpus(conn));
    all
}

/// Reserve GPUs for a training job.
pub fn reserve_gpus_for_training(
    conn: &Connection,
    training_job_id: i64,
    gpu_ids: &[i32],
) -> Result<(), String> {
    for &gpu_id in gpu_ids {
        conn.execute(
            "INSERT INTO ai_gpu_reservations (gpu_id, training_job_id) VALUES (?1, ?2)",
            params![gpu_id, training_job_id],
        )
        .map_err(|e| format!("Failed to reserve GPU {} for training job {}: {}", gpu_id, training_job_id, e))?;
    }
    println!("[AI] Reserved GPUs {:?} for training job {}", gpu_ids, training_job_id);
    Ok(())
}

/// Release GPU reservations for a training job.
pub fn release_training_gpus(conn: &Connection, training_job_id: i64) -> Result<(), String> {
    conn.execute(
        "DELETE FROM ai_gpu_reservations WHERE training_job_id = ?1",
        params![training_job_id],
    )
    .map_err(|e| format!("Failed to release GPUs for training job {}: {}", training_job_id, e))?;
    Ok(())
}

// ============================================================
// Dataset operations
// ============================================================

/// Create a new AI dataset record.
pub fn create_dataset(
    conn: &Connection,
    user_id: i64,
    name: &str,
    sweep_root: &str,
    dataset_mode: &str,
    config_json: Option<&str>,
) -> Result<i64, String> {
    conn.execute(
        "INSERT INTO ai_datasets (user_id, name, sweep_root, dataset_mode, config_json, status)
         VALUES (?1, ?2, ?3, ?4, ?5, 'scanning')",
        params![user_id, name, sweep_root, dataset_mode, config_json],
    )
    .map_err(|e| format!("Failed to create AI dataset: {}", e))?;
    Ok(conn.last_insert_rowid())
}

/// Update dataset with scan inventory results.
pub fn update_dataset_inventory(
    conn: &Connection,
    dataset_id: i64,
    stats_inventory_json: &str,
    pvd_inventory_json: &str,
    cases_json: &str,
    sweep_parameters_json: Option<&str>,
    num_cases: i64,
    num_cases_with_output: i64,
    warnings_json: Option<&str>,
) -> Result<(), String> {
    let now = Utc::now().format("%Y-%m-%d %H:%M:%S").to_string();
    conn.execute(
        "UPDATE ai_datasets SET
            stats_inventory_json = ?1,
            pvd_inventory_json = ?2,
            cases_json = ?3,
            sweep_parameters_json = ?4,
            num_cases = ?5,
            num_cases_with_output = ?6,
            warnings_json = ?7,
            status = CASE WHEN ?6 > 0 THEN 'ready' ELSE 'empty' END,
            scan_completed_at = ?8,
            updated_at = ?8
         WHERE id = ?9",
        params![
            stats_inventory_json, pvd_inventory_json, cases_json,
            sweep_parameters_json, num_cases, num_cases_with_output,
            warnings_json, now, dataset_id
        ],
    )
    .map_err(|e| format!("Failed to update dataset inventory {}: {}", dataset_id, e))?;
    Ok(())
}

/// Update dataset status and optional fields.
pub fn update_dataset_status(
    conn: &Connection,
    dataset_id: i64,
    status: &str,
    manifest_path: Option<&str>,
    cache_path: Option<&str>,
    warnings_json: Option<&str>,
) -> Result<(), String> {
    let now = Utc::now().format("%Y-%m-%d %H:%M:%S").to_string();
    conn.execute(
        "UPDATE ai_datasets SET status = ?1, manifest_path = COALESCE(?2, manifest_path),
         cache_path = COALESCE(?3, cache_path), warnings_json = COALESCE(?4, warnings_json),
         updated_at = ?5 WHERE id = ?6",
        params![status, manifest_path, cache_path, warnings_json, now, dataset_id],
    )
    .map_err(|e| format!("Failed to update dataset {}: {}", dataset_id, e))?;
    Ok(())
}

/// List all datasets for a user (or all if user_id is None).
pub fn list_datasets(conn: &Connection, user_id: Option<i64>) -> Vec<AiDataset> {
    let query = match user_id {
        Some(_) => {
            "SELECT id, user_id, name, sweep_root, COALESCE(dataset_mode, '') as dataset_mode, status,
                    manifest_path, cache_path, warnings_json, config_json,
                    created_at, updated_at,
                    stats_inventory_json, pvd_inventory_json,
                    COALESCE(num_cases, 0), COALESCE(num_cases_with_output, 0),
                    sweep_parameters_json, cases_json, source_msb, sweep_group_id,
                    scan_completed_at
             FROM ai_datasets WHERE user_id = ?1 ORDER BY created_at DESC"
        }
        None => {
            "SELECT id, user_id, name, sweep_root, COALESCE(dataset_mode, '') as dataset_mode, status,
                    manifest_path, cache_path, warnings_json, config_json,
                    created_at, updated_at,
                    stats_inventory_json, pvd_inventory_json,
                    COALESCE(num_cases, 0), COALESCE(num_cases_with_output, 0),
                    sweep_parameters_json, cases_json, source_msb, sweep_group_id,
                    scan_completed_at
             FROM ai_datasets ORDER BY created_at DESC"
        }
    };

    let mut stmt = match conn.prepare(query) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[AI] Failed to prepare dataset list query: {}", e);
            return Vec::new();
        }
    };

    let mapper = |row: &rusqlite::Row| {
        Ok(AiDataset {
            id: row.get(0)?,
            user_id: row.get(1)?,
            name: row.get(2)?,
            sweep_root: row.get(3)?,
            dataset_mode: row.get(4)?,
            status: row.get(5)?,
            manifest_path: row.get(6)?,
            cache_path: row.get(7)?,
            warnings_json: row.get(8)?,
            config_json: row.get(9)?,
            created_at: row.get(10)?,
            updated_at: row.get(11)?,
            stats_inventory_json: row.get(12)?,
            pvd_inventory_json: row.get(13)?,
            num_cases: row.get(14)?,
            num_cases_with_output: row.get(15)?,
            sweep_parameters_json: row.get(16)?,
            cases_json: row.get(17)?,
            source_msb: row.get(18)?,
            sweep_group_id: row.get(19)?,
            scan_completed_at: row.get(20)?,
        })
    };

    let rows = if let Some(uid) = user_id {
        stmt.query_map(params![uid], mapper)
    } else {
        stmt.query_map([], mapper)
    };

    match rows {
        Ok(r) => r.filter_map(|r| r.ok()).collect(),
        Err(e) => {
            eprintln!("[AI] Failed to list datasets: {}", e);
            Vec::new()
        }
    }
}

// ============================================================
// Training job operations
// ============================================================

/// Create a new training job.
pub fn create_training_job(
    conn: &Connection,
    dataset_id: i64,
    user_id: i64,
    run_name: &str,
    model_family: &str,
    gpu_ids: &str,
    config_json: Option<&str>,
) -> Result<i64, String> {
    conn.execute(
        "INSERT INTO ai_training_jobs (dataset_id, user_id, run_name, model_family, gpu_ids, config_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![dataset_id, user_id, run_name, model_family, gpu_ids, config_json],
    )
    .map_err(|e| format!("Failed to create training job: {}", e))?;
    Ok(conn.last_insert_rowid())
}

/// Update training job status.
pub fn update_training_job_status(
    conn: &Connection,
    job_id: i64,
    status: &str,
    pid: Option<i64>,
    failure_reason: Option<&str>,
) -> Result<(), String> {
    let now = Utc::now().format("%Y-%m-%d %H:%M:%S").to_string();

    match status {
        "running" | "preflight" => {
            conn.execute(
                "UPDATE ai_training_jobs SET status = ?1, pid = ?2, started_at = ?3 WHERE id = ?4",
                params![status, pid, now, job_id],
            )
        }
        "completed" | "failed" | "cancelled" => {
            conn.execute(
                "UPDATE ai_training_jobs SET status = ?1, pid = NULL, completed_at = ?2,
                 failure_reason = COALESCE(?3, failure_reason)
                 WHERE id = ?4 AND status IN ('queued', 'preflight', 'running')",
                params![status, now, failure_reason, job_id],
            )
        }
        _ => {
            conn.execute(
                "UPDATE ai_training_jobs SET status = ?1 WHERE id = ?2",
                params![status, job_id],
            )
        }
    }
    .map_err(|e| format!("Failed to update training job {}: {}", job_id, e))?;
    Ok(())
}

/// List training jobs with optional status and user filters.
pub fn list_training_jobs(
    conn: &Connection,
    user_id: Option<i64>,
    status_filter: Option<&str>,
) -> Vec<AiTrainingJob> {
    let mut query = String::from(
        "SELECT id, dataset_id, user_id, run_name, model_family, status, gpu_ids,
                priority, submitted_at, started_at, completed_at, artifact_directory,
                config_json, failure_reason, pid
         FROM ai_training_jobs WHERE 1=1"
    );

    let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

    if let Some(uid) = user_id {
        query.push_str(&format!(" AND user_id = ?{}", param_values.len() + 1));
        param_values.push(Box::new(uid));
    }
    if let Some(status) = status_filter {
        query.push_str(&format!(" AND status = ?{}", param_values.len() + 1));
        param_values.push(Box::new(status.to_string()));
    }

    query.push_str(" ORDER BY submitted_at DESC");

    let mut stmt = match conn.prepare(&query) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[AI] Failed to prepare training jobs query: {}", e);
            return Vec::new();
        }
    };

    let param_refs: Vec<&dyn rusqlite::types::ToSql> = param_values.iter().map(|b| b.as_ref()).collect();

    let rows = stmt.query_map(param_refs.as_slice(), |row| {
        Ok(AiTrainingJob {
            id: row.get(0)?,
            dataset_id: row.get(1)?,
            user_id: row.get(2)?,
            run_name: row.get(3)?,
            model_family: row.get(4)?,
            status: row.get(5)?,
            gpu_ids: row.get(6)?,
            priority: row.get(7)?,
            submitted_at: row.get(8)?,
            started_at: row.get(9)?,
            completed_at: row.get(10)?,
            artifact_directory: row.get(11)?,
            config_json: row.get(12)?,
            failure_reason: row.get(13)?,
            pid: row.get(14)?,
        })
    });

    match rows {
        Ok(r) => r.filter_map(|r| r.ok()).collect(),
        Err(e) => {
            eprintln!("[AI] Failed to list training jobs: {}", e);
            Vec::new()
        }
    }
}

/// Get the next queued training job (oldest first, by submitted_at).
pub fn get_next_queued_training_job(conn: &Connection) -> Option<AiTrainingJob> {
    let mut stmt = conn.prepare(
        "SELECT id, dataset_id, user_id, run_name, model_family, status, gpu_ids,
                priority, submitted_at, started_at, completed_at, artifact_directory,
                config_json, failure_reason, pid
         FROM ai_training_jobs WHERE status = 'queued'
         ORDER BY priority DESC, submitted_at ASC LIMIT 1"
    ).ok()?;

    stmt.query_row([], |row| {
        Ok(AiTrainingJob {
            id: row.get(0)?,
            dataset_id: row.get(1)?,
            user_id: row.get(2)?,
            run_name: row.get(3)?,
            model_family: row.get(4)?,
            status: row.get(5)?,
            gpu_ids: row.get(6)?,
            priority: row.get(7)?,
            submitted_at: row.get(8)?,
            started_at: row.get(9)?,
            completed_at: row.get(10)?,
            artifact_directory: row.get(11)?,
            config_json: row.get(12)?,
            failure_reason: row.get(13)?,
            pid: row.get(14)?,
        })
    }).ok()
}

// ============================================================
// Process management
// ============================================================

/// Build the mstar-ai CLI command for a training step.
pub fn build_mstar_ai_command(
    config: &AiTrainingConfig,
    subcommand: &str,
    args: &[(&str, &str)],
    data_root: &Path,
) -> Result<Command, String> {
    if config.container_mode {
        let mut cmd = Command::new("docker");
        cmd.arg("run")
           .arg("--rm")
           .arg("--gpus").arg("all")
           .arg("-v").arg(format!("{}:{}", data_root.display(), data_root.display()))
           .arg(&config.container_image)
           .arg("mstar-ai")
           .arg(subcommand);

        for (key, value) in args {
            cmd.arg(key).arg(value);
        }

        Ok(cmd)
    } else {
        let python_exec = &config.python_executable;
        let mut cmd = Command::new(python_exec);
        cmd.arg("-m").arg("mstar_ai.cli").arg(subcommand);

        for (key, value) in args {
            cmd.arg(key).arg(value);
        }

        Ok(cmd)
    }
}

/// Spawn a training process and return the child handle.
pub fn spawn_training_process(
    config: &AiTrainingConfig,
    config_path: &Path,
    data_root: &Path,
    log_path: &Path,
) -> Result<Child, String> {
    let log_file = std::fs::File::create(log_path)
        .map_err(|e| format!("Failed to create log file {:?}: {}", log_path, e))?;

    let log_stderr = log_file.try_clone()
        .map_err(|e| format!("Failed to clone log file handle: {}", e))?;

    let mut cmd = build_mstar_ai_command(
        config,
        "train",
        &[("--config", &config_path.to_string_lossy())],
        data_root,
    )?;

    cmd.stdout(Stdio::from(log_file))
       .stderr(Stdio::from(log_stderr))
       .stdin(Stdio::null());

    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn training process: {}", e))?;

    println!("[AI] Spawned training process PID={}", child.id());

    Ok(child)
}

/// Check if a training process (by PID) is still alive.
pub fn is_process_alive(pid: u32) -> bool {
    // On Linux, sending signal 0 checks if the process exists
    unsafe {
        libc::kill(pid as i32, 0) == 0
    }
}

/// Cancel a training process by PID.
pub fn cancel_training_process(pid: u32) -> Result<(), String> {
    println!("[AI] Cancelling training process PID={}", pid);

    // First try SIGTERM for graceful shutdown
    unsafe {
        if libc::kill(pid as i32, libc::SIGTERM) != 0 {
            return Err(format!("Failed to send SIGTERM to PID {}", pid));
        }
    }

    // Wait briefly then SIGKILL if still alive
    std::thread::sleep(std::time::Duration::from_secs(5));
    if is_process_alive(pid) {
        eprintln!("[AI] Process {} still alive after SIGTERM, sending SIGKILL", pid);
        unsafe {
            libc::kill(pid as i32, libc::SIGKILL);
        }
    }

    Ok(())
}

// ============================================================
// Path validation (mirrors data_root enforcement from api.rs)
// ============================================================

/// Validate that a path is under the data_root or allowed training roots.
pub fn validate_training_path(
    path: &str,
    data_root: &Path,
    allowed_roots: &[String],
) -> Result<PathBuf, String> {
    let candidate = std::fs::canonicalize(path)
        .map_err(|e| format!("Path does not exist or cannot be resolved: {}: {}", path, e))?;

    // Check against data_root
    let canon_data_root = std::fs::canonicalize(data_root)
        .map_err(|e| format!("data_root cannot be resolved: {}", e))?;

    if candidate.starts_with(&canon_data_root) {
        return Ok(candidate);
    }

    // Check against allowed training roots
    for root in allowed_roots {
        if let Ok(canon_root) = std::fs::canonicalize(root) {
            if candidate.starts_with(&canon_root) {
                return Ok(candidate);
            }
        }
    }

    Err(format!(
        "Path {} is outside allowed directories (data_root: {})",
        path,
        data_root.display()
    ))
}
