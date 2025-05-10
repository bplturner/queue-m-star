use std::sync::Arc;
use std::collections::HashMap;
use std::fs::File;
use std::path::{Path, PathBuf};
use warp::Filter;
use crate::{GpuStatus, ProcessInfo, log_and_print, Config};
use tokio::sync::{Mutex, RwLock as TokioRwLock};
//use warp::multipart::{FormData, Part};
use warp::Rejection;
//use bytes::Buf;
use warp::reject::PayloadTooLarge;
use crate::get_gpu_info;
use std::time::{SystemTime, UNIX_EPOCH};
use crate::config::{WebServerConfig, PathConfig};

type ProcessMap = Arc<TokioRwLock<HashMap<u32, ProcessInfo>>>;
type GpuStatusList = Arc<Mutex<Vec<GpuStatus>>>;

// Add this function at the top of the file or in a separate module
fn simple_hash(input: &str, timestamp: u64) -> String {
    let combined_input = format!("{}{}", input, timestamp);
    let mut hash: u32 = 5381;
    for byte in combined_input.bytes() {
        hash = hash.wrapping_mul(33).wrapping_add(u32::from(byte));
    }
    format!("{:05x}", hash & 0xfffff)
}

pub async fn run_web_server(
    log_file: Arc<Mutex<File>>, 
    verbose: bool, 
    process_map: ProcessMap, 
    gpu_status: GpuStatusList,
    web_server_config: &WebServerConfig,
    path_config: PathConfig,
    #[allow(unused_variables)]
    main_config: Config,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Use config values from web_server_config
    let port = web_server_config.port;
    let max_payload_size = web_server_config.max_payload_size_mb * 1024 * 1024;

    let process_map_clone = process_map.clone();
    let gpu_status_clone = gpu_status.clone();
    let log_file_clone = log_file.clone();
    let path_config_clone = path_config.clone();
    
    
    // Route to serve static files
    let static_files = warp::path("static")
        .and(warp::fs::dir("./static"));

    // Route to serve the file upload form
    let upload_form = warp::path("upload")
        .and(warp::get())
        .map(|| {
            warp::reply::html(
                r#"
                <!DOCTYPE html>
                <html lang="en">
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>Upload MSB File - LATTICEPT Cluster Server</title>
                    <link rel="stylesheet" href="/static/styles.css">
                </head>
                <body>
                    <div id="uploadForm">
                        <h2>Upload MSB File</h2>
                        <form id="msbUploadForm" enctype="application/octet-stream">
                            <input type="file" name="file" accept=".msb" required id="fileInput" />
                            <button type="submit" class="green-button">Upload</button>
                        </form>
                        <div id="uploadStatus"></div>
                        <button id="closeUploadForm" class="green-button">Close</button>
                    </div>
                </body>
                </html>
                "#
            )
        });

    // Modify the upload_msb route
    let upload_msb = warp::path("upload-msb")
        .and(warp::post())
        .and(warp::body::content_length_limit(max_payload_size))
        .and(warp::body::bytes())
        .and(warp::header::header("content-type"))
        .and(warp::query::<HashMap<String, String>>())
        .and(warp::any().map(move || log_file_clone.clone()))
        .and(warp::any().map(move || verbose))
        .and(warp::any().map(move || path_config_clone.queue_directory.clone()))
        .and_then(upload_msb_file);

    let gpu_status_route = warp::path!("gpu-status")
        .and(warp::get())
        .and(warp::any().map(move || (gpu_status_clone.clone(), process_map_clone.clone())))
        .and_then(|(gpu_status, process_map): (GpuStatusList, ProcessMap)| async move {
            let mut response = String::new();
    
            // Fetch the latest GPU info using the function from main.rs
            let latest_gpu_info = get_gpu_info().map_err(|e| {
                eprintln!("Failed to get GPU info: {}", e);
                warp::reject::custom(GpuInfoError)
            })?;
    
            let processes = process_map.read().await;
            for (i, gpu_info) in latest_gpu_info.iter().enumerate() {
                response.push_str(&format!(
                    "<div class='gpu'><h2>GPU {} ({})</h2>", i, gpu_info.name
                ));
                response.push_str(&format!(
                    "<p>Utilization: {}%</p>", gpu_info.utilization
                ));
                response.push_str(&format!(
                    "<p>Power: {:.2}W / {:.2}W</p>", gpu_info.power_usage, gpu_info.power_limit
                ));
                response.push_str(&format!(
                    "<p>Memory: {} MB / {} MB</p>", gpu_info.memory_used, gpu_info.memory_total
                ));
    
                // Use the latest GPU info for current usage
                response.push_str(&format!(
                    "<p>Current Memory Usage: {} MB</p>", gpu_info.memory_used
                ));
                response.push_str(&format!(
                    "<p>Current Power Usage: {:.2}W</p>", gpu_info.power_usage
                ));
    
                // Check if the GPU is pre-allocated
                let mut status = gpu_status.lock().await;
                if status[i].preallocated {
                    response.push_str("<p>Status: Pre-allocated</p>");
                } else {
                    response.push_str("<p>Status: Available</p>");
                }
    
                // Update the stored GPU status with the latest info
                status[i].info = gpu_info.clone();
    
                let gpu_processes: Vec<(u32, String, String)> = processes
                    .values()
                    .filter(|p| p.gpu_id == i)
                    .map(|p| (p.pid, p.msb_file.clone(), p.output_file.clone()))
                    .collect();
    
                if !gpu_processes.is_empty() {
                    response.push_str("<h3>Running processes:</h3><ul>");
                    for (pid, msb_file, _) in gpu_processes {
                        response.push_str(&format!(
                            r##"<li>PID {}: {} - <button onclick="showProcessOutput({}, '{}'); return false;" class="green-button-view">View Output</button></li>"##,
                            pid, 
                            msb_file, 
                            pid, 
                            msb_file.replace('\'', "\\'")
                        ));
                    }
                    response.push_str("</ul>");
                }
                response.push_str("</div>");
            }
    
            let full_html_response = format!(
                r#"<!DOCTYPE html>
                <html lang="en">
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>LATTICEPT Cluster Server Queue</title>
                    <link rel="stylesheet" href="/static/styles.css">
                    <script src="https://cdn.plot.ly/plotly-latest.min.js"></script>
                </head>
                <body>
                    <div class="container">
                        <div class="logo">
                            <img src="/static/logo.png" alt="Logo">
                        </div>
                        <div class="upload-link-container">
                            <button id="showUploadForm" class="green-button">Upload MSB File</button>
                        </div>
                        <div class="gpu-status-container">
                            <div class="gpu-status">
                                {}
                            </div>
                        </div>
                    </div>
                    <div id="uploadPopup" class="popup">
                        <div class="popup-content">
                            <!-- The upload form will be loaded here -->
                        </div>
                    </div>
                    <div id="processOutputPopup">
                        <h2 id="processOutputTitle"></h2>
                        <pre id="processOutputContent" class="scrollable"></pre>
                        <div id="last-time-step" class="info-box">
                            <h3>Iteration Data</h3>
                            <table id="iterationTable">
                                <!-- Rows will be dynamically populated here -->
                            </table>
                        </div>
                        <div id="updateIntervalContainer">
                            <label for="updateInterval">Update Interval (seconds):</label>
                            <input type="number" id="updateInterval" min="0.1" step="0.1" value="2">
                            <button onclick="updateRefreshInterval()">Set</button>
                        </div>
                        <div class="button-container">
                            <button id="closeButton" class="green-button" onclick="closeProcessOutput()">Close</button>
                            <button id="plot-button" class="green-button" onclick="handlePlotButtonClick()">Plot Global Variables</button>
                        </div>
                    </div>
                    <div id="plot-section" class="hidden">
                        <div id="plotly-chart"></div>
                        <div id="plot-controls">
                            <h3>Select Variables to Plot</h3>
                            <div id="variable-checkboxes" class="checkbox-grid"></div>
                        </div>                        
                        <button id="close-plot-button" class="green-button">Close Plot</button>
                    </div>
                    <script src="/static/scripts.js"></script>
                </body>
                </html>"#,
                response
            );
    
            Ok::<_, warp::Rejection>(warp::reply::html(full_html_response))
        });
    
    let process_output_route = warp::path!("process" / u32)
        .and(warp::get())
        .and(warp::any().map(move || process_map.clone()))
        .and_then(|pid: u32, process_map: ProcessMap| async move {
            let processes = process_map.read().await;
            if let Some(process) = processes.get(&pid) {
                let file_path = &process.output_file;
                if !std::path::Path::new(file_path).exists() {
                    return Ok::<_, warp::Rejection>(warp::reply::with_status(
                        warp::reply::html(format!("Output file for PID {} does not exist yet.\nFile path: {}", pid, file_path)),
                        warp::http::StatusCode::NOT_FOUND
                    ));
                }
                match tokio::fs::read_to_string(file_path).await {
                    Ok(content) => Ok::<_, warp::Rejection>(warp::reply::with_status(
                        warp::reply::html(content),
                        warp::http::StatusCode::OK
                    )),
                    Err(e) => Ok::<_, warp::Rejection>(warp::reply::with_status(
                        warp::reply::html(format!("Error reading output file for PID {}: {}\nFile path: {}", pid, e, file_path)),
                        warp::http::StatusCode::INTERNAL_SERVER_ERROR
                    )),
                }
            } else {
                Ok::<_, warp::Rejection>(warp::reply::with_status(
                    warp::reply::html(format!("No process found with PID {}", pid)),
                    warp::http::StatusCode::NOT_FOUND
                ))
            }
        });

    // Combine the routes
    let routes = gpu_status_route
        .or(process_output_route)
        .or(upload_form)
        .or(upload_msb)
        .or(static_files)
        .recover(handle_rejection);

    log_and_print(&log_file, &format!("Starting web server on port {}", port), verbose).await?;

    warp::serve(routes)
        .run(([0, 0, 0, 0], port))
        .await;

    Ok(())
}

