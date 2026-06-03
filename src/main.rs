#![recursion_limit = "512"]
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
pub mod ai_training;

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

/// System-level CPU and memory information
#[derive(Clone, Debug, serde::Serialize)]
pub struct SystemInfo {
    /// Number of logical CPU cores
    pub cpu_cores: usize,
    /// Overall CPU utilization percentage (0–100)
    pub cpu_percent: f32,
    /// Per-core utilization percentages
    pub cpu_per_core: Vec<f32>,
    /// Total physical RAM in MB
    pub memory_total_mb: u64,
    /// Used RAM in MB (total - available)
    pub memory_used_mb: u64,
    /// Available RAM in MB
    pub memory_available_mb: u64,
    /// Memory utilization percentage
    pub memory_percent: f32,
    /// System load averages (1, 5, 15 min)
    pub load_avg: [f32; 3],
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

fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Build a custom tokio runtime with larger worker thread stacks.
    // Warp's deeply nested Or<> route chain requires more stack than the
    // default 2 MB when matching 50+ routes.
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_stack_size(8 * 1024 * 1024) // 8 MB
        .build()
        .expect("Failed to build tokio runtime");
    runtime.block_on(async_main())
}

async fn async_main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
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
    // The filter rejects paths starting with "api/" to avoid catching API GET routes.
    let spa_guard = warp::get()
        .and(warp::path::full())
        .and_then(|full_path: warp::path::FullPath| async move {
            let path = full_path.as_str();
            if path.starts_with("/api/") || path.starts_with("/static/") {
                Err(warp::reject::not_found())
            } else {
                Ok(())
            }
        })
        .untuple_one();

    let index = spa_guard
        .and(warp::fs::file("./static/index.html"));

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
    let msb_url = params.get("msb_url").cloned();
    let filename = if let Some(ref src) = msb_source_path {
        // Remote file: extract filename from the server path
        std::path::Path::new(src)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("remote.msb")
            .to_string()
    } else if let Some(ref url) = msb_url {
        // URL: extract filename from URL path
        url.split('/').last()
            .and_then(|s| s.split('?').next())
            .filter(|s| !s.is_empty())
            .unwrap_or("remote.msb")
            .to_string()
    } else {
        params.get("filename").cloned().unwrap_or_else(|| "upload.msb".to_string())
    };
    let name = params.get("name").filter(|n| !n.is_empty()).cloned().unwrap_or_else(|| {
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

    // ----------------------------------------------------------------
    // PHASE 1: Download/prepare MSB file into a temp staging directory
    // We do this BEFORE creating the job in DB to avoid a race condition
    // where the queue picks up the job before the file is ready.
    // ----------------------------------------------------------------
    drop(db); // Release lock before file I/O
    let staging_dir = state.config.paths.jobs_directory.join("_staging_temp");
    let _ = tokio::fs::create_dir_all(&staging_dir).await;
    let staging_id = format!("{}_{}", chrono::Utc::now().timestamp_millis(), user.id);
    let staging_subdir = staging_dir.join(&staging_id);
    if let Err(e) = tokio::fs::create_dir_all(&staging_subdir).await {
        return Ok(warp::reply::with_status(
            warp::reply::json(&serde_json::json!({"error": format!("Failed to create staging dir: {}", e)})),
            warp::http::StatusCode::INTERNAL_SERVER_ERROR,
        ));
    }

    // Track the final filename (may be updated by Content-Disposition)
    let mut final_filename = filename.clone();
    let mut final_name = name.clone();

    if let Some(ref src) = msb_source_path {
        let dest = staging_subdir.join(&final_filename);
        if let Err(e) = tokio::fs::copy(src, &dest).await {
            let _ = tokio::fs::remove_dir_all(&staging_subdir).await;
            return Ok(warp::reply::with_status(
                warp::reply::json(&serde_json::json!({"error": format!("Failed to copy MSB from server: {}", e)})),
                warp::http::StatusCode::INTERNAL_SERVER_ERROR,
            ));
        }
        println!("[SUBMIT] Using server file: {}", src);
    } else if let Some(ref url) = msb_url {
        println!("[SUBMIT] Downloading MSB from URL: {}", url);

        let parsed_url = match url::Url::parse(url) {
            Ok(u) => u,
            Err(_) => {
                let _ = tokio::fs::remove_dir_all(&staging_subdir).await;
                return Ok(warp::reply::with_status(
                    warp::reply::json(&serde_json::json!({"error": "Invalid URL format"})),
                    warp::http::StatusCode::BAD_REQUEST,
                ));
            }
        };

        match parsed_url.scheme() {
            "http" | "https" => {},
            other => {
                let _ = tokio::fs::remove_dir_all(&staging_subdir).await;
                return Ok(warp::reply::with_status(
                    warp::reply::json(&serde_json::json!({"error": format!("Unsupported URL scheme '{}'. Only http and https are allowed.", other)})),
                    warp::http::StatusCode::BAD_REQUEST,
                ));
            }
        }

        let host = match parsed_url.host_str() {
            Some(h) => h.to_string(),
            None => {
                let _ = tokio::fs::remove_dir_all(&staging_subdir).await;
                return Ok(warp::reply::with_status(
                    warp::reply::json(&serde_json::json!({"error": "URL has no host"})),
                    warp::http::StatusCode::BAD_REQUEST,
                ));
            }
        };
        let port = parsed_url.port().unwrap_or(if parsed_url.scheme() == "https" { 443 } else { 80 });
        let lookup_addr = format!("{}:{}", host, port);
        match tokio::net::lookup_host(&lookup_addr).await {
            Ok(addrs) => {
                for addr in addrs {
                    let ip = addr.ip();
                    if ip.is_loopback() || is_private_ip(&ip) || is_link_local_ip(&ip) {
                        let _ = tokio::fs::remove_dir_all(&staging_subdir).await;
                        return Ok(warp::reply::with_status(
                            warp::reply::json(&serde_json::json!({"error": "URL must not resolve to a private or loopback address"})),
                            warp::http::StatusCode::BAD_REQUEST,
                        ));
                    }
                }
            }
            Err(_) => {
                let _ = tokio::fs::remove_dir_all(&staging_subdir).await;
                return Ok(warp::reply::with_status(
                    warp::reply::json(&serde_json::json!({"error": "Failed to resolve URL host"})),
                    warp::http::StatusCode::BAD_REQUEST,
                ));
            }
        }

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .redirect(reqwest::redirect::Policy::limited(5))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());

        let max_download_size = (state.config.file_handling.max_file_size_mb as u64) * 1024 * 1024;

        match client.get(url.as_str()).send().await {
            Ok(resp) => {
                if !resp.status().is_success() {
                    let _ = tokio::fs::remove_dir_all(&staging_subdir).await;
                    return Ok(warp::reply::with_status(
                        warp::reply::json(&serde_json::json!({"error": format!("URL returned HTTP {}", resp.status())})),
                        warp::http::StatusCode::BAD_REQUEST,
                    ));
                }

                // Extract filename from Content-Disposition header
                let cd_filename = resp.headers()
                    .get("content-disposition")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|cd| {
                        cd.split(';')
                            .map(str::trim)
                            .find(|part| part.to_lowercase().starts_with("filename="))
                            .map(|part| {
                                part.splitn(2, '=').nth(1).unwrap_or("")
                                    .trim_matches('"').trim_matches('\'')
                                    .to_string()
                            })
                            .filter(|f| !f.is_empty())
                    });

                let url_path = parsed_url.path().to_lowercase();
                let cd_has_msb = cd_filename.as_ref()
                    .map(|f| f.to_lowercase().ends_with(".msb"))
                    .unwrap_or(false);

                if !cd_has_msb && !url_path.ends_with(".msb") {
                    let _ = tokio::fs::remove_dir_all(&staging_subdir).await;
                    return Ok(warp::reply::with_status(
                        warp::reply::json(&serde_json::json!({"error": "URL must serve an .msb file (checked URL path and Content-Disposition header)"})),
                        warp::http::StatusCode::BAD_REQUEST,
                    ));
                }

                // Use Content-Disposition filename if available
                if cd_has_msb {
                    let cd_name = cd_filename.as_ref().unwrap();
                    final_filename = cd_name.clone();
                    let real_name = cd_name.trim_end_matches(".msb").trim_end_matches(".MSB");
                    // Only override name if it was auto-derived (not user-specified)
                    if final_name == name {
                        final_name = real_name.to_string();
                    }
                    println!("[SUBMIT] Filename from Content-Disposition: {}", cd_name);
                }

                if let Some(cl) = resp.content_length() {
                    if cl > max_download_size {
                        let _ = tokio::fs::remove_dir_all(&staging_subdir).await;
                        return Ok(warp::reply::with_status(
                            warp::reply::json(&serde_json::json!({"error": format!("Remote file too large ({} MB). Max is {} MB.", cl / (1024*1024), state.config.file_handling.max_file_size_mb)})),
                            warp::http::StatusCode::BAD_REQUEST,
                        ));
                    }
                }

                match resp.bytes().await {
                    Ok(data) => {
                        if data.len() as u64 > max_download_size {
                            let _ = tokio::fs::remove_dir_all(&staging_subdir).await;
                            return Ok(warp::reply::with_status(
                                warp::reply::json(&serde_json::json!({"error": format!("Downloaded file too large ({} MB). Max is {} MB.", data.len() / (1024*1024), state.config.file_handling.max_file_size_mb)})),
                                warp::http::StatusCode::BAD_REQUEST,
                            ));
                        }
                        if data.is_empty() {
                            let _ = tokio::fs::remove_dir_all(&staging_subdir).await;
                            return Ok(warp::reply::with_status(
                                warp::reply::json(&serde_json::json!({"error": "Downloaded file is empty (0 bytes)"})),
                                warp::http::StatusCode::BAD_REQUEST,
                            ));
                        }
                        let dest = staging_subdir.join(&final_filename);
                        if let Err(e) = tokio::fs::write(&dest, &data).await {
                            let _ = tokio::fs::remove_dir_all(&staging_subdir).await;
                            return Ok(warp::reply::with_status(
                                warp::reply::json(&serde_json::json!({"error": format!("Failed to write downloaded file: {}", e)})),
                                warp::http::StatusCode::INTERNAL_SERVER_ERROR,
                            ));
                        }
                        println!("[SUBMIT] Downloaded {} bytes from URL", data.len());
                    }
                    Err(e) => {
                        let _ = tokio::fs::remove_dir_all(&staging_subdir).await;
                        return Ok(warp::reply::with_status(
                            warp::reply::json(&serde_json::json!({"error": format!("Failed to read URL response: {}", e)})),
                            warp::http::StatusCode::BAD_REQUEST,
                        ));
                    }
                }
            }
            Err(e) => {
                let _ = tokio::fs::remove_dir_all(&staging_subdir).await;
                return Ok(warp::reply::with_status(
                    warp::reply::json(&serde_json::json!({"error": format!("Failed to fetch URL: {}", e)})),
                    warp::http::StatusCode::BAD_REQUEST,
                ));
            }
        }
    } else {
        // Write uploaded file data
        let dest = staging_subdir.join(&final_filename);
        if let Err(e) = tokio::fs::write(&dest, &file_data).await {
            let _ = tokio::fs::remove_dir_all(&staging_subdir).await;
            return Ok(warp::reply::with_status(
                warp::reply::json(&serde_json::json!({"error": format!("Failed to write file: {}", e)})),
                warp::http::StatusCode::INTERNAL_SERVER_ERROR,
            ));
        }
    }

    // Validate the staged file exists and is non-empty
    let staged_msb = staging_subdir.join(&final_filename);
    match tokio::fs::metadata(&staged_msb).await {
        Ok(meta) if meta.len() == 0 => {
            let _ = tokio::fs::remove_dir_all(&staging_subdir).await;
            return Ok(warp::reply::with_status(
                warp::reply::json(&serde_json::json!({"error": "MSB file is empty (0 bytes). The upload or download may have failed."})),
                warp::http::StatusCode::BAD_REQUEST,
            ));
        }
        Err(_) => {
            let _ = tokio::fs::remove_dir_all(&staging_subdir).await;
            return Ok(warp::reply::with_status(
                warp::reply::json(&serde_json::json!({"error": "No MSB file was written. The upload or download may have failed."})),
                warp::http::StatusCode::BAD_REQUEST,
            ));
        }
        _ => {}
    }

    // ----------------------------------------------------------------
    // PHASE 2: File is ready — create the job in DB and move files
    // ----------------------------------------------------------------
    let job_id = {
        let db = state.db.lock().await;
        match db::create_job(&db, user.id, &final_name, &final_filename, &version, &gpu_ids_str, unified_memory, priority, copy_to.as_deref()) {
            Ok(id) => id,
            Err(e) => {
                let _ = tokio::fs::remove_dir_all(&staging_subdir).await;
                return Ok(warp::reply::with_status(
                    warp::reply::json(&serde_json::json!({"error": e})),
                    warp::http::StatusCode::INTERNAL_SERVER_ERROR,
                ));
            }
        }
    };

    // Move staging dir to final job dir
    let job_dir = state.config.paths.jobs_directory.join(format!("job_{}", job_id));
    if let Err(_) = tokio::fs::rename(&staging_subdir, &job_dir).await {
        // Fallback: copy + remove if rename fails (cross-device)
        let _ = tokio::fs::create_dir_all(&job_dir).await;
        let src_file = staging_subdir.join(&final_filename);
        let dst_file = job_dir.join(&final_filename);
        if let Err(e) = tokio::fs::copy(&src_file, &dst_file).await {
            let _ = tokio::fs::remove_dir_all(&staging_subdir).await;
            return Ok(warp::reply::with_status(
                warp::reply::json(&serde_json::json!({"error": format!("Failed to move MSB to job dir: {}", e)})),
                warp::http::StatusCode::INTERNAL_SERVER_ERROR,
            ));
        }
        let _ = tokio::fs::remove_dir_all(&staging_subdir).await;
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
        job_id, user.username, final_filename, version, gpu_ids_str, unified_memory, copy_to);

    Ok(warp::reply::with_status(
        warp::reply::json(&serde_json::json!({
            "message": "Job submitted successfully",
            "job_id": job_id,
            "name": final_name,
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

/// SECURITY: Check if an IP address is in a private range (RFC 1918 / RFC 4193)
fn is_private_ip(ip: &std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            let octets = v4.octets();
            // 10.0.0.0/8
            octets[0] == 10
            // 172.16.0.0/12
            || (octets[0] == 172 && (octets[1] & 0xf0) == 16)
            // 192.168.0.0/16
            || (octets[0] == 192 && octets[1] == 168)
            // 169.254.169.254 — cloud metadata endpoint
            || (octets[0] == 169 && octets[1] == 254 && octets[2] == 169 && octets[3] == 254)
        }
        std::net::IpAddr::V6(v6) => {
            // fc00::/7 (Unique Local Addresses)
            let segments = v6.segments();
            (segments[0] & 0xfe00) == 0xfc00
        }
    }
}

/// SECURITY: Check if an IP address is link-local
fn is_link_local_ip(ip: &std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            let octets = v4.octets();
            // 169.254.0.0/16
            octets[0] == 169 && octets[1] == 254
        }
        std::net::IpAddr::V6(v6) => {
            let segments = v6.segments();
            // fe80::/10
            (segments[0] & 0xffc0) == 0xfe80
        }
    }
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

/// Read CPU times from /proc/stat. Returns (overall, per-core) tuples of (user+nice+system, total).
fn read_cpu_times() -> Option<((u64, u64), Vec<(u64, u64)>)> {
    let content = std::fs::read_to_string("/proc/stat").ok()?;
    let mut overall = None;
    let mut cores = Vec::new();

    for line in content.lines() {
        if line.starts_with("cpu") {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() < 8 { continue; }
            // fields: user, nice, system, idle, iowait, irq, softirq, [steal]
            let user: u64 = parts[1].parse().unwrap_or(0);
            let nice: u64 = parts[2].parse().unwrap_or(0);
            let system: u64 = parts[3].parse().unwrap_or(0);
            let idle: u64 = parts[4].parse().unwrap_or(0);
            let iowait: u64 = parts[5].parse().unwrap_or(0);
            let irq: u64 = parts[6].parse().unwrap_or(0);
            let softirq: u64 = parts[7].parse().unwrap_or(0);
            let steal: u64 = parts.get(8).and_then(|v| v.parse().ok()).unwrap_or(0);

            let busy = user + nice + system + irq + softirq + steal;
            let total = busy + idle + iowait;

            if parts[0] == "cpu" {
                overall = Some((busy, total));
            } else {
                cores.push((busy, total));
            }
        }
    }

    overall.map(|o| (o, cores))
}

/// Get system CPU and memory information.
/// CPU utilization is computed as a delta over ~200ms for accuracy.
pub fn get_system_info() -> Result<SystemInfo, Box<dyn std::error::Error + Send + Sync>> {
    // --- CPU: two-sample delta ---
    let t1 = read_cpu_times().ok_or("Failed to read /proc/stat")?;
    std::thread::sleep(std::time::Duration::from_millis(200));
    let t2 = read_cpu_times().ok_or("Failed to read /proc/stat")?;

    let cpu_percent = {
        let d_busy = t2.0 .0.saturating_sub(t1.0 .0) as f32;
        let d_total = t2.0 .1.saturating_sub(t1.0 .1) as f32;
        if d_total > 0.0 { (d_busy / d_total) * 100.0 } else { 0.0 }
    };

    let cpu_per_core: Vec<f32> = t1.1.iter().zip(t2.1.iter()).map(|(a, b)| {
        let d_busy = b.0.saturating_sub(a.0) as f32;
        let d_total = b.1.saturating_sub(a.1) as f32;
        if d_total > 0.0 { (d_busy / d_total) * 100.0 } else { 0.0 }
    }).collect();

    let cpu_cores = cpu_per_core.len();

    // --- Memory from /proc/meminfo ---
    let meminfo = std::fs::read_to_string("/proc/meminfo")?;
    let mut mem_total_kb: u64 = 0;
    let mut mem_available_kb: u64 = 0;

    for line in meminfo.lines() {
        if line.starts_with("MemTotal:") {
            mem_total_kb = line.split_whitespace().nth(1).and_then(|v| v.parse().ok()).unwrap_or(0);
        } else if line.starts_with("MemAvailable:") {
            mem_available_kb = line.split_whitespace().nth(1).and_then(|v| v.parse().ok()).unwrap_or(0);
        }
    }

    let memory_total_mb = mem_total_kb / 1024;
    let memory_available_mb = mem_available_kb / 1024;
    let memory_used_mb = memory_total_mb.saturating_sub(memory_available_mb);
    let memory_percent = if memory_total_mb > 0 {
        (memory_used_mb as f32 / memory_total_mb as f32) * 100.0
    } else { 0.0 };

    // --- Load averages from /proc/loadavg ---
    let load_avg = std::fs::read_to_string("/proc/loadavg")
        .ok()
        .and_then(|s| {
            let parts: Vec<&str> = s.split_whitespace().collect();
            if parts.len() >= 3 {
                Some([
                    parts[0].parse::<f32>().unwrap_or(0.0),
                    parts[1].parse::<f32>().unwrap_or(0.0),
                    parts[2].parse::<f32>().unwrap_or(0.0),
                ])
            } else { None }
        })
        .unwrap_or([0.0, 0.0, 0.0]);

    Ok(SystemInfo {
        cpu_cores,
        cpu_percent,
        cpu_per_core,
        memory_total_mb,
        memory_used_mb,
        memory_available_mb,
        memory_percent,
        load_avg,
    })
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
