use std::collections::HashMap;
use std::sync::Arc;
use warp::Filter;
use tokio::sync::Mutex;
use serde::{Deserialize, Serialize};
use crate::db::{self, DbHandle, User};
use crate::mstar_versions::{self, MstarVersion};
use crate::config::Config;

// ============================================================
// Request / Response types
// ============================================================

#[derive(Deserialize)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

#[derive(Deserialize)]
pub struct RegisterRequest {
    pub username: String,
    pub email: String,
    pub password: String,
}

#[derive(Serialize)]
pub struct AuthResponse {
    pub token: String,
    pub user: UserResponse,
}

#[derive(Serialize, Clone)]
pub struct UserResponse {
    pub id: i64,
    pub username: String,
    pub email: String,
    pub role: String,
}

impl From<User> for UserResponse {
    fn from(u: User) -> Self {
        UserResponse {
            id: u.id,
            username: u.username,
            email: u.email,
            role: u.role,
        }
    }
}

#[derive(Deserialize)]
pub struct CreateJobRequest {
    pub name: String,
    pub mstar_version: String,
    pub gpu_ids: Vec<i32>,
    pub unified_memory: Option<bool>,
    pub priority: Option<i32>,
}

#[derive(Serialize)]
pub struct GpuStatusResponse {
    pub index: usize,
    pub name: String,
    pub utilization: f32,
    pub power_usage: f32,
    pub power_limit: f32,
    pub memory_used: u64,
    pub memory_total: u64,
    pub memory_percent: f32,
    pub temperature: f32,
    pub running_job: Option<GpuJobInfo>,
    /// True if the GPU has active compute processes not tracked by our job system
    pub externally_busy: bool,
}

#[derive(Serialize)]
pub struct GpuJobInfo {
    pub job_id: i64,
    pub job_name: String,
    pub username: String,
}

#[derive(Serialize)]
pub struct VersionResponse {
    pub version: String,
    pub is_latest: bool,
    pub label: String,
}

#[derive(Serialize)]
pub struct ApiError {
    pub error: String,
}

#[derive(Serialize)]
pub struct ApiSuccess {
    pub message: String,
}

#[derive(Serialize)]
pub struct DashboardResponse {
    pub job_counts: HashMap<String, i64>,
    pub total_gpus: usize,
    pub active_gpus: usize,
    pub available_versions: usize,
}

// ============================================================
// Shared State
// ============================================================

pub type VersionList = Arc<Mutex<Vec<MstarVersion>>>;

/// Shared application state passed to all API handlers
#[derive(Clone)]
pub struct AppState {
    pub db: DbHandle,
    pub versions: VersionList,
    pub config: Config,
}

// ============================================================
// Helper functions
// ============================================================

fn json_error(msg: &str, code: warp::http::StatusCode) -> warp::reply::WithStatus<warp::reply::Json> {
    warp::reply::with_status(
        warp::reply::json(&ApiError { error: msg.to_string() }),
        code,
    )
}

fn json_ok<T: Serialize>(data: &T) -> warp::reply::WithStatus<warp::reply::Json> {
    warp::reply::with_status(
        warp::reply::json(data),
        warp::http::StatusCode::OK,
    )
}

/// Extract session token from Authorization header or cookie
fn extract_token(auth_header: Option<String>) -> Option<String> {
    auth_header.and_then(|h| {
        if h.starts_with("Bearer ") {
            Some(h[7..].to_string())
        } else {
            Some(h)
        }
    })
}

// ============================================================
// API Route Builders
// ============================================================

