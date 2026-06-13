use std::collections::HashMap;
use std::sync::Arc;
use warp::Filter;
use tokio::sync::Mutex;
use serde::{Deserialize, Serialize};
use crate::db::{self, DbHandle, User};
use crate::mstar_versions::{self, MstarVersion};
use crate::config::Config;
use crate::ai_training;

// SECURITY: In-memory login rate limiter
use std::time::Instant;
static LOGIN_ATTEMPTS: std::sync::LazyLock<Mutex<HashMap<String, Vec<Instant>>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

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

// AI Training request/response types

#[derive(Deserialize)]
pub struct CreateAiDatasetRequest {
    pub name: String,
    pub sweep_root: String,
    pub config: Option<serde_json::Value>,
}

#[derive(Deserialize)]
pub struct CreateAiTrainingJobRequest {
    pub dataset_id: i64,
    pub model_family: String,
    pub run_name: Option<String>,
    pub gpu_ids: Option<Vec<i32>>,
    pub config: Option<serde_json::Value>,
    /// If set, resume training from this completed job's checkpoint.
    /// Used for both "continue training" (same dataset) and "transfer learning" (new dataset).
    /// The source job must be completed and must use the same model_family.
    pub resume_from_job: Option<i64>,
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

    // System info route (CPU + memory)
    let system_info = api.and(warp::path("system")).and(warp::path::end())
        .and(warp::get())
        .and(warp::header::optional::<String>("authorization"))
        .and(with_state(state.clone()))
        .and_then(handle_system_info);

    // Version routes
    let versions_list = api.and(warp::path("versions")).and(warp::path::end())
        .and(warp::get())
        .and(warp::header::optional::<String>("authorization"))
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

    // Job archive route (single job)
    let jobs_archive = api.and(warp::path("jobs"))
        .and(warp::path::param::<i64>())
        .and(warp::path("archive"))
        .and(warp::path::end())
        .and(warp::post())
        .and(warp::header::optional::<String>("authorization"))
        .and(with_state(state.clone()))
        .and_then(handle_archive_job);

    // Archive all failed jobs (must come before parameterized routes)
    let jobs_archive_failed = api.and(warp::path("jobs"))
        .and(warp::path("archive-failed"))
        .and(warp::path::end())
        .and(warp::post())
        .and(warp::header::optional::<String>("authorization"))
        .and(with_state(state.clone()))
        .and_then(handle_archive_all_failed);

    // Checkpoint listing route
    let jobs_checkpoints = api.and(warp::path("jobs"))
        .and(warp::path::param::<i64>())
        .and(warp::path("checkpoints"))
        .and(warp::path::end())
        .and(warp::get())
        .and(warp::header::optional::<String>("authorization"))
        .and(with_state(state.clone()))
        .and_then(handle_list_checkpoints);

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

    // PVD viewer routes
    let jobs_pvd_info = api.and(warp::path("jobs"))
        .and(warp::path::param::<i64>())
        .and(warp::path("files"))
        .and(warp::path("pvd-info"))
        .and(warp::path::end())
        .and(warp::get())
        .and(warp::header::optional::<String>("authorization"))
        .and(warp::query::<HashMap<String, String>>())
        .and(with_state(state.clone()))
        .and_then(handle_pvd_info);

    let jobs_vtk_serve = api.and(warp::path("jobs"))
        .and(warp::path::param::<i64>())
        .and(warp::path("files"))
        .and(warp::path("vtk-serve"))
        .and(warp::path::end())
        .and(warp::get())
        .and(warp::header::optional::<String>("authorization"))
        .and(warp::query::<HashMap<String, String>>())
        .and(with_state(state.clone()))
        .and_then(handle_vtk_serve);

    // Visuals — scan Output dir for all loadable layers (slices, surfaces, STLs — not volumes)
    let jobs_visuals_layers = api.and(warp::path("jobs"))
        .and(warp::path::param::<i64>())
        .and(warp::path("visuals-layers"))
        .and(warp::path::end())
        .and(warp::get())
        .and(warp::header::optional::<String>("authorization"))
        .and(with_state(state.clone()))
        .and_then(handle_visuals_layers);

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

    // Render: submit a render job
    let render_submit = api.and(warp::path("render"))
        .and(warp::path::end())
        .and(warp::post())
        .and(warp::header::optional::<String>("authorization"))
        .and(warp::body::json::<RenderRequest>())
        .and(with_state(state.clone()))
        .and_then(handle_render_submit);

    // Render: get render status (reads render_status.json)
    let render_status = api.and(warp::path("render"))
        .and(warp::path::param::<i64>())
        .and(warp::path("status"))
        .and(warp::path::end())
        .and(warp::get())
        .and(warp::header::optional::<String>("authorization"))
        .and(with_state(state.clone()))
        .and_then(handle_render_status);

    // Render: upload a state file for a job
    let render_upload_state = api.and(warp::path("jobs"))
        .and(warp::path::param::<i64>())
        .and(warp::path("upload-state"))
        .and(warp::path::end())
        .and(warp::post())
        .and(warp::header::optional::<String>("authorization"))
        .and(warp::multipart::form().max_length(500 * 1024 * 1024)) // 500 MB
        .and(with_state(state.clone()))
        .and_then(handle_upload_state_file);

    // Render: list state files for a job
    let render_list_states = api.and(warp::path("jobs"))
        .and(warp::path::param::<i64>())
        .and(warp::path("state-files"))
        .and(warp::path::end())
        .and(warp::get())
        .and(warp::header::optional::<String>("authorization"))
        .and(with_state(state.clone()))
        .and_then(handle_list_state_files);

    // Admin: install latest M-Star version
    let admin_install_version = api.and(warp::path("admin"))
        .and(warp::path("install-version"))
        .and(warp::path::end())
        .and(warp::post())
        .and(warp::header::optional::<String>("authorization"))
        .and(with_state(state.clone()))
        .and_then(handle_install_version);

    // ---- AI Training routes ----

    // GET /api/ai/datasets
    let ai_datasets_list = api.and(warp::path("ai")).and(warp::path("datasets")).and(warp::path::end())
        .and(warp::get())
        .and(warp::header::optional::<String>("authorization"))
        .and(with_state(state.clone()))
        .and_then(handle_ai_list_datasets);

    // POST /api/ai/datasets
    let ai_datasets_create = api.and(warp::path("ai")).and(warp::path("datasets")).and(warp::path::end())
        .and(warp::post())
        .and(warp::header::optional::<String>("authorization"))
        .and(warp::body::json())
        .and(with_state(state.clone()))
        .and_then(handle_ai_create_dataset);

    // GET /api/ai/datasets/:id
    let ai_datasets_get = api.and(warp::path("ai")).and(warp::path("datasets"))
        .and(warp::path::param::<i64>())
        .and(warp::path::end())
        .and(warp::get())
        .and(warp::header::optional::<String>("authorization"))
        .and(with_state(state.clone()))
        .and_then(handle_ai_get_dataset);

    // POST /api/ai/datasets/:id/rescan
    let ai_datasets_rescan = api.and(warp::path("ai")).and(warp::path("datasets"))
        .and(warp::path::param::<i64>())
        .and(warp::path("rescan"))
        .and(warp::path::end())
        .and(warp::post())
        .and(warp::header::optional::<String>("authorization"))
        .and(with_state(state.clone()))
        .and_then(handle_ai_rescan_dataset);

    // POST /api/ai/datasets/:id/prepare
    let ai_datasets_prepare = api.and(warp::path("ai")).and(warp::path("datasets"))
        .and(warp::path::param::<i64>())
        .and(warp::path("prepare"))
        .and(warp::path::end())
        .and(warp::post())
        .and(warp::header::optional::<String>("authorization"))
        .and(warp::body::json())
        .and(with_state(state.clone()))
        .and_then(handle_ai_prepare_dataset);

    // GET /api/ai/datasets/:id/derived-fields
    let ai_datasets_derived = api.and(warp::path("ai")).and(warp::path("datasets"))
        .and(warp::path::param::<i64>())
        .and(warp::path("derived-fields"))
        .and(warp::path::end())
        .and(warp::get())
        .and(warp::header::optional::<String>("authorization"))
        .and(with_state(state.clone()))
        .and_then(handle_ai_get_derived_fields);

    // POST /api/ai/datasets/:id/probe
    let ai_datasets_probe = api.and(warp::path("ai")).and(warp::path("datasets"))
        .and(warp::path::param::<i64>())
        .and(warp::path("probe"))
        .and(warp::path::end())
        .and(warp::post())
        .and(warp::header::optional::<String>("authorization"))
        .and(with_state(state.clone()))
        .and_then(handle_ai_probe_dataset);

    // POST /api/ai/field-ops/delete/:dataset_id
    let ai_datasets_delete_fields = api.and(warp::post())
        .and(warp::path("ai")).and(warp::path("field-ops"))
        .and(warp::path("delete"))
        .and(warp::path::param::<i64>())
        .and(warp::path::end())
        .and(warp::header::optional::<String>("authorization"))
        .and(warp::body::json())
        .and(with_state(state.clone()))
        .and_then(handle_ai_delete_fields);

    // GET /api/ai/training-jobs
    let ai_training_jobs_list = api.and(warp::path("ai")).and(warp::path("training-jobs")).and(warp::path::end())
        .and(warp::get())
        .and(warp::header::optional::<String>("authorization"))
        .and(warp::query::<HashMap<String, String>>())
        .and(with_state(state.clone()))
        .and_then(handle_ai_list_training_jobs);

    // POST /api/ai/training-jobs
    let ai_training_jobs_create = api.and(warp::path("ai")).and(warp::path("training-jobs")).and(warp::path::end())
        .and(warp::post())
        .and(warp::header::optional::<String>("authorization"))
        .and(warp::body::json())
        .and(with_state(state.clone()))
        .and_then(handle_ai_create_training_job);

    // GET /api/ai/training-jobs/:id
    let ai_training_jobs_get = api.and(warp::path("ai")).and(warp::path("training-jobs"))
        .and(warp::path::param::<i64>())
        .and(warp::path::end())
        .and(warp::get())
        .and(warp::header::optional::<String>("authorization"))
        .and(with_state(state.clone()))
        .and_then(handle_ai_get_training_job);

    // POST /api/ai/training-jobs/:id/cancel
    let ai_training_jobs_cancel = api.and(warp::path("ai")).and(warp::path("training-jobs"))
        .and(warp::path::param::<i64>())
        .and(warp::path("cancel"))
        .and(warp::path::end())
        .and(warp::post())
        .and(warp::header::optional::<String>("authorization"))
        .and(with_state(state.clone()))
        .and_then(handle_ai_cancel_training_job);

    // GET /api/ai/training-jobs/:id/log — raw training log
    let ai_training_jobs_log = api.and(warp::path("ai")).and(warp::path("training-jobs"))
        .and(warp::path::param::<i64>())
        .and(warp::path("log"))
        .and(warp::path::end())
        .and(warp::get())
        .and(warp::header::optional::<String>("authorization"))
        .and(with_state(state.clone()))
        .and_then(handle_ai_training_log);

    // GET /api/ai/training-jobs/:id/metrics — epoch-by-epoch training metrics
    let ai_training_jobs_metrics = api.and(warp::path("ai")).and(warp::path("training-jobs"))
        .and(warp::path::param::<i64>())
        .and(warp::path("metrics"))
        .and(warp::path::end())
        .and(warp::get())
        .and(warp::header::optional::<String>("authorization"))
        .and(with_state(state.clone()))
        .and_then(handle_ai_training_metrics);

    // POST /api/ai/training-jobs/:id/export — export model to ONNX/TorchScript
    let ai_training_jobs_export = api.and(warp::path("ai")).and(warp::path("training-jobs"))
        .and(warp::path::param::<i64>())
        .and(warp::path("export"))
        .and(warp::path::end())
        .and(warp::post())
        .and(warp::header::optional::<String>("authorization"))
        .and(warp::body::json::<serde_json::Value>())
        .and(with_state(state.clone()))
        .and_then(handle_ai_export_model);

    // POST /api/ai/training-jobs/:id/infer — run inference with a trained model
    let ai_training_jobs_infer = api.and(warp::path("ai")).and(warp::path("training-jobs"))
        .and(warp::path::param::<i64>())
        .and(warp::path("infer"))
        .and(warp::path::end())
        .and(warp::post())
        .and(warp::header::optional::<String>("authorization"))
        .and(warp::body::json::<serde_json::Value>())
        .and(with_state(state.clone()))
        .and_then(handle_ai_infer);

    // POST /api/ai/training-jobs/:id/infer-sweep — batch inference across a parameter range
    let ai_training_jobs_infer_sweep = api.and(warp::path("ai")).and(warp::path("training-jobs"))
        .and(warp::path::param::<i64>())
        .and(warp::path("infer-sweep"))
        .and(warp::path::end())
        .and(warp::post())
        .and(warp::header::optional::<String>("authorization"))
        .and(warp::body::json::<serde_json::Value>())
        .and(with_state(state.clone()))
        .and_then(handle_ai_infer_sweep);

    // GET /api/ai/training-jobs/:id/inference-progress — poll sweep inference progress
    let ai_training_jobs_inference_progress = api.and(warp::path("ai")).and(warp::path("training-jobs"))
        .and(warp::path::param::<i64>())
        .and(warp::path("inference-progress"))
        .and(warp::path::end())
        .and(warp::get())
        .and(warp::header::optional::<String>("authorization"))
        .and(with_state(state.clone()))
        .and_then(handle_ai_inference_progress);

    // GET /api/ai/config  (return enabled status + defaults)
    let ai_training_config = api.and(warp::path("ai")).and(warp::path("config")).and(warp::path::end())
        .and(warp::get())
        .and(warp::header::optional::<String>("authorization"))
        .and(with_state(state.clone()))
        .and_then(handle_ai_config);

    // POST /api/ai/preflight
    let ai_preflight = api.and(warp::path("ai")).and(warp::path("preflight")).and(warp::path::end())
        .and(warp::post())
        .and(warp::header::optional::<String>("authorization"))
        .and(warp::body::json::<serde_json::Value>())
        .and(with_state(state.clone()))
        .and_then(handle_ai_preflight);

    // GET /api/ai/artifacts/pvd-info — parse a PVD file from AI artifacts
    let ai_artifacts_pvd_info = api.and(warp::path("ai")).and(warp::path("artifacts"))
        .and(warp::path("pvd-info"))
        .and(warp::path::end())
        .and(warp::get())
        .and(warp::header::optional::<String>("authorization"))
        .and(warp::query::<HashMap<String, String>>())
        .and(with_state(state.clone()))
        .and_then(handle_ai_artifact_pvd_info);

    // GET /api/ai/artifacts/vtk-serve — serve a VTI/VTP/VTU file from AI artifacts
    let ai_artifacts_vtk_serve = api.and(warp::path("ai")).and(warp::path("artifacts"))
        .and(warp::path("vtk-serve"))
        .and(warp::path::end())
        .and(warp::get())
        .and(warp::header::optional::<String>("authorization"))
        .and(warp::query::<HashMap<String, String>>())
        .and(with_state(state.clone()))
        .and_then(handle_ai_artifact_vtk_serve);

    // ---------- Sweep detection routes ----------
    // POST /api/sweep/detect — detect sweeps in an MSB file
    let sweep_detect = api.and(warp::path("sweep")).and(warp::path("detect")).and(warp::path::end())
        .and(warp::post())
        .and(warp::header::optional::<String>("authorization"))
        .and(warp::body::json::<serde_json::Value>())
        .and(with_state(state.clone()))
        .and_then(handle_sweep_detect);

    // POST /api/sweep/submit — submit a sweep batch (creates N jobs)
    let sweep_submit = api.and(warp::path("sweep")).and(warp::path("submit")).and(warp::path::end())
        .and(warp::post())
        .and(warp::header::optional::<String>("authorization"))
        .and(warp::body::json::<serde_json::Value>())
        .and(with_state(state.clone()))
        .and_then(handle_sweep_submit);

    // POST /api/sweep/:group_id/create-dataset — create AI training dataset from completed sweep
    let sweep_create_dataset = api.and(warp::path("sweep"))
        .and(warp::path::param::<String>())
        .and(warp::path("create-dataset"))
        .and(warp::path::end())
        .and(warp::post())
        .and(warp::header::optional::<String>("authorization"))
        .and(warp::body::json::<serde_json::Value>())
        .and(with_state(state.clone()))
        .and_then(handle_sweep_create_dataset);

    auth_login
        .or(auth_register)
        .or(auth_logout)
        .or(auth_me)
        .or(jobs_list)
        .or(jobs_submit)
        .or(jobs_upload)
        .or(jobs_get)
        .or(jobs_visuals_layers)
        .or(jobs_cancel)
        .or(jobs_restart)
        .or(jobs_archive_failed)
        .or(jobs_archive)
        .or(jobs_checkpoints)
        .or(jobs_output)
        .or(jobs_progress)
        .or(jobs_stats_list)
        .or(jobs_stats_data)
        .or(jobs_files_download)
        .or(jobs_pvd_info)
        .or(jobs_vtk_serve)
        .or(jobs_files_list)
        .or(render_submit)
        .or(render_status)
        .or(render_upload_state)
        .or(render_list_states)
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
        .or(admin_install_version)
        .or(system_info)
        .or(browse)
        .boxed()
        // AI Training routes (more specific routes before generic /:id)
        .or(ai_datasets_list)
        .or(ai_datasets_create)
        .or(ai_datasets_rescan)
        .or(ai_datasets_prepare)
        .or(ai_datasets_derived)
        .or(ai_datasets_probe)
        .or(ai_datasets_delete_fields)
        .or(ai_datasets_get)
        .or(ai_training_jobs_list)
        .or(ai_training_jobs_create)
        .or(ai_training_jobs_get)
        .or(ai_training_jobs_cancel)
        .or(ai_training_jobs_log)
        .or(ai_training_jobs_metrics)
        .or(ai_training_jobs_export)
        .or(ai_training_jobs_infer)
        .or(ai_training_jobs_infer_sweep)
        .or(ai_training_jobs_inference_progress)
        .or(ai_training_config)
        .or(ai_preflight)
        .or(ai_artifacts_pvd_info)
        .or(ai_artifacts_vtk_serve)
        .boxed()
        // Sweep routes
        .or(sweep_detect)
        .or(sweep_submit)
        .or(sweep_create_dataset)
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
    // SECURITY: Rate limit login attempts (max 10 per 5 minutes per username)
    let rate_limit_window = std::time::Duration::from_secs(300);
    let max_attempts: usize = 10;
    {
        let mut attempts = LOGIN_ATTEMPTS.lock().await;
        let entry = attempts.entry(body.username.clone()).or_insert_with(Vec::new);
        let now = Instant::now();
        entry.retain(|t| now.duration_since(*t) < rate_limit_window);
        if entry.len() >= max_attempts {
            return Ok(json_error("Too many login attempts. Try again in a few minutes.", warp::http::StatusCode::TOO_MANY_REQUESTS));
        }
        entry.push(now);
    }

