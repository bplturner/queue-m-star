use std::path::Path;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
use tokio::process::Command as TokioCommand;
use crate::config::Config;
use crate::db::{self, DbHandle, Job};
use crate::mstar_versions::{resolve_version, build_mstar_command};
use crate::api::VersionList;

/// Run the queue manager loop as a background Tokio task.
///
/// Periodically checks for queued jobs and launches them when GPUs are available.
/// Also monitors running jobs and updates their status on completion.
pub async fn run_queue_manager(
    db: DbHandle,
    versions: VersionList,
    config: Config,
) {
    let poll_interval = std::time::Duration::from_secs(config.queue.poll_interval_secs);

    // Smart recovery: check if previously-running jobs are still alive
    {
        let conn = db.lock().await;
        match db::get_running_jobs(&conn) {
            Ok(running_jobs) => {
                if running_jobs.is_empty() {
                    println!("[QUEUE] No running jobs to recover from previous session");
                } else {
                    println!("[QUEUE] Found {} running jobs from previous session, checking PIDs...", running_jobs.len());
                    for job in &running_jobs {
                        if let Some(pid) = job.pid {
                            // Check if the process is still alive
                            let alive = unsafe {
                                libc::kill(pid as i32, 0) == 0
                            };
                            if alive {
                                println!("[QUEUE] Job {} (PID {}) is STILL RUNNING — re-attaching", job.id, pid);
                                // Spawn a waiter task that monitors the process
                                let db_clone = db.clone();
                                let job_id = job.id;
                                let job_copy_to = job.copy_to_path.clone();
                                let job_working_dir = job.working_directory.clone();
                                tokio::spawn(async move {
                                    reattach_to_running_process(db_clone, job_id, pid as u32, job_copy_to, job_working_dir).await;
                                });
                            } else {
                                println!("[QUEUE] Job {} (PID {}) is DEAD — marking as failed", job.id, pid);
                                let _ = db::fail_stale_job(&conn, job.id, "Process died during daemon restart");
                            }
                        } else {
                            println!("[QUEUE] Job {} has no PID — marking as failed", job.id);
                            let _ = db::fail_stale_job(&conn, job.id, "No PID recorded, daemon restarted");
                        }
                    }
                }
            }
            Err(e) => eprintln!("[QUEUE] Error checking running jobs: {}", e),
        }
    }

    // Ensure jobs directory exists
    let jobs_dir = &config.paths.jobs_directory;
    if let Err(e) = tokio::fs::create_dir_all(&jobs_dir).await {
        eprintln!("[QUEUE] Failed to create jobs directory {}: {}", jobs_dir.display(), e);
    }

    loop {
        // Check for queued jobs
        let next_job = {
            let conn = db.lock().await;
            db::get_next_queued_job(&conn).unwrap_or(None)
        };

        if let Some(job) = next_job {
            // Check if requested GPUs are available
            let requested_gpus: Vec<i32> = serde_json::from_str(&job.gpu_ids).unwrap_or_default();
            let gpus_available = check_gpus_available(&db, &requested_gpus).await;

            // Also check max concurrent jobs
            let running_count = {
                let conn = db.lock().await;
                db::list_jobs(&conn, Some("running"), None)
                    .map(|jobs| jobs.len())
                    .unwrap_or(0)
            };

            if gpus_available && running_count < config.queue.max_concurrent_jobs {
                println!("[QUEUE] Launching job {} ({})", job.id, job.name);

                let db_clone = db.clone();
                let versions_clone = versions.clone();
                let config_clone = config.clone();

                tokio::spawn(async move {
                    if let Err(e) = launch_job(db_clone, versions_clone, config_clone, job).await {
                        eprintln!("[QUEUE] Failed to launch job: {}", e);
                    }
                });
            }
        }

        tokio::time::sleep(poll_interval).await;
    }
}

/// Check if all requested GPUs are available:
/// 1. Not reserved by other jobs in our database
/// 2. No active compute processes detected by nvidia-smi (external workloads)
async fn check_gpus_available(db: &DbHandle, requested_gpus: &[i32]) -> bool {
    if requested_gpus.is_empty() {
        return false;
    }

    // Check DB reservations
    let conn = db.lock().await;
    let reserved = db::get_reserved_gpus(&conn).unwrap_or_default();
    drop(conn);

    if requested_gpus.iter().any(|g| reserved.contains(g)) {
        return false;
    }

    // Check actual GPU processes — never schedule onto GPUs with external workloads
    if let Ok(gpu_info) = crate::get_gpu_info() {
        for &gpu_id in requested_gpus {
            if let Some(info) = gpu_info.get(gpu_id as usize) {
                if info.has_compute_processes {
                    println!("[QUEUE] GPU {} has active compute processes, skipping", gpu_id);
                    return false;
                }
            }
        }
    }

    true
}