pub fn api_routes(
    state: AppState,
) -> impl Filter<Extract = (impl warp::Reply,), Error = warp::Rejection> + Clone {
    let api = warp::path("api");

    // Auth routes
    let auth_login = api.and(warp::path("auth")).and(warp::path("login"))
        .and(warp::post())
        .and(warp::body::json())
        .and(with_state(state.clone()))
        .and_then(handle_login);

    let auth_register = api.and(warp::path("auth")).and(warp::path("register"))
        .and(warp::post())
        .and(warp::body::json())
        .and(with_state(state.clone()))
        .and_then(handle_register);

    let auth_logout = api.and(warp::path("auth")).and(warp::path("logout"))
        .and(warp::post())
        .and(warp::header::optional::<String>("authorization"))
        .and(with_state(state.clone()))
        .and_then(handle_logout);

    let auth_me = api.and(warp::path("auth")).and(warp::path("me"))
        .and(warp::get())
        .and(warp::header::optional::<String>("authorization"))
        .and(with_state(state.clone()))
        .and_then(handle_me);

    // Job routes
    let jobs_list = api.and(warp::path("jobs")).and(warp::path::end())
        .and(warp::get())
        .and(warp::query::<HashMap<String, String>>())
        .and(warp::header::optional::<String>("authorization"))
        .and(with_state(state.clone()))
        .and_then(handle_list_jobs);

    let jobs_get = api.and(warp::path("jobs"))
        .and(warp::path::param::<i64>())
        .and(warp::path::end())
        .and(warp::get())
        .and(warp::header::optional::<String>("authorization"))
        .and(with_state(state.clone()))
        .and_then(handle_get_job);

    let jobs_submit = api.and(warp::path("jobs")).and(warp::path::end())
        .and(warp::post())
        .and(warp::header::optional::<String>("authorization"))
        .and(with_state(state.clone()))
        .and_then(handle_submit_job_metadata);

    let jobs_upload = api.and(warp::path("jobs"))
        .and(warp::path::param::<i64>())
        .and(warp::path("upload"))
        .and(warp::post())
        .and(warp::header::optional::<String>("authorization"))
        .and(warp::body::content_length_limit(500 * 1024 * 1024))
        .and(warp::body::bytes())
        .and(warp::query::<HashMap<String, String>>())
        .and(with_state(state.clone()))
        .and_then(|id: i64, auth: Option<String>, data: bytes::Bytes, params: HashMap<String, String>, state: AppState| {
            handle_upload_msb(id, auth, data, params, state)
        });

    let jobs_cancel = api.and(warp::path("jobs"))
        .and(warp::path::param::<i64>())
        .and(warp::path("cancel"))
        .and(warp::post())
        .and(warp::header::optional::<String>("authorization"))
        .and(with_state(state.clone()))
        .and_then(handle_cancel_job);

    let jobs_output = api.and(warp::path("jobs"))
        .and(warp::path::param::<i64>())
        .and(warp::path("output"))
        .and(warp::get())
        .and(warp::header::optional::<String>("authorization"))
        .and(warp::query::<HashMap<String, String>>())
        .and(with_state(state.clone()))
        .and_then(handle_job_output);

    let jobs_progress = api.and(warp::path("jobs"))
        .and(warp::path::param::<i64>())
        .and(warp::path("progress"))
        .and(warp::get())
        .and(warp::header::optional::<String>("authorization"))
        .and(with_state(state.clone()))
        .and_then(handle_job_progress);

    // GPU routes
    let gpus_list = api.and(warp::path("gpus")).and(warp::path::end())
        .and(warp::get())
        .and(warp::header::optional::<String>("authorization"))
        .and(with_state(state.clone()))
        .and_then(handle_list_gpus);

    let gpus_history = api.and(warp::path("gpus")).and(warp::path("history"))
        .and(warp::path::end())
        .and(warp::get())
        .and(warp::header::optional::<String>("authorization"))
        .and(warp::query::<HashMap<String, String>>())
        .and(with_state(state.clone()))
        .and_then(handle_gpu_history);

    // Version routes
    let versions_list = api.and(warp::path("versions")).and(warp::path::end())
        .and(warp::get())
        .and(with_state(state.clone()))
        .and_then(handle_list_versions);

    let versions_refresh = api.and(warp::path("versions")).and(warp::path("refresh"))
        .and(warp::post())
        .and(warp::header::optional::<String>("authorization"))
        .and(with_state(state.clone()))
        .and_then(handle_refresh_versions);

    // Dashboard route
    let dashboard = api.and(warp::path("dashboard")).and(warp::path::end())
        .and(warp::get())
        .and(warp::header::optional::<String>("authorization"))
        .and(with_state(state.clone()))
        .and_then(handle_dashboard);

    // Users admin routes
    let users_list = api.and(warp::path("users")).and(warp::path::end())
        .and(warp::get())
        .and(warp::header::optional::<String>("authorization"))
        .and(with_state(state.clone()))
        .and_then(handle_list_users);

    let users_create = api.and(warp::path("users")).and(warp::path::end())
        .and(warp::post())
        .and(warp::header::optional::<String>("authorization"))
        .and(warp::body::json())
        .and(with_state(state.clone()))
        .and_then(handle_create_user);

    let users_update = api.and(warp::path("users"))
        .and(warp::path::param::<i64>())
        .and(warp::path::end())
        .and(warp::put())
        .and(warp::header::optional::<String>("authorization"))
        .and(warp::body::json())
        .and(with_state(state.clone()))
        .and_then(handle_update_user);

    let users_gpus = api.and(warp::path("users"))
        .and(warp::path::param::<i64>())
        .and(warp::path("gpus"))
        .and(warp::path::end())
        .and(warp::get())
        .and(warp::header::optional::<String>("authorization"))
        .and(with_state(state.clone()))
        .and_then(handle_get_user_gpus);

    let users_delete = api.and(warp::path("users"))
        .and(warp::path::param::<i64>())
        .and(warp::path::end())
        .and(warp::delete())
        .and(warp::header::optional::<String>("authorization"))
        .and(with_state(state.clone()))
        .and_then(handle_delete_user);

    // Job restart route
    let jobs_restart = api.and(warp::path("jobs"))
        .and(warp::path::param::<i64>())
        .and(warp::path("restart"))
        .and(warp::post())
        .and(warp::header::optional::<String>("authorization"))
        .and(warp::body::json())
        .and(with_state(state.clone()))
        .and_then(handle_restart_job);

    // Stats file listing route (dynamic discovery of out/Stats/*.txt)
    let jobs_stats_list = api.and(warp::path("jobs"))
        .and(warp::path::param::<i64>())
        .and(warp::path("stats"))
        .and(warp::path::end())
        .and(warp::get())
        .and(warp::header::optional::<String>("authorization"))
        .and(with_state(state.clone()))
        .and_then(handle_list_stats_files);

    // Stats file data route (parse a specific stats TSV file)
    let jobs_stats_data = api.and(warp::path("jobs"))
        .and(warp::path::param::<i64>())
        .and(warp::path("stats"))
        .and(warp::path::param::<String>())
        .and(warp::path::end())
        .and(warp::get())
        .and(warp::header::optional::<String>("authorization"))
        .and(with_state(state.clone()))
        .and_then(handle_get_stats_file);

    // File browser routes
    let jobs_files_list = api.and(warp::path("jobs"))
        .and(warp::path::param::<i64>())
        .and(warp::path("files"))
        .and(warp::path::end())
        .and(warp::get())
        .and(warp::header::optional::<String>("authorization"))
        .and(warp::query::<HashMap<String, String>>())
        .and(with_state(state.clone()))
        .and_then(handle_list_files);

    let jobs_files_download = api.and(warp::path("jobs"))
        .and(warp::path::param::<i64>())
        .and(warp::path("files"))
        .and(warp::path("download"))
        .and(warp::path::end())
        .and(warp::get())
        .and(warp::header::optional::<String>("authorization"))
        .and(warp::query::<HashMap<String, String>>())
        .and(with_state(state.clone()))
        .and_then(handle_download_file);

    // Browse server filesystem route (for remote MSB selection)
    let browse = api.and(warp::path("browse")).and(warp::path::end())
        .and(warp::get())
        .and(warp::header::optional::<String>("authorization"))
        .and(warp::query::<HashMap<String, String>>())
        .and(with_state(state.clone()))
        .and_then(handle_browse);

    // Create directory route (for copy-to browser)
    let browse_mkdir = api.and(warp::path("browse")).and(warp::path("mkdir")).and(warp::path::end())
        .and(warp::post())
        .and(warp::header::optional::<String>("authorization"))
        .and(warp::body::json::<HashMap<String, String>>())
        .and(with_state(state.clone()))
        .and_then(handle_mkdir);

    auth_login
        .or(auth_register)
        .or(auth_logout)
        .or(auth_me)
        .or(jobs_list)
        .or(jobs_submit)
        .or(jobs_upload)
        .or(jobs_get)
        .or(jobs_cancel)
        .or(jobs_restart)
        .or(jobs_output)
        .or(jobs_progress)
        .or(jobs_stats_list)
        .or(jobs_stats_data)
        .or(jobs_files_download)
        .or(jobs_files_list)
        .or(gpus_history)
        .or(gpus_list)
        .or(versions_list)
        .or(versions_refresh)
        .or(dashboard)
        .or(users_list)
        .or(users_create)
        .or(users_update)
        .or(users_gpus)
        .or(users_delete)
        .or(browse_mkdir)
        .or(browse)
}

fn with_state(state: AppState) -> impl Filter<Extract = (AppState,), Error = std::convert::Infallible> + Clone {
    warp::any().map(move || state.clone())
}

// ============================================================
// Auth Handlers
// ============================================================

async fn handle_login(
    body: LoginRequest,
    state: AppState,
) -> Result<impl warp::Reply, warp::Rejection> {
    let db = state.db.lock().await;
    match db::authenticate_user(&db, &body.username, &body.password) {
        Ok(user) => {
            match db::create_session(&db, user.id) {
                Ok(token) => Ok(json_ok(&AuthResponse {
                    token,
                    user: user.into(),
                })),
                Err(e) => Ok(json_error(&e, warp::http::StatusCode::INTERNAL_SERVER_ERROR)),
            }
        }
        Err(e) => Ok(json_error(&e, warp::http::StatusCode::UNAUTHORIZED)),
    }
}

async fn handle_register(
    body: RegisterRequest,
    state: AppState,
) -> Result<impl warp::Reply, warp::Rejection> {
    let db = state.db.lock().await;
    match db::create_user(&db, &body.username, &body.email, &body.password, "user") {
        Ok(id) => {
            match db::create_session(&db, id) {
                Ok(token) => Ok(json_ok(&AuthResponse {
                    token,
                    user: UserResponse {
                        id,
                        username: body.username,
                        email: body.email,
                        role: "user".to_string(),
                    },
                })),
                Err(e) => Ok(json_error(&e, warp::http::StatusCode::INTERNAL_SERVER_ERROR)),
            }
        }
        Err(e) => Ok(json_error(&e, warp::http::StatusCode::BAD_REQUEST)),
    }
}

async fn handle_logout(
    auth: Option<String>,
    state: AppState,
) -> Result<impl warp::Reply, warp::Rejection> {
    if let Some(token) = extract_token(auth) {
        let db = state.db.lock().await;
        let _ = db::delete_session(&db, &token);
    }
    Ok(json_ok(&ApiSuccess { message: "Logged out".to_string() }))
}