    let db = state.db.lock().await;
    // Opportunistically clean up expired sessions
    let _ = db::cleanup_expired_sessions(&db);
    match db::authenticate_user(&db, &body.username, &body.password) {
        Ok(user) => {
            // Clear rate limit on successful login
            {
                let mut attempts = LOGIN_ATTEMPTS.lock().await;
                attempts.remove(&body.username);
            }
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
    // Validate email domain from config before creating user
    let domain = &state.config.security.allowed_email_domain;
    if let Err(e) = db::validate_email(&body.email, domain) {
        return Ok(json_error(&e, warp::http::StatusCode::BAD_REQUEST));
    }
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

/// SECURITY: Helper to authenticate AND verify ownership/admin access for a job.
/// Non-admin users can only access their own jobs.
async fn require_job_access(auth: &Option<String>, state: &AppState, job_id: i64) -> Result<(User, db::Job), warp::reply::WithStatus<warp::reply::Json>> {
    let user = require_auth(auth, state).await?;
    let db = state.db.lock().await;
    let job = db::get_job(&db, job_id)
        .map_err(|e| json_error(&e, warp::http::StatusCode::NOT_FOUND))?;
    if user.role != "admin" && job.user_id != user.id {
        return Err(json_error("Access denied: you can only access your own jobs", warp::http::StatusCode::FORBIDDEN));
    }
    Ok((user, job))
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
    let include_archived = status == Some("archived");
    let db = state.db.lock().await;
    match db::list_jobs(&db, status, limit, include_archived) {
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
    _auth: Option<String>,
    _state: AppState,
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

    let raw_filename = params.get("filename").cloned().unwrap_or_else(|| "upload.msb".to_string());

    // SECURITY: Sanitize filename — strip path components and reject null bytes
    let sanitized = std::path::Path::new(&raw_filename)
        .file_name()
        .and_then(|n| n.to_str())
        .map(|s| s.replace('\0', ""))
        .unwrap_or_else(|| "upload.msb".to_string());

    if sanitized.is_empty() || sanitized == "." || sanitized == ".." {
        return Ok(json_error("Invalid filename", warp::http::StatusCode::BAD_REQUEST));
    }
    let filename = sanitized;

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
    // SECURITY: Ownership check — users can only view their own job output
    let (_user, job) = match require_job_access(&auth, &state, job_id).await {
        Ok(r) => r,
        Err(e) => return Ok(e),
    };


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
    // SECURITY: Ownership check
    let (_user, job) = match require_job_access(&auth, &state, job_id).await {
        Ok(r) => r,
        Err(e) => return Ok(e),
    };

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
    let running_jobs = db::list_jobs(&db, Some("running"), None, true).unwrap_or_default();
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
// System Info Handler (CPU + Memory)
// ============================================================

async fn handle_system_info(
    auth: Option<String>,
    state: AppState,
) -> Result<impl warp::Reply, warp::Rejection> {
    if let Err(e) = require_auth(&auth, &state).await {
        return Ok(e);
    }

    // get_system_info() blocks for ~200ms (CPU delta sampling), so run it off the async runtime
    let info = tokio::task::spawn_blocking(crate::get_system_info)
        .await
        .map_err(|_| warp::reject::reject())?;

    match info {
        Ok(sys) => Ok(json_ok(&sys)),
        Err(e) => Ok(json_error(&format!("Failed to get system info: {}", e), warp::http::StatusCode::INTERNAL_SERVER_ERROR)),
    }
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
    // SECURITY: Ownership check
    let (_user, job) = match require_job_access(&auth, &state, job_id).await {
        Ok(r) => r,
        Err(e) => return Ok(e),
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

    // SECURITY: Ownership check
    let (_user, job) = match require_job_access(&auth, &state, job_id).await {
        Ok(r) => r,
        Err(e) => return Ok(e.into_response()),
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
        "xml" | "pvd" => "application/xml",
        "json" => "application/json",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "vtu" | "vtk" | "vtp" => "application/octet-stream",
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
// PVD Viewer Handlers
// ============================================================

/// Parse a PVD file and return timestep/variable metadata for the viewer
async fn handle_pvd_info(
    job_id: i64,
    auth: Option<String>,
    params: HashMap<String, String>,
    state: AppState,
) -> Result<impl warp::Reply, warp::Rejection> {
    // SECURITY: Ownership check
    let (_user, job) = match require_job_access(&auth, &state, job_id).await {
        Ok(r) => r,
        Err(e) => return Ok(e),
    };

    let working_dir = match &job.working_directory {
        Some(d) if !d.is_empty() => std::path::PathBuf::from(d),
        _ => return Ok(json_error("Job has no working directory", warp::http::StatusCode::NOT_FOUND)),
    };

    let out_dir = working_dir.join("out");
    let pvd_path_str = params.get("path").cloned().unwrap_or_default();
    if pvd_path_str.is_empty() {
        return Ok(json_error("Missing 'path' parameter", warp::http::StatusCode::BAD_REQUEST));
    }

    let pvd_file = out_dir.join(&pvd_path_str);

    // Security: canonicalize and verify it's within out/
    let canonical_out = match out_dir.canonicalize() {
        Ok(p) => p,
        Err(_) => return Ok(json_error("Cannot resolve output directory", warp::http::StatusCode::INTERNAL_SERVER_ERROR)),
    };
    let canonical_pvd = match pvd_file.canonicalize() {
        Ok(p) => p,
        Err(_) => return Ok(json_error("PVD file not found", warp::http::StatusCode::NOT_FOUND)),
    };
    if !canonical_pvd.starts_with(&canonical_out) {
        return Ok(json_error("Access denied", warp::http::StatusCode::FORBIDDEN));
    }

    // Read and parse the PVD XML
    let pvd_content = match tokio::fs::read_to_string(&canonical_pvd).await {
        Ok(c) => c,
        Err(e) => return Ok(json_error(&format!("Failed to read PVD: {}", e), warp::http::StatusCode::INTERNAL_SERVER_ERROR)),
    };

    // Parse PVD XML to extract datasets
    let mut timestep_map: std::collections::BTreeMap<String, Vec<serde_json::Value>> = std::collections::BTreeMap::new();
    let mut file_extension = String::new();

    for line in pvd_content.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with("<DataSet") {
            continue;
        }

        // Parse attributes from the DataSet element
        let ts = extract_xml_attr(trimmed, "timestep").unwrap_or_default();
        let file = extract_xml_attr(trimmed, "file").unwrap_or_default();
        let part = extract_xml_attr(trimmed, "part").unwrap_or_default();
        let group = extract_xml_attr(trimmed, "group").unwrap_or_default();

        if file.is_empty() || ts.is_empty() {
            continue;
        }

        if file_extension.is_empty() {
            if let Some(ext) = file.rsplit('.').next() {
                file_extension = ext.to_lowercase();
            }
        }

        let entry = timestep_map.entry(ts.clone()).or_insert_with(Vec::new);
        entry.push(serde_json::json!({
            "file": file,
            "part": part,
            "group": group,
        }));
    }

    // Build sorted unique timesteps
    let mut timesteps: Vec<serde_json::Value> = timestep_map.iter().map(|(ts, files)| {
        let ts_val: f64 = ts.parse().unwrap_or(0.0);
        serde_json::json!({
            "time": ts_val,
            "time_str": ts,
            "files": files,
        })
    }).collect();

    // Sort by actual numeric time value
    timesteps.sort_by(|a, b| {
        let ta = a["time"].as_f64().unwrap_or(0.0);
        let tb = b["time"].as_f64().unwrap_or(0.0);
        ta.partial_cmp(&tb).unwrap_or(std::cmp::Ordering::Equal)
    });

    // Try to get data array info from one representative file
    let arrays_info = if let Some(first_ts) = timesteps.first() {
        if let Some(first_file) = first_ts["files"].as_array().and_then(|a| a.first()) {
            if let Some(file_path) = first_file["file"].as_str() {
                // The file path in PVD is relative to the PVD file's directory
                let pvd_dir = canonical_pvd.parent().unwrap_or(&canonical_out);
                let data_file = pvd_dir.join(file_path);
                get_vtk_arrays_info(&data_file).await
            } else {
                None
            }
        } else {
            None
        }
    } else {
        None
    };

    Ok(json_ok(&serde_json::json!({
        "pvd_path": pvd_path_str,
        "file_type": file_extension,
        "timestep_count": timesteps.len(),
        "timesteps": timesteps,
        "arrays": arrays_info.unwrap_or_else(|| serde_json::json!([])),
    })))
}

/// Scan Output directory for all loadable visual layers (slices, surfaces, STLs — skip volumes)
async fn handle_visuals_layers(
    job_id: i64,
    auth: Option<String>,
    state: AppState,
) -> Result<impl warp::Reply, warp::Rejection> {
    // SECURITY: Ownership check
    let (_user, job) = match require_job_access(&auth, &state, job_id).await {
        Ok(r) => r,
        Err(e) => return Ok(e),
    };

    let working_dir = match &job.working_directory {
        Some(d) if !d.is_empty() => std::path::PathBuf::from(d),
        _ => return Ok(json_error("Job has no working directory", warp::http::StatusCode::NOT_FOUND)),
    };

    let out_dir = working_dir.join("out");
    let output_dir = out_dir.join("Output");

    if !output_dir.exists() {
        return Ok(json_ok(&serde_json::json!({ "layers": [] })));
    }

    let mut layers = Vec::new();

    // Scan for .pvd files in Output/
    if let Ok(entries) = std::fs::read_dir(&output_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() { continue; }
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
            if ext != "pvd" { continue; }

            let name = path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();

            // Skip volumes
            if name.starts_with("Volume") { continue; }

            // Read first DataSet line to determine referenced file type
            let mut file_type = String::from("vtp");
            if let Ok(content) = std::fs::read_to_string(&path) {
                for line in content.lines() {
                    let trimmed = line.trim();
                    if trimmed.starts_with("<DataSet") {
                        if let Some(fattr) = extract_xml_attr(trimmed, "file") {
                            if let Some(ext) = fattr.rsplit('.').next() {
                                file_type = ext.to_lowercase();
                            }
                        }
                        break;
                    }
                }
            }

            // Determine category for sorting
            let category = if name.starts_with("Slice") && (name.contains("X_") || name.contains("Y_") || name.contains("Z_")) {
                "slice"
            } else if name == "BoundaryConditions" {
                "boundary"
            } else {
                "surface"
            };

            let rel_path = format!("Output/{}", entry.file_name().to_string_lossy());
            layers.push(serde_json::json!({
                "name": name,
                "type": "pvd",
                "path": rel_path,
                "file_type": file_type,
                "category": category,
            }));
        }
    }

    // Scan recursively for .stl files in Output/
    fn find_stls(dir: &std::path::Path, base: &std::path::Path, layers: &mut Vec<serde_json::Value>) {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    find_stls(&path, base, layers);
                } else if path.extension().and_then(|e| e.to_str()) == Some("stl") {
                    let name = path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
                    let rel_path = path.strip_prefix(base).unwrap_or(&path).to_string_lossy().to_string();
                    layers.push(serde_json::json!({
                        "name": name,
                        "type": "stl",
                        "path": rel_path,
                        "file_type": "stl",
                        "category": "stl",
                    }));
                }
            }
        }
    }
    find_stls(&output_dir, &out_dir, &mut layers);

    // Sort: slices first, then boundary, then surfaces, then STLs
    layers.sort_by(|a, b| {
        let order = |v: &serde_json::Value| -> u8 {
            match v["category"].as_str().unwrap_or("") {
                "slice" => 0,
                "boundary" => 1,
                "surface" => 2,
                "stl" => 3,
                _ => 4,
            }
        };
        let oa = order(a);
        let ob = order(b);
        if oa != ob { return oa.cmp(&ob); }
        let na = a["name"].as_str().unwrap_or("");
        let nb = b["name"].as_str().unwrap_or("");
        na.cmp(nb)
    });

    Ok(json_ok(&serde_json::json!({ "layers": layers })))
}

/// Get data array information from a VTU or VTP file using the Python helper
async fn get_vtk_arrays_info(file_path: &std::path::Path) -> Option<serde_json::Value> {
    let ext = file_path.extension().and_then(|e| e.to_str()).unwrap_or("");
    let info_cmd = match ext {
        "vtu" => "info-vtu",
        "vtp" => "info-vtp",
        "vti" => "info-vti",
        _ => return None,
    };

    // Find our helper script relative to the executable
    let script_path = std::env::current_exe()
        .ok()?
        .parent()?
        .join("scripts/vtu_to_vtp.py");

    // Fallback: try relative to CWD
    let script = if script_path.exists() {
        script_path
    } else {
        std::path::PathBuf::from("scripts/vtu_to_vtp.py")
    };

    if !script.exists() {
        println!("[PVD] Warning: vtu_to_vtp.py not found at {:?}", script);
        return None;
    }

    let output = tokio::process::Command::new("python3")
        .arg(&script)
        .arg(info_cmd)
        .arg(file_path)
        .output()
        .await
        .ok()?;

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let info: serde_json::Value = serde_json::from_str(stdout.trim()).ok()?;
        info.get("arrays").cloned()
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        println!("[PVD] Array info failed: {}", stderr);
        None
    }
}

/// Extract an XML attribute value from a tag string (simple regex-free parser)
fn extract_xml_attr(tag: &str, attr_name: &str) -> Option<String> {
    let pattern = format!("{}=\"", attr_name);
    if let Some(start) = tag.find(&pattern) {
        let value_start = start + pattern.len();
        if let Some(end) = tag[value_start..].find('"') {
            return Some(tag[value_start..value_start + end].to_string());
        }
    }
    None
}

/// Serve a VTK file (VTP directly, VTU after conversion to VTP)
async fn handle_vtk_serve(
    job_id: i64,
    auth: Option<String>,
    params: HashMap<String, String>,
    state: AppState,
) -> Result<warp::reply::Response, warp::Rejection> {
    use warp::Reply;

    // SECURITY: Ownership check
    let (_user, job) = match require_job_access(&auth, &state, job_id).await {
        Ok(r) => r,
        Err(e) => return Ok(e.into_response()),
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

    // Security check
    let canonical_out = match out_dir.canonicalize() {
        Ok(p) => p,
        Err(_) => return Ok(json_error("Cannot resolve output directory", warp::http::StatusCode::INTERNAL_SERVER_ERROR).into_response()),
    };
    let canonical_target = match target.canonicalize() {
        Ok(p) => p,
        Err(_) => return Ok(json_error("File not found", warp::http::StatusCode::NOT_FOUND).into_response()),
    };
    if !canonical_target.starts_with(&canonical_out) {
        return Ok(json_error("Access denied", warp::http::StatusCode::FORBIDDEN).into_response());
    }
    if !canonical_target.is_file() {
        return Ok(json_error("Not a file", warp::http::StatusCode::BAD_REQUEST).into_response());
    }

    let ext = canonical_target.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let content = match ext.as_str() {
        "vtp" => {
            // Serve VTP directly
            match tokio::fs::read(&canonical_target).await {
                Ok(c) => c,
                Err(e) => return Ok(json_error(&format!("Failed to read VTP: {}", e),
                    warp::http::StatusCode::INTERNAL_SERVER_ERROR).into_response()),
            }
        },
        "vtu" => {
            // Convert VTU to VTP, using cache
            let cache_path = canonical_target.with_extension("vtu.converted.vtp");

            if cache_path.exists() {
                // Use cached conversion
                match tokio::fs::read(&cache_path).await {
                    Ok(c) => c,
                    Err(e) => return Ok(json_error(&format!("Failed to read cached VTP: {}", e),
                        warp::http::StatusCode::INTERNAL_SERVER_ERROR).into_response()),
                }
            } else {
                // Convert on-the-fly
                let script_path = std::path::PathBuf::from("scripts/vtu_to_vtp.py");
                if !script_path.exists() {
                    return Ok(json_error("Conversion script not found", warp::http::StatusCode::INTERNAL_SERVER_ERROR).into_response());
                }

                let result = tokio::process::Command::new("python3")
                    .arg(&script_path)
                    .arg("convert")
                    .arg(&canonical_target)
                    .arg(&cache_path)
                    .output()
                    .await;

                match result {
                    Ok(output) if output.status.success() => {
                        match tokio::fs::read(&cache_path).await {
                            Ok(c) => c,
                            Err(e) => return Ok(json_error(&format!("Failed to read converted VTP: {}", e),
                                warp::http::StatusCode::INTERNAL_SERVER_ERROR).into_response()),
                        }
                    },
                    Ok(output) => {
                        let stderr = String::from_utf8_lossy(&output.stderr);
                        return Ok(json_error(&format!("VTU conversion failed: {}", stderr),
                            warp::http::StatusCode::INTERNAL_SERVER_ERROR).into_response());
                    },
                    Err(e) => {
                        return Ok(json_error(&format!("Failed to run conversion: {}", e),
                            warp::http::StatusCode::INTERNAL_SERVER_ERROR).into_response());
                    }
                }
            }
        },
        "vti" => {
            // Convert VTI (ImageData) to VTP via Python VTK, using cache
            let cache_path = canonical_target.with_extension("vti.converted.vtp");

            if cache_path.exists() {
                match tokio::fs::read(&cache_path).await {
                    Ok(c) => c,
                    Err(e) => return Ok(json_error(&format!("Failed to read cached VTP: {}", e),
                        warp::http::StatusCode::INTERNAL_SERVER_ERROR).into_response()),
                }
            } else {
                let script_path = std::path::PathBuf::from("scripts/vtu_to_vtp.py");
                if !script_path.exists() {
                    return Ok(json_error("Conversion script not found", warp::http::StatusCode::INTERNAL_SERVER_ERROR).into_response());
                }

                let result = tokio::process::Command::new("python3")
                    .arg(&script_path)
                    .arg("convert")
                    .arg(&canonical_target)
                    .arg(&cache_path)
                    .output()
                    .await;

                match result {
                    Ok(output) if output.status.success() => {
                        match tokio::fs::read(&cache_path).await {
                            Ok(c) => c,
                            Err(e) => return Ok(json_error(&format!("Failed to read converted VTP: {}", e),
                                warp::http::StatusCode::INTERNAL_SERVER_ERROR).into_response()),
                        }
                    },
                    Ok(output) => {
                        let stderr = String::from_utf8_lossy(&output.stderr);
                        return Ok(json_error(&format!("VTI conversion failed: {}", stderr),
                            warp::http::StatusCode::INTERNAL_SERVER_ERROR).into_response());
                    },
                    Err(e) => {
                        return Ok(json_error(&format!("Failed to run conversion: {}", e),
                            warp::http::StatusCode::INTERNAL_SERVER_ERROR).into_response());
                    }
                }
            }
        },
        "stl" => {
            // Serve STL directly (binary mesh format)
            match tokio::fs::read(&canonical_target).await {
                Ok(c) => c,
                Err(e) => return Ok(json_error(&format!("Failed to read STL: {}", e),
                    warp::http::StatusCode::INTERNAL_SERVER_ERROR).into_response()),
            }
        },
        _ => {
            return Ok(json_error(&format!("Unsupported file type: {}", ext),
                warp::http::StatusCode::BAD_REQUEST).into_response());
        }
    };

    // Return with CORS-friendly headers for fetch from the browser
    Ok(warp::reply::with_header(
        warp::reply::with_header(
            warp::reply::with_status(content, warp::http::StatusCode::OK),
            "Content-Type", "application/octet-stream"
        ),
        "Cache-Control", "public, max-age=3600"
    ).into_response())
}

// ============================================================
// Version Handlers
// ============================================================

async fn handle_list_versions(
    auth: Option<String>,
    state: AppState,
) -> Result<impl warp::Reply, warp::Rejection> {
    // SECURITY: Require authentication to list versions (prevents information leak)
    if let Err(e) = require_auth(&auth, &state).await {
        return Ok(e);
    }
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
// Admin: M-Star Version Installer
// ============================================================

async fn handle_install_version(
    auth: Option<String>,
    state: AppState,
) -> Result<impl warp::Reply, warp::Rejection> {
    // Require admin role
    let user = match require_auth(&auth, &state).await {
        Ok(u) => u,
        Err(e) => return Ok(e),
    };
    if user.role != "admin" {
        return Ok(json_error("Admin access required", warp::http::StatusCode::FORBIDDEN));
    }

    let install_dir = state.config.paths.mstar_install_dir.clone();
    let install_dir_str = install_dir.to_string_lossy().to_string();

    // Run download-latest.sh
    let download_script = install_dir.join("download-latest.sh");
    if !download_script.exists() {
        return Ok(json_error(
            &format!("Download script not found at {}", download_script.display()),
            warp::http::StatusCode::INTERNAL_SERVER_ERROR,
        ));
    }

    println!("[ADMIN] User '{}' triggered M-Star version install", user.username);

    let download_result = tokio::process::Command::new("bash")
        .arg(&download_script)
        .env("MSTAR_INSTALL_DIR", &install_dir_str)
        .current_dir(&install_dir)
        .output()
        .await;

    let download_output = match download_result {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            if !output.status.success() {
                println!("[ADMIN] Download script failed: {}", stderr);
                return Ok(json_error(
                    &format!("Download failed: {}{}", stdout, stderr),
                    warp::http::StatusCode::INTERNAL_SERVER_ERROR,
                ));
            }
            println!("[ADMIN] Download script succeeded");
            stdout
        }
        Err(e) => {
            return Ok(json_error(
                &format!("Failed to run download script: {}", e),
                warp::http::StatusCode::INTERNAL_SERVER_ERROR,
            ));
        }
    };

    // Run update-latest-symlink.sh
    let symlink_script = install_dir.join("update-latest-symlink.sh");
    let symlink_output = if symlink_script.exists() {
        match tokio::process::Command::new("bash")
            .arg(&symlink_script)
            .env("MSTAR_INSTALL_DIR", &install_dir_str)
            .current_dir(&install_dir)
            .output()
            .await
        {
            Ok(output) => {
                let stdout = String::from_utf8_lossy(&output.stdout).to_string();
                let stderr = String::from_utf8_lossy(&output.stderr).to_string();
                if !output.status.success() {
                    println!("[ADMIN] Symlink script warning: {}", stderr);
                }
                stdout
            }
            Err(e) => format!("Symlink script error: {}", e),
        }
    } else {
        "Symlink script not found, skipped".to_string()
    };

    // Refresh the versions list
    let new_versions = mstar_versions::discover_versions(&state.config.paths.mstar_install_dir);
    let version_count = new_versions.len();
    let latest_version = new_versions.iter()
        .find(|v| v.is_latest)
        .map(|v| v.version.clone())
        .unwrap_or_else(|| "unknown".to_string());
    *state.versions.lock().await = new_versions;

    println!("[ADMIN] Version install complete. Latest: {}. Total versions: {}", latest_version, version_count);

    Ok(json_ok(&serde_json::json!({
        "success": true,
        "latest_version": latest_version,
        "total_versions": version_count,
        "download_output": download_output,
        "symlink_output": symlink_output,
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
    /// Specific checkpoint number to restart from. If None, uses --load-last.
    #[serde(default)]
    checkpoint_number: Option<i64>,
    /// Override: GPU IDs as JSON array string, e.g. "[0,2]"
    #[serde(default)]
    gpu_ids: Option<String>,
    /// Override: M-Star version to use
    #[serde(default)]
    mstar_version: Option<String>,
    /// Override: Job priority
    #[serde(default)]
    priority: Option<i32>,
    /// Override: Whether to enable unified memory
    #[serde(default)]
    unified_memory: Option<bool>,
    /// Override: Path to copy results to
    #[serde(default)]
    copy_to_path: Option<String>,
}

async fn handle_restart_job(
    job_id: i64,
    auth: Option<String>,
    body: RestartRequest,
    state: AppState,
) -> Result<impl warp::Reply, warp::Rejection> {
    // SECURITY: Ownership check — only job owner or admin can restart
    let (_user, _job) = match require_job_access(&auth, &state, job_id).await {
        Ok(r) => r,
        Err(e) => return Ok(e),
    };

    // Build restart_options JSON that includes checkpoint_number if specified
    let opts = {
        let mut base = match &body.restart_options {
            Some(v) => v.clone(),
            None => serde_json::json!({}),
        };
        if let Some(cp) = body.checkpoint_number {
            base["checkpoint_number"] = serde_json::json!(cp);
        }
        base
    };

    let opts_str = serde_json::to_string(&opts).unwrap_or_else(|_| "{}".to_string());

    let db = state.db.lock().await;
    match db::create_restart_job(
        &db,
        job_id,
        Some(&opts_str),
        body.gpu_ids.as_deref(),
        body.mstar_version.as_deref(),
        body.priority,
        body.unified_memory,
        body.copy_to_path.as_deref(),
    ) {
        Ok(new_id) => {
            let cp_msg = match body.checkpoint_number {
                Some(n) => format!(" from checkpoint {}", n),
                None => " from latest checkpoint".to_string(),
            };
            println!("[API] Created restart job {} from failed job {}{}", new_id, job_id, cp_msg);
            Ok(json_ok(&serde_json::json!({
                "message": format!("Restart job created (#{}) from job #{}{}", new_id, job_id, cp_msg),
                "new_job_id": new_id,
                "original_job_id": job_id,
            })))
        }
        Err(e) => Ok(json_error(&e, warp::http::StatusCode::BAD_REQUEST)),
    }
}

// ============================================================
// Job Archive Handlers
// ============================================================

async fn handle_archive_job(
    job_id: i64,
    auth: Option<String>,
    state: AppState,
) -> Result<impl warp::Reply, warp::Rejection> {
    // SECURITY: Ownership check — only job owner or admin can archive
    let (_user, _job) = match require_job_access(&auth, &state, job_id).await {
        Ok(r) => r,
        Err(e) => return Ok(e),
    };

    let db = state.db.lock().await;
    match db::archive_job(&db, job_id) {
        Ok(()) => {
            println!("[API] Archived job {}", job_id);
            Ok(json_ok(&serde_json::json!({ "message": format!("Job #{} archived", job_id) })))
        }
        Err(e) => Ok(json_error(&e, warp::http::StatusCode::BAD_REQUEST)),
    }
}

async fn handle_archive_all_failed(
    auth: Option<String>,
    state: AppState,
) -> Result<impl warp::Reply, warp::Rejection> {
    // SECURITY: Only admins can bulk-archive all failed jobs
    let user = match require_auth(&auth, &state).await {
        Ok(u) => u,
        Err(e) => return Ok(e),
    };
    if user.role != "admin" {
        return Ok(json_error("Admin access required for bulk archive", warp::http::StatusCode::FORBIDDEN));
    }

    let db = state.db.lock().await;
    match db::archive_all_failed(&db) {
        Ok(count) => {
            println!("[API] Archived {} failed jobs", count);
            Ok(json_ok(&serde_json::json!({
                "message": format!("{} failed job(s) archived", count),
                "archived_count": count,
            })))
        }
        Err(e) => Ok(json_error(&e, warp::http::StatusCode::INTERNAL_SERVER_ERROR)),
    }
}

// ============================================================
// Checkpoint Listing Handler
// ============================================================

async fn handle_list_checkpoints(
    job_id: i64,
    auth: Option<String>,
    state: AppState,
) -> Result<impl warp::Reply, warp::Rejection> {
    // SECURITY: Ownership check
    let (_user, job) = match require_job_access(&auth, &state, job_id).await {
        Ok(r) => r,
        Err(e) => return Ok(e),
    };

    let work_dir = match &job.working_directory {
        Some(d) => d.clone(),
        None => return Ok(json_ok(&serde_json::json!({ "checkpoints": [] }))),
    };

    let checkpoint_dir = std::path::Path::new(&work_dir).join("out").join("Checkpoint");
    if !checkpoint_dir.exists() {
        return Ok(json_ok(&serde_json::json!({ "checkpoints": [] })));
    }

    let mut checkpoints = Vec::new();

    if let Ok(entries) = std::fs::read_dir(&checkpoint_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            // Checkpoint directories are typically numbered (e.g., "0", "1", "2", ...)
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                if let Ok(num) = name.parse::<i64>() {
                    let modified = path.metadata()
                        .and_then(|m| m.modified())
                        .ok()
                        .map(|t| {
                            let datetime: chrono::DateTime<chrono::Utc> = t.into();
                            datetime.format("%Y-%m-%d %H:%M:%S").to_string()
                        })
                        .unwrap_or_default();

                    checkpoints.push(serde_json::json!({
                        "number": num,
                        "modified": modified,
                        "is_dir": path.is_dir(),
                    }));
                }
            }
        }
    }

    // Sort by checkpoint number descending (most recent first)
    checkpoints.sort_by(|a, b| {
        let na = a["number"].as_i64().unwrap_or(0);
        let nb = b["number"].as_i64().unwrap_or(0);
        nb.cmp(&na)
    });

    Ok(json_ok(&serde_json::json!({ "checkpoints": checkpoints })))
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
    // SECURITY: Ownership check
    let (_user, job) = match require_job_access(&auth, &state, job_id).await {
        Ok(r) => r,
        Err(e) => return Ok(e),
    };

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
    // SECURITY: Ownership check
    let (_user, job) = match require_job_access(&auth, &state, job_id).await {
        Ok(r) => r,
        Err(e) => return Ok(e),
    };

    // Sanitize filename — prevent directory traversal
    let safe_filename = std::path::Path::new(&filename)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");
    if safe_filename.is_empty() || safe_filename.contains("..") {
        return Ok(json_error("Invalid filename", warp::http::StatusCode::BAD_REQUEST));
    }

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

/// Browse the server filesystem for MSB files (restricted to configured data_root)
async fn handle_browse(
    auth: Option<String>,
    params: HashMap<String, String>,
    state: AppState,
) -> Result<impl warp::Reply, warp::Rejection> {
    if let Err(e) = require_auth(&auth, &state).await {
        return Ok(e);
    }

    let browse_root = state.config.paths.data_root.to_str().unwrap_or("/");
    let requested_path = params.get("path").cloned().unwrap_or_else(|| browse_root.to_string());
    let mode = params.get("mode").cloned().unwrap_or_else(|| "all".to_string()); // "all", "dirs", "msb"

    // Security: ensure the path is under the configured data_root and canonicalize
    let canonical = match std::fs::canonicalize(&requested_path) {
        Ok(p) => p,
        Err(_) => {
            // Path doesn't exist — try the browse root
            return Ok(json_error("Path not found", warp::http::StatusCode::NOT_FOUND));
        }
    };

    if !canonical.starts_with(browse_root) {
        return Ok(json_error(&format!("Access denied: path must be under {}", browse_root), warp::http::StatusCode::FORBIDDEN));
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

                    let file_type = match entry.file_type() {
                        Ok(ft) => ft,
                        Err(_) => match std::fs::metadata(entry.path()) {
                            Ok(m) => m.file_type(),
                            Err(_) => continue, // Skip unreadable entries (e.g., dangling symlinks)
                        },
                    };
                    let is_dir = file_type.is_dir();
                    let is_msb = !is_dir && (name.to_lowercase().ends_with(".msb"));
                    let is_pvsm = !is_dir && (name.to_lowercase().ends_with(".pvsm"));

                    // Filter based on mode
                    let include = match mode.as_str() {
                        "dirs" => is_dir,
                        "msb" => is_dir || is_msb,
                        "pvsm" => is_dir || is_pvsm,
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
                        "is_pvsm": is_pvsm,
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

/// Create a new directory (restricted to configured data_root)
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

    // SECURITY: Resolve the path to catch traversal attacks
    // We canonicalize the parent (which must exist) and append the leaf name
    let data_root = state.config.paths.data_root.to_str().unwrap_or("/");
    let requested = std::path::Path::new(&path);
    let parent = match requested.parent() {
        Some(p) => p,
        None => return Ok(json_error("Invalid path", warp::http::StatusCode::BAD_REQUEST)),
    };

    // The parent must exist and resolve under the configured data_root
    let canonical_parent = match std::fs::canonicalize(parent) {
        Ok(p) => p,
        Err(_) => return Ok(json_error("Parent directory does not exist", warp::http::StatusCode::BAD_REQUEST)),
    };

    if !canonical_parent.starts_with(data_root) {
        return Ok(json_error(&format!("Path must be under {}", data_root), warp::http::StatusCode::FORBIDDEN));
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

// ============================================================
// Render Job Handlers
// ============================================================

#[derive(Deserialize)]
struct RenderRequest {
    /// ID of the completed simulation job to render (optional if source_path given)
    #[serde(default)]
    source_job_id: Option<i64>,
    /// Direct path to simulation data directory (alternative to source_job_id)
    #[serde(default)]
    source_path: Option<String>,
    /// Name for the render job
    #[serde(default)]
    name: Option<String>,
    /// Path to the .pvsm state file (absolute path or relative to source dir)
    state_file: String,
    /// M-Star version to use for pvpython (determines which ParaView binary)
    #[serde(default = "default_render_version")]
    mstar_version: String,
    /// GPU ID to use for rendering
    #[serde(default)]
    gpu_id: i32,
    /// Resolution as [width, height], or null for state file resolution
    #[serde(default)]
    resolution: Option<Vec<i32>>,
    /// Framerate (default: 25)
    #[serde(default = "default_fps")]
    fps: i32,
    /// Video quality CRF value 0-51 (default: 23)
    #[serde(default = "default_crf")]
    video_quality: i32,
    /// Use transparent background
    #[serde(default)]
    transparent: bool,
    /// PNG compression 0-9
    #[serde(default)]
    compression: i32,
    /// Render each view as separate file
    #[serde(default)]
    separate_views: bool,
    /// Scale fonts with resolution
    #[serde(default)]
    scale_fonts: bool,
    /// Generate MP4 video from frames
    #[serde(default = "default_true_bool")]
    generate_video: bool,
}

fn default_render_version() -> String { "latest".to_string() }
fn default_fps() -> i32 { 25 }
fn default_crf() -> i32 { 23 }
fn default_true_bool() -> bool { true }

async fn handle_render_submit(
    auth: Option<String>,
    body: RenderRequest,
    state: AppState,
) -> Result<impl warp::Reply, warp::Rejection> {
    // SECURITY: Authenticate user
    let user = match require_auth(&auth, &state).await {
        Ok(u) => u,
        Err(e) => return Ok(e),
    };

    // Determine source: either from a job ID or a direct path
    let (source_work_dir, source_job_id_for_db, source_name, source_label) = if let Some(job_id) = body.source_job_id {
        // Source from a job
        let source_job = {
            let db = state.db.lock().await;
            match db::get_job(&db, job_id) {
                Ok(j) => j,
                Err(e) => return Ok(json_error(&format!("Source job not found: {}", e), warp::http::StatusCode::NOT_FOUND)),
            }
        };

        // SECURITY: Verify the user owns the source job (or is admin)
        if user.role != "admin" && source_job.user_id != user.id {
            return Ok(json_error("Access denied: you can only render your own jobs", warp::http::StatusCode::FORBIDDEN));
        }

        let work_dir = match &source_job.working_directory {
            Some(d) => d.clone(),
            None => return Ok(json_error("Source job has no working directory", warp::http::StatusCode::BAD_REQUEST)),
        };

        let label = source_job.msb_filename.clone();
        (work_dir, Some(job_id), source_job.name.clone(), label)
    } else if let Some(ref path_str) = body.source_path {
        // Source from a direct network path
        // SECURITY: Validate the path is under the data root
        let browse_root = state.config.paths.data_root.to_str().unwrap_or("/");
        let canonical = match std::fs::canonicalize(path_str) {
            Ok(p) => p,
            Err(_) => return Ok(json_error("Source path not found", warp::http::StatusCode::BAD_REQUEST)),
        };
        if !canonical.starts_with(browse_root) {
            return Ok(json_error(&format!("Source path must be under {}", browse_root), warp::http::StatusCode::FORBIDDEN));
        }
        if !canonical.is_dir() {
            return Ok(json_error("Source path must be a directory", warp::http::StatusCode::BAD_REQUEST));
        }

        let dir_name = canonical.file_name().and_then(|n| n.to_str()).unwrap_or("unknown").to_string();
        let label = canonical.to_str().unwrap_or(path_str).to_string();
        (canonical.to_str().unwrap_or("").to_string(), None, dir_name, label)
    } else {
        return Ok(json_error("Either source_job_id or source_path is required", warp::http::StatusCode::BAD_REQUEST));
    };

    // Validate source has output data
    let out_dir = std::path::Path::new(&source_work_dir).join("out");
    if !out_dir.is_dir() {
        return Ok(json_error("Source has no output data (out/ directory missing)", warp::http::StatusCode::BAD_REQUEST));
    }

    // Validate and resolve state file path
    // SECURITY: For job-based sources, state file must be under job dir
    //           For path-based sources, state file can be absolute (must be under data root)
    let state_file_path = {
        let raw = std::path::Path::new(&body.state_file);
        let resolved = if raw.is_absolute() {
            raw.to_path_buf()
        } else {
            std::path::Path::new(&source_work_dir).join(raw)
        };

        match std::fs::canonicalize(&resolved) {
            Ok(canonical) => {
                // For job-based sources, ensure state file is under the job's working directory
                if body.source_job_id.is_some() {
                    let work_dir_canonical = match std::fs::canonicalize(&source_work_dir) {
                        Ok(c) => c,
                        Err(e) => return Ok(json_error(&format!("Cannot resolve working directory: {}", e), warp::http::StatusCode::INTERNAL_SERVER_ERROR)),
                    };
                    if !canonical.starts_with(&work_dir_canonical) {
                        return Ok(json_error("State file must be within the job's working directory", warp::http::StatusCode::FORBIDDEN));
                    }
                } else {
                    // For path-based sources, ensure state file is under data root
                    let browse_root = state.config.paths.data_root.to_str().unwrap_or("/");
                    if !canonical.starts_with(browse_root) {
                        return Ok(json_error("State file must be under the data root", warp::http::StatusCode::FORBIDDEN));
                    }
                }
                canonical
            }
            Err(e) => return Ok(json_error(&format!("State file not found: {}", e), warp::http::StatusCode::BAD_REQUEST)),
        }
    };

    if !state_file_path.extension().map_or(false, |ext| ext == "pvsm") {
        return Ok(json_error("State file must have .pvsm extension", warp::http::StatusCode::BAD_REQUEST));
    }

    // Validate render parameters
    if body.fps < 1 || body.fps > 120 {
        return Ok(json_error("FPS must be between 1 and 120", warp::http::StatusCode::BAD_REQUEST));
    }
    if body.video_quality < 0 || body.video_quality > 51 {
        return Ok(json_error("Video quality (CRF) must be between 0 and 51", warp::http::StatusCode::BAD_REQUEST));
    }
    if body.compression < 0 || body.compression > 9 {
        return Ok(json_error("Compression must be between 0 and 9", warp::http::StatusCode::BAD_REQUEST));
    }
    if body.gpu_id < 0 {
        return Ok(json_error("GPU ID must be non-negative", warp::http::StatusCode::BAD_REQUEST));
    }
    if let Some(ref res) = body.resolution {
        if res.len() != 2 || res[0] <= 0 || res[1] <= 0 {
            return Ok(json_error("Resolution must be [width, height] with positive values", warp::http::StatusCode::BAD_REQUEST));
        }
    }

    // Build render name
    let render_name = body.name.clone().unwrap_or_else(|| {
        format!("Render: {}", source_name)
    });

    // Build render options JSON for storage and later use by the queue daemon
    let render_options = serde_json::json!({
        "state_file": state_file_path.to_str().unwrap_or(""),
        "source_work_dir": source_work_dir,
        "gpu_id": body.gpu_id,
        "resolution": body.resolution,
        "fps": body.fps,
        "video_quality": body.video_quality,
        "transparent": body.transparent,
        "compression": body.compression,
        "separate_views": body.separate_views,
        "scale_fonts": body.scale_fonts,
        "generate_video": body.generate_video,
        "render_name": render_name.replace(" ", "_").replace("/", "_"),
    });
    let render_options_str = serde_json::to_string(&render_options)
        .unwrap_or_else(|_| "{}".to_string());

    // GPU IDs as JSON array
    let gpu_ids_str = format!("[{}]", body.gpu_id);

    let db = state.db.lock().await;
    match db::create_render_job(
        &db,
        user.id,
        &render_name,
        source_job_id_for_db,
        &source_label,
        &body.mstar_version,
        &gpu_ids_str,
        &render_options_str,
    ) {
        Ok(job_id) => Ok(json_ok(&serde_json::json!({
            "message": "Render job created",
            "job_id": job_id,
            "source_job_id": source_job_id_for_db,
        }))),
        Err(e) => Ok(json_error(&e, warp::http::StatusCode::INTERNAL_SERVER_ERROR)),
    }
}

async fn handle_render_status(
    job_id: i64,
    auth: Option<String>,
    state: AppState,
) -> Result<impl warp::Reply, warp::Rejection> {
    // SECURITY: Ownership check
    let (_user, job) = match require_job_access(&auth, &state, job_id).await {
        Ok(r) => r,
        Err(e) => return Ok(e),
    };

    // Verify this is a render job
    if job.job_type != "render" {
        return Ok(json_error("Not a render job", warp::http::StatusCode::BAD_REQUEST));
    }

    // Read render_status.json from the render output directory
    let work_dir = match &job.working_directory {
        Some(d) => d.clone(),
        None => {
            // Job hasn't started yet — return queued status
            return Ok(json_ok(&serde_json::json!({
                "job_status": job.status,
                "state": "queued",
                "current_frame": 0,
                "total_frames": 0,
                "percent": 0,
                "elapsed_seconds": 0,
                "eta_seconds": 0,
                "error": null,
                "video_file": null,
            })));
        }
    };

    let status_file = std::path::Path::new(&work_dir).join("render_status.json");

    // IMPORTANT: The DB job status is the authoritative source of truth.
    // The render_status.json file may be stale (e.g., process crashed at frame 13/40
    // and never updated the file). We always overlay the DB status onto the response.
    let db_status = &job.status;
    let db_error = &job.error_message;

    match tokio::fs::read_to_string(&status_file).await {
        Ok(content) => {
            match serde_json::from_str::<serde_json::Value>(&content) {
                Ok(mut status) => {
                    // Overlay the authoritative DB status
                    if let Some(obj) = status.as_object_mut() {
                        obj.insert("job_status".to_string(), serde_json::json!(db_status));

                        // If the DB says the job failed, override the file's state
                        if db_status == "failed" {
                            obj.insert("state".to_string(), serde_json::json!("failed"));
                            if let Some(err) = db_error {
                                obj.insert("error".to_string(), serde_json::json!(err));
                            }
                        } else if db_status == "completed" {
                            obj.insert("state".to_string(), serde_json::json!("completed"));
                        }
                    }
                    Ok(json_ok(&status))
                }
                Err(_) => Ok(json_ok(&serde_json::json!({
                    "job_status": db_status,
                    "state": if db_status == "failed" { "failed" } else { "unknown" },
                    "error": db_error.as_deref().unwrap_or("Invalid status file format"),
                }))),
            }
        }
        Err(_) => {
            // Status file doesn't exist yet — job may be starting or may have failed
            // before writing the file
            Ok(json_ok(&serde_json::json!({
                "job_status": db_status,
                "state": db_status,
                "current_frame": 0,
                "total_frames": 0,
                "percent": 0,
                "error": db_error,
            })))
        }
    }
}

async fn handle_upload_state_file(
    job_id: i64,
    auth: Option<String>,
    form: warp::multipart::FormData,
    state: AppState,
) -> Result<impl warp::Reply, warp::Rejection> {
    use futures::TryStreamExt;
    use bytes::Buf;

    // SECURITY: Ownership check
    let (_user, job) = match require_job_access(&auth, &state, job_id).await {
        Ok(r) => r,
        Err(e) => return Ok(e),
    };

    let work_dir = match &job.working_directory {
        Some(d) => d.clone(),
        None => return Ok(json_error("Job has no working directory", warp::http::StatusCode::BAD_REQUEST)),
    };

    // Create state_files subdirectory
    let states_dir = std::path::Path::new(&work_dir).join("state_files");
    if let Err(e) = tokio::fs::create_dir_all(&states_dir).await {
        return Ok(json_error(&format!("Failed to create state files directory: {}", e),
                             warp::http::StatusCode::INTERNAL_SERVER_ERROR));
    }

    let mut parts = form;
    let mut uploaded_files = Vec::new();

    while let Ok(Some(mut part)) = parts.try_next().await {
        let raw_filename = part.filename()
            .map(|s| s.to_string())
            .unwrap_or_else(|| "state.pvsm".to_string());

        // SECURITY: Sanitize filename — strip path components, allow only safe chars
        let safe_filename = {
            let basename = std::path::Path::new(&raw_filename)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("state.pvsm");

            // Only allow alphanumeric, dash, underscore, dot
            let sanitized: String = basename.chars()
                .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '_' })
                .collect();

            // Ensure .pvsm extension
            if !sanitized.ends_with(".pvsm") {
                format!("{}.pvsm", sanitized)
            } else {
                sanitized
            }
        };

        // Read file data from part stream
        let mut file_data = Vec::new();
        while let Some(Ok(mut chunk)) = part.data().await {
            while chunk.has_remaining() {
                let bytes = chunk.chunk();
                file_data.extend_from_slice(bytes);
                let len = bytes.len();
                chunk.advance(len);
            }
        }

        // Size validation (max 500 MB)
        if file_data.len() > 500 * 1024 * 1024 {
            return Ok(json_error("State file too large (max 500 MB)", warp::http::StatusCode::BAD_REQUEST));
        }

        let dest_path = states_dir.join(&safe_filename);
        if let Err(e) = tokio::fs::write(&dest_path, &file_data).await {
            return Ok(json_error(&format!("Failed to write state file: {}", e),
                                 warp::http::StatusCode::INTERNAL_SERVER_ERROR));
        }

        uploaded_files.push(serde_json::json!({
            "filename": safe_filename,
            "size": file_data.len(),
            "path": dest_path.to_str().unwrap_or(""),
        }));
    }

    if uploaded_files.is_empty() {
        return Ok(json_error("No files uploaded", warp::http::StatusCode::BAD_REQUEST));
    }

    Ok(json_ok(&serde_json::json!({
        "message": format!("Uploaded {} state file(s)", uploaded_files.len()),
        "files": uploaded_files,
    })))
}

async fn handle_list_state_files(
    job_id: i64,
    auth: Option<String>,
    state: AppState,
) -> Result<impl warp::Reply, warp::Rejection> {
    // SECURITY: Ownership check
    let (_user, job) = match require_job_access(&auth, &state, job_id).await {
        Ok(r) => r,
        Err(e) => return Ok(e),
    };

    let work_dir = match &job.working_directory {
        Some(d) => d.clone(),
        None => return Ok(json_ok(&serde_json::json!({ "state_files": [] }))),
    };

    let states_dir = std::path::Path::new(&work_dir).join("state_files");

    let mut state_files = Vec::new();

    if states_dir.is_dir() {
        if let Ok(entries) = std::fs::read_dir(&states_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().map_or(false, |ext| ext == "pvsm") {
                    let filename = path.file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("unknown")
                        .to_string();
                    let size = path.metadata().map(|m| m.len()).unwrap_or(0);
                    state_files.push(serde_json::json!({
                        "filename": filename,
                        "path": path.to_str().unwrap_or(""),
                        "size": size,
                    }));
                }
            }
        }
    }

    // Also check out/Output for any .pvsm files that may have been generated by the solver
    let output_dir = std::path::Path::new(&work_dir).join("out").join("Output");
    if output_dir.is_dir() {
        if let Ok(entries) = std::fs::read_dir(&output_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().map_or(false, |ext| ext == "pvsm") {
                    let filename = path.file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("unknown")
                        .to_string();
                    let size = path.metadata().map(|m| m.len()).unwrap_or(0);
                    state_files.push(serde_json::json!({
                        "filename": filename,
                        "path": path.to_str().unwrap_or(""),
                        "size": size,
                        "source": "output",
                    }));
                }
            }
        }
    }

    Ok(json_ok(&serde_json::json!({
        "state_files": state_files,
    })))
}

// ============================================================
// AI Training Handlers
// ============================================================

/// GET /api/ai/datasets — list datasets for the authenticated user
async fn handle_ai_list_datasets(
    auth: Option<String>,
    state: AppState,
) -> Result<impl warp::Reply, warp::Rejection> {
    if !state.config.ai_training.enabled {
        return Ok(json_error("AI training is not enabled", warp::http::StatusCode::SERVICE_UNAVAILABLE));
    }

    let token = match extract_token(auth) {
        Some(t) => t,
        None => return Ok(json_error("Authentication required", warp::http::StatusCode::UNAUTHORIZED)),
    };

    let db = state.db.lock().await;
    let user = match db::validate_session(&db, &token) {
        Ok(u) => u,
        Err(_) => return Ok(json_error("Invalid session", warp::http::StatusCode::UNAUTHORIZED)),
    };

    // Admins see all; users see their own
    let user_filter = if user.role == "admin" { None } else { Some(user.id) };
    let datasets = ai_training::list_datasets(&db, user_filter);

    Ok(json_ok(&serde_json::json!({ "datasets": datasets })))
}

/// POST /api/ai/datasets — create a new AI dataset
async fn handle_ai_create_dataset(
    auth: Option<String>,
    body: CreateAiDatasetRequest,
    state: AppState,
) -> Result<impl warp::Reply, warp::Rejection> {
    if !state.config.ai_training.enabled {
        return Ok(json_error("AI training is not enabled", warp::http::StatusCode::SERVICE_UNAVAILABLE));
    }

    let token = match extract_token(auth) {
        Some(t) => t,
        None => return Ok(json_error("Authentication required", warp::http::StatusCode::UNAUTHORIZED)),
    };

    let db = state.db.lock().await;
    let user = match db::validate_session(&db, &token) {
        Ok(u) => u,
        Err(_) => return Ok(json_error("Invalid session", warp::http::StatusCode::UNAUTHORIZED)),
    };

    // Validate sweep_root path against data_root + jobs_directory
    let mut training_roots = state.config.ai_training.allowed_training_roots.clone();
    // Also allow paths under the jobs directory (where sweeps are stored)
    if let Some(jobs_dir) = state.config.paths.jobs_directory.to_str() {
        training_roots.push(jobs_dir.to_string());
    }
    if let Err(e) = ai_training::validate_training_path(
        &body.sweep_root,
        &state.config.paths.data_root,
        &training_roots,
    ) {
        return Ok(json_error(&format!("Invalid sweep root: {}", e), warp::http::StatusCode::BAD_REQUEST));
    }

    let config_json = body.config.map(|v| v.to_string());

    let dataset_id = match ai_training::create_dataset(
        &db,
        user.id,
        &body.name,
        &body.sweep_root,
        "",  // dataset_mode is now empty — inventory scan determines what's available
        config_json.as_deref(),
    ) {
        Ok(id) => id,
        Err(e) => return Ok(json_error(&e, warp::http::StatusCode::INTERNAL_SERVER_ERROR)),
    };

    // Drop the DB lock before spawning background scan
    drop(db);

    // Trigger background scan
    let scan_root = body.sweep_root.clone();
    let scan_db = state.db.clone();
    tokio::spawn(async move {
        run_dataset_scan(scan_db, dataset_id, &scan_root).await;
    });

    Ok(json_ok(&serde_json::json!({
        "id": dataset_id,
        "message": "Dataset created — scanning output data",
        "status": "scanning"
    })))
}

/// GET /api/ai/datasets/:id — get a single dataset
async fn handle_ai_get_dataset(
    id: i64,
    auth: Option<String>,
    state: AppState,
) -> Result<impl warp::Reply, warp::Rejection> {
    if !state.config.ai_training.enabled {
        return Ok(json_error("AI training is not enabled", warp::http::StatusCode::SERVICE_UNAVAILABLE));
    }

    let token = match extract_token(auth) {
        Some(t) => t,
        None => return Ok(json_error("Authentication required", warp::http::StatusCode::UNAUTHORIZED)),
    };

    let db = state.db.lock().await;
    let user = match db::validate_session(&db, &token) {
        Ok(u) => u,
        Err(_) => return Ok(json_error("Invalid session", warp::http::StatusCode::UNAUTHORIZED)),
    };

    let datasets = ai_training::list_datasets(&db, None);
    match datasets.into_iter().find(|d| d.id == id) {
        Some(ds) => {
            if user.role != "admin" && ds.user_id != user.id {
                return Ok(json_error("Forbidden", warp::http::StatusCode::FORBIDDEN));
            }
            Ok(json_ok(&ds))
        }
        None => Ok(json_error("Dataset not found", warp::http::StatusCode::NOT_FOUND)),
    }
}

/// POST /api/ai/datasets/:id/rescan — re-scan dataset inventory
async fn handle_ai_rescan_dataset(
    id: i64,
    auth: Option<String>,
    state: AppState,
) -> Result<impl warp::Reply, warp::Rejection> {
    if !state.config.ai_training.enabled {
        return Ok(json_error("AI training is not enabled", warp::http::StatusCode::SERVICE_UNAVAILABLE));
    }

    let token = match extract_token(auth) {
        Some(t) => t,
        None => return Ok(json_error("Authentication required", warp::http::StatusCode::UNAUTHORIZED)),
    };

    let db = state.db.lock().await;
    let user = match db::validate_session(&db, &token) {
        Ok(u) => u,
        Err(_) => return Ok(json_error("Invalid session", warp::http::StatusCode::UNAUTHORIZED)),
    };

    let datasets = ai_training::list_datasets(&db, None);
    let ds = match datasets.into_iter().find(|d| d.id == id) {
        Some(ds) => {
            if user.role != "admin" && ds.user_id != user.id {
                return Ok(json_error("Forbidden", warp::http::StatusCode::FORBIDDEN));
            }
            ds
        }
        None => return Ok(json_error("Dataset not found", warp::http::StatusCode::NOT_FOUND)),
    };

    // Set status to scanning
    let _ = ai_training::update_dataset_status(&db, id, "scanning", None, None, None);
    drop(db);

    // Trigger background scan
    let scan_root = ds.sweep_root.clone();
    let scan_db = state.db.clone();
    tokio::spawn(async move {
        run_dataset_scan(scan_db, id, &scan_root).await;
    });

    Ok(json_ok(&serde_json::json!({
        "id": id,
        "message": "Re-scanning dataset",
        "status": "scanning"
    })))
}

/// POST /api/ai/datasets/:id/prepare — compute derived fields and export as VTK
async fn handle_ai_prepare_dataset(
    id: i64,
    auth: Option<String>,
    body: serde_json::Value,
    state: AppState,
) -> Result<impl warp::Reply, warp::Rejection> {
    if !state.config.ai_training.enabled {
        return Ok(json_error("AI training is not enabled", warp::http::StatusCode::SERVICE_UNAVAILABLE));
    }

    let token = match extract_token(auth) {
        Some(t) => t,
        None => return Ok(json_error("Authentication required", warp::http::StatusCode::UNAUTHORIZED)),
    };

    let db = state.db.lock().await;
    let user = match db::validate_session(&db, &token) {
        Ok(u) => u,
        Err(_) => return Ok(json_error("Invalid session", warp::http::StatusCode::UNAUTHORIZED)),
    };

    let datasets = ai_training::list_datasets(&db, None);
    let ds = match datasets.into_iter().find(|d| d.id == id) {
        Some(ds) => {
            if user.role != "admin" && ds.user_id != user.id {
                return Ok(json_error("Forbidden", warp::http::StatusCode::FORBIDDEN));
            }
            ds
        }
        None => return Ok(json_error("Dataset not found", warp::http::StatusCode::NOT_FOUND)),
    };

    // Set status to preparing
    let _ = ai_training::update_dataset_status(&db, id, "preparing", None, None, None);
    drop(db);

    // Serialize recipe config
    let recipe_json = serde_json::to_string(&body).unwrap_or_default();
    let force = body.get("force").and_then(|v| v.as_bool()).unwrap_or(false);

    // Spawn background prepare job using the CLI
    let sweep_root = ds.sweep_root.clone();
    let prep_db = state.db.clone();
    let config = state.config.clone();

    tokio::spawn(async move {
        run_prepare_job(prep_db, id, &sweep_root, &recipe_json, force, &config).await;
    });

    Ok(json_ok(&serde_json::json!({
        "id": id,
        "message": "Dataset preparation started",
        "status": "preparing"
    })))
}

/// Run the prepare CLI command in a background task
async fn run_prepare_job(
    db: crate::DbHandle,
    dataset_id: i64,
    sweep_root: &str,
    recipe_json: &str,
    force: bool,
    config: &crate::Config,
) {
    println!("[PREPARE] Starting preparation for dataset {} at {}", dataset_id, sweep_root);

    let mut cmd_args = vec![
        "-u".to_string(),
        "-m".to_string(), "mstar_ai.cli".to_string(),
        "prepare".to_string(),
        "--sweep-root".to_string(), sweep_root.to_string(),
    ];

    if !recipe_json.is_empty() && recipe_json != "{}" {
        cmd_args.push("--recipe-json".to_string());
        cmd_args.push(recipe_json.to_string());
    }

    if force {
        cmd_args.push("--force".to_string());
    }

    let python_dir = std::path::Path::new(&config.ai_training.artifact_root)
        .parent()
        .map(|p| p.join("python/ai_training"))
        .unwrap_or_else(|| std::path::PathBuf::from("/opt/mstar_queue/python/ai_training"));

    let pythonpath = python_dir.to_string_lossy().to_string();

    let output = tokio::process::Command::new(&config.ai_training.python_executable)
        .args(&cmd_args)
        .env("PYTHONPATH", &pythonpath)
        .env("PYTHONUNBUFFERED", "1")
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .env("WARP_LOG_LEVEL", "error")
        .output()
        .await;

    let conn = db.lock().await;
    match output {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            let stderr = String::from_utf8_lossy(&out.stderr);

            if out.status.success() {
                println!("[PREPARE] Dataset {} preparation completed successfully", dataset_id);
                if !stderr.is_empty() {
                    eprintln!("[PREPARE] stderr: {}", stderr);
                }
                let _ = ai_training::update_dataset_status(
                    &conn, dataset_id, "prepared", None, None,
                    Some(&stdout),
                );
            } else {
                let err_msg = format!("Preparation failed (exit {}): {}", out.status, stderr);
                eprintln!("[PREPARE] {}", err_msg);
                let _ = ai_training::update_dataset_status(
                    &conn, dataset_id, "error", None, None,
                    Some(&err_msg),
                );
            }
        }
        Err(e) => {
            let err_msg = format!("Failed to spawn prepare process: {}", e);
            eprintln!("[PREPARE] {}", err_msg);
            let _ = ai_training::update_dataset_status(
                &conn, dataset_id, "error", None, None,
                Some(&err_msg),
            );
        }
    }
}

/// GET /api/ai/datasets/:id/derived-fields — list derived fields for a dataset
async fn handle_ai_get_derived_fields(
    id: i64,
    auth: Option<String>,
    state: AppState,
) -> Result<impl warp::Reply, warp::Rejection> {
    if !state.config.ai_training.enabled {
        return Ok(json_error("AI training is not enabled", warp::http::StatusCode::SERVICE_UNAVAILABLE));
    }

    let token = match extract_token(auth) {
        Some(t) => t,
        None => return Ok(json_error("Authentication required", warp::http::StatusCode::UNAUTHORIZED)),
    };

    let db = state.db.lock().await;
    let _user = match db::validate_session(&db, &token) {
        Ok(u) => u,
        Err(_) => return Ok(json_error("Invalid session", warp::http::StatusCode::UNAUTHORIZED)),
    };

    let datasets = ai_training::list_datasets(&db, None);
    let ds = match datasets.into_iter().find(|d| d.id == id) {
        Some(ds) => ds,
        None => return Ok(json_error("Dataset not found", warp::http::StatusCode::NOT_FOUND)),
    };
    drop(db);

    // Read the .derived/ manifest directly from the filesystem
    let derived_dir = std::path::Path::new(&ds.sweep_root).join(".derived");
    let mut fields = Vec::new();

    if derived_dir.is_dir() {
        // Read preparation metadata if it exists
        let prep_meta_path = derived_dir.join("preparation.json");
        let prep_meta: Option<serde_json::Value> = if prep_meta_path.is_file() {
            std::fs::read_to_string(&prep_meta_path)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
        } else {
            None
        };

        // Scan field directories
        if let Ok(entries) = std::fs::read_dir(&derived_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_dir() { continue; }

                let field_name = path.file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("")
                    .to_string();

                if field_name.starts_with('.') { continue; }

                // Skip target_* fields — these are provenance side-effects from
                // training (saved for cache/auditability), not user-prepared fields.
                // They contain sanitized keys (e.g. "target_velocity_vector_m_s")
                // that don't correspond to M-Star field names and would cause
                // "field not found" errors if selected as training targets.
                if field_name.starts_with("target_") { continue; }

                // Read recipe.json
                let recipe_path = path.join("recipe.json");
                let recipe: Option<serde_json::Value> = if recipe_path.is_file() {
                    std::fs::read_to_string(&recipe_path)
                        .ok()
                        .and_then(|s| serde_json::from_str(&s).ok())
                } else {
                    None
                };

                // Count NPZ files
                let npz_count = std::fs::read_dir(&path)
                    .map(|rd| rd.flatten().filter(|e| {
                        e.path().extension().and_then(|x| x.to_str()) == Some("npz")
                    }).count())
                    .unwrap_or(0);

                fields.push(serde_json::json!({
                    "field_name": field_name,
                    "recipe": recipe,
                    "case_count": npz_count,
                }));
            }
        }

        // Sort fields by name
        fields.sort_by(|a, b| {
            a.get("field_name").and_then(|v| v.as_str()).unwrap_or("")
                .cmp(b.get("field_name").and_then(|v| v.as_str()).unwrap_or(""))
        });

        // Read live progress if preparation is in-flight
        let progress_path = derived_dir.join(".progress.json");
        let progress: Option<serde_json::Value> = if progress_path.is_file() {
            std::fs::read_to_string(&progress_path)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
        } else {
            None
        };

        return Ok(json_ok(&serde_json::json!({
            "dataset_id": id,
            "derived_dir": derived_dir.to_string_lossy(),
            "fields": fields,
            "preparation_meta": prep_meta,
            "progress": progress,
        })));
    }

    Ok(json_ok(&serde_json::json!({
        "dataset_id": id,
        "derived_dir": derived_dir.to_string_lossy(),
        "fields": fields,
        "preparation_meta": null,
    })))
}

/// POST /api/ai/derived-fields/:dataset_id/delete — delete computed fields with password confirmation
async fn handle_ai_delete_fields(
    id: i64,
    auth: Option<String>,
    body: serde_json::Value,
    state: AppState,
) -> Result<impl warp::Reply, warp::Rejection> {
    if !state.config.ai_training.enabled {
        return Ok(json_error("AI training is not enabled", warp::http::StatusCode::SERVICE_UNAVAILABLE));
    }

    let token = match extract_token(auth) {
        Some(t) => t,
        None => return Ok(json_error("Authentication required", warp::http::StatusCode::UNAUTHORIZED)),
    };

    let db = state.db.lock().await;
    let user = match db::validate_session(&db, &token) {
        Ok(u) => u,
        Err(_) => return Ok(json_error("Invalid session", warp::http::StatusCode::UNAUTHORIZED)),
    };

    // Verify password
    let password = match body.get("password").and_then(|v| v.as_str()) {
        Some(p) => p.to_string(),
        None => return Ok(json_error("Password required", warp::http::StatusCode::BAD_REQUEST)),
    };

    match bcrypt::verify(&password, &user.password_hash) {
        Ok(true) => {},
        Ok(false) => return Ok(json_error("Incorrect password", warp::http::StatusCode::FORBIDDEN)),
        Err(_) => return Ok(json_error("Password verification failed", warp::http::StatusCode::INTERNAL_SERVER_ERROR)),
    }

    // Get field names to delete
    let field_names: Vec<String> = match body.get("field_names").and_then(|v| v.as_array()) {
        Some(arr) => arr.iter().filter_map(|v| v.as_str().map(String::from)).collect(),
        None => return Ok(json_error("field_names array required", warp::http::StatusCode::BAD_REQUEST)),
    };

    if field_names.is_empty() {
        return Ok(json_error("No field names provided", warp::http::StatusCode::BAD_REQUEST));
    }

    // Look up the dataset
    let datasets = ai_training::list_datasets(&db, None);
    let ds = match datasets.into_iter().find(|d| d.id == id) {
        Some(ds) => ds,
        None => return Ok(json_error("Dataset not found", warp::http::StatusCode::NOT_FOUND)),
    };
    drop(db);

    let derived_dir = std::path::Path::new(&ds.sweep_root).join(".derived");
    let mut deleted = Vec::new();
    let mut errors = Vec::new();

    for field_name in &field_names {
        // Sanitize: prevent path traversal
        if field_name.contains("..") || field_name.contains('/') || field_name.contains('\\') {
            errors.push(format!("Invalid field name: {}", field_name));
            continue;
        }

        let field_dir = derived_dir.join(field_name);
        if field_dir.is_dir() {
            match std::fs::remove_dir_all(&field_dir) {
                Ok(_) => {
                    println!("[PREPARE] Deleted derived field '{}' from dataset {} by user '{}'",
                              field_name, id, user.username);
                    deleted.push(field_name.clone());
                },
                Err(e) => {
                    errors.push(format!("{}: {}", field_name, e));
                }
            }
        } else {
            errors.push(format!("{}: not found", field_name));
        }
    }

    Ok(json_ok(&serde_json::json!({
        "deleted": deleted,
        "deleted_count": deleted.len(),
        "errors": errors,
    })))
}

/// POST /api/ai/datasets/:id/probe — discover available PVD files and fields
async fn handle_ai_probe_dataset(
    id: i64,
    auth: Option<String>,
    state: AppState,
) -> Result<impl warp::Reply, warp::Rejection> {
    if !state.config.ai_training.enabled {
        return Ok(json_error("AI training is not enabled", warp::http::StatusCode::SERVICE_UNAVAILABLE));
    }

    let token = match extract_token(auth) {
        Some(t) => t,
        None => return Ok(json_error("Authentication required", warp::http::StatusCode::UNAUTHORIZED)),
    };

    let db = state.db.lock().await;
    let _user = match db::validate_session(&db, &token) {
        Ok(u) => u,
        Err(_) => return Ok(json_error("Invalid session", warp::http::StatusCode::UNAUTHORIZED)),
    };

    let datasets = ai_training::list_datasets(&db, None);
    let ds = match datasets.into_iter().find(|d| d.id == id) {
        Some(ds) => ds,
        None => return Ok(json_error("Dataset not found", warp::http::StatusCode::NOT_FOUND)),
    };
    drop(db);

    // Run Python probe script
    let python = state.config.ai_training.python_executable.clone();
    let sweep_root = ds.sweep_root.clone();

    // Build PYTHONPATH — same logic as run_prepare_job
    let python_dir = std::path::Path::new(&state.config.ai_training.artifact_root)
        .parent()
        .map(|p| p.join("python/ai_training"))
        .unwrap_or_else(|| std::path::PathBuf::from("/opt/mstar_queue/python/ai_training"));
    let pythonpath = if python_dir.is_absolute() && python_dir.exists() {
        python_dir.to_string_lossy().to_string()
    } else {
        // Fallback: resolve relative to working directory (WorkingDirectory=/opt/mstar_queue)
        "/opt/mstar_queue/python/ai_training".to_string()
    };

    let output = tokio::process::Command::new(&python)
        .args(&["-m", "mstar_ai.dataset.probe", &sweep_root])
        .env("PYTHONPATH", &pythonpath)
        .env("PYTHONUNBUFFERED", "1")
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .output()
        .await;

    match output {
        Ok(result) => {
            if result.status.success() {
                let stdout = String::from_utf8_lossy(&result.stdout);
                match serde_json::from_str::<serde_json::Value>(&stdout) {
                    Ok(probe_data) => Ok(json_ok(&serde_json::json!({
                        "dataset_id": id,
                        "sweep_root": sweep_root,
                        "probe": probe_data,
                    }))),
                    Err(e) => Ok(json_error(
                        &format!("Failed to parse probe output: {}", e),
                        warp::http::StatusCode::INTERNAL_SERVER_ERROR,
                    )),
                }
            } else {
                let stderr = String::from_utf8_lossy(&result.stderr);
                eprintln!("[AI] Probe failed for dataset {}: {}", id, stderr);
                Ok(json_error(
                    &format!("Probe failed: {}", stderr.chars().take(500).collect::<String>()),
                    warp::http::StatusCode::INTERNAL_SERVER_ERROR,
                ))
            }
        }
        Err(e) => Ok(json_error(
            &format!("Failed to run probe: {}", e),
            warp::http::StatusCode::INTERNAL_SERVER_ERROR,
        )),
    }
}

async fn handle_ai_list_training_jobs(
    auth: Option<String>,
    params: HashMap<String, String>,
    state: AppState,
) -> Result<impl warp::Reply, warp::Rejection> {
    if !state.config.ai_training.enabled {
        return Ok(json_error("AI training is not enabled", warp::http::StatusCode::SERVICE_UNAVAILABLE));
    }

    let token = match extract_token(auth) {
        Some(t) => t,
        None => return Ok(json_error("Authentication required", warp::http::StatusCode::UNAUTHORIZED)),
    };

    let db = state.db.lock().await;
    let user = match db::validate_session(&db, &token) {
        Ok(u) => u,
        Err(_) => return Ok(json_error("Invalid session", warp::http::StatusCode::UNAUTHORIZED)),
    };

    let user_filter = if user.role == "admin" { None } else { Some(user.id) };
    let status_filter = params.get("status").map(|s| s.as_str());
    let jobs = ai_training::list_training_jobs(&db, user_filter, status_filter);

    Ok(json_ok(&serde_json::json!({ "training_jobs": jobs })))
}

/// POST /api/ai/training-jobs — create and queue a training job
async fn handle_ai_create_training_job(
    auth: Option<String>,
    body: CreateAiTrainingJobRequest,
    state: AppState,
) -> Result<impl warp::Reply, warp::Rejection> {
    if !state.config.ai_training.enabled {
        return Ok(json_error("AI training is not enabled", warp::http::StatusCode::SERVICE_UNAVAILABLE));
    }

    let token = match extract_token(auth) {
        Some(t) => t,
        None => return Ok(json_error("Authentication required", warp::http::StatusCode::UNAUTHORIZED)),
    };

    let db = state.db.lock().await;
    let user = match db::validate_session(&db, &token) {
        Ok(u) => u,
        Err(_) => return Ok(json_error("Invalid session", warp::http::StatusCode::UNAUTHORIZED)),
    };

    // Validate model family
    let valid_families = ["fno", "unet", "gnn", "mlp", "transolver"];
    if !valid_families.contains(&body.model_family.as_str()) {
        return Ok(json_error(
            &format!("Invalid model_family: '{}'. Valid: {:?}", body.model_family, valid_families),
            warp::http::StatusCode::BAD_REQUEST,
        ));
    }

    // Check concurrent training limit
    let running = ai_training::list_training_jobs(&db, None, Some("running"));
    let max = state.config.ai_training.max_concurrent_training_jobs;
    if running.len() >= max {
        return Ok(json_error(
            &format!("Maximum concurrent training jobs ({}) reached", max),
            warp::http::StatusCode::TOO_MANY_REQUESTS,
        ));
    }

    let run_name = body.run_name.unwrap_or_else(|| {
        format!("run_{}_{}", body.model_family, chrono::Utc::now().format("%Y%m%d_%H%M%S"))
    });

    let gpu_ids_json = match &body.gpu_ids {
        Some(ids) => serde_json::to_string(ids).unwrap_or_else(|_| "[]".to_string()),
        None => "[]".to_string(),
    };

    // ---- Resume / Transfer Learning ----
    // If resume_from_job is specified, validate and resolve the checkpoint path.
    let mut checkpoint_path: Option<String> = None;
    if let Some(source_job_id) = body.resume_from_job {
        let source_jobs = ai_training::list_training_jobs(&db, None, None);
        let source = source_jobs.iter().find(|j| j.id == source_job_id);
        match source {
            None => {
                return Ok(json_error(
                    &format!("Source job #{} not found", source_job_id),
                    warp::http::StatusCode::BAD_REQUEST,
                ));
            }
            Some(src) => {
                if src.status != "completed" {
                    return Ok(json_error(
                        &format!("Source job #{} is not completed (status: {})", source_job_id, src.status),
                        warp::http::StatusCode::BAD_REQUEST,
                    ));
                }
                if src.model_family != body.model_family {
                    return Ok(json_error(
                        &format!(
                            "Model family mismatch: source job #{} uses '{}' but new job uses '{}'. \
                             Resume/transfer is only compatible with the same model architecture.",
                            source_job_id, src.model_family, body.model_family
                        ),
                        warp::http::StatusCode::BAD_REQUEST,
                    ));
                }
                // Resolve checkpoint path: prefer best_model.pt, fall back to latest.pt
                match &src.artifact_directory {
                    Some(dir) => {
                        let ckpt_dir = std::path::Path::new(dir).join("checkpoints");
                        let best = ckpt_dir.join("best_model.pt");
                        let latest = ckpt_dir.join("latest.pt");
                        if best.exists() {
                            checkpoint_path = Some(best.to_string_lossy().to_string());
                        } else if latest.exists() {
                            checkpoint_path = Some(latest.to_string_lossy().to_string());
                        } else {
                            return Ok(json_error(
                                &format!("No checkpoint found in source job #{} at {:?}", source_job_id, ckpt_dir),
                                warp::http::StatusCode::BAD_REQUEST,
                            ));
                        }
                    }
                    None => {
                        return Ok(json_error(
                            &format!("Source job #{} has no artifact directory", source_job_id),
                            warp::http::StatusCode::BAD_REQUEST,
                        ));
                    }
                }
            }
        }
    }

    // Merge checkpoint path into config JSON
    let mut config_json = body.config.map(|v| v.to_string());
    if let Some(ref ckpt) = checkpoint_path {
        // Parse existing config or create new one, inject resume_from_checkpoint
        let mut cfg: serde_json::Value = config_json
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or_else(|| serde_json::json!({}));
        if let Some(obj) = cfg.as_object_mut() {
            obj.insert("resume_from_checkpoint".to_string(), serde_json::json!(ckpt));
        }
        config_json = Some(cfg.to_string());
    }

    match ai_training::create_training_job(
        &db,
        body.dataset_id,
        user.id,
        &run_name,
        &body.model_family,
        &gpu_ids_json,
        config_json.as_deref(),
    ) {
        Ok(id) => {
            // If resuming, also store the checkpoint path in the dedicated column
            if let Some(ref ckpt) = checkpoint_path {
                let _ = db.execute(
                    "UPDATE ai_training_jobs SET resume_from_checkpoint = ?2 WHERE id = ?1",
                    rusqlite::params![id, ckpt],
                );
            }
            Ok(json_ok(&serde_json::json!({
                "id": id,
                "run_name": run_name,
                "message": if checkpoint_path.is_some() { "Training job queued (resuming from checkpoint)" } else { "Training job queued" },
                "resume_from_checkpoint": checkpoint_path,
            })))
        },
        Err(e) => Ok(json_error(&e, warp::http::StatusCode::INTERNAL_SERVER_ERROR)),
    }
}

/// GET /api/ai/training-jobs/:id — get a single training job
async fn handle_ai_get_training_job(
    id: i64,
    auth: Option<String>,
    state: AppState,
) -> Result<impl warp::Reply, warp::Rejection> {
    if !state.config.ai_training.enabled {
        return Ok(json_error("AI training is not enabled", warp::http::StatusCode::SERVICE_UNAVAILABLE));
    }

    let token = match extract_token(auth) {
        Some(t) => t,
        None => return Ok(json_error("Authentication required", warp::http::StatusCode::UNAUTHORIZED)),
    };

    let db = state.db.lock().await;
    let user = match db::validate_session(&db, &token) {
        Ok(u) => u,
        Err(_) => return Ok(json_error("Invalid session", warp::http::StatusCode::UNAUTHORIZED)),
    };

    let jobs = ai_training::list_training_jobs(&db, None, None);
    match jobs.into_iter().find(|j| j.id == id) {
        Some(job) => {
            if user.role != "admin" && job.user_id != user.id {
                return Ok(json_error("Forbidden", warp::http::StatusCode::FORBIDDEN));
            }
            Ok(json_ok(&job))
        }
        None => Ok(json_error("Training job not found", warp::http::StatusCode::NOT_FOUND)),
    }
}

/// POST /api/ai/training-jobs/:id/cancel — cancel a running training job
async fn handle_ai_cancel_training_job(
    id: i64,
    auth: Option<String>,
    state: AppState,
) -> Result<impl warp::Reply, warp::Rejection> {
    if !state.config.ai_training.enabled {
        return Ok(json_error("AI training is not enabled", warp::http::StatusCode::SERVICE_UNAVAILABLE));
    }

    let token = match extract_token(auth) {
        Some(t) => t,
        None => return Ok(json_error("Authentication required", warp::http::StatusCode::UNAUTHORIZED)),
    };

    let db = state.db.lock().await;
    let user = match db::validate_session(&db, &token) {
        Ok(u) => u,
        Err(_) => return Ok(json_error("Invalid session", warp::http::StatusCode::UNAUTHORIZED)),
    };

    // Find the job
    let jobs = ai_training::list_training_jobs(&db, None, None);
    let job = match jobs.into_iter().find(|j| j.id == id) {
        Some(j) => j,
        None => return Ok(json_error("Training job not found", warp::http::StatusCode::NOT_FOUND)),
    };

    // Auth check
    if user.role != "admin" && job.user_id != user.id {
        return Ok(json_error("Forbidden", warp::http::StatusCode::FORBIDDEN));
    }

    // Can only cancel queued/running jobs
    if job.status != "queued" && job.status != "running" && job.status != "preflight" {
        return Ok(json_error(
            &format!("Cannot cancel a {} job", job.status),
            warp::http::StatusCode::CONFLICT,
        ));
    }

    // Kill the process if running
    if let Some(pid) = job.pid {
        let _ = ai_training::cancel_training_process(pid as u32);
    }

    // Release GPUs
    let _ = ai_training::release_training_gpus(&db, id);

    // Update status
    if let Err(e) = ai_training::update_training_job_status(
        &db, id, "cancelled", None, Some("Cancelled by user"),
    ) {
        return Ok(json_error(&e, warp::http::StatusCode::INTERNAL_SERVER_ERROR));
    }

    Ok(json_ok(&ApiSuccess { message: "Training job cancelled".to_string() }))
}

/// GET /api/ai/training-jobs/:id/log — raw training log
async fn handle_ai_training_log(
    id: i64,
    auth: Option<String>,
    state: AppState,
) -> Result<impl warp::Reply, warp::Rejection> {
    if !state.config.ai_training.enabled {
        return Ok(json_error("AI training is not enabled", warp::http::StatusCode::SERVICE_UNAVAILABLE));
    }

    let token = match extract_token(auth) {
        Some(t) => t,
        None => return Ok(json_error("Authentication required", warp::http::StatusCode::UNAUTHORIZED)),
    };

    let db = state.db.lock().await;
    let user = match db::validate_session(&db, &token) {
        Ok(u) => u,
        Err(_) => return Ok(json_error("Invalid session", warp::http::StatusCode::UNAUTHORIZED)),
    };

    // Find the job
    let jobs = ai_training::list_training_jobs(&db, None, None);
    let job = match jobs.into_iter().find(|j| j.id == id) {
        Some(j) => j,
        None => return Ok(json_error("Training job not found", warp::http::StatusCode::NOT_FOUND)),
    };

    // Auth check
    if user.role != "admin" && job.user_id != user.id {
        return Ok(json_error("Forbidden", warp::http::StatusCode::FORBIDDEN));
    }

    // Query the dedicated log_path column (may be relative to CWD)
    let stored_log_path: Option<String> = db.query_row(
        "SELECT log_path FROM ai_training_jobs WHERE id = ?1",
        rusqlite::params![id],
        |row| row.get(0),
    ).ok().flatten();
    drop(db);

    // Resolve the log file path
    let log_path = if let Some(ref lp) = stored_log_path {
        let p = std::path::Path::new(lp);
        let abs = if p.is_absolute() { p.to_path_buf() } else {
            std::env::current_dir().unwrap_or_default().join(p)
        };
        if abs.exists() {
            abs
        } else {
            // Fall through to artifact_directory search
            std::path::PathBuf::new()
        }
    } else {
        std::path::PathBuf::new()
    };

    // If log_path didn't work, try artifact_directory
    let log_path = if log_path.exists() {
        log_path
    } else {
        match &job.artifact_directory {
            Some(dir) => {
                let p = std::path::Path::new(dir).join(format!("training_{}.log", id));
                if p.exists() {
                    p
                } else {
                    // Fallback: check for any .log file in the directory
                    let fallback = std::path::Path::new(dir);
                    if fallback.is_dir() {
                        let mut log_file = None;
                        if let Ok(entries) = std::fs::read_dir(fallback) {
                            for entry in entries.flatten() {
                                if entry.path().extension().map_or(false, |e| e == "log") {
                                    log_file = Some(entry.path());
                                    break;
                                }
                            }
                        }
                        match log_file {
                            Some(f) => f,
                            None => return Ok(json_ok(&serde_json::json!({
                                "log": "",
                                "message": "No log file found in artifact directory"
                            }))),
                        }
                    } else {
                        return Ok(json_ok(&serde_json::json!({
                            "log": "",
                            "message": "Artifact directory not found"
                        })));
                    }
                }
            }
            None => return Ok(json_ok(&serde_json::json!({
                "log": "",
                "message": "No artifact directory for this job"
            }))),
        }
    };

    // Read the log file (cap at 200KB to prevent huge responses)
    match tokio::fs::read_to_string(&log_path).await {
        Ok(content) => {
            let max_len = 200 * 1024; // 200KB
            let truncated = content.len() > max_len;
            let log_content = if truncated {
                format!("... [truncated, showing last {} bytes] ...\n{}", max_len, &content[content.len() - max_len..])
            } else {
                content
            };
            Ok(json_ok(&serde_json::json!({
                "log": log_content,
                "log_path": log_path.to_str().unwrap_or(""),
                "truncated": truncated,
            })))
        }
        Err(e) => Ok(json_ok(&serde_json::json!({
            "log": "",
            "message": format!("Failed to read log file: {}", e),
        }))),
    }
}

/// GET /api/ai/training-jobs/:id/metrics — epoch-by-epoch training metrics for visualization
async fn handle_ai_training_metrics(
    id: i64,
    auth: Option<String>,
    state: AppState,
) -> Result<impl warp::Reply, warp::Rejection> {
    if !state.config.ai_training.enabled {
        return Ok(json_error("AI training is not enabled", warp::http::StatusCode::SERVICE_UNAVAILABLE));
    }

    let token = match extract_token(auth) {
        Some(t) => t,
        None => return Ok(json_error("Authentication required", warp::http::StatusCode::UNAUTHORIZED)),
    };

    let db = state.db.lock().await;
    let user = match db::validate_session(&db, &token) {
        Ok(u) => u,
        Err(_) => return Ok(json_error("Invalid session", warp::http::StatusCode::UNAUTHORIZED)),
    };

    let jobs = ai_training::list_training_jobs(&db, None, None);
    let job = match jobs.into_iter().find(|j| j.id == id) {
        Some(j) => j,
        None => return Ok(json_error("Training job not found", warp::http::StatusCode::NOT_FOUND)),
    };

    if user.role != "admin" && job.user_id != user.id {
        return Ok(json_error("Forbidden", warp::http::StatusCode::FORBIDDEN));
    }
    drop(db);

    let artifact_dir = match &job.artifact_directory {
        Some(dir) => {
            let p = std::path::PathBuf::from(dir);
            if p.is_absolute() {
                p
            } else {
                std::env::current_dir().unwrap_or_default().join(p)
            }
        }
        None => {
            return Ok(json_ok(&serde_json::json!({
                "status": "ok",
                "job_id": id,
                "job_status": job.status,
                "epochs": [],
                "test_metrics": null,
                "config": null,
                "message": "No artifact directory for this job"
            })));
        }
    };

    // 1. Read metrics.jsonl (one JSON object per line, one per epoch)
    //    The metrics file may be:
    //    a) directly in artifact_dir (if artifact_dir was correctly set to the run directory)
    //    b) in a sibling directory named after the run_name (e.g. ai_artifacts/run_unet_XXX)
    //       because artifact_dir still points to ai_artifacts/training_job_N (legacy bug)
    let mut metrics_path = artifact_dir.join("metrics.jsonl");
    if !metrics_path.exists() {
        // Check sibling directory: parent(artifact_dir) / run_name
        if let Some(parent) = artifact_dir.parent() {
            let sibling = parent.join(&job.run_name);
            let candidate = sibling.join("metrics.jsonl");
            if candidate.exists() {
                metrics_path = candidate;
            }
        }
    }

    let mut epochs: Vec<serde_json::Value> = Vec::new();
    if metrics_path.exists() {
        if let Ok(content) = tokio::fs::read_to_string(&metrics_path).await {
            for line in content.lines().take(10_000) {
                let trimmed = line.trim();
                if trimmed.is_empty() { continue; }
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(trimmed) {
                    epochs.push(val);
                }
            }
        }
    }

    // Determine the effective run directory (for results.json and config)
    let effective_dir = metrics_path.parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| artifact_dir.clone());

    // 2. Read results.json (final test metrics)
    //    Check effective_dir first (where metrics.jsonl was found), then artifact_dir
    let mut results_path = effective_dir.join("results.json");
    if !results_path.exists() {
        results_path = artifact_dir.join("results.json");
    }
    let (test_metrics, training_summary) = if results_path.exists() {
        match tokio::fs::read_to_string(&results_path).await {
            Ok(content) => {
                if let Ok(results) = serde_json::from_str::<serde_json::Value>(&content) {
                    (
                        results.get("test_metrics").cloned(),
                        results.get("training_summary").cloned(),
                    )
                } else {
                    (None, None)
                }
            }
            Err(_) => (None, None),
        }
    } else {
        (None, None)
    };

    // 3. Read training_config.json (key config fields)
    //    Check effective_dir first (where metrics.jsonl was found), then artifact_dir
    let mut config_path = effective_dir.join("training_config.json");
    if !config_path.exists() {
        config_path = artifact_dir.join("training_config.json");
    }
    let config = if config_path.exists() {
        match tokio::fs::read_to_string(&config_path).await {
            Ok(content) => {
                if let Ok(cfg) = serde_json::from_str::<serde_json::Value>(&content) {
                    Some(serde_json::json!({
                        "model_family": cfg.get("model_family").and_then(|v| v.as_str()).unwrap_or(""),
                        "epochs": cfg.get("epochs").and_then(|v| v.as_i64()).unwrap_or(0),
                        "batch_size": cfg.get("batch_size").and_then(|v| v.as_i64()).unwrap_or(0),
                        "learning_rate": cfg.get("learning_rate").and_then(|v| v.as_f64()).unwrap_or(0.0),
                        "dataset_mode": cfg.get("dataset_mode").and_then(|v| v.as_str()).unwrap_or(""),
                    }))
                } else {
                    None
                }
            }
            Err(_) => None,
        }
    } else {
        None
    };

    Ok(json_ok(&serde_json::json!({
        "status": "ok",
        "job_id": id,
        "job_status": job.status,
        "epochs": epochs,
        "test_metrics": test_metrics,
        "training_summary": training_summary,
        "config": config,
    })))
}

/// POST /api/ai/training-jobs/:id/export — export model to ONNX/TorchScript
async fn handle_ai_export_model(
    id: i64,
    auth: Option<String>,
    body: serde_json::Value,
    state: AppState,
) -> Result<impl warp::Reply, warp::Rejection> {
    if !state.config.ai_training.enabled {
        return Ok(json_error("AI training is not enabled", warp::http::StatusCode::SERVICE_UNAVAILABLE));
    }

    let token = match extract_token(auth) {
        Some(t) => t,
        None => return Ok(json_error("Authentication required", warp::http::StatusCode::UNAUTHORIZED)),
    };

    let db = state.db.lock().await;
    let user = match db::validate_session(&db, &token) {
        Ok(u) => u,
        Err(_) => return Ok(json_error("Invalid session", warp::http::StatusCode::UNAUTHORIZED)),
    };

    let jobs = ai_training::list_training_jobs(&db, None, None);
    let job = match jobs.into_iter().find(|j| j.id == id) {
        Some(j) => j,
        None => return Ok(json_error("Training job not found", warp::http::StatusCode::NOT_FOUND)),
    };

    if user.role != "admin" && job.user_id != user.id {
        return Ok(json_error("Forbidden", warp::http::StatusCode::FORBIDDEN));
    }
    drop(db);

    if job.status != "completed" {
        return Ok(json_error("Only completed training jobs can be exported", warp::http::StatusCode::BAD_REQUEST));
    }

    let artifact_dir = match &job.artifact_directory {
        Some(dir) => {
            let p = std::path::PathBuf::from(dir);
            if p.is_absolute() { p } else { std::env::current_dir().unwrap_or_default().join(p) }
        }
        None => return Ok(json_error("No artifact directory for this job", warp::http::StatusCode::BAD_REQUEST)),
    };

    // Find the best checkpoint
    let find_checkpoint = |dir: &std::path::Path| -> Option<std::path::PathBuf> {
        let cp_dir = dir.join("checkpoints");
        let best = cp_dir.join("best_model.pt");
        if best.exists() { return Some(best); }
        let latest = cp_dir.join("latest.pt");
        if latest.exists() { return Some(latest); }
        None
    };

    // Try artifact_dir first, then sibling run_name directory
    let checkpoint_path = find_checkpoint(&artifact_dir)
        .or_else(|| {
            artifact_dir.parent().and_then(|parent| {
                find_checkpoint(&parent.join(&job.run_name))
            })
        });

    let checkpoint_path = match checkpoint_path {
        Some(p) => p,
        None => return Ok(json_error("No checkpoint found in artifact directory", warp::http::StatusCode::BAD_REQUEST)),
    };

    // Parse requested formats
    let formats = body.get("formats")
        .and_then(|v| v.as_str())
        .unwrap_or("onnx,torchscript")
        .to_string();

    let output_dir = artifact_dir.join("export");

    // Run Python export CLI
    let ai_training_dir = std::env::current_dir()
        .map(|d| d.join("python").join("ai_training"))
        .unwrap_or_else(|_| std::path::PathBuf::from("/opt/mstar_queue/python/ai_training"));
    let python_path = match std::env::var("PYTHONPATH") {
        Ok(existing) => format!("{}:{}", ai_training_dir.display(), existing),
        Err(_) => ai_training_dir.display().to_string(),
    };

    let output = tokio::process::Command::new("python3")
        .arg("-m")
        .arg("mstar_ai.cli")
        .arg("export")
        .arg("--checkpoint")
        .arg(checkpoint_path.to_str().unwrap_or(""))
        .arg("--output-dir")
        .arg(output_dir.to_str().unwrap_or(""))
        .arg("--format")
        .arg(&formats)
        .arg("--device")
        .arg("cpu")
        .env("PYTHONPATH", &python_path)
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .await;

    match output {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout).to_string();
            let stderr = String::from_utf8_lossy(&out.stderr).to_string();

            if out.status.success() {
                // Parse JSON output from CLI
                let result: serde_json::Value = serde_json::from_str(&stdout)
                    .unwrap_or(serde_json::json!({"raw_output": stdout}));
                Ok(json_ok(&serde_json::json!({
                    "status": "ok",
                    "job_id": id,
                    "export": result,
                    "output_dir": output_dir.to_str().unwrap_or(""),
                })))
            } else {
                eprintln!("[AI-EXPORT] Model export failed for job {}: {}", id, stderr);
                Ok(json_error(
                    &format!("Export failed: {}", if stderr.len() > 500 { &stderr[..500] } else { &stderr }),
                    warp::http::StatusCode::INTERNAL_SERVER_ERROR,
                ))
            }
        }
        Err(e) => {
            eprintln!("[AI-EXPORT] Failed to spawn export process for job {}: {}", id, e);
            Ok(json_error(
                &format!("Failed to start export process: {}", e),
                warp::http::StatusCode::INTERNAL_SERVER_ERROR,
            ))
        }
    }
}

/// POST /api/ai/training-jobs/:id/infer — run inference with a trained model
async fn handle_ai_infer(
    id: i64,
    auth: Option<String>,
    body: serde_json::Value,
    state: AppState,
) -> Result<impl warp::Reply, warp::Rejection> {
    if !state.config.ai_training.enabled {
        return Ok(json_error("AI training is not enabled", warp::http::StatusCode::SERVICE_UNAVAILABLE));
    }

    let token = match extract_token(auth) {
        Some(t) => t,
        None => return Ok(json_error("Authentication required", warp::http::StatusCode::UNAUTHORIZED)),
    };

    let db = state.db.lock().await;
    let user = match db::validate_session(&db, &token) {
        Ok(u) => u,
        Err(_) => return Ok(json_error("Invalid session", warp::http::StatusCode::UNAUTHORIZED)),
    };

    let jobs = ai_training::list_training_jobs(&db, None, None);
    let job = match jobs.into_iter().find(|j| j.id == id) {
        Some(j) => j,
        None => return Ok(json_error("Training job not found", warp::http::StatusCode::NOT_FOUND)),
    };

    if user.role != "admin" && job.user_id != user.id {
        return Ok(json_error("Forbidden", warp::http::StatusCode::FORBIDDEN));
    }
    drop(db);

    if job.status != "completed" {
        return Ok(json_error("Only completed training jobs can be used for inference", warp::http::StatusCode::BAD_REQUEST));
    }

    let artifact_dir = match &job.artifact_directory {
        Some(dir) => {
            let p = std::path::PathBuf::from(dir);
            if p.is_absolute() { p } else { std::env::current_dir().unwrap_or_default().join(p) }
        }
        None => return Ok(json_error("No artifact directory for this job", warp::http::StatusCode::BAD_REQUEST)),
    };

    // Find the best checkpoint
    let find_checkpoint = |dir: &std::path::Path| -> Option<std::path::PathBuf> {
        let cp_dir = dir.join("checkpoints");
        let best = cp_dir.join("best_model.pt");
        if best.exists() { return Some(best); }
        let latest = cp_dir.join("latest.pt");
        if latest.exists() { return Some(latest); }
        None
    };

    // Try artifact_dir first, then sibling run_name directory
    let checkpoint_path = find_checkpoint(&artifact_dir)
        .or_else(|| {
            artifact_dir.parent().and_then(|parent| {
                find_checkpoint(&parent.join(&job.run_name))
            })
        });

    let checkpoint_path = match checkpoint_path {
        Some(p) => p,
        None => return Ok(json_error("No checkpoint found in artifact directory", warp::http::StatusCode::BAD_REQUEST)),
    };

    // Parse input parameters from request body
    let input_params = body.get("input_params")
        .map(|v| v.to_string())
        .unwrap_or_else(|| "{}".to_string());

    let output_dir = artifact_dir.join("inference_output");

    // Run Python inference CLI
    let ai_training_dir = std::env::current_dir()
        .map(|d| d.join("python").join("ai_training"))
        .unwrap_or_else(|_| std::path::PathBuf::from("/opt/mstar_queue/python/ai_training"));
    let python_path = match std::env::var("PYTHONPATH") {
        Ok(existing) => format!("{}:{}", ai_training_dir.display(), existing),
        Err(_) => ai_training_dir.display().to_string(),
    };

    eprintln!("[AI-INFER] Running inference for job {} with params: {}", id, input_params);

    let output = tokio::process::Command::new("python3")
        .arg("-m")
        .arg("mstar_ai.cli")
        .arg("infer")
        .arg("--checkpoint")
        .arg(checkpoint_path.to_str().unwrap_or(""))
        .arg("--input-params")
        .arg(&input_params)
        .arg("--output-dir")
        .arg(output_dir.to_str().unwrap_or(""))
        .env("PYTHONPATH", &python_path)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .await;

    match output {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout).to_string();
            let stderr = String::from_utf8_lossy(&out.stderr).to_string();

            if out.status.success() {
                // Parse JSON output from CLI
                let result: serde_json::Value = serde_json::from_str(&stdout)
                    .unwrap_or(serde_json::json!({"raw_output": stdout}));
                Ok(json_ok(&serde_json::json!({
                    "status": "ok",
                    "job_id": id,
                    "inference": result,
                    "output_dir": output_dir.to_str().unwrap_or(""),
                })))
            } else {
                eprintln!("[AI-INFER] Inference failed for job {}: {}", id, stderr);
                // Try to parse error JSON from stderr
                let err_msg = if let Ok(err_json) = serde_json::from_str::<serde_json::Value>(&stderr) {
                    err_json.get("message")
                        .and_then(|m| m.as_str())
                        .unwrap_or(&stderr)
                        .to_string()
                } else {
                    if stderr.len() > 500 { stderr[..500].to_string() } else { stderr }
                };
                Ok(json_error(
                    &format!("Inference failed: {}", err_msg),
                    warp::http::StatusCode::INTERNAL_SERVER_ERROR,
                ))
            }
        }
        Err(e) => {
            eprintln!("[AI-INFER] Failed to spawn inference process for job {}: {}", id, e);
            Ok(json_error(
                &format!("Failed to start inference process: {}", e),
                warp::http::StatusCode::INTERNAL_SERVER_ERROR,
            ))
        }
    }
}

