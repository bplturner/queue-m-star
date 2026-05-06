use std::fs::OpenOptions;
use std::path::Path;
use std::ffi::OsStr;
use std::process::Command;
use notify::{Watcher, RecursiveMode, Config as NotifyConfig};
use notify::PollWatcher;
use clap::Parser;
use std::sync::Arc;
use std::collections::HashMap;
use tokio::sync::Mutex as TokioMutex;
use tokio::fs as tokio_fs;
use tokio::time::{Duration, sleep};

pub mod config;
pub mod db;
pub mod api;
pub mod queue;
pub mod web_server;
pub mod gpu_info;
pub mod mstar_versions;

use crate::config::Config;
use crate::db::DbHandle;
use crate::api::{AppState, VersionList};

// ============================================================
// Shared Types
// ============================================================

#[derive(Clone, Debug)]
pub struct GpuInfo {
    pub name: String,
    pub utilization: f32,
    pub power_usage: f32,
    pub power_limit: f32,
    pub memory_used: u64,
    pub memory_total: u64,
    pub temperature: f32,
    /// True if nvidia-smi reports compute processes running on this GPU
    pub has_compute_processes: bool,
}

#[derive(Parser, Debug)]
#[clap(author, version, about = "M-Star CFD Queue Manager", long_about = None)]
struct Args {
    /// Suppress console output
    #[clap(short, long)]
    quiet: bool,

    /// Enable the web server
    #[clap(long, default_value = "true")]
    enable_web_server: bool,
}