async fn handle_me(
    auth: Option<String>,
    state: AppState,
) -> Result<impl warp::Reply, warp::Rejection> {
    let token = match extract_token(auth) {
        Some(t) => t,
        None => return Ok(json_error("Not authenticated", warp::http::StatusCode::UNAUTHORIZED)),
    };
    let db = state.db.lock().await;
    match db::validate_session(&db, &token) {
        Ok(user) => Ok(json_ok(&UserResponse::from(user))),
        Err(e) => Ok(json_error(&e, warp::http::StatusCode::UNAUTHORIZED)),
    }
}

/// Helper: authenticate a request, returning the User or an error reply
async fn require_auth(auth: &Option<String>, state: &AppState) -> Result<User, warp::reply::WithStatus<warp::reply::Json>> {
    let token = extract_token(auth.clone())
        .ok_or_else(|| json_error("Not authenticated", warp::http::StatusCode::UNAUTHORIZED))?;
    let db = state.db.lock().await;
    db::validate_session(&db, &token)
        .map_err(|e| json_error(&e, warp::http::StatusCode::UNAUTHORIZED))
}

// ============================================================
// Job Handlers
// ============================================================

async fn handle_list_jobs(
    params: HashMap<String, String>,
    auth: Option<String>,
    state: AppState,
) -> Result<impl warp::Reply, warp::Rejection> {
    if let Err(e) = require_auth(&auth, &state).await {
        return Ok(e);
    }
    let status = params.get("status").map(|s| s.as_str());
    let limit = params.get("limit").and_then(|l| l.parse::<i64>().ok());
    let db = state.db.lock().await;
    match db::list_jobs(&db, status, limit) {
        Ok(jobs) => Ok(json_ok(&jobs)),
        Err(e) => Ok(json_error(&e, warp::http::StatusCode::INTERNAL_SERVER_ERROR)),
    }
}

async fn handle_get_job(
    job_id: i64,
    auth: Option<String>,
    state: AppState,
) -> Result<impl warp::Reply, warp::Rejection> {
    if let Err(e) = require_auth(&auth, &state).await {
        return Ok(e);
    }
    let db = state.db.lock().await;
    match db::get_job(&db, job_id) {
        Ok(job) => Ok(json_ok(&job)),
        Err(e) => Ok(json_error(&e, warp::http::StatusCode::NOT_FOUND)),
    }
}

/// Step 1 of job submission: create the job record with metadata.
/// The MSB file is uploaded separately via POST /api/jobs/:id/upload
async fn handle_submit_job_metadata(
    auth: Option<String>,
    state: AppState,
) -> Result<impl warp::Reply, warp::Rejection> {
    // This will be called with JSON body via a custom extraction
    // For now, read from query params as a simpler approach
    Ok(json_error("Use multipart upload at /api/jobs/:id/upload", warp::http::StatusCode::BAD_REQUEST))
}

async fn handle_upload_msb(
    job_id: i64,
    auth: Option<String>,
    file_data: bytes::Bytes,
    params: HashMap<String, String>,
    state: AppState,
) -> Result<impl warp::Reply, warp::Rejection> {
    let _user = match require_auth(&auth, &state).await {
        Ok(u) => u,
        Err(e) => return Ok(e),
    };

    let filename = params.get("filename").cloned().unwrap_or_else(|| "upload.msb".to_string());

    // Save MSB file to jobs directory
    let jobs_dir = &state.config.paths.jobs_directory;
    let job_dir = jobs_dir.join(format!("job_{}", job_id));

    if let Err(e) = tokio::fs::create_dir_all(&job_dir).await {
        return Ok(json_error(&format!("Failed to create job directory: {}", e), warp::http::StatusCode::INTERNAL_SERVER_ERROR));
    }

    let msb_path = job_dir.join(&filename);
    if let Err(e) = tokio::fs::write(&msb_path, &file_data).await {
        return Ok(json_error(&format!("Failed to write file: {}", e), warp::http::StatusCode::INTERNAL_SERVER_ERROR));
    }

    // Update job working directory in DB
    let db = state.db.lock().await;
    let _ = db.execute(
        "UPDATE jobs SET working_directory = ?2, msb_filename = ?3 WHERE id = ?1",
        rusqlite::params![job_id, job_dir.to_str().unwrap_or(""), filename],
    );

    Ok(json_ok(&serde_json::json!({
        "message": "File uploaded successfully",
        "job_id": job_id,
        "filename": filename,
    })))
}

async fn handle_cancel_job(
    job_id: i64,
    auth: Option<String>,
    state: AppState,
) -> Result<impl warp::Reply, warp::Rejection> {
    let user = match require_auth(&auth, &state).await {
        Ok(u) => u,
        Err(e) => return Ok(e),
    };
    let db = state.db.lock().await;

    // Ownership check: non-admin users can only cancel their own jobs
    if user.role != "admin" {
        if let Ok(job) = db::get_job(&db, job_id) {
            if job.user_id != user.id {
                return Ok(json_error("You can only cancel your own jobs", warp::http::StatusCode::FORBIDDEN));
            }
        }
    }

    match db::cancel_job(&db, job_id) {
        Ok(pid) => {
            // If there was a running PID, kill it
            if let Some(pid) = pid {
                let _ = nix::sys::signal::kill(
                    nix::unistd::Pid::from_raw(pid as i32),
                    nix::sys::signal::Signal::SIGTERM,
                );
            }
            Ok(json_ok(&ApiSuccess { message: format!("Job {} cancelled", job_id) }))
        }
        Err(e) => Ok(json_error(&e, warp::http::StatusCode::BAD_REQUEST)),
    }
}

async fn handle_job_output(
    job_id: i64,
    auth: Option<String>,
    params: HashMap<String, String>,
    state: AppState,
) -> Result<impl warp::Reply, warp::Rejection> {
    if let Err(e) = require_auth(&auth, &state).await {
        return Ok(e);
    }
    let db = state.db.lock().await;
    let job = match db::get_job(&db, job_id) {
        Ok(j) => j,
        Err(e) => return Ok(json_error(&e, warp::http::StatusCode::NOT_FOUND)),
    };
    drop(db); // Release lock before file I/O

    let output_file = match &job.output_file {
        Some(f) => f.clone(),
        None => return Ok(json_error("No output file yet", warp::http::StatusCode::NOT_FOUND)),
    };

    let tail = params.get("tail").and_then(|t| t.parse::<usize>().ok());

    match tokio::fs::read_to_string(&output_file).await {
        Ok(content) => {
            let output = if let Some(n) = tail {
                let lines: Vec<&str> = content.lines().collect();
                let start = if lines.len() > n { lines.len() - n } else { 0 };
                lines[start..].join("\n")
            } else {
                content
            };
            Ok(json_ok(&serde_json::json!({
                "job_id": job_id,
                "status": job.status,
                "output": output,
            })))
        }
        Err(e) => Ok(json_error(&format!("Failed to read output: {}", e), warp::http::StatusCode::INTERNAL_SERVER_ERROR)),
    }
}

// ============================================================
// Progress Parser (M-Star CFD output log — generic)
// ============================================================

use std::collections::HashMap as StdHashMap;

