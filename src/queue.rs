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

        // ============================================================
        // 1. Process simulation / render jobs
        // ============================================================
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
                db::list_jobs(&conn, Some("running"), None, true)
                    .map(|jobs| jobs.len())
                    .unwrap_or(0)
            };

            if gpus_available && running_count < config.queue.max_concurrent_jobs {
                // Sweep concurrency control: if this job belongs to a sweep group,
                // check max_concurrent limit for the group before launching.
                let sweep_ok = if let Some(ref group_id) = job.sweep_group_id {
                    let conn = db.lock().await;
                    let active = db::count_active_sweep_jobs(&conn, group_id).unwrap_or(0);
                    // Parse max_concurrent from sweep_config JSON
                    let max_conc: usize = job.sweep_config.as_deref()
                        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
                        .and_then(|v| v.get("max_concurrent").and_then(|n| n.as_u64()))
                        .unwrap_or(1) as usize;
                    (active as usize) < max_conc
                } else {
                    true // Non-sweep jobs always pass this check
                };

                if sweep_ok {

                let job_id = job.id;
                let job_name = job.name.clone();
                println!("[QUEUE] Launching job {} ({})", job_id, job_name);

                // BUG 11 FIX: Atomically mark job as "launching" to prevent the
                // next poll cycle from picking up the same job while we're still
                // doing async setup (version resolution, MSB unpack, etc.).
                {
                    let conn = db.lock().await;
                    let _ = conn.execute(
                        "UPDATE jobs SET status = 'launching' WHERE id = ?1 AND status = 'queued'",
                        rusqlite::params![job_id],
                    );
                }

                let db_clone = db.clone();
                let versions_clone = versions.clone();
                let config_clone = config.clone();

                tokio::spawn(async move {
                    // BUG 3/4/5 FIX: If launch_job returns Err, the job would remain
                    // stuck forever. We now call fail_job on any error return.
                    if let Err(e) = launch_job(db_clone.clone(), versions_clone, config_clone, job).await {
                        eprintln!("[QUEUE] Failed to launch job {}: {}", job_id, e);
                        let conn = db_clone.lock().await;
                        // fail_job checks status IN ('running', 'queued') — add 'launching'
                        let _ = conn.execute(
                            "UPDATE jobs SET status = 'failed', completed_at = datetime('now'), pid = NULL,
                             error_message = ?2
                             WHERE id = ?1 AND status IN ('queued', 'running', 'launching')",
                            rusqlite::params![job_id, format!("Launch failed: {}", e)],
                        );
                        // Release any GPU reservations that might have been partially created
                        let _ = conn.execute(
                            "DELETE FROM gpu_reservations WHERE job_id = ?1",
                            rusqlite::params![job_id],
                        );
                    }
                });
                } // end if sweep_ok
            } // end if gpus_available
        } // end if let Some(job)

        // ============================================================
        // 2. Process AI training jobs (if enabled)
        // ============================================================
        if config.ai_training.enabled {
            let next_training_job = {
                let conn = db.lock().await;
                crate::ai_training::get_next_queued_training_job(&conn)
            };

            if let Some(tj) = next_training_job {
                // Check concurrent training limit
                let running_training = {
                    let conn = db.lock().await;
                    crate::ai_training::list_training_jobs(&conn, None, Some("running")).len()
                };

                if running_training < config.ai_training.max_concurrent_training_jobs {
                    // Parse and check GPU availability
                    let requested_gpus: Vec<i32> = serde_json::from_str(&tj.gpu_ids).unwrap_or_default();
                    let gpus_ok = if requested_gpus.is_empty() {
                        true // Auto GPU selection will happen in launch
                    } else {
                        check_gpus_available(&db, &requested_gpus).await
                    };

                    if gpus_ok {
                        let tj_id = tj.id;
                        println!("[QUEUE] Launching AI training job {} ({})", tj_id, tj.run_name);

                        // Mark as preflight to prevent re-pickup
                        {
                            let conn = db.lock().await;
                            let _ = crate::ai_training::update_training_job_status(
                                &conn, tj_id, "preflight", None, None,
                            );
                        }

                        let db_clone = db.clone();
                        let config_clone = config.clone();

                        tokio::spawn(async move {
                            launch_training_job(db_clone, config_clone, tj).await;
                        });
                    }
                }
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
    // Dispatch render jobs to specialized handler
    if job.job_type == "render" {
        return launch_render_job(db, versions, config, job).await;
    }

    // Resolve M-Star version
    // For restart jobs: job.mstar_version already contains the correct version
    // (either user-overridden or inherited from original job via create_restart_job).
    // For new jobs: use the version selected at submission time.
    let is_restart = job.restart_from_job_id.is_some();
    let version_to_resolve = job.mstar_version.clone();

    let versions_lock = versions.lock().await;
    let version = resolve_version(&versions_lock, &version_to_resolve)
        .ok_or_else(|| {
            format!("M-Star version '{}' not found or not installed", version_to_resolve)
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
    } else if let Some(ref wd) = job.working_directory {
        // Job already has a working directory set (e.g., sweep export case subdir)
        let dir = std::path::PathBuf::from(wd);
        if !dir.exists() {
            tokio::fs::create_dir_all(&dir).await
                .map_err(|e| format!("Failed to create pre-set working dir: {}", e))?;
        }
        dir
    } else {
        let dir = config.paths.jobs_directory.join(format!("job_{}", job.id));
        tokio::fs::create_dir_all(&dir).await
            .map_err(|e| format!("Failed to create job dir: {}", e))?;
        dir
    };

    let job_dir_str = job_dir.to_str().unwrap_or("").to_string();

    if !is_restart {
        // Normal job: check MSB and run unpack_msb.py
        let mut msb_path = job_dir.join(&job.msb_filename);
        if !msb_path.exists() {
            // For sweep exports: the MSB filename may differ from what's in the DB.
            // Scan the working directory for any .msb file.
            let mut found_msb = false;
            if let Ok(mut entries) = tokio::fs::read_dir(&job_dir).await {
                while let Ok(Some(entry)) = entries.next_entry().await {
                    let name = entry.file_name().to_string_lossy().to_string();
                    if name.to_lowercase().ends_with(".msb") {
                        msb_path = entry.path();
                        found_msb = true;
                        // Update msb_filename in DB to match the actual file
                        if name != job.msb_filename {
                            let conn = db.lock().await;
                            let _ = conn.execute(
                                "UPDATE jobs SET msb_filename = ?2 WHERE id = ?1",
                                rusqlite::params![job.id, &name],
                            );
                            drop(conn);
                            println!("[QUEUE] Job {} — resolved MSB filename: {} -> {}", job.id, job.msb_filename, name);
                        }
                        break;
                    }
                }
            }

            if !found_msb {
                // Last resort: check the queue directory
                let queue_msb = config.paths.queue_directory.join(&job.msb_filename);
                if queue_msb.exists() {
                    msb_path = job_dir.join(&job.msb_filename);
                    tokio::fs::copy(&queue_msb, &msb_path).await
                        .map_err(|e| format!("Failed to copy MSB from queue: {}", e))?;
                } else {
                    let err = format!("MSB file not found: {} (also checked working dir for any .msb)", msb_path.display());
                    let conn = db.lock().await;
                    let _ = db::fail_job(&conn, job.id, &err);
                    return Err(err);
                }
            }
        }

        // Safety net: reject empty MSB files before wasting GPU time
        let msb_meta = tokio::fs::metadata(&msb_path).await
            .map_err(|e| format!("Failed to stat MSB: {}", e))?;
        if msb_meta.len() == 0 {
            let err = format!("MSB file is empty (0 bytes): {}", msb_path.display());
            let conn = db.lock().await;
            let _ = db::fail_job(&conn, job.id, &err);
            return Err(err);
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

    // Determine checkpoint restart mode
    let checkpoint: Option<i64> = if is_restart {
        // Check if a specific checkpoint number was requested in restart_options
        let cp_val = job.restart_options.as_ref()
            .and_then(|opts| serde_json::from_str::<serde_json::Value>(opts).ok())
            .and_then(|v| v.get("checkpoint_number").and_then(|n| n.as_i64()));

        match cp_val {
            Some(0) => None,      // Explicit fresh start — use --force
            Some(n) => Some(n),   // Specific checkpoint or -1 for --load-last
            None => Some(-1),     // No preference — default to --load-last
        }
    } else {
        None  // Fresh run — will use --force
    };

    let command = build_mstar_command(
        &version,
        "input.xml",
        "out",
        &gpu_ids,
        job.unified_memory,
        checkpoint,
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
             if is_restart {
                 match checkpoint {
                     Some(n) if n >= 0 => format!(" (RESTART from checkpoint {})", n),
                     _ => " (RESTART with --load-last)".to_string(),
                 }
             } else { String::new() });

    // Wait for process completion in a spawned task
    let db_clone = db.clone();
    let job_id = job.id;
    let job_copy_to = job.copy_to_path.clone();
    let job_working_dir = Some(job_dir_str.clone());
    let data_root = config.paths.data_root.to_str().unwrap_or("/").to_string();
    let job_sweep_group_id = job.sweep_group_id.clone();

    tokio::spawn(async move {
        match child.wait().await {
            Ok(status) => {
                let conn = db_clone.lock().await;
                if status.success() {
                    println!("[QUEUE] Job {} completed successfully", job_id);
                    let _ = db::complete_job(&conn, job_id);

                    // Check if this was a sweep job and all siblings are now complete
                    if let Some(ref sgid) = job_sweep_group_id {
                        check_sweep_dataset_completion(&conn, sgid);
                    }

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

/// Launch a render job — invokes pvpython with render_job.py and a config JSON.
///
/// Uses the M-Star version-bundled pvpython from {install_dir}/post/bin/pvpython
/// with fallback to the system-wide ParaView installation.
async fn launch_render_job(
    db: DbHandle,
    versions: VersionList,
    _config: Config,
    job: Job,
) -> Result<(), String> {
    println!("[QUEUE] Launching RENDER job {}", job.id);

    // Parse render options from restart_options JSON
    let render_opts: serde_json::Value = job.restart_options.as_ref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_else(|| serde_json::json!({}));

    let source_work_dir = render_opts.get("source_work_dir")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Render job missing source_work_dir in options".to_string())?
        .to_string();

    let state_file = render_opts.get("state_file")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Render job missing state_file in options".to_string())?
        .to_string();

    // SECURITY: Validate state file exists and is within expected directory
    if !Path::new(&state_file).exists() {
        let err = format!("State file not found: {}", state_file);
        let conn = db.lock().await;
        let _ = db::fail_job(&conn, job.id, &err);
        return Err(err);
    }

    // Resolve pvpython binary — for rendering, prefer system ParaView (has --mesa launcher
    // for headless GPU rendering). Fall back to version-bundled pvpython if system not found.
    let (pvpython_path, use_mesa_flag) = {
        let system_pv = std::path::PathBuf::from(
            "/opt/ParaView-6.0.1-MPI-Linux-Python3.12-x86_64/bin/pvpython"
        );
        if system_pv.exists() {
            println!("[QUEUE] Using system pvpython (with --mesa support): {}", system_pv.display());
            (system_pv, true)
        } else {
            // Fallback to version-bundled pvpython (no --mesa launcher)
            let version_to_resolve = job.mstar_version.clone();
            let versions_lock = versions.lock().await;
            let version_pvpython = resolve_version(&versions_lock, &version_to_resolve)
                .map(|v| v.install_dir.join("post").join("bin").join("pvpython"));
            drop(versions_lock);

            match version_pvpython {
                Some(ref p) if p.exists() => {
                    println!("[QUEUE] Using version-bundled pvpython (no --mesa): {}", p.display());
                    (p.clone(), false)
                }
                _ => {
                    let err = "No pvpython binary found (neither system-wide nor version-bundled)".to_string();
                    let conn = db.lock().await;
                    let _ = db::fail_job(&conn, job.id, &err);
                    return Err(err);
                }
            }
        }
    };

    // Create render output directory
    let render_dir = std::path::Path::new(&source_work_dir).join("renders");
    tokio::fs::create_dir_all(&render_dir).await
        .map_err(|e| format!("Failed to create renders directory: {}", e))?;

    let render_dir_str = render_dir.to_str().unwrap_or("").to_string();
    let render_name = render_opts.get("render_name")
        .and_then(|v| v.as_str())
        .unwrap_or("render")
        .to_string();

    // Build the config.json for render_job.py
    let status_file_path = render_dir.join("render_status.json");
    let render_config = serde_json::json!({
        "case_path": source_work_dir,
        "state_file": state_file,
        "output_dir": render_dir_str,
        "status_file": status_file_path.to_str().unwrap_or(""),
        "resolution": render_opts.get("resolution"),
        "fps": render_opts.get("fps").and_then(|v| v.as_i64()).unwrap_or(25),
        "video_quality": render_opts.get("video_quality").and_then(|v| v.as_i64()).unwrap_or(23),
        "transparent": render_opts.get("transparent").and_then(|v| v.as_bool()).unwrap_or(false),
        "compression": render_opts.get("compression").and_then(|v| v.as_i64()).unwrap_or(0),
        "separate_views": render_opts.get("separate_views").and_then(|v| v.as_bool()).unwrap_or(false),
        "scale_fonts": render_opts.get("scale_fonts").and_then(|v| v.as_bool()).unwrap_or(false),
        "generate_video": render_opts.get("generate_video").and_then(|v| v.as_bool()).unwrap_or(true),
        "gpu_id": render_opts.get("gpu_id").and_then(|v| v.as_i64()).unwrap_or(0),
        "render_name": render_name,
    });

    // Write config JSON to render directory
    let config_path = render_dir.join("render_config.json");
    let config_json_str = serde_json::to_string_pretty(&render_config)
        .map_err(|e| format!("Failed to serialize render config: {}", e))?;
    tokio::fs::write(&config_path, &config_json_str).await
        .map_err(|e| format!("Failed to write render config: {}", e))?;

    // Locate render_job.py script
    let render_script = std::env::current_dir()
        .map(|d| d.join("render_job.py"))
        .unwrap_or_else(|_| std::path::PathBuf::from("render_job.py"));

    if !render_script.exists() {
        let err = format!("render_job.py not found at: {}", render_script.display());
        let conn = db.lock().await;
        let _ = db::fail_job(&conn, job.id, &err);
        return Err(err);
    }

    // Create output log file
    let output_filename = format!("output_render_{}.txt", job.id);
    let output_path = render_dir.join(&output_filename);
    let output_path_str = output_path.to_str().unwrap_or("").to_string();

    let output_file = std::fs::File::create(&output_path)
        .map_err(|e| format!("Failed to create output file: {}", e))?;
    let stderr_file = output_file.try_clone()
        .map_err(|e| format!("Failed to clone output file: {}", e))?;

    // Resolve the mstar.sh env script for the version (if available)
    // Only source this when using the version-bundled pvpython — sourcing it with
    // the system ParaView can cause LD_LIBRARY_PATH conflicts
    let env_source = if !use_mesa_flag {
        let version_to_resolve = job.mstar_version.clone();
        let versions_lock = versions.lock().await;
        let src = resolve_version(&versions_lock, &version_to_resolve)
            .map(|v| format!("source \"{}\" && ", v.env_script.display()))
            .unwrap_or_default();
        drop(versions_lock);
        src
    } else {
        String::new()
    };

    // Set CUDA_VISIBLE_DEVICES before pvpython so VisRTX only initializes the selected GPU
    let gpu_id = render_opts.get("gpu_id").and_then(|v| v.as_i64()).unwrap_or(0);

    // --mesa flag only works with the system ParaView launcher (not the raw pvpython-real)
    let mesa_flag = if use_mesa_flag { "--mesa " } else { "" };

    let command = format!(
        "CUDA_VISIBLE_DEVICES={} {}\"{}\" {}--force-offscreen-rendering \"{}\" \"{}\"",
        gpu_id,
        env_source,
        pvpython_path.display(),
        mesa_flag,
        render_script.display(),
        config_path.display(),
    );

    println!("[QUEUE] Render command for job {}: {}", job.id, command);

    // Launch pvpython
    let mut child = TokioCommand::new("bash")
        .arg("-c")
        .arg(&command)
        .current_dir(&source_work_dir)
        .env("CUDA_VISIBLE_DEVICES", gpu_id.to_string())
        .stdout(Stdio::from(output_file))
        .stderr(Stdio::from(stderr_file))
        .spawn()
        .map_err(|e| format!("Failed to spawn pvpython: {}", e))?;

    let pid = child.id().unwrap_or(0);

    // Update DB: mark as running, set working directory to render output dir
    {
        let conn = db.lock().await;
        if let Err(e) = db::start_job(&conn, job.id, pid, &render_dir_str, &output_path_str) {
            eprintln!("[QUEUE] Failed to update render job status: {}", e);
        }
    }

    println!("[QUEUE] Render job {} started with PID {} on GPU {}", job.id, pid,
             render_opts.get("gpu_id").and_then(|v| v.as_i64()).unwrap_or(0));

    // Wait for process completion
    let db_clone = db.clone();
    let job_id = job.id;

    tokio::spawn(async move {
        match child.wait().await {
            Ok(status) => {
                let conn = db_clone.lock().await;
                if status.success() {
                    println!("[QUEUE] Render job {} completed successfully", job_id);
                    let _ = db::complete_job(&conn, job_id);
                } else {
                    let err = format!("Render process exited with status: {}", status);
                    println!("[QUEUE] Render job {} failed: {}", job_id, err);
                    let _ = db::fail_job(&conn, job_id, &err);
                }
            }
            Err(e) => {
                let conn = db_clone.lock().await;
                let _ = db::fail_job(&conn, job_id, &format!("Render process error: {}", e));
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

// ============================================================
// AI Training Job Launcher
// ============================================================

/// Launch a queued AI training job:
/// 1. Create artifact directory
/// 2. Write training config JSON
/// 3. Reserve GPUs
/// 4. Spawn mstar-ai CLI process
/// 5. Monitor until completion/failure
/// 6. Release GPUs and update DB
async fn launch_training_job(
    db: DbHandle,
    config: Config,
    job: crate::ai_training::AiTrainingJob,
) {
    let job_id = job.id;
    let ai_config = &config.ai_training;
    let data_root = &config.paths.data_root;

    // 1. Create artifact directory
    let artifact_dir = std::path::Path::new(&ai_config.artifact_root)
        .join(format!("training_job_{}", job_id));

    if let Err(e) = tokio::fs::create_dir_all(&artifact_dir).await {
        let msg = format!("Failed to create artifact directory: {}", e);
        eprintln!("[AI] Training job {} — {}", job_id, msg);
        let conn = db.lock().await;
        let _ = crate::ai_training::update_training_job_status(&conn, job_id, "failed", None, Some(&msg));
        return;
    }

    // 2. Build training config JSON
    // Fetch dataset while holding the lock, then drop the lock before processing
    let dataset_opt = {
        let conn = db.lock().await;
        let datasets = crate::ai_training::list_datasets(&conn, None);
        datasets.into_iter().find(|d| d.id == job.dataset_id)
    }; // conn dropped here — safe to re-lock below

    let training_config = match dataset_opt {
        Some(ds) => {
            // Merge user config overrides with defaults
            let mut cfg = serde_json::json!({
                "dataset_id": ds.id,
                "sweep_root": ds.sweep_root,
                "dataset_mode": if ds.dataset_mode.is_empty() { "time_averaged_2d" } else { &ds.dataset_mode },
                "model_family": job.model_family,
                "run_name": job.run_name,
                "output_dir": artifact_dir.to_str().unwrap_or(""),
                "batch_size": ai_config.default_batch_size,
                "epochs": ai_config.default_epochs,
                "learning_rate": ai_config.default_learning_rate,
            });

            // Apply user-supplied config overrides
            if let Some(ref user_config) = job.config_json {
                if let Ok(overrides) = serde_json::from_str::<serde_json::Value>(user_config) {
                    if let (Some(base), Some(ovr)) = (cfg.as_object_mut(), overrides.as_object()) {
                        for (k, v) in ovr {
                            base.insert(k.clone(), v.clone());
                        }
                    }
                }
            }

            // Set manifest path if available
            if let Some(ref manifest) = ds.manifest_path {
                if let Some(obj) = cfg.as_object_mut() {
                    obj.insert("manifest_path".to_string(), serde_json::json!(manifest));
                }
            }

            cfg
        }
        None => {
            let msg = format!("Dataset {} not found", job.dataset_id);
            eprintln!("[AI] Training job {} — {}", job_id, msg);
            let conn = db.lock().await;
            let _ = crate::ai_training::update_training_job_status(&conn, job_id, "failed", None, Some(&msg));
            return;
        }
    };

    // Write config to disk
    let config_path = artifact_dir.join("training_config.json");
    let config_str = serde_json::to_string_pretty(&training_config).unwrap_or_default();
    if let Err(e) = tokio::fs::write(&config_path, &config_str).await {
        let msg = format!("Failed to write training config: {}", e);
        eprintln!("[AI] Training job {} — {}", job_id, msg);
        let conn = db.lock().await;
        let _ = crate::ai_training::update_training_job_status(&conn, job_id, "failed", None, Some(&msg));
        return;
    }

    // 3. Reserve GPUs
    let gpu_ids: Vec<i32> = serde_json::from_str(&job.gpu_ids).unwrap_or_default();
    if !gpu_ids.is_empty() {
        let conn = db.lock().await;
        if let Err(e) = crate::ai_training::reserve_gpus_for_training(&conn, job_id, &gpu_ids) {
            eprintln!("[AI] Training job {} — GPU reservation failed: {}", job_id, e);
            let _ = crate::ai_training::update_training_job_status(&conn, job_id, "failed", None, Some(&e));
            return;
        }
    }

    // 4. Spawn training process
    let log_path = artifact_dir.join(format!("training_{}.log", job_id));
    let spawn_result = crate::ai_training::spawn_training_process(
        ai_config,
        &config_path,
        data_root,
        &log_path,
        &gpu_ids,
    );

    let mut child = match spawn_result {
        Ok(c) => c,
        Err(e) => {
            let msg = format!("Failed to spawn training process: {}", e);
            eprintln!("[AI] Training job {} — {}", job_id, msg);
            let conn = db.lock().await;
            let _ = crate::ai_training::release_training_gpus(&conn, job_id);
            let _ = crate::ai_training::update_training_job_status(&conn, job_id, "failed", None, Some(&msg));
            return;
        }
    };

    let pid = child.id();

    // 5. Update DB to running
    {
        let conn = db.lock().await;
        let _ = crate::ai_training::update_training_job_status(
            &conn, job_id, "running", Some(pid as i64), None,
        );
        // Store artifact directory
        let _ = conn.execute(
            "UPDATE ai_training_jobs SET artifact_directory = ?2 WHERE id = ?1",
            rusqlite::params![job_id, artifact_dir.to_str().unwrap_or("")],
        );
    }

    println!("[AI] Training job {} started — PID={}, GPUs={:?}, artifact_dir={}",
        job_id, pid, gpu_ids, artifact_dir.display());

    // 6. Monitor process in background (non-blocking)
    // child.wait() is std::process::Child::wait() which is blocking — must use
    // spawn_blocking to avoid stalling the tokio runtime for hours/days.
    let db_clone = db.clone();
    tokio::spawn(async move {
        let exit_status = tokio::task::spawn_blocking(move || {
            child.wait()
        }).await;

        let conn = db_clone.lock().await;

        // Check current status: if the job was already cancelled by the user,
        // don't overwrite "cancelled" with "failed" (cancel/monitor race).
        let current_status = {
            let jobs = crate::ai_training::list_training_jobs(&conn, None, None);
            jobs.into_iter().find(|j| j.id == job_id).map(|j| j.status)
        };
        let already_terminal = matches!(
            current_status.as_deref(),
            Some("cancelled") | Some("completed") | Some("failed")
        );

        // Always release GPUs (idempotent DELETE)
        let _ = crate::ai_training::release_training_gpus(&conn, job_id);

        if already_terminal {
            println!("[AI] Training job {} — process exited but status already '{}', skipping update",
                job_id, current_status.unwrap_or_default());
            return;
        }

        match exit_status {
            Ok(Ok(status)) => {
                if status.success() {
                    println!("[AI] Training job {} completed successfully", job_id);
                    let _ = crate::ai_training::update_training_job_status(
                        &conn, job_id, "completed", None, None,
                    );
                } else {
                    let msg = format!("Training process exited with status: {}", status);
                    println!("[AI] Training job {} failed: {}", job_id, msg);
                    let _ = crate::ai_training::update_training_job_status(
                        &conn, job_id, "failed", None, Some(&msg),
                    );
                }
            }
            Ok(Err(e)) => {
                let msg = format!("Failed to wait for training process: {}", e);
                eprintln!("[AI] Training job {} — {}", job_id, msg);
                let _ = crate::ai_training::update_training_job_status(
                    &conn, job_id, "failed", None, Some(&msg),
                );
            }
            Err(e) => {
                let msg = format!("Training monitor task panicked: {}", e);
                eprintln!("[AI] Training job {} — {}", job_id, msg);
                let _ = crate::ai_training::update_training_job_status(
                    &conn, job_id, "failed", None, Some(&msg),
                );
            }
        }
    });
}

/// Check if all jobs in a sweep group are complete. If so, update the
/// auto-created ai_dataset from 'pending' to 'ready'.
/// If the sweep jobs have copy_to_path set, update the dataset's sweep_root
/// to point to the copy destination (since that's where the data lives long-term).
fn check_sweep_dataset_completion(conn: &rusqlite::Connection, sweep_group_id: &str) {
    // Count remaining active jobs in this sweep group
    let active_count = match crate::db::count_active_sweep_jobs(conn, sweep_group_id) {
        Ok(c) => c,
        Err(_) => return,
    };

    if active_count > 0 {
        return; // Still running jobs
    }

    // Check if there are any queued jobs left
    let queued: i64 = conn.query_row(
        "SELECT COUNT(*) FROM jobs WHERE sweep_group_id = ?1 AND status = 'queued'",
        rusqlite::params![sweep_group_id],
        |row| row.get(0),
    ).unwrap_or(1);

    if queued > 0 {
        return; // Still queued jobs
    }

    // All jobs are done (completed or failed).
    // Check if sweep jobs have a copy_to_path — if so, the dataset should point there
    let copy_to_path: Option<String> = conn.query_row(
        "SELECT copy_to_path FROM jobs WHERE sweep_group_id = ?1 AND copy_to_path IS NOT NULL AND copy_to_path != '' LIMIT 1",
        rusqlite::params![sweep_group_id],
        |row| row.get(0),
    ).ok();

    // If copy_to_path was set, the sweep root for the dataset should be updated
    // to the copy destination's parent (copy_to_path is per-case, the parent is the sweep root)
    if let Some(ref ctp) = copy_to_path {
        let copy_parent = std::path::Path::new(ctp)
            .parent()
            .map(|p| p.to_str().unwrap_or(""))
            .unwrap_or("");

        if !copy_parent.is_empty() {
            let _ = conn.execute(
                "UPDATE ai_datasets SET sweep_root = ?2, status = 'ready',
                 warnings_json = COALESCE(warnings_json, 'All sweep cases complete — dataset updated to copy destination'),
                 updated_at = datetime('now')
                 WHERE status = 'pending' AND config_json LIKE ?1",
                rusqlite::params![format!("%{}%", sweep_group_id), copy_parent],
            );
            println!("[SWEEP] All jobs in group {} complete — dataset updated to copy destination: {}", sweep_group_id, copy_parent);
            return;
        }
    }

    // No copy_to_path — just mark as ready with the original sweep_root
    let dataset_update = conn.execute(
        "UPDATE ai_datasets SET status = 'ready', warnings_json = COALESCE(warnings_json, 'All sweep cases complete'),
         updated_at = datetime('now')
         WHERE status = 'pending' AND config_json LIKE ?1",
        rusqlite::params![format!("%{}%", sweep_group_id)],
    );

    match dataset_update {
        Ok(n) if n > 0 => {
            println!("[SWEEP] All jobs in group {} complete — dataset marked as ready", sweep_group_id);
        }
        _ => {
            // No pending dataset found — that's OK if it was already marked or doesn't exist
        }
    }
}