// ============================================================
// Main Entry Point
// ============================================================

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    println!("===========================================");
    println!("  M-Star Queue - Job Management System");
    println!("===========================================");

    // Load and validate configuration
    let config = Config::load().expect("Failed to load configuration");
    config.validate().expect("Invalid configuration");
    println!("[INIT] Configuration loaded from config.toml");

    // Parse command line arguments
    let args = Args::parse();
    let _verbose = !args.quiet;

    // Initialize database
    println!("[INIT] Initializing database at: {}", config.paths.database_file.display());
    let db: DbHandle = db::init_db(&config.paths.database_file)
        .expect("Failed to initialize database");

    // Ensure default admin user exists
    {
        let conn = db.lock().await;
        db::ensure_default_admin(&conn)
            .expect("Failed to create default admin");
    }

    // Discover M-Star versions
    println!("[INIT] Scanning for M-Star versions at: {}", config.paths.mstar_install_dir.display());
    let discovered_versions = mstar_versions::discover_versions(&config.paths.mstar_install_dir);
    println!("[INIT] Found {} M-Star versions", discovered_versions.len());
    for v in &discovered_versions {
        println!("  - {} {}", v.version, if v.is_latest { "(latest)" } else { "" });
    }
    let versions: VersionList = Arc::new(TokioMutex::new(discovered_versions));

    // Initialize log file
    let log_file = Arc::new(TokioMutex::new(OpenOptions::new()
        .create(true)
        .append(true)
        .open(&config.paths.log_file)?));

    // Create shared application state
    let app_state = AppState {
        db: db.clone(),
        versions: versions.clone(),
        config: config.clone(),
    };

    // Ensure jobs directory exists
    tokio_fs::create_dir_all(&config.paths.jobs_directory).await?;
    println!("[INIT] Jobs directory: {}", config.paths.jobs_directory.display());

    // Start the queue manager (background task)
    {
        let db_clone = db.clone();
        let versions_clone = versions.clone();
        let config_clone = config.clone();
        tokio::spawn(async move {
            queue::run_queue_manager(db_clone, versions_clone, config_clone).await;
        });
        println!("[INIT] Queue manager started (polling every {}s, max {} concurrent jobs)",
            config.queue.poll_interval_secs, config.queue.max_concurrent_jobs);
    }

    // Start GPU metrics logger (1-second snapshots)
    {
        let log_path = config.paths.gpu_metrics_log.clone();
        tokio::spawn(async move {
            gpu_metrics_logger(log_path).await;
        });
        println!("[INIT] GPU metrics logger started (1s interval) → {}", config.paths.gpu_metrics_log.display());
    }

    // Start the web server
    if args.enable_web_server {
        let state_clone = app_state.clone();
        let web_config = config.web_server.clone();
        tokio::spawn(async move {
            run_web_server(state_clone, &web_config).await;
        });
        println!("[INIT] Web server started on port {}", config.web_server.port);
    }

    // Start file watcher for legacy network queue intake
    let queue_dir = config.paths.queue_directory.clone();
    if queue_dir.exists() {
        println!("[INIT] Watching {} for .MSB files (file watcher intake)", queue_dir.display());

        let db_clone = db.clone();
        let config_clone = config.clone();
        let _log_file_clone = log_file.clone();

        let (tx, mut rx) = tokio::sync::mpsc::channel(100);

        let mut watcher = PollWatcher::new(
            move |res| { let _ = tx.blocking_send(res); },
            NotifyConfig::default()
                .with_poll_interval(std::time::Duration::from_secs(2))
                .with_compare_contents(true),
        )?;
        watcher.watch(&queue_dir, RecursiveMode::NonRecursive)?;

        tokio::spawn(async move {
            while let Some(event) = rx.recv().await {
                if let Ok(notify::Event { kind: notify::EventKind::Create(_), paths, .. }) = event {
                    for path in paths {
                        if is_msb_file(&path) {
                            println!("[WATCHER] Detected new .MSB file: {:?}", path);

                            // Wait a moment for the file to finish copying
                            sleep(Duration::from_secs(3)).await;

                            match queue::create_job_from_file_watcher(
                                &db_clone, &config_clone, &path
                            ).await {
                                Ok(job_id) => {
                                    println!("[WATCHER] Created job {} from {:?}", job_id, path);
                                }
                                Err(e) => {
                                    eprintln!("[WATCHER] Failed to create job from {:?}: {}", path, e);
                                }
                            }
                        }
                    }
                }
            }
        });

        // Keep watcher alive
        std::mem::forget(watcher);
    } else {
        println!("[INIT] Queue directory {} does not exist, file watcher disabled", queue_dir.display());
    }

    println!("[INIT] M-Star Queue is ready!");
    println!("[INIT] Web UI: http://localhost:{}/", config.web_server.port);

    // Notify systemd that the service is fully initialized and ready.
    // Required for Type=notify services — systemd waits for this before considering
    // the service "active". Also enables the watchdog timer.
    let _ = sd_notify::notify(false, &[sd_notify::NotifyState::Ready]);

    // Keep the main task alive
    tokio::signal::ctrl_c().await?;
    println!("\n[SHUTDOWN] Received Ctrl+C, shutting down...");
    Ok(())
}

// ============================================================
// Web Server (combining API + static files)
// ============================================================

async fn run_web_server(state: AppState, web_config: &config::WebServerConfig) {
    use warp::Filter;

    let port = web_config.port;

    // API routes
    let api = api::api_routes(state.clone());

    // Job submission route (create job + upload in one step via JSON body)
    let submit_job = warp::path("api").and(warp::path("jobs")).and(warp::path("submit"))
        .and(warp::post())
        .and(warp::header::optional::<String>("authorization"))
        .and(warp::body::content_length_limit(500 * 1024 * 1024))
        .and(warp::body::bytes())
        .and(warp::query::<HashMap<String, String>>())
        .and(warp::any().map(move || state.clone()))
        .and_then(handle_full_job_submit);

    // Serve the SPA index.html for all non-API, non-static routes
    let index = warp::get()
        .and(warp::path::tail())
        .and(warp::fs::file("./static/index.html"))
        .map(|_tail: warp::path::Tail, file| file);

    // Static file serving
    let static_files = warp::path("static").and(warp::fs::dir("./static"));

    let routes = submit_job.or(api).or(static_files).or(index)
        .with(warp::cors()
            .allow_any_origin()
            .allow_methods(vec!["GET", "POST", "DELETE", "OPTIONS"])
            .allow_headers(vec!["authorization", "content-type"])
        );

    warp::serve(routes)
        .run(([0, 0, 0, 0], port))
        .await;
}