async fn handle_job_progress(
    job_id: i64,
    auth: Option<String>,
    state: AppState,
) -> Result<impl warp::Reply, warp::Rejection> {
    if let Err(e) = require_auth(&auth, &state).await {
        return Ok(e);
    }
    let db = state.db.lock().await;
    let job = match db::get_job(&db, job_id) {
        Ok(j) => j,
        Err(e) => return Ok(json_error(&e, warp::http::StatusCode::NOT_FOUND)),
    };
    drop(db);

    let output_file = match &job.output_file {
        Some(f) => f.clone(),
        None => return Ok(json_ok(&serde_json::json!({
            "job_id": job_id,
            "status": job.status,
            "latest": null,
            "mstar_version": null,
            "total_runtime": null,
            "time_series": {},
            "sim_times": [],
            "wall_times": [],
        }))),
    };

    match tokio::fs::read_to_string(&output_file).await {
        Ok(content) => {
            let parsed = parse_mstar_output(&content);
            Ok(json_ok(&serde_json::json!({
                "job_id": job_id,
                "status": job.status,
                "mstar_version": parsed.mstar_version,
                "total_runtime": parsed.total_runtime,
                "latest": parsed.latest,
                "sim_times": parsed.sim_times,
                "wall_times": parsed.wall_times,
                "time_series": parsed.time_series,
            })))
        }
        Err(e) => Ok(json_error(&format!("Failed to read output: {}", e), warp::http::StatusCode::INTERNAL_SERVER_ERROR)),
    }
}

/// Parsed M-Star output with all variables as time-series
struct MstarParsedOutput {
    mstar_version: Option<String>,
    total_runtime: Option<f64>,
    /// Latest block snapshot: { "section_name": { "key": "value", ... }, ... }
    latest: Option<serde_json::Value>,
    /// Simulation time for each block
    sim_times: Vec<f64>,
    /// Wall time (hr) for each block
    wall_times: Vec<f64>,
    /// Time-series keyed by "Section / Variable Name" → [values...]
    /// Only includes variables that have at least one numeric value
    time_series: StdHashMap<String, Vec<f64>>,
}

/// Parse M-Star CFD output log and extract ALL variables as time-series.
///
/// Blocks are delimited by lines starting with `---`.
/// Within each block, sections are marked by lines ending with `:` (e.g., `Fluid Stats:`).
/// Key-value pairs are `Key = Value` lines within a section.
/// The top-level lines before any section marker belong to the root section.
fn parse_mstar_output(content: &str) -> MstarParsedOutput {
    let mut result = MstarParsedOutput {
        mstar_version: None,
        total_runtime: None,
        latest: None,
        sim_times: Vec::new(),
        wall_times: Vec::new(),
        time_series: StdHashMap::new(),
    };

    // Phase 1: Split into blocks delimited by --- lines
    let mut blocks: Vec<StdHashMap<String, StdHashMap<String, String>>> = Vec::new();
    let mut current_block: StdHashMap<String, StdHashMap<String, String>> = StdHashMap::new();
    let mut current_section = String::new(); // "" = root/unnamed section
    let mut in_block = false;
    let mut found_first_separator = false;

    for line in content.lines() {
        let trimmed = line.trim();

        // Extract M-Star version from header (before any block)
        if trimmed.starts_with("M-Star CFD (") && result.mstar_version.is_none() {
            result.mstar_version = Some(trimmed
                .trim_start_matches("M-Star CFD (")
                .trim_end_matches(')')
                .to_string());
            continue;
        }

        // Extract total runtime from system setup (first occurrence only)
        if !in_block && trimmed.starts_with("Runtime (s) = ") && result.total_runtime.is_none() {
            result.total_runtime = trimmed.split('=').nth(1)
                .and_then(|v| v.trim().parse().ok());
            continue;
        }

        // Separator line
        if trimmed.starts_with("---") {
            if !found_first_separator {
                found_first_separator = true;
                in_block = true;
                current_block = StdHashMap::new();
                current_section = String::new();
                continue;
            }

            // End of current block — save it if it has data
            if in_block && !current_block.is_empty() {
                blocks.push(current_block);
            }
            // Start new block
            current_block = StdHashMap::new();
            current_section = String::new();
            in_block = true;
            continue;
        }

        if !in_block {
            continue;
        }

        // Empty line — don't change section (M-Star uses blank lines within blocks)
        if trimmed.is_empty() {
            continue;
        }

        // Section header: line ending with `:` and no `=` sign
        if trimmed.ends_with(':') && !trimmed.contains('=') {
            current_section = trimmed.trim_end_matches(':').to_string();
            continue;
        }

        // Key = Value pair
        if let Some(eq_pos) = trimmed.find(" = ") {
            let key = trimmed[..eq_pos].trim().to_string();
            let value = trimmed[eq_pos + 3..].trim().to_string();
            current_block.entry(current_section.clone())
                .or_insert_with(StdHashMap::new)
                .insert(key, value);
        }
    }

    // Don't forget the last block if file doesn't end with ---
    if in_block && !current_block.is_empty() {
        blocks.push(current_block);
    }

    if blocks.is_empty() {
        return result;
    }

    // Phase 2: Build time-series from blocks
    for block in &blocks {
        // Extract sim_time from the Progress section or root
        let sim_time = block.iter()
            .flat_map(|(_, kv)| kv.get("Time (s)"))
            .filter_map(|v| v.parse::<f64>().ok())
            .next()
            .unwrap_or(0.0);

        let wall_time = block.iter()
            .flat_map(|(_, kv)| kv.get("Elapsed Wall Time (hr)"))
            .filter_map(|v| v.parse::<f64>().ok())
            .next()
            .unwrap_or(0.0);

        result.sim_times.push(sim_time);
        result.wall_times.push(wall_time);

        // For every key-value pair in every section, try to parse as numeric
        for (section, kvs) in block {
            for (key, value) in kvs {
                // Build full variable name
                let var_name = if section.is_empty() {
                    key.clone()
                } else {
                    format!("{} / {}", section, key)
                };

                // Try to parse the value as f64
                if let Ok(v) = value.parse::<f64>() {
                    let series = result.time_series.entry(var_name)
                        .or_insert_with(|| vec![f64::NAN; result.sim_times.len() - 1]);
                    // Pad with NaN if this variable wasn't in earlier blocks
                    while series.len() < result.sim_times.len() - 1 {
                        series.push(f64::NAN);
                    }
                    series.push(v);
                }
            }
        }

        // Pad all existing series that didn't appear in this block
        let n = result.sim_times.len();
        for series in result.time_series.values_mut() {
            while series.len() < n {
                series.push(f64::NAN);
            }
        }
    }

    // Phase 3: Build latest block as JSON
    let last_block = blocks.last().unwrap();
    let mut latest_json = serde_json::Map::new();
    for (section, kvs) in last_block {
        let section_name = if section.is_empty() { "General" } else { section.as_str() };
        let section_obj: serde_json::Map<String, serde_json::Value> = kvs.iter()
            .map(|(k, v)| (k.clone(), serde_json::Value::String(v.clone())))
            .collect();
        latest_json.insert(section_name.to_string(), serde_json::Value::Object(section_obj));
    }
    result.latest = Some(serde_json::Value::Object(latest_json));

    result
}

// ============================================================
// GPU Handlers
// ============================================================