/// POST /api/ai/training-jobs/:id/infer-sweep — batch inference across a parameter range
async fn handle_ai_infer_sweep(
    id: i64,
    auth: Option<String>,
    body: serde_json::Value,
    state: AppState,
) -> Result<impl warp::Reply, warp::Rejection> {
    if !state.config.ai_training.enabled {
        return Ok(json_error("AI training is not enabled", warp::http::StatusCode::SERVICE_UNAVAILABLE));
    }

    let token = match extract_token(auth) {
        Some(t) => t,
        None => return Ok(json_error("Authentication required", warp::http::StatusCode::UNAUTHORIZED)),
    };

    let db = state.db.lock().await;
    let user = match db::validate_session(&db, &token) {
        Ok(u) => u,
        Err(_) => return Ok(json_error("Invalid session", warp::http::StatusCode::UNAUTHORIZED)),
    };

    let jobs = ai_training::list_training_jobs(&db, None, None);
    let job = match jobs.into_iter().find(|j| j.id == id) {
        Some(j) => j,
        None => return Ok(json_error("Training job not found", warp::http::StatusCode::NOT_FOUND)),
    };

    if user.role != "admin" && job.user_id != user.id {
        return Ok(json_error("Forbidden", warp::http::StatusCode::FORBIDDEN));
    }
    drop(db);

    if job.status != "completed" {
        return Ok(json_error("Only completed training jobs can be used for inference", warp::http::StatusCode::BAD_REQUEST));
    }

    let artifact_dir = match &job.artifact_directory {
        Some(dir) => {
            let p = std::path::PathBuf::from(dir);
            if p.is_absolute() { p } else { std::env::current_dir().unwrap_or_default().join(p) }
        }
        None => return Ok(json_error("No artifact directory for this job", warp::http::StatusCode::BAD_REQUEST)),
    };

    // Find the best checkpoint (same logic as single infer)
    let find_checkpoint = |dir: &std::path::Path| -> Option<std::path::PathBuf> {
        let cp_dir = dir.join("checkpoints");
        let best = cp_dir.join("best_model.pt");
        if best.exists() { return Some(best); }
        let latest = cp_dir.join("latest.pt");
        if latest.exists() { return Some(latest); }
        None
    };

    let checkpoint_path = find_checkpoint(&artifact_dir)
        .or_else(|| {
            artifact_dir.parent().and_then(|parent| {
                find_checkpoint(&parent.join(&job.run_name))
            })
        });

    let checkpoint_path = match checkpoint_path {
        Some(p) => p,
        None => return Ok(json_error("No checkpoint found in artifact directory", warp::http::StatusCode::BAD_REQUEST)),
    };

    // Parse sweep parameters from request body
    let param_name = body.get("param_name").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let param_start = body.get("start").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let param_end = body.get("end").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let param_step = body.get("step").and_then(|v| v.as_f64()).unwrap_or(1.0);

    if param_name.is_empty() {
        return Ok(json_error("Missing 'param_name' in request body", warp::http::StatusCode::BAD_REQUEST));
    }
    if param_step <= 0.0 {
        return Ok(json_error("'step' must be positive", warp::http::StatusCode::BAD_REQUEST));
    }
    let n_steps = ((param_end - param_start) / param_step).ceil() as i64 + 1;
    if n_steps > 500 {
        return Ok(json_error(&format!("Too many steps ({}). Max is 500.", n_steps), warp::http::StatusCode::BAD_REQUEST));
    }

    let other_params = body.get("other_params")
        .map(|v| v.to_string())
        .unwrap_or_else(|| "null".to_string());

    let output_dir = artifact_dir.join("inference_output");

    let ai_training_dir = std::env::current_dir()
        .map(|d| d.join("python").join("ai_training"))
        .unwrap_or_else(|_| std::path::PathBuf::from("/opt/mstar_queue/python/ai_training"));
    let python_path = match std::env::var("PYTHONPATH") {
        Ok(existing) => format!("{}:{}", ai_training_dir.display(), existing),
        Err(_) => ai_training_dir.display().to_string(),
    };

    eprintln!("[AI-SWEEP] Running sweep for job {}: {}=[{}, {}] step {}", id, param_name, param_start, param_end, param_step);

    let mut cmd = tokio::process::Command::new("python3");
    cmd.arg("-m").arg("mstar_ai.cli")
        .arg("infer-sweep")
        .arg("--checkpoint").arg(checkpoint_path.to_str().unwrap_or(""))
        .arg("--param-name").arg(&param_name)
        .arg("--start").arg(param_start.to_string())
        .arg("--end").arg(param_end.to_string())
        .arg("--step").arg(param_step.to_string())
        .arg("--output-dir").arg(output_dir.to_str().unwrap_or(""));

    if other_params != "null" {
        cmd.arg("--other-params").arg(&other_params);
    }

    let output = cmd
        .env("PYTHONPATH", &python_path)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .await;

    match output {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout).to_string();
            let stderr = String::from_utf8_lossy(&out.stderr).to_string();

            if out.status.success() {
                let result: serde_json::Value = serde_json::from_str(&stdout)
                    .unwrap_or(serde_json::json!({"raw_output": stdout}));
                Ok(json_ok(&serde_json::json!({
                    "status": "ok",
                    "job_id": id,
                    "sweep": result,
                    "output_dir": output_dir.to_str().unwrap_or(""),
                })))
            } else {
                eprintln!("[AI-SWEEP] Sweep failed for job {}: {}", id, stderr);
                let err_msg = if stderr.len() > 500 { stderr[..500].to_string() } else { stderr };
                Ok(json_error(
                    &format!("Sweep inference failed: {}", err_msg),
                    warp::http::StatusCode::INTERNAL_SERVER_ERROR,
                ))
            }
        }
        Err(e) => {
            eprintln!("[AI-SWEEP] Failed to spawn sweep process for job {}: {}", id, e);
            Ok(json_error(
                &format!("Failed to start sweep inference: {}", e),
                warp::http::StatusCode::INTERNAL_SERVER_ERROR,
            ))
        }
    }
}