/// Launch a queued job:
/// 1. Resolve M-Star version
/// 2. Create working directory
/// 3. Run unpack_msb.py
/// 4. Launch mstar-cfd-mgpu (with mpirun for multi-GPU)
/// 5. Stream output to file
/// 6. Update DB on completion/failure
async fn launch_job(
    db: DbHandle,
    versions: VersionList,
    config: Config,
    job: Job,
) -> Result<(), String> {
    // Resolve M-Star version
    let versions_lock = versions.lock().await;
    let version = resolve_version(&versions_lock, &job.mstar_version)
        .ok_or_else(|| format!("M-Star version '{}' not found", job.mstar_version))?
        .clone();
    drop(versions_lock);

    let is_restart = job.restart_from_job_id.is_some();

    // Determine working directory
    let job_dir = if is_restart {
        // Restart jobs reuse the original job's working directory
        let original_id = job.restart_from_job_id.unwrap();
        let orig_dir = {
            let conn = db.lock().await;
            let orig = db::get_job(&conn, original_id)
                .map_err(|e| format!("Failed to get original job {}: {}", original_id, e))?;
            orig.working_directory
                .ok_or_else(|| format!("Original job {} has no working directory", original_id))?
        };
        std::path::PathBuf::from(orig_dir)
    } else {
        let dir = config.paths.jobs_directory.join(format!("job_{}", job.id));
        tokio::fs::create_dir_all(&dir).await
            .map_err(|e| format!("Failed to create job dir: {}", e))?;
        dir
    };

    let job_dir_str = job_dir.to_str().unwrap_or("").to_string();

    if !is_restart {
        // Normal job: check MSB and run unpack_msb.py
        let msb_path = job_dir.join(&job.msb_filename);
        if !msb_path.exists() {
            let queue_msb = config.paths.queue_directory.join(&job.msb_filename);
            if queue_msb.exists() {
                tokio::fs::copy(&queue_msb, &msb_path).await
                    .map_err(|e| format!("Failed to copy MSB from queue: {}", e))?;
            } else {
                let err = format!("MSB file not found: {}", msb_path.display());
                let conn = db.lock().await;
                let _ = db::fail_job(&conn, job.id, &err);
                return Err(err);
            }
        }

        println!("[QUEUE] Running unpack_msb.py for job {}", job.id);
        let unpack_script = std::env::current_dir()
            .map(|d| d.join("unpack_msb.py"))
            .unwrap_or_else(|_| std::path::PathBuf::from("unpack_msb.py"));

        let unpack_output = TokioCommand::new("python3")
            .arg(unpack_script.to_str().unwrap_or("unpack_msb.py"))
            .arg(msb_path.to_str().unwrap_or(""))
            .arg(job_dir.to_str().unwrap_or(""))
            .output()
            .await
            .map_err(|e| format!("Failed to run unpack_msb.py: {}", e))?;

        if !unpack_output.status.success() {
            let stderr = String::from_utf8_lossy(&unpack_output.stderr);
            let err = format!("unpack_msb.py failed: {}", stderr);
            let conn = db.lock().await;
            let _ = db::fail_job(&conn, job.id, &err);
            return Err(err);
        }
    } else {
        println!("[QUEUE] Restart job {} — reusing working directory: {}", job.id, job_dir_str);
        // Future extensibility: apply input.xml modifications from restart_options here
        // if let Some(opts) = &job.restart_options {
        //     apply_restart_options(&job_dir, opts)?;
        // }
    }

    // Build the mstar command
    let gpu_ids: Vec<i32> = serde_json::from_str(&job.gpu_ids).unwrap_or_default();
    let command = build_mstar_command(
        &version,
        "input.xml",
        "out",
        &gpu_ids,
        job.unified_memory,
        !is_restart, // --force for fresh starts only
        is_restart,  // --load-last for restarts
    );

    println!("[QUEUE] Command for job {}: {}", job.id, command);

    // Create output file — redirect stdout/stderr directly to it via OS file descriptor
    let output_filename = format!("output_job_{}.txt", job.id);
    let output_path = job_dir.join(&output_filename);
    let output_path_str = output_path.to_str().unwrap_or("").to_string();

    let output_file = std::fs::File::create(&output_path)
        .map_err(|e| format!("Failed to create output file: {}", e))?;
    let stderr_file = output_file.try_clone()
        .map_err(|e| format!("Failed to clone output file: {}", e))?;

    // Launch the process with stdout/stderr going directly to the file
    let mut child = TokioCommand::new("bash")
        .arg("-c")
        .arg(&command)
        .current_dir(&job_dir)
        .stdout(Stdio::from(output_file))
        .stderr(Stdio::from(stderr_file))
        .spawn()
        .map_err(|e| format!("Failed to spawn mstar: {}", e))?;

    let pid = child.id().unwrap_or(0);

    // Update DB: mark as running
    {
        let conn = db.lock().await;
        if let Err(e) = db::start_job(&conn, job.id, pid, &job_dir_str, &output_path_str) {
            eprintln!("[QUEUE] Failed to update job status: {}", e);
        }
    }

    println!("[QUEUE] Job {} started with PID {} on GPUs {:?}{}", job.id, pid, gpu_ids,
             if is_restart { " (RESTART with --load-last)" } else { "" });

    // Wait for process completion in a spawned task
    let db_clone = db.clone();
    let job_id = job.id;
    let job_copy_to = job.copy_to_path.clone();
    let job_working_dir = Some(job_dir_str.clone());

    tokio::spawn(async move {
        match child.wait().await {
            Ok(status) => {
                let conn = db_clone.lock().await;
                if status.success() {
                    println!("[QUEUE] Job {} completed successfully", job_id);
                    let _ = db::complete_job(&conn, job_id);
                    drop(conn); // Release lock before file I/O
                    // Auto-copy results if copy_to_path is set
                    if let Some(ref copy_to) = job_copy_to {
                        copy_results_to_destination(job_id, &job_working_dir, copy_to).await;
                    }
                } else {
                    let err = format!("Process exited with status: {}", status);
                    println!("[QUEUE] Job {} failed: {}", job_id, err);
                    let _ = db::fail_job(&conn, job_id, &err);
                }
            }
            Err(e) => {
                let conn = db_clone.lock().await;
                let _ = db::fail_job(&conn, job_id, &format!("Process error: {}", e));
            }
        }
    });

    Ok(())
}