async fn handle_list_gpus(
    auth: Option<String>,
    state: AppState,
) -> Result<impl warp::Reply, warp::Rejection> {
    if let Err(e) = require_auth(&auth, &state).await {
        return Ok(e);
    }

    // Get live GPU info
    let gpu_info = match crate::get_gpu_info() {
        Ok(info) => info,
        Err(e) => return Ok(json_error(&format!("Failed to get GPU info: {}", e), warp::http::StatusCode::INTERNAL_SERVER_ERROR)),
    };

    // Get running jobs to map GPUs → jobs
    let db = state.db.lock().await;
    let running_jobs = db::list_jobs(&db, Some("running"), None).unwrap_or_default();
    drop(db);

    let mut gpu_responses: Vec<GpuStatusResponse> = Vec::new();

    for (i, info) in gpu_info.iter().enumerate() {
        let memory_percent = if info.memory_total > 0 {
            (info.memory_used as f32 / info.memory_total as f32) * 100.0
        } else {
            0.0
        };

        // Find job running on this GPU
        let running_job = running_jobs.iter().find(|j| {
            let gpu_ids: Vec<i32> = serde_json::from_str(&j.gpu_ids).unwrap_or_default();
            gpu_ids.contains(&(i as i32))
        }).map(|j| GpuJobInfo {
            job_id: j.id,
            job_name: j.name.clone(),
            username: j.username.clone(),
        });

        gpu_responses.push(GpuStatusResponse {
            index: i,
            name: info.name.clone(),
            utilization: info.utilization,
            power_usage: info.power_usage,
            power_limit: info.power_limit,
            memory_used: info.memory_used,
            memory_total: info.memory_total,
            memory_percent,
            temperature: info.temperature,
            externally_busy: info.has_compute_processes && running_job.is_none(),
            running_job,
        });
    }

    Ok(json_ok(&gpu_responses))
}

// ============================================================
// GPU History Handler
// ============================================================

async fn handle_gpu_history(
    auth: Option<String>,
    params: HashMap<String, String>,
    state: AppState,
) -> Result<impl warp::Reply, warp::Rejection> {
    if let Err(e) = require_auth(&auth, &state).await {
        return Ok(e);
    }

    let minutes = params.get("minutes")
        .and_then(|m| m.parse::<i64>().ok())
        .unwrap_or(60);

    let log_path = &state.config.paths.gpu_metrics_log;
    if !log_path.exists() {
        return Ok(json_ok(&serde_json::json!({ "gpus": {} })));
    }

    let content = match tokio::fs::read_to_string(log_path).await {
        Ok(c) => c,
        Err(e) => return Ok(json_error(&format!("Failed to read GPU metrics log: {}", e),
            warp::http::StatusCode::INTERNAL_SERVER_ERROR)),
    };

    let cutoff = chrono::Utc::now() - chrono::Duration::minutes(minutes);
    let cutoff_str = cutoff.format("%Y-%m-%dT%H:%M:%SZ").to_string();

    // Parse CSV: timestamp,gpu_id,utilization,memory_used,memory_total,power_usage,power_limit,temperature
    let mut gpu_data: std::collections::HashMap<String, serde_json::Value> = std::collections::HashMap::new();

    // Temporary storage: gpu_id -> { timestamps, utilization, memory_percent, power_percent, temperature }
    let mut gpu_series: std::collections::HashMap<u32, (Vec<String>, Vec<f64>, Vec<f64>, Vec<f64>, Vec<f64>)> = std::collections::HashMap::new();

    for line in content.lines().skip(1) { // skip header
        let fields: Vec<&str> = line.split(',').collect();
        if fields.len() < 8 { continue; }

        let ts = fields[0];
        if ts < cutoff_str.as_str() { continue; }

        let gpu_id: u32 = match fields[1].parse() { Ok(v) => v, Err(_) => continue };
        let util: f64 = fields[2].parse().unwrap_or(0.0);
        let mem_used: f64 = fields[3].parse().unwrap_or(0.0);
        let mem_total: f64 = fields[4].parse().unwrap_or(1.0);
        let power: f64 = fields[5].parse().unwrap_or(0.0);
        let power_limit: f64 = fields[6].parse().unwrap_or(1.0);
        let temp: f64 = fields[7].parse().unwrap_or(0.0);

        let mem_pct = if mem_total > 0.0 { (mem_used / mem_total) * 100.0 } else { 0.0 };
        let power_pct = if power_limit > 0.0 { (power / power_limit) * 100.0 } else { 0.0 };

        let entry = gpu_series.entry(gpu_id).or_insert_with(|| {
            (Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new())
        });
        entry.0.push(ts.to_string());
        entry.1.push(util);
        entry.2.push(mem_pct);
        entry.3.push(power_pct);
        entry.4.push(temp);
    }

    // Downsample if too many points (keep at most ~1000 points per GPU)
    for (gpu_id, (timestamps, util, mem, power, temp)) in &gpu_series {
        let n = timestamps.len();
        let step = if n > 1000 { n / 1000 } else { 1 };

        let ts_sampled: Vec<&str> = timestamps.iter().step_by(step).map(|s| s.as_str()).collect();
        let util_sampled: Vec<f64> = util.iter().step_by(step).copied().collect();
        let mem_sampled: Vec<f64> = mem.iter().step_by(step).copied().collect();
        let power_sampled: Vec<f64> = power.iter().step_by(step).copied().collect();
        let temp_sampled: Vec<f64> = temp.iter().step_by(step).copied().collect();

        gpu_data.insert(gpu_id.to_string(), serde_json::json!({
            "timestamps": ts_sampled,
            "utilization": util_sampled,
            "memory_percent": mem_sampled,
            "power_percent": power_sampled,
            "temperature": temp_sampled,
        }));
    }

    Ok(json_ok(&serde_json::json!({ "gpus": gpu_data })))
}

// ============================================================
// File Browser Handlers
// ============================================================

async fn handle_list_files(
    job_id: i64,
    auth: Option<String>,
    params: HashMap<String, String>,
    state: AppState,
) -> Result<impl warp::Reply, warp::Rejection> {
    if let Err(e) = require_auth(&auth, &state).await {
        return Ok(e);
    }

    let job = {
        let conn = state.db.lock().await;
        match db::get_job(&conn, job_id) {
            Ok(j) => j,
            Err(e) => return Ok(json_error(&e, warp::http::StatusCode::NOT_FOUND)),
        }
    };

    let working_dir = match &job.working_directory {
        Some(d) if !d.is_empty() => std::path::PathBuf::from(d),
        _ => return Ok(json_error("Job has no working directory", warp::http::StatusCode::NOT_FOUND)),
    };

    // Base is the job's out/ directory
    let out_dir = working_dir.join("out");
    if !out_dir.exists() {
        return Ok(json_error("Output directory not found", warp::http::StatusCode::NOT_FOUND));
    }

    let sub_path = params.get("path").cloned().unwrap_or_default();
    let target_dir = out_dir.join(&sub_path);

    // Security: canonicalize and verify it's within out/
    let canonical_out = match out_dir.canonicalize() {
        Ok(p) => p,
        Err(_) => return Ok(json_error("Cannot resolve output directory", warp::http::StatusCode::INTERNAL_SERVER_ERROR)),
    };
    let canonical_target = match target_dir.canonicalize() {
        Ok(p) => p,
        Err(_) => return Ok(json_error("Path not found", warp::http::StatusCode::NOT_FOUND)),
    };
    if !canonical_target.starts_with(&canonical_out) {
        return Ok(json_error("Access denied: path traversal detected", warp::http::StatusCode::FORBIDDEN));
    }

    if !canonical_target.is_dir() {
        return Ok(json_error("Not a directory", warp::http::StatusCode::BAD_REQUEST));
    }

    let mut entries = Vec::new();
    if let Ok(mut read_dir) = tokio::fs::read_dir(&canonical_target).await {
        while let Ok(Some(entry)) = read_dir.next_entry().await {
            let metadata = entry.metadata().await;
            let is_dir = metadata.as_ref().map(|m| m.is_dir()).unwrap_or(false);
            let size = metadata.as_ref().map(|m| m.len()).unwrap_or(0);
            let modified = metadata.as_ref().ok()
                .and_then(|m| m.modified().ok())
                .map(|t| {
                    let datetime: chrono::DateTime<chrono::Utc> = t.into();
                    datetime.format("%Y-%m-%dT%H:%M:%SZ").to_string()
                })
                .unwrap_or_default();

            entries.push(serde_json::json!({
                "name": entry.file_name().to_string_lossy(),
                "is_dir": is_dir,
                "size": size,
                "modified": modified,
            }));
        }
    }

    // Sort: directories first, then by name
    entries.sort_by(|a, b| {
        let a_dir = a["is_dir"].as_bool().unwrap_or(false);
        let b_dir = b["is_dir"].as_bool().unwrap_or(false);
        match (a_dir, b_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or("")),
        }
    });

    Ok(json_ok(&serde_json::json!({
        "path": sub_path,
        "entries": entries,
    })))
}