/// GET /api/ai/training-jobs/:id/inference-progress — poll sweep inference progress
async fn handle_ai_inference_progress(
    id: i64,
    auth: Option<String>,
    state: AppState,
) -> Result<impl warp::Reply, warp::Rejection> {
    if !state.config.ai_training.enabled {
        return Ok(json_error("AI training is not enabled", warp::http::StatusCode::SERVICE_UNAVAILABLE));
    }

    let token = match extract_token(auth) {
        Some(t) => t,
        None => return Ok(json_error("Authentication required", warp::http::StatusCode::UNAUTHORIZED)),
    };

    let db = state.db.lock().await;
    let user = match db::validate_session(&db, &token) {
        Ok(u) => u,
        Err(_) => return Ok(json_error("Invalid session", warp::http::StatusCode::UNAUTHORIZED)),
    };

    let jobs = ai_training::list_training_jobs(&db, None, None);
    let job = match jobs.into_iter().find(|j| j.id == id) {
        Some(j) => j,
        None => return Ok(json_error("Training job not found", warp::http::StatusCode::NOT_FOUND)),
    };

    if user.role != "admin" && job.user_id != user.id {
        return Ok(json_error("Forbidden", warp::http::StatusCode::FORBIDDEN));
    }
    drop(db);

    let artifact_dir = match &job.artifact_directory {
        Some(dir) => {
            let p = std::path::PathBuf::from(dir);
            if p.is_absolute() { p } else { std::env::current_dir().unwrap_or_default().join(p) }
        }
        None => return Ok(json_ok(&serde_json::json!({
            "status": "ok",
            "progress": null,
        }))),
    };

    // Try the run directory first (same parent-sibling logic as metrics)
    let mut progress_path = artifact_dir.join("inference_output").join("inference_progress.json");
    if !progress_path.exists() {
        if let Some(parent) = artifact_dir.parent() {
            let sibling = parent.join(&job.run_name).join("inference_output").join("inference_progress.json");
            if sibling.exists() {
                progress_path = sibling;
            }
        }
    }

    if progress_path.exists() {
        match tokio::fs::read_to_string(&progress_path).await {
            Ok(content) => {
                if let Ok(progress) = serde_json::from_str::<serde_json::Value>(&content) {
                    Ok(json_ok(&serde_json::json!({
                        "status": "ok",
                        "progress": progress,
                    })))
                } else {
                    Ok(json_ok(&serde_json::json!({
                        "status": "ok",
                        "progress": null,
                    })))
                }
            }
            Err(_) => Ok(json_ok(&serde_json::json!({
                "status": "ok",
                "progress": null,
            }))),
        }
    } else {
        Ok(json_ok(&serde_json::json!({
            "status": "ok",
            "progress": null,
        })))
    }
}