// Modify the upload_msb_file function
async fn upload_msb_file(
    file_data: bytes::Bytes,
    content_type: String,
    params: HashMap<String, String>,
    log_file: Arc<Mutex<File>>,
    verbose: bool,
    queue_directory: PathBuf
) -> Result<impl warp::Reply, Rejection> {
    let log_error = |e| {
        eprintln!("Error logging: {}", e);
        warp::reject::custom(UploadError)
    };

    log_and_print(&log_file, "Starting file upload process", verbose).await.map_err(log_error)?;

    // Get filename from query parameters
    let filename = params.get("filename").cloned().unwrap_or_else(|| "unknown.msb".to_string());
    log_and_print(&log_file, &format!("File name: {}", filename), verbose).await.map_err(log_error)?;

    // Check content type
    if content_type != "application/octet-stream" {
        log_and_print(&log_file, &format!("Invalid content type: {}", content_type), verbose).await.map_err(log_error)?;
        return Ok(warp::reply::with_status(
            warp::reply::html("<p>Invalid content type. Please upload an MSB file.</p>".to_string()),
            warp::http::StatusCode::BAD_REQUEST,
        ));
    }

    let file_extension = Path::new(&filename).extension().and_then(|ext| ext.to_str()).unwrap_or("");
    if file_extension != "msb" {
        log_and_print(&log_file, &format!("Invalid file format: {}", file_extension), verbose).await.map_err(log_error)?;
        return Ok(warp::reply::with_status(
            warp::reply::html("<p>Invalid file format. Please upload an MSB file.</p>".to_string()),
            warp::http::StatusCode::BAD_REQUEST,
        ));
    }

    // Get current timestamp and generate hash
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("Time went backwards")
        .as_secs();
    
    let hash_suffix = simple_hash(&filename, timestamp);

    // Create new filename with hash suffix
    let filename_without_ext = filename.trim_end_matches(".msb");
    let new_filename = format!("{}_{}.msb", filename_without_ext, hash_suffix);

    let filepath = queue_directory.join(&new_filename);
    log_and_print(&log_file, &format!("Uploading to: {}", filepath.display()), verbose).await.map_err(log_error)?;

    tokio::fs::write(&filepath, &file_data).await.map_err(|e| {
        let _ = log_and_print(&log_file, &format!("Error writing file: {}", e), verbose);
        warp::reject::custom(UploadError)
    })?;

    log_and_print(&log_file, &format!("File uploaded successfully: {} (original filename: {})", new_filename, filename), verbose).await.map_err(log_error)?;

    Ok(warp::reply::with_status(
        warp::reply::html(format!("<p>File uploaded successfully as {}.</p>", new_filename)),
        warp::http::StatusCode::OK,
    ))
}

// Function to handle rejections and convert them into proper HTTP responses
async fn handle_rejection(err: warp::Rejection) -> Result<impl warp::Reply, std::convert::Infallible> {
    let code;
    let message: String;

    if err.is_not_found() {
        code = warp::http::StatusCode::NOT_FOUND;
        message = "Not Found".to_string();
    } else if let Some(_upload_error) = err.find::<UploadError>() {
        code = warp::http::StatusCode::BAD_REQUEST;
        message = "File upload failed.".to_string();
    } else if err.find::<PayloadTooLarge>().is_some() {
        code = warp::http::StatusCode::PAYLOAD_TOO_LARGE;
        message = "The uploaded file is too large. Please upload a smaller file.".to_string();
    } else {
        eprintln!("Unhandled rejection: {:?}", err);
        code = warp::http::StatusCode::INTERNAL_SERVER_ERROR;
        message = "Internal Server Error.".to_string();
    }

    Ok(warp::reply::with_status(
        warp::reply::html(format!("<pre>{}</pre>", message)),
        code,
    ))
}

#[derive(Debug)]
struct UploadError;
impl warp::reject::Reject for UploadError {}

#[derive(Debug)]
struct GpuInfoError;
impl warp::reject::Reject for GpuInfoError {}