/// Create a job from a file-watcher detection (legacy intake from network queue directory)
pub async fn create_job_from_file_watcher(
    db: &DbHandle,
    config: &Config,
    msb_path: &Path,
) -> Result<i64, String> {
    let filename = msb_path.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown.msb")
        .to_string();

    let job_name = filename.trim_end_matches(".msb")
        .trim_end_matches(".MSB")
        .to_string();

    // Use default version and auto-assign GPU
    let default_version = config.queue.default_mstar_version.clone();

    // Find a free GPU:
    // 1. Not reserved by another job in our DB
    // 2. No active compute processes (external workloads)
    let conn = db.lock().await;
    let reserved = db::get_reserved_gpus(&conn).unwrap_or_default();

    let gpu_info = crate::get_gpu_info().unwrap_or_default();
    let total_gpus = gpu_info.len();

    let free_gpu = (0..total_gpus as i32)
        .find(|g| {
            !reserved.contains(g)
            && gpu_info.get(*g as usize)
                .map(|info| !info.has_compute_processes)
                .unwrap_or(false)
        });

    let free_gpu = match free_gpu {
        Some(g) => g,
        None => {
            println!("[QUEUE] No free GPUs available for file-watcher job");
            return Err("No free GPUs available".to_string());
        }
    };

    let gpu_ids = serde_json::json!([free_gpu]).to_string();

    // Create job as system user (user_id = 1, the admin)
    let job_id = db::create_job(&conn, 1, &job_name, &filename, &default_version, &gpu_ids, false, 0, None)?;

    // Create job directory and copy MSB file there
    let job_dir = config.paths.jobs_directory.join(format!("job_{}", job_id));
    drop(conn); // Release lock before file I/O

    tokio::fs::create_dir_all(&job_dir).await
        .map_err(|e| format!("Failed to create job dir: {}", e))?;

    let dest = job_dir.join(&filename);
    tokio::fs::copy(msb_path, &dest).await
        .map_err(|e| format!("Failed to copy MSB to job dir: {}", e))?;

    // Remove original from queue directory
    let _ = tokio::fs::remove_file(msb_path).await;

    // Update working directory in DB
    let conn = db.lock().await;
    let _ = conn.execute(
        "UPDATE jobs SET working_directory = ?2 WHERE id = ?1",
        rusqlite::params![job_id, job_dir.to_str().unwrap_or("")],
    );

    println!("[QUEUE] Created job {} from file watcher: {}", job_id, filename);

    Ok(job_id)
}