/// Handle a full job submission: metadata via query params + MSB file as body
async fn handle_full_job_submit(
    auth: Option<String>,
    file_data: bytes::Bytes,
    params: HashMap<String, String>,
    state: AppState,
) -> Result<impl warp::Reply, warp::Rejection> {
    // Authenticate
    let token = match auth.and_then(|h| {
        if h.starts_with("Bearer ") { Some(h[7..].to_string()) } else { Some(h) }
    }) {
        Some(t) => t,
        None => return Ok(warp::reply::with_status(
            warp::reply::json(&serde_json::json!({"error": "Not authenticated"})),
            warp::http::StatusCode::UNAUTHORIZED,
        )),
    };

    let db = state.db.lock().await;
    let user = match db::validate_session(&db, &token) {
        Ok(u) => u,
        Err(e) => return Ok(warp::reply::with_status(
            warp::reply::json(&serde_json::json!({"error": e})),
            warp::http::StatusCode::UNAUTHORIZED,
        )),
    };

    // Extract params
    let msb_source_path = params.get("msb_source_path").cloned();
    let filename = if let Some(ref src) = msb_source_path {
        // Remote file: extract filename from the server path
        std::path::Path::new(src)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("remote.msb")
            .to_string()
    } else {
        params.get("filename").cloned().unwrap_or_else(|| "upload.msb".to_string())
    };
    let name = params.get("name").cloned().unwrap_or_else(|| {
        filename.trim_end_matches(".msb").trim_end_matches(".MSB").to_string()
    });
    let version = params.get("version").cloned().unwrap_or_else(|| "latest".to_string());
    let gpu_ids_str = params.get("gpu_ids").cloned().unwrap_or_else(|| "[0]".to_string());
    let unified_memory = params.get("unified_memory").map(|v| v == "true" || v == "1").unwrap_or(false);
    let priority = params.get("priority").and_then(|p| p.parse::<i32>().ok()).unwrap_or(0);
    let copy_to = params.get("copy_to").cloned();

    // SECURITY: Validate copy_to path resolves under the configured data_root
    let data_root = state.config.paths.data_root.to_str().unwrap_or("/");
    if let Some(ref ctp) = copy_to {
        let requested = std::path::Path::new(ctp);
        // If the directory already exists, canonicalize it directly
        // Otherwise canonicalize the nearest existing parent
        let check_path = if requested.exists() {
            std::fs::canonicalize(requested).ok()
        } else if let Some(parent) = requested.parent() {
            if parent.exists() {
                std::fs::canonicalize(parent).ok()
            } else {
                // Parent doesn't exist yet — just do a string-level check as a baseline
                Some(std::path::PathBuf::from(ctp))
            }
        } else {
            None
        };
        match check_path {
            Some(resolved) if resolved.starts_with(data_root) => {},
            Some(_) => return Ok(warp::reply::with_status(
                warp::reply::json(&serde_json::json!({"error": format!("copy_to path must resolve under {}", data_root)})),
                warp::http::StatusCode::BAD_REQUEST,
            )),
            None => return Ok(warp::reply::with_status(
                warp::reply::json(&serde_json::json!({"error": "copy_to path is invalid"})),
                warp::http::StatusCode::BAD_REQUEST,
            )),
        }
    }

    // SECURITY: Validate msb_source_path exists and resolves under the configured data_root
    if let Some(ref src) = msb_source_path {
        let canonical = match std::fs::canonicalize(src) {
            Ok(p) => p,
            Err(_) => return Ok(warp::reply::with_status(
                warp::reply::json(&serde_json::json!({"error": format!("File not found: {}", src)})),
                warp::http::StatusCode::BAD_REQUEST,
            )),
        };
        if !canonical.starts_with(data_root) {
            return Ok(warp::reply::with_status(
                warp::reply::json(&serde_json::json!({"error": format!("msb_source_path must resolve under {}", data_root)})),
                warp::http::StatusCode::BAD_REQUEST,
            ));
        }
    }

    // Create job in DB
    let job_id = match db::create_job(&db, user.id, &name, &filename, &version, &gpu_ids_str, unified_memory, priority, copy_to.as_deref()) {
        Ok(id) => id,
        Err(e) => return Ok(warp::reply::with_status(
            warp::reply::json(&serde_json::json!({"error": e})),
            warp::http::StatusCode::INTERNAL_SERVER_ERROR,
        )),
    };
    drop(db); // Release lock before file I/O

    // Create job directory
    let job_dir = state.config.paths.jobs_directory.join(format!("job_{}", job_id));
    if let Err(e) = tokio::fs::create_dir_all(&job_dir).await {
        return Ok(warp::reply::with_status(
            warp::reply::json(&serde_json::json!({"error": format!("Failed to create directory: {}", e)})),
            warp::http::StatusCode::INTERNAL_SERVER_ERROR,
        ));
    }

    // Get MSB file into job directory
    let msb_path = job_dir.join(&filename);
    if let Some(ref src) = msb_source_path {
        // Copy from server filesystem
        if let Err(e) = tokio::fs::copy(src, &msb_path).await {
            return Ok(warp::reply::with_status(
                warp::reply::json(&serde_json::json!({"error": format!("Failed to copy MSB from server: {}", e)})),
                warp::http::StatusCode::INTERNAL_SERVER_ERROR,
            ));
        }
        println!("[SUBMIT] Job {} using server file: {}", job_id, src);
    } else {
        // Write uploaded file data
        if let Err(e) = tokio::fs::write(&msb_path, &file_data).await {
            return Ok(warp::reply::with_status(
                warp::reply::json(&serde_json::json!({"error": format!("Failed to write file: {}", e)})),
                warp::http::StatusCode::INTERNAL_SERVER_ERROR,
            ));
        }
    }

    // Update working directory in DB
    {
        let db = state.db.lock().await;
        let _ = db.execute(
            "UPDATE jobs SET working_directory = ?2 WHERE id = ?1",
            rusqlite::params![job_id, job_dir.to_str().unwrap_or("")],
        );
    }

    println!("[SUBMIT] Job {} created by {} ({}): version={}, gpus={}, unified_memory={}, copy_to={:?}",
        job_id, user.username, filename, version, gpu_ids_str, unified_memory, copy_to);

    Ok(warp::reply::with_status(
        warp::reply::json(&serde_json::json!({
            "message": "Job submitted successfully",
            "job_id": job_id,
            "name": name,
            "version": version,
            "gpu_ids": gpu_ids_str,
            "unified_memory": unified_memory,
            "copy_to": copy_to,
        })),
        warp::http::StatusCode::OK,
    ))
}