async fn handle_download_file(
    job_id: i64,
    auth: Option<String>,
    params: HashMap<String, String>,
    state: AppState,
) -> Result<warp::reply::Response, warp::Rejection> {
    use warp::Reply;

    if let Err(e) = require_auth(&auth, &state).await {
        return Ok(e.into_response());
    }

    let job = {
        let conn = state.db.lock().await;
        match db::get_job(&conn, job_id) {
            Ok(j) => j,
            Err(e) => return Ok(json_error(&e, warp::http::StatusCode::NOT_FOUND).into_response()),
        }
    };

    let working_dir = match &job.working_directory {
        Some(d) if !d.is_empty() => std::path::PathBuf::from(d),
        _ => return Ok(json_error("Job has no working directory", warp::http::StatusCode::NOT_FOUND).into_response()),
    };

    let out_dir = working_dir.join("out");
    let file_path = params.get("path").cloned().unwrap_or_default();
    if file_path.is_empty() {
        return Ok(json_error("Missing 'path' parameter", warp::http::StatusCode::BAD_REQUEST).into_response());
    }

    let target = out_dir.join(&file_path);

    let canonical_out = match out_dir.canonicalize() {
        Ok(p) => p,
        Err(_) => return Ok(json_error("Cannot resolve output directory", warp::http::StatusCode::INTERNAL_SERVER_ERROR).into_response()),
    };
    let canonical_target = match target.canonicalize() {
        Ok(p) => p,
        Err(_) => return Ok(json_error("File not found", warp::http::StatusCode::NOT_FOUND).into_response()),
    };
    if !canonical_target.starts_with(&canonical_out) {
        return Ok(json_error("Access denied: path traversal detected", warp::http::StatusCode::FORBIDDEN).into_response());
    }
    if !canonical_target.is_file() {
        return Ok(json_error("Not a file", warp::http::StatusCode::BAD_REQUEST).into_response());
    }

    let content = match tokio::fs::read(&canonical_target).await {
        Ok(c) => c,
        Err(e) => return Ok(json_error(&format!("Failed to read file: {}", e),
            warp::http::StatusCode::INTERNAL_SERVER_ERROR).into_response()),
    };

    let filename = canonical_target.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "download".to_string());

    let ext = canonical_target.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    let content_type = match ext {
        "txt" | "log" | "csv" => "text/plain",
        "xml" => "application/xml",
        "json" => "application/json",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "vtu" | "vtk" => "application/octet-stream",
        _ => "application/octet-stream",
    };

    Ok(warp::reply::with_header(
        warp::reply::with_header(
            warp::reply::with_status(content, warp::http::StatusCode::OK),
            "Content-Type", content_type
        ),
        "Content-Disposition", format!("attachment; filename=\"{}\"", filename)
    ).into_response())
}

// ============================================================
// Version Handlers
// ============================================================

async fn handle_list_versions(
    state: AppState,
) -> Result<impl warp::Reply, warp::Rejection> {
    let versions = state.versions.lock().await;
    let response: Vec<VersionResponse> = versions.iter().map(|v| VersionResponse {
        version: v.version.clone(),
        is_latest: v.is_latest,
        label: v.label(),
    }).collect();
    Ok(json_ok(&response))
}

async fn handle_refresh_versions(
    auth: Option<String>,
    state: AppState,
) -> Result<impl warp::Reply, warp::Rejection> {
    if let Err(e) = require_auth(&auth, &state).await {
        return Ok(e);
    }
    let new_versions = mstar_versions::discover_versions(&state.config.paths.mstar_install_dir);
    let count = new_versions.len();
    *state.versions.lock().await = new_versions;
    Ok(json_ok(&serde_json::json!({
        "message": format!("Refreshed: {} versions found", count),
        "count": count,
    })))
}

// ============================================================
// Dashboard Handler
// ============================================================

async fn handle_dashboard(
    auth: Option<String>,
    state: AppState,
) -> Result<impl warp::Reply, warp::Rejection> {
    if let Err(e) = require_auth(&auth, &state).await {
        return Ok(e);
    }
    let db = state.db.lock().await;
    let job_counts = db::get_job_counts(&db).unwrap_or_default();
    drop(db);

    let gpu_info = crate::get_gpu_info().unwrap_or_default();
    let gpu_count = gpu_info.len();
    let busy_gpus = gpu_info.iter().filter(|g| g.has_compute_processes).count();
    let version_count = state.versions.lock().await.len();

    Ok(json_ok(&DashboardResponse {
        job_counts,
        total_gpus: gpu_count,
        active_gpus: busy_gpus,
        available_versions: version_count,
    }))
}

// ============================================================
// User Admin Handlers
// ============================================================

async fn handle_list_users(
    auth: Option<String>,
    state: AppState,
) -> Result<impl warp::Reply, warp::Rejection> {
    let user = match require_auth(&auth, &state).await {
        Ok(u) => u,
        Err(e) => return Ok(e),
    };
    if user.role != "admin" {
        return Ok(json_error("Admin access required", warp::http::StatusCode::FORBIDDEN));
    }
    let db = state.db.lock().await;
    match db::list_users(&db) {
        Ok(users) => {
            let response: Vec<serde_json::Value> = users.into_iter().map(|u| {
                let gpu_ids = db::get_user_gpu_access(&db, u.id).unwrap_or_default();
                serde_json::json!({
                    "id": u.id,
                    "username": u.username,
                    "email": u.email,
                    "role": u.role,
                    "created_at": u.created_at,
                    "gpu_access": gpu_ids,
                })
            }).collect();
            Ok(json_ok(&response))
        }
        Err(e) => Ok(json_error(&e, warp::http::StatusCode::INTERNAL_SERVER_ERROR)),
    }
}

async fn handle_delete_user(
    user_id: i64,
    auth: Option<String>,
    state: AppState,
) -> Result<impl warp::Reply, warp::Rejection> {
    let user = match require_auth(&auth, &state).await {
        Ok(u) => u,
        Err(e) => return Ok(e),
    };
    if user.role != "admin" {
        return Ok(json_error("Admin access required", warp::http::StatusCode::FORBIDDEN));
    }
    if user.id == user_id {
        return Ok(json_error("Cannot delete yourself", warp::http::StatusCode::BAD_REQUEST));
    }
    let db = state.db.lock().await;
    match db::delete_user(&db, user_id) {
        Ok(_) => Ok(json_ok(&ApiSuccess { message: format!("User {} deleted", user_id) })),
        Err(e) => Ok(json_error(&e, warp::http::StatusCode::NOT_FOUND)),
    }
}

#[derive(Deserialize)]
struct CreateUserRequest {
    username: String,
    email: String,
    password: String,
    #[serde(default = "default_user_role")]
    role: String,
    #[serde(default)]
    gpu_ids: Vec<i32>,
}

fn default_user_role() -> String {
    "user".to_string()
}