/// GET /api/ai/artifacts/pvd-info — parse PVD from AI artifact output
async fn handle_ai_artifact_pvd_info(
    auth: Option<String>,
    params: HashMap<String, String>,
    state: AppState,
) -> Result<impl warp::Reply, warp::Rejection> {
    if let Err(e) = require_auth(&auth, &state).await {
        return Ok(e);
    }

    let path_str = params.get("path").cloned().unwrap_or_default();
    if path_str.is_empty() {
        return Ok(json_error("Missing 'path' parameter", warp::http::StatusCode::BAD_REQUEST));
    }

    let pvd_path = std::path::PathBuf::from(&path_str);

    // Security: must be within AI artifacts directory
    let ai_artifacts_base = state.config.ai_training.artifact_root.clone();
    let ai_base = if std::path::PathBuf::from(&ai_artifacts_base).is_absolute() {
        std::path::PathBuf::from(&ai_artifacts_base)
    } else {
        std::env::current_dir().unwrap_or_default().join(&ai_artifacts_base)
    };

    let canonical_base = match ai_base.canonicalize() {
        Ok(p) => p,
        Err(_) => return Ok(json_error("AI artifacts directory not found", warp::http::StatusCode::INTERNAL_SERVER_ERROR)),
    };
    let canonical_pvd = match pvd_path.canonicalize() {
        Ok(p) => p,
        Err(_) => return Ok(json_error("PVD file not found", warp::http::StatusCode::NOT_FOUND)),
    };
    if !canonical_pvd.starts_with(&canonical_base) {
        return Ok(json_error("Access denied: path outside AI artifacts", warp::http::StatusCode::FORBIDDEN));
    }

    // Read and parse PVD XML (reuse same logic as handle_pvd_info)
    let pvd_content = match tokio::fs::read_to_string(&canonical_pvd).await {
        Ok(c) => c,
        Err(e) => return Ok(json_error(&format!("Failed to read PVD: {}", e), warp::http::StatusCode::INTERNAL_SERVER_ERROR)),
    };

    // Use a Vec to preserve PVD file order, then sort numerically.
    // A BTreeMap<String> would sort "10" before "2" lexicographically,
    // which scrambles animation playback for AI prediction sweeps.
    let mut timestep_entries: Vec<(f64, String, Vec<serde_json::Value>)> = Vec::new();
    let mut file_extension = String::new();

    for line in pvd_content.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with("<DataSet") { continue; }

        let ts = extract_xml_attr(trimmed, "timestep").unwrap_or_default();
        let file = extract_xml_attr(trimmed, "file").unwrap_or_default();
        let part = extract_xml_attr(trimmed, "part").unwrap_or_default();
        let group = extract_xml_attr(trimmed, "group").unwrap_or_default();
        let name = extract_xml_attr(trimmed, "name").unwrap_or_default();

        if file.is_empty() { continue; }

        if file_extension.is_empty() {
            file_extension = std::path::Path::new(&file)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_lowercase();
        }

        let entry = serde_json::json!({
            "file": file,
            "part": part.parse::<i32>().unwrap_or(0),
            "group": if group.is_empty() { "" } else { &group },
            "name": if name.is_empty() { "" } else { &name },
        });

        let ts_f64 = ts.parse::<f64>().unwrap_or(0.0);

        // Check if we already have this timestep (for multi-part datasets)
        if let Some(existing) = timestep_entries.iter_mut().find(|(t, _, _)| (*t - ts_f64).abs() < 1e-12) {
            existing.2.push(entry);
        } else {
            timestep_entries.push((ts_f64, ts, vec![entry]));
        }
    }

    // Sort by the numeric timestep value, not the string representation
    timestep_entries.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

    let timesteps: Vec<serde_json::Value> = timestep_entries.into_iter().map(|(t, _ts_str, files)| {
        // Use the name from the first file entry as the timestep label
        let label = files.first()
            .and_then(|f| f.get("name"))
            .and_then(|n| n.as_str())
            .unwrap_or("")
            .to_string();
        let mut ts_obj = serde_json::json!({ "time": t, "files": files });
        if !label.is_empty() {
            ts_obj["label"] = serde_json::json!(label);
        }
        ts_obj
    }).collect();

    // Try to discover arrays from the first VTI/VTP/VTU file
    let mut arrays = Vec::new();
    if let Some(first_ts) = timesteps.first() {
        if let Some(first_files) = first_ts.get("files").and_then(|f| f.as_array()) {
            if let Some(first_file) = first_files.first().and_then(|f| f.get("file")).and_then(|f| f.as_str()) {
                let pvd_dir = canonical_pvd.parent().unwrap_or(std::path::Path::new(""));
                let vtk_path = pvd_dir.join(first_file);
                if vtk_path.exists() {
                    if let Some(arr_val) = get_vtk_arrays_info(&vtk_path).await {
                        if let Some(arr) = arr_val.as_array() {
                            arrays = arr.clone();
                        }
                    }
                }
            }
        }
    }

    Ok(json_ok(&serde_json::json!({
        "pvd_path": path_str,
        "file_type": file_extension,
        "timesteps": timesteps,
        "arrays": arrays,
    })))
}

