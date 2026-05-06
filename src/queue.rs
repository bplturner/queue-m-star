use std::path::Path;
use std::process::Stdio;
use tokio::process::Command as TokioCommand;
use crate::config::Config;
use crate::db::{self, DbHandle, Job};
use crate::mstar_versions::{resolve_version, build_mstar_command};
use crate::api::VersionList;

/// Run the queue manager loop as a background Tokio task.
///
/// Periodically checks for queued jobs and launches them when GPUs are available.
/// Also monitors running jobs and updates their status on completion.
///
/// Production features:
/// - Auto-requeues dead jobs on startup (if `auto_requeue_on_restart` is enabled)
/// - Startup delay to wait for NFS mounts and GPU drivers after reboot
/// - Systemd watchdog heartbeat every poll cycle
pub async fn run_queue_manager(
    db: DbHandle,
    versions: VersionList,
    config: Config,
) {
    let poll_interval = std::time::Duration::from_secs(config.queue.poll_interval_secs);
    let auto_requeue = config.queue.auto_requeue_on_restart;

    // Smart recovery: check if previously-running jobs are still alive
    {
        let conn = db.lock().await;
        match db::get_running_jobs(&conn) {
            Ok(running_jobs) => {
                if running_jobs.is_empty() {
                    println!("[QUEUE] No running jobs to recover from previous session");
                } else {
                    println!("[QUEUE] Found {} running jobs from previous session, checking PIDs...", running_jobs.len());
                    if auto_requeue {
                        println!("[QUEUE] Auto-requeue is ENABLED — dead jobs will be re-queued for checkpoint restart");
                    } else {
                        println!("[QUEUE] Auto-requeue is DISABLED — dead jobs will be marked as failed");
                    }
                    for job in &running_jobs {
                        if let Some(pid) = job.pid {
                            // Check if the process is still alive
                            let alive = unsafe {
                                libc::kill(pid as i32, 0) == 0
                            };
                            if alive && is_mstar_process(pid as u32) {
                                let ver_info = job.resolved_version.as_deref().unwrap_or(&job.mstar_version);
                                println!("[QUEUE] Job {} (PID {}, M-Star v{}) is STILL RUNNING — re-attaching", job.id, pid, ver_info);

                                // Re-create GPU reservations so the scheduler knows these GPUs are busy
                                let gpu_ids: Vec<i32> = serde_json::from_str(&job.gpu_ids).unwrap_or_default();
                                for gpu_id in &gpu_ids {
                                    let _ = conn.execute(
                                        "INSERT OR REPLACE INTO gpu_reservations (gpu_id, job_id) VALUES (?1, ?2)",
                                        rusqlite::params![gpu_id, job.id],
                                    );
                                }
                                println!("[QUEUE] Job {} — restored GPU reservations: {:?}", job.id, gpu_ids);

                                // Spawn a waiter task that monitors the process
                                let db_clone = db.clone();
                                let job_id = job.id;
                                let job_copy_to = job.copy_to_path.clone();
                                let job_working_dir = job.working_directory.clone();
                                let reattach_data_root = config.paths.data_root.to_str().unwrap_or("/").to_string();
                                tokio::spawn(async move {
                                    reattach_to_running_process(db_clone, job_id, pid as u32, job_copy_to, job_working_dir, reattach_data_root).await;
                                });
                            } else if alive {
                                // PID is alive but NOT an mstar process — PID was reused by another program
                                println!("[QUEUE] Job {} (PID {}) — PID is alive but NOT an M-Star process (PID reuse detected) — marking as failed", job.id, pid);
                                let _ = db::fail_stale_job(&conn, job.id, "PID reused by another process after daemon restart");
                            } else if auto_requeue {
                                // Process is dead and auto-requeue is enabled — re-queue for checkpoint restart
                                println!("[QUEUE] Job {} (PID {}) is DEAD — RE-QUEUING for checkpoint restart", job.id, pid);
                                let _ = db::requeue_stale_job(&conn, job.id, "Auto-requeued: process died during daemon/machine restart");
                            } else {
                                println!("[QUEUE] Job {} (PID {}) is DEAD — marking as failed", job.id, pid);
                                let _ = db::fail_stale_job(&conn, job.id, "Process died during daemon restart");
                            }
                        } else {
                            if auto_requeue {
                                println!("[QUEUE] Job {} has no PID — RE-QUEUING for restart", job.id);
                                let _ = db::requeue_stale_job(&conn, job.id, "Auto-requeued: no PID recorded, daemon restarted");
                            } else {
                                println!("[QUEUE] Job {} has no PID — marking as failed", job.id);
                                let _ = db::fail_stale_job(&conn, job.id, "No PID recorded, daemon restarted");
                            }
                        }
                    }
                }
            }
            Err(e) => eprintln!("[QUEUE] Error checking running jobs: {}", e),
        }
    }

    // Startup delay: wait for NFS mounts and GPU drivers to initialize after reboot
    if config.queue.startup_delay_secs > 0 {
        println!("[QUEUE] Startup delay: waiting {}s for NFS mounts and GPUs...",
            config.queue.startup_delay_secs);
        tokio::time::sleep(std::time::Duration::from_secs(config.queue.startup_delay_secs)).await;
        println!("[QUEUE] Startup delay complete, beginning queue processing");
    }

    // Ensure jobs directory exists
    let jobs_dir = &config.paths.jobs_directory;
    if let Err(e) = tokio::fs::create_dir_all(&jobs_dir).await {
        eprintln!("[QUEUE] Failed to create jobs directory {}: {}", jobs_dir.display(), e);
    }

    loop {
        // Systemd watchdog heartbeat — tells systemd "I'm still alive"
        let _ = sd_notify::notify(false, &[sd_notify::NotifyState::Watchdog]);

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
    // For checkpoint restarts: use the exact version from the original run to avoid
    // incompatible checkpoint formats. For new jobs: resolve normally.
    let is_restart = job.restart_from_job_id.is_some();
    let version_to_resolve = if is_restart {
        // Use the resolved version from the original job if available
        let orig_resolved = {
            let conn = db.lock().await;
            if let Some(orig_id) = job.restart_from_job_id {
                db::get_job(&conn, orig_id)
                    .ok()
                    .and_then(|j| j.resolved_version)
            } else {
                None
            }
        };
        orig_resolved.unwrap_or_else(|| job.mstar_version.clone())
    } else {
        job.mstar_version.clone()
    };

    let versions_lock = versions.lock().await;
    let version = resolve_version(&versions_lock, &version_to_resolve)
        .ok_or_else(|| {
            if is_restart {
                format!(
                    "M-Star version '{}' (from original job) is no longer installed. \
                     Cannot restart with a different version — checkpoint files may be incompatible.",
                    version_to_resolve
                )
            } else {
                format!("M-Star version '{}' not found", version_to_resolve)
            }
        })?
        .clone();
    drop(versions_lock);

    // Persist the actual version used — critical for future checkpoint restarts
    {
        let conn = db.lock().await;
        if let Err(e) = db::update_resolved_version(&conn, job.id, &version.version) {
            eprintln!("[QUEUE] Warning: failed to store resolved version for job {}: {}", job.id, e);
        }
    }
    println!("[QUEUE] Job {} using M-Star v{}", job.id, version.version);

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
    let data_root = config.paths.data_root.to_str().unwrap_or("/").to_string();

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
                        copy_results_to_destination(job_id, &job_working_dir, copy_to, &data_root).await;
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
/// Uses waitpid to get the actual exit status when the process exits.
async fn reattach_to_running_process(
    db: DbHandle,
    job_id: i64,
    pid: u32,
    copy_to_path: Option<String>,
    working_directory: Option<String>,
    data_root: String,
) {
    println!("[QUEUE] Monitoring re-attached job {} (PID {})", job_id, pid);

    // Try to use waitpid in a blocking thread to get the real exit status.
    // waitpid only works for child processes of this daemon, so for re-attached
    // orphans we fall back to kill-polling + output file inspection.
    let exit_success = tokio::task::spawn_blocking(move || {
        loop {
            // Poll every 2 seconds
            std::thread::sleep(std::time::Duration::from_secs(2));

            let alive = unsafe { libc::kill(pid as i32, 0) == 0 };
            if !alive {
                // Process is gone. Try waitpid to reap and get status.
                let mut status: i32 = 0;
                let result = unsafe {
                    libc::waitpid(pid as i32, &mut status, libc::WNOHANG)
                };
                if result > 0 {
                    // We got the exit status
                    if libc::WIFEXITED(status) {
                        let code = libc::WEXITSTATUS(status);
                        return Some(code == 0);
                    } else {
                        // Killed by signal
                        return Some(false);
                    }
                }
                // waitpid returned 0 or -1: not our child, can't get status
                return None;
            }
        }
    }).await.unwrap_or(None);

    // Determine success from exit status or output file inspection
    let success = match exit_success {
        Some(ok) => {
            println!("[QUEUE] Re-attached job {} (PID {}) — waitpid reports {}",
                job_id, pid, if ok { "success" } else { "failure" });
            ok
        }
        None => {
            // Couldn't get exit status (orphaned process). Check output file for errors.
            let ok = check_job_output_success(job_id, &working_directory).await;
            println!("[QUEUE] Re-attached job {} (PID {}) — output file inspection reports {}",
                job_id, pid, if ok { "success (no errors found)" } else { "failure (errors detected)" });
            ok
        }
    };

    let conn = db.lock().await;
    if success {
        println!("[QUEUE] Re-attached job {} completed successfully", job_id);
        let _ = db::complete_job(&conn, job_id);
    } else {
        println!("[QUEUE] Re-attached job {} failed", job_id);
        let _ = db::fail_job(&conn, job_id, "Process exited with errors (detected after daemon restart)");
    }
    drop(conn);

    // Auto-copy results only on success
    if success {
        if let Some(ref copy_to) = copy_to_path {
            copy_results_to_destination(job_id, &working_directory, copy_to, &data_root).await;
        }
    }
}

/// Check if a PID belongs to an M-Star CFD process by inspecting /proc/{pid}/cmdline.
/// Prevents re-attaching to a random process after PID reuse.
fn is_mstar_process(pid: u32) -> bool {
    let cmdline_path = format!("/proc/{}/cmdline", pid);
    match std::fs::read(&cmdline_path) {
        Ok(data) => {
            // cmdline is null-separated, convert to a single string
            let cmdline = String::from_utf8_lossy(&data).to_lowercase();
            let is_mstar = cmdline.contains("mstar-cfd") || cmdline.contains("mstar_cfd");
            if !is_mstar {
                println!("[QUEUE] PID {} cmdline: {:?} — NOT an M-Star process", pid,
                    String::from_utf8_lossy(&data).replace('\0', " "));
            }
            is_mstar
        }
        Err(_) => false, // Can't read — process may have died between checks
    }
}

/// Inspect the job's output file to determine if the simulation completed successfully.
/// M-Star CFD writes specific patterns on success vs failure.
async fn check_job_output_success(job_id: i64, working_directory: &Option<String>) -> bool {
    let work_dir = match working_directory {
        Some(ref d) => d.clone(),
        None => return false,
    };

    // Check the output log file (output_job_N.txt)
    let output_file = format!("{}/output_job_{}.txt", work_dir, job_id);
    let content = match tokio::fs::read_to_string(&output_file).await {
        Ok(c) => c,
        Err(_) => {
            // No output file — also check stdout capture
            let alt = format!("{}/out/mstar_output.log", work_dir);
            match tokio::fs::read_to_string(&alt).await {
                Ok(c) => c,
                Err(_) => {
                    println!("[QUEUE] Job {} — no output file found, assuming failure", job_id);
                    return false;
                }
            }
        }
    };

    // Check the last ~2000 chars for error indicators
    let tail: &str = if content.len() > 2000 {
        &content[content.len() - 2000..]
    } else {
        &content
    };
    let tail_lower = tail.to_lowercase();

    // M-Star error patterns
    let error_patterns = [
        "error",
        "fatal",
        "abort",
        "segfault",
        "segmentation fault",
        "killed",
        "out of memory",
        "cuda error",
    ];

    // M-Star success patterns (simulation completed normally)
    let success_patterns = [
        "simulation complete",
        "simulation finished",
        "done.",
        "total time",
    ];

    // If we find a success pattern near the end, it's good
    for pat in &success_patterns {
        if tail_lower.contains(pat) {
            return true;
        }
    }

    // If we find error patterns, it's bad
    for pat in &error_patterns {
        if tail_lower.contains(pat) {
            return false;
        }
    }

    // If the output exists and has substantial content but no clear indicator,
    // check if the Stats/Timing.txt file exists (indicates simulation ran to end)
    let timing_file = format!("{}/out/Stats/Timing.txt", work_dir);
    if tokio::fs::metadata(&timing_file).await.is_ok() {
        return true;
    }

    // Default: assume success if output exists and has content
    content.len() > 100
}

/// Copy completed job results to the specified destination path
/// SECURITY: Validates destination resolves under the configured data_root
/// SAFETY: Never deletes source data; verifies copy before reporting success
async fn copy_results_to_destination(
    job_id: i64,
    working_directory: &Option<String>,
    destination: &str,
    data_root: &str,
) {
    let src_dir = match working_directory {
        Some(ref d) => d.clone(),
        None => {
            eprintln!("[COPY] Job {} has no working directory, cannot copy results", job_id);
            return;
        }
    };

    // SECURITY: Validate destination resolves under the configured data_root
    let dest_path = std::path::Path::new(destination);
    // For new paths, canonicalize the nearest existing ancestor
    let mut check = dest_path.to_path_buf();
    loop {
        if check.exists() {
            match std::fs::canonicalize(&check) {
                Ok(canonical) => {
                    if !canonical.starts_with(data_root) {
                        eprintln!("[COPY] SECURITY BLOCKED: Job {} destination {} resolves to {} which is outside {}",
                            job_id, destination, canonical.display(), data_root);
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