async fn handle_create_user(
    auth: Option<String>,
    body: CreateUserRequest,
    state: AppState,
) -> Result<impl warp::Reply, warp::Rejection> {
    let user = match require_auth(&auth, &state).await {
        Ok(u) => u,
        Err(e) => return Ok(e),
    };
    if user.role != "admin" {
        return Ok(json_error("Admin access required", warp::http::StatusCode::FORBIDDEN));
    }

    let db = state.db.lock().await;
    match db::create_user_by_admin(&db, &body.username, &body.email, &body.password, &body.role, &body.gpu_ids) {
        Ok(new_id) => Ok(json_ok(&serde_json::json!({
            "message": format!("User '{}' created", body.username),
            "user_id": new_id,
        }))),
        Err(e) => Ok(json_error(&e, warp::http::StatusCode::BAD_REQUEST)),
    }
}

#[derive(Deserialize)]
struct UpdateUserRequest {
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    gpu_ids: Option<Vec<i32>>,
}

async fn handle_update_user(
    user_id: i64,
    auth: Option<String>,
    body: UpdateUserRequest,
    state: AppState,
) -> Result<impl warp::Reply, warp::Rejection> {
    let user = match require_auth(&auth, &state).await {
        Ok(u) => u,
        Err(e) => return Ok(e),
    };
    if user.role != "admin" {
        return Ok(json_error("Admin access required", warp::http::StatusCode::FORBIDDEN));
    }

    let db = state.db.lock().await;

    if let Some(ref role) = body.role {
        if let Err(e) = db::update_user_role(&db, user_id, role) {
            return Ok(json_error(&e, warp::http::StatusCode::BAD_REQUEST));
        }
    }

    if let Some(ref gpu_ids) = body.gpu_ids {
        if let Err(e) = db::set_user_gpu_access(&db, user_id, gpu_ids) {
            return Ok(json_error(&e, warp::http::StatusCode::BAD_REQUEST));
        }
    }

    Ok(json_ok(&ApiSuccess { message: format!("User {} updated", user_id) }))
}

async fn handle_get_user_gpus(
    user_id: i64,
    auth: Option<String>,
    state: AppState,
) -> Result<impl warp::Reply, warp::Rejection> {
    let user = match require_auth(&auth, &state).await {
        Ok(u) => u,
        Err(e) => return Ok(e),
    };
    // Users can query their own access, admins can query anyone's
    if user.role != "admin" && user.id != user_id {
        return Ok(json_error("Access denied", warp::http::StatusCode::FORBIDDEN));
    }

    let db = state.db.lock().await;
    match db::get_user_gpu_access(&db, user_id) {
        Ok(gpu_ids) => Ok(json_ok(&serde_json::json!({ "user_id": user_id, "gpu_ids": gpu_ids }))),
        Err(e) => Ok(json_error(&e, warp::http::StatusCode::INTERNAL_SERVER_ERROR)),
    }
}

// ============================================================
// Job Restart Handler
// ============================================================

#[derive(Deserialize)]
struct RestartRequest {
    #[serde(default)]
    restart_options: Option<serde_json::Value>,
}

async fn handle_restart_job(
    job_id: i64,
    auth: Option<String>,
    body: RestartRequest,
    state: AppState,
) -> Result<impl warp::Reply, warp::Rejection> {
    if let Err(e) = require_auth(&auth, &state).await {
        return Ok(e);
    }

    let opts_str = body.restart_options
        .map(|v| serde_json::to_string(&v).unwrap_or_else(|_| "{}".to_string()));

    let db = state.db.lock().await;
    match db::create_restart_job(&db, job_id, opts_str.as_deref()) {
        Ok(new_id) => {
            println!("[API] Created restart job {} from failed job {}", new_id, job_id);
            Ok(json_ok(&serde_json::json!({
                "message": format!("Restart job created (#{}) from job #{}", new_id, job_id),
                "new_job_id": new_id,
                "original_job_id": job_id,
            })))
        }
        Err(e) => Ok(json_error(&e, warp::http::StatusCode::BAD_REQUEST)),
    }
}

// ============================================================
// Stats File Handlers (dynamic discovery of out/Stats/)
// ============================================================

/// List all stats files in a job's out/Stats/ directory.
/// Reads the header line of each .txt file to extract column names.
async fn handle_list_stats_files(
    job_id: i64,
    auth: Option<String>,
    state: AppState,
) -> Result<impl warp::Reply, warp::Rejection> {
    if let Err(e) = require_auth(&auth, &state).await {
        return Ok(e);
    }

    let db = state.db.lock().await;
    let job = match db::get_job(&db, job_id) {
        Ok(j) => j,
        Err(e) => return Ok(json_error(&e, warp::http::StatusCode::NOT_FOUND)),
    };
    drop(db);

    let work_dir = match &job.working_directory {
        Some(d) => d.clone(),
        None => return Ok(json_ok(&serde_json::json!({ "files": [] }))),
    };

    let stats_dir = std::path::Path::new(&work_dir).join("out").join("Stats");
    if !stats_dir.exists() {
        return Ok(json_ok(&serde_json::json!({ "files": [] })));
    }

    let mut files = Vec::new();

    // Dynamically scan for all .txt files in the Stats directory
    if let Ok(entries) = std::fs::read_dir(&stats_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() && path.extension().map(|e| e == "txt").unwrap_or(false) {
                let filename = path.file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("")
                    .to_string();

                // Read header line to get column names
                let columns = match std::fs::read_to_string(&path) {
                    Ok(content) => {
                        content.lines().next()
                            .map(|header| {
                                header.split('\t')
                                    .map(|s| s.trim().to_string())
                                    .filter(|s| !s.is_empty())
                                    .collect::<Vec<_>>()
                            })
                            .unwrap_or_default()
                    }
                    Err(_) => Vec::new(),
                };

                // Count data rows
                let row_count = match std::fs::read_to_string(&path) {
                    Ok(content) => content.lines().skip(1).filter(|l| !l.trim().is_empty()).count(),
                    Err(_) => 0,
                };

                // Derive a friendly category name from the filename
                let category = filename.trim_end_matches(".txt").to_string();

                files.push(serde_json::json!({
                    "filename": filename,
                    "category": category,
                    "columns": columns,
                    "row_count": row_count,
                }));
            }
        }
    }

    // Sort by category name for consistent display
    files.sort_by(|a, b| {
        let ca = a["category"].as_str().unwrap_or("");
        let cb = b["category"].as_str().unwrap_or("");
        ca.cmp(cb)
    });

    Ok(json_ok(&serde_json::json!({ "files": files })))
}