/// GET /api/ai/artifacts/vtk-serve — serve VTK file from AI artifact output
async fn handle_ai_artifact_vtk_serve(
    auth: Option<String>,
    params: HashMap<String, String>,
    state: AppState,
) -> Result<warp::reply::Response, warp::Rejection> {
    use warp::Reply;

    if let Err(e) = require_auth(&auth, &state).await {
        return Ok(e.into_response());
    }

    let file_path = params.get("path").cloned().unwrap_or_default();
    if file_path.is_empty() {
        return Ok(json_error("Missing 'path' parameter", warp::http::StatusCode::BAD_REQUEST).into_response());
    }

    let target = std::path::PathBuf::from(&file_path);

    // Security: must be within AI artifacts directory
    let ai_artifacts_base = state.config.ai_training.artifact_root.clone();
    let ai_base = if std::path::PathBuf::from(&ai_artifacts_base).is_absolute() {
        std::path::PathBuf::from(&ai_artifacts_base)
    } else {
        std::env::current_dir().unwrap_or_default().join(&ai_artifacts_base)
    };

    let canonical_base = match ai_base.canonicalize() {
        Ok(p) => p,
        Err(_) => return Ok(json_error("AI artifacts directory not found", warp::http::StatusCode::INTERNAL_SERVER_ERROR).into_response()),
    };
    let canonical_target = match target.canonicalize() {
        Ok(p) => p,
        Err(_) => return Ok(json_error("File not found", warp::http::StatusCode::NOT_FOUND).into_response()),
    };
    if !canonical_target.starts_with(&canonical_base) {
        return Ok(json_error("Access denied", warp::http::StatusCode::FORBIDDEN).into_response());
    }
    if !canonical_target.is_file() {
        return Ok(json_error("Not a file", warp::http::StatusCode::BAD_REQUEST).into_response());
    }

    let ext = canonical_target.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let content = match ext.as_str() {
        "vtp" => {
            match tokio::fs::read(&canonical_target).await {
                Ok(c) => c,
                Err(e) => return Ok(json_error(&format!("Failed to read VTP: {}", e),
                    warp::http::StatusCode::INTERNAL_SERVER_ERROR).into_response()),
            }
        },
        "vtu" | "vti" => {
            let cache_ext = format!("{}.converted.vtp", ext);
            let cache_path = canonical_target.with_extension(&cache_ext);

            if cache_path.exists() {
                match tokio::fs::read(&cache_path).await {
                    Ok(c) => c,
                    Err(e) => return Ok(json_error(&format!("Failed to read cached VTP: {}", e),
                        warp::http::StatusCode::INTERNAL_SERVER_ERROR).into_response()),
                }
            } else {
                let script_path = std::path::PathBuf::from("scripts/vtu_to_vtp.py");
                if !script_path.exists() {
                    return Ok(json_error("Conversion script not found", warp::http::StatusCode::INTERNAL_SERVER_ERROR).into_response());
                }

                let result = tokio::process::Command::new("python3")
                    .arg(&script_path)
                    .arg("convert")
                    .arg(&canonical_target)
                    .arg(&cache_path)
                    .output()
                    .await;

                match result {
                    Ok(output) if output.status.success() => {
                        match tokio::fs::read(&cache_path).await {
                            Ok(c) => c,
                            Err(e) => return Ok(json_error(&format!("Failed to read converted VTP: {}", e),
                                warp::http::StatusCode::INTERNAL_SERVER_ERROR).into_response()),
                        }
                    },
                    Ok(output) => {
                        let stderr = String::from_utf8_lossy(&output.stderr);
                        return Ok(json_error(&format!("Conversion failed: {}", stderr),
                            warp::http::StatusCode::INTERNAL_SERVER_ERROR).into_response());
                    },
                    Err(e) => {
                        return Ok(json_error(&format!("Failed to run conversion: {}", e),
                            warp::http::StatusCode::INTERNAL_SERVER_ERROR).into_response());
                    }
                }
            }
        },
        _ => {
            return Ok(json_error(&format!("Unsupported file type: {}", ext),
                warp::http::StatusCode::BAD_REQUEST).into_response());
        }
    };

    Ok(warp::reply::with_header(
        warp::reply::with_header(
            warp::reply::with_status(content, warp::http::StatusCode::OK),
            "Content-Type", "application/octet-stream"
        ),
        "Cache-Control", "public, max-age=3600"
    ).into_response())
}