// ============================================================
// Utilities
// ============================================================

fn is_msb_file(path: &Path) -> bool {
    path.extension()
        .and_then(OsStr::to_str)
        .map(|ext| ext.eq_ignore_ascii_case("msb"))
        .unwrap_or(false)
}

pub fn get_gpu_info() -> Result<Vec<GpuInfo>, Box<dyn std::error::Error + Send + Sync>> {
    let output = Command::new("nvidia-smi")
        .args(&["--query-gpu=name,utilization.gpu,power.draw,power.limit,memory.used,memory.total,temperature.gpu",
                "--format=csv,noheader,nounits"])
        .output()?;
    let output_str = String::from_utf8(output.stdout)?;

    let mut gpu_info = Vec::new();
    for line in output_str.lines() {
        let values: Vec<&str> = line.split(',').map(str::trim).collect();
        if values.len() == 7 {
            gpu_info.push(GpuInfo {
                name: values[0].to_string(),
                utilization: values[1].parse().unwrap_or(0.0),
                power_usage: values[2].parse().unwrap_or(0.0),
                power_limit: values[3].parse().unwrap_or(0.0),
                memory_used: values[4].parse().unwrap_or(0),
                memory_total: values[5].parse().unwrap_or(0),
                temperature: values[6].parse().unwrap_or(0.0),
                has_compute_processes: false, // will be set below
            });
        }
    }

    if gpu_info.is_empty() {
        return Err("No GPUs found".into());
    }

    // Query for active compute processes to detect external workloads
    // nvidia-smi --query-compute-apps=gpu_uuid,pid,process_name --format=csv,noheader
    // We use gpu_bus_id instead since it maps to index order
    if let Ok(proc_output) = Command::new("nvidia-smi")
        .args(&["--query-compute-apps=gpu_bus_id,pid,process_name",
                "--format=csv,noheader"])
        .output()
    {
        if let Ok(proc_str) = String::from_utf8(proc_output.stdout) {
            // Get index→bus_id mapping
            let bus_ids = get_gpu_bus_ids();
            
            for line in proc_str.lines() {
                let parts: Vec<&str> = line.split(',').map(str::trim).collect();
                if parts.len() >= 2 {
                    let bus_id = parts[0].to_uppercase();
                    // Find which GPU index this bus_id maps to
                    if let Some(idx) = bus_ids.iter().position(|b| b.to_uppercase() == bus_id) {
                        if idx < gpu_info.len() {
                            gpu_info[idx].has_compute_processes = true;
                        }
                    }
                }
            }
        }
    }

    Ok(gpu_info)
}