/// Parse a specific stats file and return column data as arrays.
/// Response: { columns: [...], data: { "Column Name": [v1, v2, ...], ... } }
async fn handle_get_stats_file(
    job_id: i64,
    filename: String,
    auth: Option<String>,
    state: AppState,
) -> Result<impl warp::Reply, warp::Rejection> {
    if let Err(e) = require_auth(&auth, &state).await {
        return Ok(e);
    }

    // Sanitize filename — prevent directory traversal
    let safe_filename = std::path::Path::new(&filename)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");
    if safe_filename.is_empty() || safe_filename.contains("..") {
        return Ok(json_error("Invalid filename", warp::http::StatusCode::BAD_REQUEST));
    }

    let db = state.db.lock().await;
    let job = match db::get_job(&db, job_id) {
        Ok(j) => j,
        Err(e) => return Ok(json_error(&e, warp::http::StatusCode::NOT_FOUND)),
    };
    drop(db);

    let work_dir = match &job.working_directory {
        Some(d) => d.clone(),
        None => return Ok(json_error("Job has no working directory", warp::http::StatusCode::NOT_FOUND)),
    };

    let file_path = std::path::Path::new(&work_dir)
        .join("out").join("Stats").join(safe_filename);

    if !file_path.exists() {
        return Ok(json_error(
            &format!("Stats file not found: {}", safe_filename),
            warp::http::StatusCode::NOT_FOUND,
        ));
    }

    match tokio::fs::read_to_string(&file_path).await {
        Ok(content) => {
            let mut lines = content.lines();

            // Parse header
            let columns: Vec<String> = match lines.next() {
                Some(header) => header.split('\t')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect(),
                None => return Ok(json_ok(&serde_json::json!({
                    "columns": [],
                    "data": {},
                }))),
            };

            // Initialize column arrays
            let num_cols = columns.len();
            let mut col_data: Vec<Vec<Option<f64>>> = vec![Vec::new(); num_cols];

            // Parse data rows
            for line in lines {
                let trimmed = line.trim();
                if trimmed.is_empty() { continue; }

                let fields: Vec<&str> = trimmed.split('\t').collect();
                for (i, col) in col_data.iter_mut().enumerate() {
                    let val = fields.get(i)
                        .and_then(|s| s.trim().parse::<f64>().ok());
                    col.push(val);
                }
            }

            // Build keyed data object
            let mut data_map = serde_json::Map::new();
            for (i, col_name) in columns.iter().enumerate() {
                let values: Vec<serde_json::Value> = col_data[i].iter()
                    .map(|v| match v {
                        Some(f) => {
                            if f.is_nan() || f.is_infinite() {
                                serde_json::Value::Null
                            } else {
                                serde_json::json!(f)
                            }
                        }
                        None => serde_json::Value::Null,
                    })
                    .collect();
                data_map.insert(col_name.clone(), serde_json::Value::Array(values));
            }

            Ok(json_ok(&serde_json::json!({
                "filename": safe_filename,
                "columns": columns,
                "data": data_map,
            })))
        }
        Err(e) => Ok(json_error(
            &format!("Failed to read stats file: {}", e),
            warp::http::StatusCode::INTERNAL_SERVER_ERROR,
        )),
    }
}

/// Browse the server filesystem for MSB files (restricted to /simulations)
async fn handle_browse(
    auth: Option<String>,
    params: HashMap<String, String>,
    state: AppState,
) -> Result<impl warp::Reply, warp::Rejection> {
    if let Err(e) = require_auth(&auth, &state).await {
        return Ok(e);
    }

    let browse_root = "/simulations";
    let requested_path = params.get("path").cloned().unwrap_or_else(|| browse_root.to_string());
    let mode = params.get("mode").cloned().unwrap_or_else(|| "all".to_string()); // "all", "dirs", "msb"

    // Security: ensure the path is under /simulations and canonicalize
    let canonical = match std::fs::canonicalize(&requested_path) {
        Ok(p) => p,
        Err(_) => {
            // Path doesn't exist — try the browse root
            return Ok(json_error("Path not found", warp::http::StatusCode::NOT_FOUND));
        }
    };

    if !canonical.starts_with(browse_root) {
        return Ok(json_error("Access denied: path must be under /simulations", warp::http::StatusCode::FORBIDDEN));
    }

    let canonical_str = canonical.to_str().unwrap_or(browse_root).to_string();

    // Read directory entries
    let mut entries = Vec::new();
    match std::fs::read_dir(&canonical) {
        Ok(dir) => {
            for entry in dir {
                if let Ok(entry) = entry {
                    let name = entry.file_name().to_str().unwrap_or("").to_string();
                    // Skip hidden files/directories
                    if name.starts_with('.') { continue; }

                    let file_type = entry.file_type().unwrap_or_else(|_| {
                        std::fs::metadata(entry.path()).unwrap().file_type()
                    });
                    let is_dir = file_type.is_dir();
                    let is_msb = !is_dir && (name.to_lowercase().ends_with(".msb"));

                    // Filter based on mode
                    let include = match mode.as_str() {
                        "dirs" => is_dir,
                        "msb" => is_dir || is_msb,
                        _ => true, // "all" — show everything
                    };

                    if !include { continue; }

                    let size = if !is_dir {
                        entry.metadata().map(|m| m.len()).unwrap_or(0)
                    } else {
                        0
                    };

                    entries.push(serde_json::json!({
                        "name": name,
                        "path": entry.path().to_str().unwrap_or(""),
                        "is_dir": is_dir,
                        "is_msb": is_msb,
                        "size": size,
                    }));
                }
            }
        }
        Err(e) => {
            return Ok(json_error(
                &format!("Failed to read directory: {}", e),
                warp::http::StatusCode::INTERNAL_SERVER_ERROR,
            ));
        }
    }

    // Sort: directories first, then files, alphabetically
    entries.sort_by(|a, b| {
        let a_dir = a["is_dir"].as_bool().unwrap_or(false);
        let b_dir = b["is_dir"].as_bool().unwrap_or(false);
        match (a_dir, b_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => {
                let a_name = a["name"].as_str().unwrap_or("");
                let b_name = b["name"].as_str().unwrap_or("");
                a_name.to_lowercase().cmp(&b_name.to_lowercase())
            }
        }
    });

    // Compute parent path
    let parent = if canonical_str != browse_root {
        canonical.parent().and_then(|p| p.to_str()).map(|s| s.to_string())
    } else {
        None
    };

    Ok(json_ok(&serde_json::json!({
        "path": canonical_str,
        "parent": parent,
        "entries": entries,
    })))
}

/// Create a new directory (restricted to /simulations)
async fn handle_mkdir(
    auth: Option<String>,
    body: HashMap<String, String>,
    state: AppState,
) -> Result<impl warp::Reply, warp::Rejection> {
    if let Err(e) = require_auth(&auth, &state).await {
        return Ok(e);
    }

    let path = match body.get("path") {
        Some(p) => p.clone(),
        None => return Ok(json_error("Missing 'path' field", warp::http::StatusCode::BAD_REQUEST)),
    };

    // SECURITY: Resolve the path to catch traversal attacks (e.g. /simulations/../../etc)
    // We canonicalize the parent (which must exist) and append the leaf name
    let requested = std::path::Path::new(&path);
    let parent = match requested.parent() {
        Some(p) => p,
        None => return Ok(json_error("Invalid path", warp::http::StatusCode::BAD_REQUEST)),
    };

    // The parent must exist and resolve under /simulations
    let canonical_parent = match std::fs::canonicalize(parent) {
        Ok(p) => p,
        Err(_) => return Ok(json_error("Parent directory does not exist", warp::http::StatusCode::BAD_REQUEST)),
    };

    if !canonical_parent.starts_with("/simulations") {
        return Ok(json_error("Path must be under /simulations", warp::http::StatusCode::FORBIDDEN));
    }

    // Rebuild the safe path from canonical parent + leaf
    let leaf = match requested.file_name() {
        Some(n) => n,
        None => return Ok(json_error("Invalid directory name", warp::http::StatusCode::BAD_REQUEST)),
    };
    let safe_path = canonical_parent.join(leaf);

    match std::fs::create_dir_all(&safe_path) {
        Ok(_) => Ok(json_ok(&serde_json::json!({
            "message": "Directory created",
            "path": safe_path.to_str().unwrap_or(""),
        }))),
        Err(e) => Ok(json_error(
            &format!("Failed to create directory: {}", e),
            warp::http::StatusCode::INTERNAL_SERVER_ERROR,
        )),
    }
}