/// GET /api/ai/config — return AI training configuration (enabled, defaults)
async fn handle_ai_config(
    auth: Option<String>,
    state: AppState,
) -> Result<impl warp::Reply, warp::Rejection> {
    let token = match extract_token(auth) {
        Some(t) => t,
        None => return Ok(json_error("Authentication required", warp::http::StatusCode::UNAUTHORIZED)),
    };

    let db = state.db.lock().await;
    let _user = match db::validate_session(&db, &token) {
        Ok(u) => u,
        Err(_) => return Ok(json_error("Invalid session", warp::http::StatusCode::UNAUTHORIZED)),
    };

    let cfg = &state.config.ai_training;

    // Get channel registry from Python module
    let channel_registry: serde_json::Value = {
        let ai_training_dir = std::env::current_dir()
            .map(|d| d.join("python").join("ai_training"))
            .unwrap_or_else(|_| std::path::PathBuf::from("/opt/mstar_queue/python/ai_training"));
        let python_path = match std::env::var("PYTHONPATH") {
            Ok(existing) => format!("{}:{}", ai_training_dir.display(), existing),
            Err(_) => ai_training_dir.display().to_string(),
        };
        let output = std::process::Command::new("python3")
            .arg("-c")
            .arg("import json; from mstar_ai.dataset.spatial_inputs import get_channel_registry; print(json.dumps(get_channel_registry()))")
            .env("PYTHONPATH", &python_path)
            .env("PYTHONDONTWRITEBYTECODE", "1")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .output();

        match output {
            Ok(out) if out.status.success() => {
                let stdout = String::from_utf8_lossy(&out.stdout);
                serde_json::from_str(stdout.trim()).unwrap_or_else(|e| {
                    eprintln!("[AI] channel_registry JSON parse error: {}", e);
                    serde_json::json!([])
                })
            },
            Ok(out) => {
                let stderr = String::from_utf8_lossy(&out.stderr);
                eprintln!("[AI] channel_registry Python failed (exit {}): {}",
                    out.status, stderr.chars().take(500).collect::<String>());
                serde_json::json!([])
            },
            Err(e) => {
                eprintln!("[AI] channel_registry subprocess error: {}", e);
                serde_json::json!([])
            },
        }
    };

    Ok(json_ok(&serde_json::json!({
        "enabled": cfg.enabled,
        "container_mode": cfg.container_mode,
        "default_model_family": cfg.default_model_family,
        "default_dataset_format": cfg.default_dataset_format,
        "default_batch_size": cfg.default_batch_size,
        "default_epochs": cfg.default_epochs,
        "default_learning_rate": cfg.default_learning_rate,
        "checkpoint_interval_epochs": cfg.checkpoint_interval_epochs,
        "max_concurrent_training_jobs": cfg.max_concurrent_training_jobs,
        "gpu_selection_policy": cfg.gpu_selection_policy,
        "channel_registry": channel_registry,
    })))
}

/// POST /api/ai/preflight — run preflight checks for a training config
async fn handle_ai_preflight(
    auth: Option<String>,
    body: serde_json::Value,
    state: AppState,
) -> Result<impl warp::Reply, warp::Rejection> {
    if !state.config.ai_training.enabled {
        return Ok(json_error("AI training is not enabled", warp::http::StatusCode::SERVICE_UNAVAILABLE));
    }

    let token = match extract_token(auth) {
        Some(t) => t,
        None => return Ok(json_error("Authentication required", warp::http::StatusCode::UNAUTHORIZED)),
    };

    let db = state.db.lock().await;
    let _user = match db::validate_session(&db, &token) {
        Ok(u) => u,
        Err(_) => return Ok(json_error("Invalid session", warp::http::StatusCode::UNAUTHORIZED)),
    };

    // Run preflight via the mstar-ai CLI
    let cfg = &state.config.ai_training;
    let config_str = body.to_string();

    let mut cmd = if cfg.container_mode {
        let mut c = std::process::Command::new("docker");
        c.arg("run").arg("--rm")
         .arg(&cfg.container_image)
         .arg("mstar-ai").arg("preflight")
         .arg("--config-json").arg(&config_str);
        c
    } else {
        let mut c = std::process::Command::new(&cfg.python_executable);
        c.arg("-m").arg("mstar_ai.cli").arg("preflight")
         .arg("--config-json").arg(&config_str);
        c
    };

    // Set PYTHONPATH so mstar_ai is importable
    let ai_training_dir = std::env::current_dir()
        .map(|d| d.join("python").join("ai_training"))
        .unwrap_or_else(|_| std::path::PathBuf::from("/opt/mstar_queue/python/ai_training"));
    let pythonpath = match std::env::var("PYTHONPATH") {
        Ok(existing) => format!("{}:{}", ai_training_dir.display(), existing),
        Err(_) => ai_training_dir.display().to_string(),
    };

    cmd.stdout(std::process::Stdio::piped())
       .stderr(std::process::Stdio::piped())
       .env("PYTHONPATH", &pythonpath);

    match cmd.output() {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            // Try to parse as JSON
            match serde_json::from_str::<serde_json::Value>(&stdout) {
                Ok(result) => Ok(json_ok(&result)),
                Err(_) => Ok(json_ok(&serde_json::json!({
                    "status": if output.status.success() { "ok" } else { "error" },
                    "output": stdout.trim(),
                }))),
            }
        }
        Err(e) => Ok(json_error(
            &format!("Failed to run preflight: {}", e),
            warp::http::StatusCode::INTERNAL_SERVER_ERROR,
        )),
    }
}

// ============================================================
// Sweep Detection & Batch Submit
// ============================================================

/// POST /api/sweep/detect — detect sweeps in an MSB file using sweep_inspector.py
///
/// Body: { "msb_path": "/path/to/file.msb", "mstar_version": "4.4.23" }
/// Returns: { "sweeps": [...], "error": null }
async fn handle_sweep_detect(
    auth: Option<String>,
    body: serde_json::Value,
    state: AppState,
) -> Result<impl warp::Reply, warp::Rejection> {
    let token = match extract_token(auth) {
        Some(t) => t,
        None => return Ok(json_error("Authentication required", warp::http::StatusCode::UNAUTHORIZED)),
    };

    let db = state.db.lock().await;
    let _user = match db::validate_session(&db, &token) {
        Ok(u) => u,
        Err(_) => return Ok(json_error("Invalid session", warp::http::StatusCode::UNAUTHORIZED)),
    };
    drop(db);

    let msb_path = match body.get("msb_path").and_then(|v| v.as_str()) {
        Some(p) => p.to_string(),
        None => return Ok(json_error("msb_path required", warp::http::StatusCode::BAD_REQUEST)),
    };

    let mstar_version = body.get("mstar_version")
        .and_then(|v| v.as_str())
        .unwrap_or("latest")
        .to_string();

    // Resolve M-Star version to directory path
    let mstar_dir = resolve_mstar_dir(&state.config.paths.mstar_install_dir, &mstar_version);
    let mstar_dir = match mstar_dir {
        Some(d) => d,
        None => return Ok(json_error(
            &format!("M-Star version '{}' not found", mstar_version),
            warp::http::StatusCode::BAD_REQUEST,
        )),
    };

    // SECURITY: Validate MSB path is under allowed directories
    let msb_canonical = match std::fs::canonicalize(&msb_path) {
        Ok(p) => p,
        Err(_) => return Ok(json_error(
            &format!("MSB file not found: {}", msb_path),
            warp::http::StatusCode::BAD_REQUEST,
        )),
    };

    let data_root = &state.config.paths.data_root;
    let queue_dir = &state.config.paths.queue_directory;
    if !msb_canonical.starts_with(data_root) && !msb_canonical.starts_with(queue_dir) {
        return Ok(json_error(
            "MSB path is outside allowed directories",
            warp::http::StatusCode::FORBIDDEN,
        ));
    }

    // Find the sweep_inspector.py script (deployed to working directory, e.g. /opt/mstar_queue)
    let sweep_script = std::env::current_dir()
        .map(|d| d.join("sweep_inspector.py"))
        .unwrap_or_else(|_| std::path::PathBuf::from("sweep_inspector.py"));

    // Run sweep_inspector.py detect
    let mstar_lib = mstar_dir.join("lib");
    let mstar_bin = mstar_dir.join("bin");
    let python = "python3";

    let output = tokio::task::spawn_blocking(move || {
        std::process::Command::new(python)
            .arg(sweep_script.to_str().unwrap_or("sweep_inspector.py"))
            .arg("detect")
            .arg(&msb_path)
            .env("MSTAR_DIR", mstar_dir.to_str().unwrap_or(""))
            .env("PYTHONPATH", format!("{}:{}",
                mstar_lib.display(),
                std::env::var("PYTHONPATH").unwrap_or_default()))
            .env("LD_LIBRARY_PATH", format!("{}:{}:{}",
                mstar_lib.display(),
                mstar_bin.display(),
                std::env::var("LD_LIBRARY_PATH").unwrap_or_default()))
            .env("PATH", format!("{}:{}",
                mstar_bin.display(),
                std::env::var("PATH").unwrap_or_default()))
            .env("HOME", std::env::var("HOME").unwrap_or_else(|_| "/opt/mstar_queue".to_string()))
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .output()
    }).await;

    match output {
        Ok(Ok(result)) => {
            let stdout = String::from_utf8_lossy(&result.stdout);
            let stderr = String::from_utf8_lossy(&result.stderr);

            if !result.status.success() {
                return Ok(json_error(
                    &format!("Sweep detection failed: {}", stderr.trim()),
                    warp::http::StatusCode::INTERNAL_SERVER_ERROR,
                ));
            }

            // Try parsing the entire stdout as JSON first
            let parse_result = serde_json::from_str::<serde_json::Value>(&stdout)
                .or_else(|_| {
                    // Fallback: M-Star native output may leak before the JSON.
                    // Find the first '{' and try parsing from there.
                    if let Some(start) = stdout.find('{') {
                        serde_json::from_str::<serde_json::Value>(&stdout[start..])
                    } else {
                        Err(serde_json::from_str::<serde_json::Value>("!").unwrap_err())
                    }
                });

            match parse_result {
                Ok(sweep_data) => Ok(json_ok(&sweep_data)),
                Err(e) => Ok(json_error(
                    &format!("Failed to parse sweep data: {}", e),
                    warp::http::StatusCode::INTERNAL_SERVER_ERROR,
                )),
            }
        }
        Ok(Err(e)) => Ok(json_error(
            &format!("Failed to run sweep inspector: {}", e),
            warp::http::StatusCode::INTERNAL_SERVER_ERROR,
        )),
        Err(e) => Ok(json_error(
            &format!("Sweep detection task failed: {}", e),
            warp::http::StatusCode::INTERNAL_SERVER_ERROR,
        )),
    }
}