/// Re-attach to a running process after daemon restart.
/// Polls the PID at regular intervals and updates DB when it exits.
async fn reattach_to_running_process(
    db: DbHandle,
    job_id: i64,
    pid: u32,
    copy_to_path: Option<String>,
    working_directory: Option<String>,
) {
    println!("[QUEUE] Monitoring re-attached job {} (PID {})", job_id, pid);

    loop {
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;

        // Check if process is still alive
        let alive = unsafe {
            libc::kill(pid as i32, 0) == 0
        };

        if !alive {
            // Process has exited
            let conn = db.lock().await;
            // We mark it as completed since it finished on its own
            // The user can check the output file for actual errors
            println!("[QUEUE] Re-attached job {} (PID {}) has exited — marking as completed", job_id, pid);
            let _ = db::complete_job(&conn, job_id);
            drop(conn);

            // Auto-copy results if copy_to_path is set
            if let Some(ref copy_to) = copy_to_path {
                copy_results_to_destination(job_id, &working_directory, copy_to).await;
            }

            break;
        }
    }
}

/// Copy completed job results to the specified destination path
/// SECURITY: Validates destination resolves under /simulations
/// SAFETY: Never deletes source data; verifies copy before reporting success
async fn copy_results_to_destination(
    job_id: i64,
    working_directory: &Option<String>,
    destination: &str,
) {
    let src_dir = match working_directory {
        Some(ref d) => d.clone(),
        None => {
            eprintln!("[COPY] Job {} has no working directory, cannot copy results", job_id);
            return;
        }
    };

    // SECURITY: Validate destination resolves under /simulations
    let dest_path = std::path::Path::new(destination);
    // For new paths, canonicalize the nearest existing ancestor
    let mut check = dest_path.to_path_buf();
    loop {
        if check.exists() {
            match std::fs::canonicalize(&check) {
                Ok(canonical) => {
                    if !canonical.starts_with("/simulations") {
                        eprintln!("[COPY] SECURITY BLOCKED: Job {} destination {} resolves to {} which is outside /simulations",
                            job_id, destination, canonical.display());
                        return;
                    }
                    break;
                }
                Err(e) => {
                    eprintln!("[COPY] Job {} — failed to canonicalize {}: {}", job_id, check.display(), e);
                    return;
                }
            }
        }
        if !check.pop() {
            eprintln!("[COPY] Job {} — destination path {} has no valid ancestor", job_id, destination);
            return;
        }
    }

    println!("[COPY] Job {} — copying results from {} to {}", job_id, src_dir, destination);

    // Create destination directory
    if let Err(e) = tokio::fs::create_dir_all(destination).await {
        eprintln!("[COPY] Job {} — failed to create destination {}: {}", job_id, destination, e);
        return;
    }

    // Use cp -r for reliable recursive copy (NEVER delete source)
    match TokioCommand::new("cp")
        .arg("-r")
        .arg("-T")  // Treat destination as the target, not a subdirectory
        .arg(&src_dir)
        .arg(destination)
        .output()
        .await
    {
        Ok(output) => {
            if output.status.success() {
                // VERIFY: Check destination actually has files
                match tokio::fs::read_dir(destination).await {
                    Ok(mut entries) => {
                        let has_files = entries.next_entry().await.map(|e| e.is_some()).unwrap_or(false);
                        if has_files {
                            println!("[COPY] Job {} — results copied and verified at {}", job_id, destination);
                        } else {
                            eprintln!("[COPY] Job {} — WARNING: copy reported success but destination appears empty: {}", job_id, destination);
                        }
                    }
                    Err(e) => {
                        eprintln!("[COPY] Job {} — WARNING: copy reported success but cannot read destination: {}", job_id, e);
                    }
                }
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr);
                eprintln!("[COPY] Job {} — copy failed: {}", job_id, stderr);
            }
        }
        Err(e) => {
            eprintln!("[COPY] Job {} — failed to run cp: {}", job_id, e);
        }
    }
}