/// Get PCI bus IDs in GPU index order (for mapping process queries to GPU indices)
fn get_gpu_bus_ids() -> Vec<String> {
    Command::new("nvidia-smi")
        .args(&["--query-gpu=pci.bus_id", "--format=csv,noheader"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.lines().map(|l| l.trim().to_string()).collect())
        .unwrap_or_default()
}

// ============================================================
// GPU Metrics Logger (1-second snapshots)
// ============================================================

/// Background task that polls nvidia-smi every 1 second and appends
/// utilization, memory, power, and temperature metrics to a CSV log.
/// The log auto-rotates when it exceeds ~50 MB.
async fn gpu_metrics_logger(log_path: std::path::PathBuf) {
    use std::io::Write;
    use chrono::Utc;

    let max_size: u64 = 50 * 1024 * 1024; // 50 MB rotation threshold

    loop {
        if let Ok(gpu_info) = get_gpu_info() {
            let timestamp = Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();

            // Check if file needs header or rotation
            let needs_header = !log_path.exists() || std::fs::metadata(&log_path)
                .map(|m| m.len() == 0).unwrap_or(true);

            // Rotate if too large
            if log_path.exists() {
                if let Ok(meta) = std::fs::metadata(&log_path) {
                    if meta.len() > max_size {
                        let rotated = log_path.with_extension("log.old");
                        let _ = std::fs::rename(&log_path, &rotated);
                    }
                }
            }

            if let Ok(mut file) = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&log_path)
            {
                // Write header if new file
                if needs_header || std::fs::metadata(&log_path).map(|m| m.len() == 0).unwrap_or(true) {
                    let _ = writeln!(file, "timestamp,gpu_id,utilization,memory_used,memory_total,power_usage,power_limit,temperature");
                }

                for (i, info) in gpu_info.iter().enumerate() {
                    let _ = writeln!(
                        file,
                        "{},{},{:.1},{},{},{:.1},{:.1},{:.0}",
                        timestamp, i,
                        info.utilization,
                        info.memory_used, info.memory_total,
                        info.power_usage, info.power_limit,
                        info.temperature
                    );
                }
            }
        }

        sleep(Duration::from_secs(1)).await;
    }
}