/// POST /api/sweep/submit — submit a parameter sweep as a batch of jobs
///
/// Body: {
///   "msb_path": "/path/to/file.msb",
///   "sweep_index": 0,
///   "mstar_version": "4.4.23",
///   "cases": ["LX_75", "LX_100"],
///   "gpu_pool": [0, 1, 2, 3],
///   "gpus_per_case": 2,
///   "max_concurrent": 2,
///   "priority": 0,
///   "unified_memory": false,
///   "copy_to_path": "",
///   "sweep_name": "Resolution Sweep"
/// }
async fn handle_sweep_submit(
    auth: Option<String>,
    body: serde_json::Value,
    state: AppState,
) -> Result<impl warp::Reply, warp::Rejection> {
    let token = match extract_token(auth) {
        Some(t) => t,
        None => return Ok(json_error("Authentication required", warp::http::StatusCode::UNAUTHORIZED)),
    };

    let db = state.db.lock().await;
    let user = match db::validate_session(&db, &token) {
        Ok(u) => u,
        Err(_) => return Ok(json_error("Invalid session", warp::http::StatusCode::UNAUTHORIZED)),
    };
    let user_id = user.id;
    let _username = user.username.clone();
    drop(db);

    // Parse required fields
    let msb_path = match body.get("msb_path").and_then(|v| v.as_str()) {
        Some(p) => p.to_string(),
        None => return Ok(json_error("msb_path required", warp::http::StatusCode::BAD_REQUEST)),
    };

    let sweep_index = body.get("sweep_index").and_then(|v| v.as_i64()).unwrap_or(0);

    let cases: Vec<String> = match body.get("cases").and_then(|v| v.as_array()) {
        Some(arr) => arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect(),
        None => return Ok(json_error("cases array required", warp::http::StatusCode::BAD_REQUEST)),
    };

    if cases.is_empty() {
        return Ok(json_error("At least one case must be selected", warp::http::StatusCode::BAD_REQUEST));
    }

    let gpu_pool: Vec<i64> = body.get("gpu_pool")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_i64()).collect())
        .unwrap_or_default();

    let gpus_per_case = body.get("gpus_per_case").and_then(|v| v.as_u64()).unwrap_or(1) as usize;
    let max_concurrent = body.get("max_concurrent").and_then(|v| v.as_u64()).unwrap_or(1) as usize;
    let mstar_version = body.get("mstar_version").and_then(|v| v.as_str()).unwrap_or("latest").to_string();
    let priority = body.get("priority").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
    let unified_memory = body.get("unified_memory").and_then(|v| v.as_bool()).unwrap_or(false);
    let copy_to = body.get("copy_to_path").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(|s| s.to_string());
    let sweep_name = body.get("sweep_name").and_then(|v| v.as_str()).unwrap_or("Sweep").to_string();

    // Validate GPU pool and allocation
    if gpu_pool.is_empty() {
        return Ok(json_error("gpu_pool required", warp::http::StatusCode::BAD_REQUEST));
    }
    if gpus_per_case == 0 || gpus_per_case > gpu_pool.len() {
        return Ok(json_error(
            &format!("gpus_per_case ({}) must be 1..{}", gpus_per_case, gpu_pool.len()),
            warp::http::StatusCode::BAD_REQUEST,
        ));
    }

    // SECURITY: validate MSB path
    let msb_canonical = match std::fs::canonicalize(&msb_path) {
        Ok(p) => p,
        Err(_) => return Ok(json_error("MSB file not found", warp::http::StatusCode::BAD_REQUEST)),
    };
    let data_root = &state.config.paths.data_root;
    let queue_dir = &state.config.paths.queue_directory;
    if !msb_canonical.starts_with(data_root) && !msb_canonical.starts_with(queue_dir) {
        return Ok(json_error("MSB path outside allowed directories", warp::http::StatusCode::FORBIDDEN));
    }

    // ---- NEW: Create unified sweep directory via export_for_queue ----

    // Build sweep root path: jobs_directory/sweeps/{sweep_name}_{timestamp}
    let timestamp = chrono::Utc::now().format("%Y%m%d_%H%M%S").to_string();
    let safe_name: String = sweep_name.chars()
        .map(|c| if c.is_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .collect();
    let sweep_dir_name = format!("{}_{}", safe_name, timestamp);
    let sweep_root = state.config.paths.jobs_directory
        .join("sweeps")
        .join(&sweep_dir_name);

    // Ensure parent directory exists
    let sweep_parent = sweep_root.parent().unwrap_or(&sweep_root);
    if let Err(e) = tokio::fs::create_dir_all(sweep_parent).await {
        return Ok(json_error(
            &format!("Failed to create sweep directory: {}", e),
            warp::http::StatusCode::INTERNAL_SERVER_ERROR,
        ));
    }

    // Resolve M-Star version for the export
    let install_dir = &state.config.paths.mstar_install_dir;
    let mstar_dir = match resolve_mstar_dir(install_dir, &mstar_version) {
        Some(d) => d,
        None => return Ok(json_error(
            &format!("M-Star version '{}' not found", mstar_version),
            warp::http::StatusCode::BAD_REQUEST,
        )),
    };

    // Run sweep_inspector.py export_for_queue
    let sweep_script = std::env::current_dir()
        .map(|d| d.join("sweep_inspector.py"))
        .unwrap_or_else(|_| std::path::PathBuf::from("sweep_inspector.py"));

    let mstar_lib = mstar_dir.join("lib");
    let mstar_bin = mstar_dir.join("bin");
    let sweep_root_str = sweep_root.to_str().unwrap_or("").to_string();
    let msb_path_clone = msb_path.clone();
    let mstar_version_clone = mstar_version.clone();

    println!("[SWEEP] Exporting sweep to: {}", sweep_root_str);

    let export_output = tokio::time::timeout(
        std::time::Duration::from_secs(300), // 5 min timeout for export
        tokio::task::spawn_blocking(move || {
            std::process::Command::new("python3")
                .arg(sweep_script.to_str().unwrap_or("sweep_inspector.py"))
                .arg("export_for_queue")
                .arg(&msb_path_clone)
                .arg(sweep_index.to_string())
                .arg(&sweep_root_str)
                .env("MSTAR_DIR", mstar_dir.to_str().unwrap_or(""))
                .env("MSTAR_VERSION", &mstar_version_clone)
                .env("PYTHONPATH", format!("{}:{}",
                    mstar_lib.display(),
                    std::env::var("PYTHONPATH").unwrap_or_default()))
                .env("LD_LIBRARY_PATH", format!("{}:{}:{}",
                    mstar_lib.display(),
                    mstar_bin.display(),
                    std::env::var("LD_LIBRARY_PATH").unwrap_or_default()))
                .env("PATH", format!("{}:{}",
                    mstar_bin.display(),
                    std::env::var("PATH").unwrap_or_default()))
                .env("HOME", std::env::var("HOME").unwrap_or_else(|_| "/opt/mstar_queue".to_string()))
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .output()
        })
    ).await;

    let export_result: serde_json::Value = match export_output {
        Ok(Ok(Ok(result))) => {
            let stdout = String::from_utf8_lossy(&result.stdout);
            let stderr_str = String::from_utf8_lossy(&result.stderr);

            if !result.status.success() {
                return Ok(json_error(
                    &format!("Sweep export failed: {}", stderr_str.trim()),
                    warp::http::StatusCode::INTERNAL_SERVER_ERROR,
                ));
            }

            // Parse JSON with fallback for native output contamination
            serde_json::from_str::<serde_json::Value>(&stdout)
                .or_else(|_| {
                    if let Some(start) = stdout.find('{') {
                        serde_json::from_str::<serde_json::Value>(&stdout[start..])
                    } else {
                        Err(serde_json::from_str::<serde_json::Value>("!").unwrap_err())
                    }
                })
                .unwrap_or_else(|e| serde_json::json!({"error": format!("Failed to parse export output: {}", e)}))
        }
        Ok(Ok(Err(e))) => return Ok(json_error(&format!("Failed to run export: {}", e), warp::http::StatusCode::INTERNAL_SERVER_ERROR)),
        Ok(Err(e)) => return Ok(json_error(&format!("Export task failed: {}", e), warp::http::StatusCode::INTERNAL_SERVER_ERROR)),
        Err(_) => return Ok(json_error("Sweep export timed out (5 min)", warp::http::StatusCode::GATEWAY_TIMEOUT)),
    };

    // Check for export errors
    if let Some(err) = export_result.get("error").and_then(|v| v.as_str()) {
        return Ok(json_error(&format!("Sweep export failed: {}", err), warp::http::StatusCode::INTERNAL_SERVER_ERROR));
    }

    let exported_cases = export_result.get("cases")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let sweep_root_path = export_result.get("sweep_root")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    println!("[SWEEP] Export complete: {} cases to {}", exported_cases.len(), sweep_root_path);

    // ---- Create jobs with working_directory pointing into case subdirs ----

    let sweep_group_id = format!("sweep-{}", db::generate_token()[..16].to_string());

    let sweep_config = serde_json::json!({
        "sweep_name": sweep_name,
        "sweep_index": sweep_index,
        "gpus_per_case": gpus_per_case,
        "max_concurrent": max_concurrent,
        "gpu_pool": gpu_pool,
        "total_cases": cases.len(),
        "msb_source": msb_path,
        "sweep_root": sweep_root_path,
        "parameters": export_result.get("manifest")
            .and_then(|m| m.get("parameters"))
            .cloned()
            .unwrap_or_else(|| serde_json::json!([])),
        "cases": exported_cases.iter().map(|c| {
            serde_json::json!({
                "name": c.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                "parameters": c.get("parameters").cloned().unwrap_or_else(|| serde_json::json!({})),
            })
        }).collect::<Vec<_>>(),
    }).to_string();

    let mut created_jobs = Vec::new();
    let msb_filename = std::path::Path::new(&msb_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("sweep.msb")
        .to_string();

    for (i, case_name) in cases.iter().enumerate() {
        // Round-robin GPU assignment
        let start_idx = (i * gpus_per_case) % gpu_pool.len();
        let case_gpus: Vec<i64> = (0..gpus_per_case)
            .map(|j| gpu_pool[(start_idx + j) % gpu_pool.len()])
            .collect();
        let gpu_ids_str = serde_json::to_string(&case_gpus).unwrap_or_else(|_| "[]".to_string());

        let job_name = format!("{} — {}", sweep_name, case_name);

        // Find this case's exported directory and MSB
        let case_dir = exported_cases.iter()
            .find(|c| c.get("name").and_then(|v| v.as_str()) == Some(case_name))
            .and_then(|c| c.get("directory").and_then(|v| v.as_str()))
            .map(|s| s.to_string());

        let case_msb = exported_cases.iter()
            .find(|c| c.get("name").and_then(|v| v.as_str()) == Some(case_name))
            .and_then(|c| c.get("msb_file").and_then(|v| v.as_str()))
            .map(|s| std::path::Path::new(s).file_name().and_then(|n| n.to_str()).unwrap_or(&msb_filename).to_string())
            .unwrap_or_else(|| msb_filename.clone());

        let db = state.db.lock().await;
        let copy_to_ref = copy_to.as_deref();
        let result = db::create_sweep_job(
            &db, user_id, &job_name, &case_msb, &mstar_version, &gpu_ids_str,
            unified_memory, priority, copy_to_ref,
            &sweep_group_id, case_name, &sweep_config,
        );

        match result {
            Ok(job_id) => {
                // Set working_directory to the case subdirectory (already created by export)
                if let Some(ref cd) = case_dir {
                    let _ = db.execute(
                        "UPDATE jobs SET working_directory = ?2 WHERE id = ?1",
                        rusqlite::params![job_id, cd],
                    );
                }
                drop(db);

                created_jobs.push(serde_json::json!({
                    "job_id": job_id,
                    "case_name": case_name,
                    "gpu_ids": case_gpus,
                    "working_directory": case_dir,
                }));
            }
            Err(e) => {
                drop(db);
                created_jobs.push(serde_json::json!({
                    "case_name": case_name,
                    "error": e,
                }));
            }
        }
    }

    // ---- Auto-create AI dataset from the sweep directory ----
    let dataset_id = {
        let db = state.db.lock().await;
        let config_json = serde_json::json!({
            "sweep_group_id": sweep_group_id,
            "sweep_name": sweep_name,
            "source_msb": msb_path,
            "mstar_version": mstar_version,
            "sweep_root": sweep_root_path,
            "total_cases": cases.len(),
            "auto_created": true,
        }).to_string();

        let dataset_name = format!("{}", sweep_name);
        match crate::ai_training::create_dataset(
            &db, user_id, &dataset_name, &sweep_root_path,
            "stats_table", Some(&config_json),
        ) {
            Ok(id) => {
                // Set to 'pending' — will flip to 'ready' when all sweep jobs complete
                let manifest = format!("{}/sweep_manifest.json", sweep_root_path);
                let _ = crate::ai_training::update_dataset_status(
                    &db, id, "pending", Some(&manifest), None,
                    Some(&format!("{{\"status_info\": \"Waiting for {} sweep cases to complete\"}}", cases.len())),
                );
                Some(id)
            }
            Err(e) => {
                eprintln!("[SWEEP] Warning: failed to auto-create dataset: {}", e);
                None
            }
        }
    };

    let total_created = created_jobs.iter().filter(|j| j.get("job_id").is_some()).count();
    println!("[SWEEP] Created sweep group {} with {} jobs ({}), sweep_root={}, dataset_id={:?}",
        sweep_group_id, total_created, sweep_name, sweep_root_path, dataset_id);

    Ok(json_ok(&serde_json::json!({
        "sweep_group_id": sweep_group_id,
        "jobs": created_jobs,
        "total_created": total_created,
        "sweep_name": sweep_name,
        "sweep_root": sweep_root_path,
        "dataset_id": dataset_id,
    })))
}

/// POST /api/sweep/:group_id/create-dataset
/// Creates an AI training dataset from a completed sweep group.
async fn handle_sweep_create_dataset(
    sweep_group_id: String,
    auth: Option<String>,
    body: serde_json::Value,
    state: AppState,
) -> Result<impl warp::Reply, warp::Rejection> {
    let token = match extract_token(auth) {
        Some(t) => t,
        None => return Ok(json_error("Authentication required", warp::http::StatusCode::UNAUTHORIZED)),
    };

    let conn = state.db.lock().await;
    let user = match db::validate_session(&conn, &token) {
        Ok(u) => u,
        Err(_) => return Ok(json_error("Invalid session", warp::http::StatusCode::UNAUTHORIZED)),
    };

    let dataset_name = body.get("name").and_then(|v| v.as_str()).unwrap_or("Sweep Dataset");

    // Get all jobs in this sweep group
    let sweep_jobs = crate::db::list_sweep_jobs(&conn, &sweep_group_id)
        .map_err(|_| warp::reject::reject())?;

    if sweep_jobs.is_empty() {
        return Ok(json_error("No jobs found for this sweep group", warp::http::StatusCode::NOT_FOUND));
    }

    // Count completed vs total
    let completed: Vec<_> = sweep_jobs.iter().filter(|j| j.status == "completed").collect();
    let total = sweep_jobs.len();

    if completed.is_empty() {
        return Ok(json_error(
            "No completed jobs in this sweep group",
            warp::http::StatusCode::BAD_REQUEST,
        ));
    }

    // Determine sweep_root from the first completed job's working directory parent
    let sweep_root = completed.first()
        .and_then(|j| j.working_directory.as_deref())
        .map(|wd| {
            std::path::Path::new(wd)
                .parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|| wd.to_string())
        })
        .unwrap_or_else(|| "/simulations".to_string());

    // Store provenance in config
    let config_json = serde_json::json!({
        "sweep_group_id": sweep_group_id,
        "total_sweep_jobs": total,
        "completed_jobs": completed.len(),
        "source_msb": completed.first().map(|j| &j.msb_filename),
        "mstar_version": completed.first().map(|j| &j.mstar_version),
    }).to_string();

    // Create the AI dataset
    let dataset_id = crate::ai_training::create_dataset(
        &conn,
        user.id,
        dataset_name,
        &sweep_root,
        "",  // No mode — inventory scan determines what's available
        Some(&config_json),
    ).map_err(|e| {
        eprintln!("[SWEEP->DATASET] Failed to create dataset: {}", e);
        warp::reject::reject()
    })?;

    // config_json is already set via create_dataset INSERT above

    // Create dataset cases from completed job working directories
    let mut cases_added = 0;
    for job in &completed {
        if let Some(wd) = job.working_directory.as_deref() {
            if std::path::Path::new(wd).exists() {
                let case_name = job.sweep_case_name.as_deref().unwrap_or(&job.name);
                let _ = conn.execute(
                    "INSERT INTO ai_dataset_cases (dataset_id, case_name, case_directory, status, config_json)
                     VALUES (?1, ?2, ?3, 'ready', ?4)",
                    rusqlite::params![
                        dataset_id,
                        case_name,
                        wd,
                        serde_json::json!({
                            "job_id": job.id,
                            "sweep_case_name": job.sweep_case_name,
                            "mstar_version": job.mstar_version,
                        }).to_string(),
                    ],
                );
                cases_added += 1;
            }
        }
    }

    let warnings = if completed.len() < total {
        Some(format!("{} of {} jobs completed — {} skipped (failed/running/queued)",
            completed.len(), total, total - completed.len()))
    } else {
        None
    };

    // Don't set status to 'ready' yet — the background scan will set it
    // Just store the warnings for now
    if let Some(ref w) = warnings {
        let _ = crate::ai_training::update_dataset_status(
            &conn, dataset_id, "scanning", None, None, Some(w), 
        );
    }

    println!("[SWEEP->DATASET] Created dataset {} from sweep group {} ({} cases)",
        dataset_id, sweep_group_id, cases_added);

    // Drop the DB lock before spawning background scan
    drop(conn);

    // Trigger background scan to populate inventory
    let scan_root_clone = sweep_root.clone();
    let scan_db = state.db.clone();
    tokio::spawn(async move {
        run_dataset_scan(scan_db, dataset_id, &scan_root_clone).await;
    });

    Ok(json_ok(&serde_json::json!({
        "dataset_id": dataset_id,
        "cases_added": cases_added,
        "total_jobs": total,
        "completed_jobs": completed.len(),
        "warnings": warnings,
        "status": "scanning",
    })))
}

/// Resolve an M-Star version string (e.g. "4.4.23" or "latest") to the actual
/// installation directory path.
fn resolve_mstar_dir(install_dir: &std::path::Path, version: &str) -> Option<std::path::PathBuf> {
    if version == "latest" {
        // Try the symlink first
        let latest = install_dir.join("mstarcfd-latest");
        if latest.exists() {
            return Some(std::fs::canonicalize(&latest).ok()?);
        }
        // Fall back to discovering versions and picking the highest
        let versions = crate::mstar_versions::discover_versions(install_dir);
        versions.first().map(|v| install_dir.join(format!("mstarcfd-{}", v.version)))
    } else {
        let dir = install_dir.join(format!("mstarcfd-{}", version));
        if dir.is_dir() { Some(dir) } else { None }
    }
}

/// Run the dataset scanner against a sweep root and store the inventory.
/// Called in a background task after dataset creation.
async fn run_dataset_scan(db: crate::DbHandle, dataset_id: i64, sweep_root: &str) {
    println!("[DATASET-SCAN] Starting scan for dataset {} at {}", dataset_id, sweep_root);

    let scanner_path = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| std::path::PathBuf::from("."));

    // Try to find the scanner script relative to the executable or in known locations
    let scanner_script = [
        scanner_path.join("dataset_scanner.py"),
        std::path::PathBuf::from("/opt/mstar_queue/dataset_scanner.py"),
        std::path::PathBuf::from("dataset_scanner.py"),
    ]
    .iter()
    .find(|p| p.exists())
    .cloned();

    let script = match scanner_script {
        Some(s) => s,
        None => {
            eprintln!("[DATASET-SCAN] dataset_scanner.py not found");
            let conn = db.lock().await;
            let _ = ai_training::update_dataset_status(
                &conn, dataset_id, "error", None, None,
                Some("Scanner script not found"),
            );
            return;
        }
    };

    // Run the scanner
    let output = tokio::process::Command::new("python3")
        .arg(&script)
        .arg("scan")
        .arg(sweep_root)
        .output()
        .await;

    match output {
        Ok(result) => {
            if !result.status.success() {
                let stderr = String::from_utf8_lossy(&result.stderr);
                eprintln!("[DATASET-SCAN] Scanner failed for dataset {}: {}", dataset_id, stderr);
                let conn = db.lock().await;
                let _ = ai_training::update_dataset_status(
                    &conn, dataset_id, "error", None, None,
                    Some(&format!("Scan failed: {}", stderr.chars().take(500).collect::<String>())),
                );
                return;
            }

            let stdout = String::from_utf8_lossy(&result.stdout);
            match serde_json::from_str::<serde_json::Value>(&stdout) {
                Ok(inventory) => {
                    // Build enriched stats inventory — include validation + sizes
                    let mut stats_inv = inventory.get("stats_inventory")
                        .cloned()
                        .unwrap_or_else(|| serde_json::json!({}));
                    // Embed validation and sizes into the stats inventory blob
                    if let Some(v) = inventory.get("validation") {
                        stats_inv["validation"] = v.clone();
                    }
                    if let Some(v) = inventory.get("total_data_bytes") {
                        stats_inv["total_data_bytes"] = v.clone();
                    }
                    if let Some(v) = inventory.get("total_data_human") {
                        stats_inv["total_data_human"] = v.clone();
                    }
                    if let Some(v) = inventory.get("total_stats_bytes") {
                        stats_inv["total_stats_bytes"] = v.clone();
                    }
                    if let Some(v) = inventory.get("total_pvd_bytes") {
                        stats_inv["total_pvd_bytes"] = v.clone();
                    }

                    let stats_inv_str = stats_inv.to_string();
                    let pvd_inv = inventory.get("pvd_inventory")
                        .map(|v| v.to_string())
                        .unwrap_or_else(|| "{}".to_string());
                    let cases = inventory.get("cases")
                        .map(|v| v.to_string())
                        .unwrap_or_else(|| "[]".to_string());
                    let sweep_params = inventory.get("sweep_parameters")
                        .map(|v| v.to_string());
                    let num_cases = inventory.get("num_cases")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0);
                    let num_with_output = inventory.get("num_cases_with_output")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0);
                    let warnings = inventory.get("warnings")
                        .map(|v| v.to_string());

                    // Determine dataset status from validation
                    let validation_status = inventory.get("validation")
                        .and_then(|v| v.get("status"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("ready");

                    let conn = db.lock().await;
                    match ai_training::update_dataset_inventory(
                        &conn,
                        dataset_id,
                        &stats_inv_str,
                        &pvd_inv,
                        &cases,
                        sweep_params.as_deref(),
                        num_cases,
                        num_with_output,
                        warnings.as_deref(),
                    ) {
                        Ok(()) => {
                            // Set status based on validation
                            let ds_status = match validation_status {
                                "pass" => "ready",
                                "warn" => "warnings",
                                "fail" => "error",
                                _ => "ready",
                            };
                            let _ = ai_training::update_dataset_status(
                                &conn, dataset_id, ds_status, None, None, None,
                            );
                            println!("[DATASET-SCAN] Dataset {} scan complete: {} cases, {} with output, validation={}",
                                dataset_id, num_cases, num_with_output, validation_status);
                        }
                        Err(e) => {
                            eprintln!("[DATASET-SCAN] Failed to store inventory for dataset {}: {}", dataset_id, e);
                        }
                    }
                }
                Err(e) => {
                    eprintln!("[DATASET-SCAN] Failed to parse scanner output for dataset {}: {}", dataset_id, e);
                    let conn = db.lock().await;
                    let _ = ai_training::update_dataset_status(
                        &conn, dataset_id, "error", None, None,
                        Some(&format!("Parse error: {}", e)),
                    );
                }
            }
        }
        Err(e) => {
            eprintln!("[DATASET-SCAN] Failed to run scanner for dataset {}: {}", dataset_id, e);
            let conn = db.lock().await;
            let _ = ai_training::update_dataset_status(
                &conn, dataset_id, "error", None, None,
                Some(&format!("Spawn error: {}", e)),
            );
        }
    }
}
