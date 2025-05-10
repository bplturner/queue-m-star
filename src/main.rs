use std::fs::{File, OpenOptions};
use std::io::{self, ErrorKind, Write};
use std::path::Path;
use std::ffi::OsStr;
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};
use notify::{Watcher, RecursiveMode, Config as NotifyConfig};
use chrono::Local;
use clap::Parser;
use md5::Context;
use std::sync::Arc;
use std::collections::HashMap;
use regex::Regex;
use tokio::sync::Mutex as TokioMutex;
use tokio::fs as tokio_fs;
use tokio::time::{Duration, sleep, Instant as TokioInstant};
use tokio::sync::RwLock as TokioRwLock;
use tokio::task;
use tokio::process::Command as TokioCommand;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

pub mod web_server;
pub mod gpu_info;

// Make sure GpuInfo is defined here or re-exported from another module
#[derive(Clone, Debug)]
pub struct GpuInfo {
    pub name: String,
    pub utilization: f32,
    pub power_usage: f32,
    pub power_limit: f32,
    pub memory_used: u64,
    pub memory_total: u64,
}

#[derive(Parser, Debug)]
#[clap(author, version, about, long_about = None)]
struct Args {
    #[clap(short, long)]
    quiet: bool,

    #[clap(long, default_value = "true")]
    enable_web_server: bool,
}

#[derive(Clone, Debug)]
pub struct ProcessInfo {
    pub pid: u32,
    pub gpu_id: usize,
    pub msb_file: String,
    pub output_file: String,
}

type ProcessMap = Arc<TokioRwLock<HashMap<u32, ProcessInfo>>>;

#[derive(Clone, Debug)]
pub struct GpuStatus {
    pub info: GpuInfo,
    pub preallocated: bool,
}

type GpuStatusList = Arc<TokioMutex<Vec<GpuStatus>>>;

use web_server::run_web_server;

mod config;
use crate::config::Config;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Load configuration
    let config = Config::load().expect("Failed to load configuration");
    // Validate the configuration
    config.validate().expect("Invalid configuration");

    // Parse command line arguments
    let args = Args::parse();
    // Determine verbosity based on quiet flag
    let verbose = !args.quiet;

    // Use config values instead of hardcoded paths for the log file
    let log_file = Arc::new(TokioMutex::new(OpenOptions::new()
        .create(true) // Create the file if it doesn't exist
        .append(true) // Append to the file if it exists
        .open(&config.paths.log_file)?)); // Open the log file specified in the config
    
    // Get the queue directory from the config
    let queue_dir = &config.paths.queue_directory;
    
    // Initialize the process map
    let process_map: ProcessMap = Arc::new(TokioRwLock::new(HashMap::new()));
    // Initialize the GPU status list, passing the config for detailed settings
    let gpu_status: GpuStatusList = initialize_gpu_status(&log_file, verbose, &config).await?;

    // Check if the web server should be enabled
    if args.enable_web_server {
        // Clone Arcs and config for the web server task
        let web_process_map = Arc::clone(&process_map); // Clone process_map for web server
        let web_gpu_status = Arc::clone(&gpu_status); // Clone gpu_status for web server
        let web_log_file = Arc::clone(&log_file); // Clone log_file for web server
        let web_config = config.web_server.clone(); // Clone web_server config section
        let paths_config = config.paths.clone(); // Clone paths config section
        let main_config_clone = config.clone(); // Clone the entire config for web server access if needed for GPU status

        // Spawn the web server task
        tokio::spawn(async move {
            // Run the web server
            if let Err(e) = run_web_server(
                web_log_file, 
                verbose, 
                web_process_map, 
                web_gpu_status,
                &web_config, // Pass web_server config
                paths_config, // Pass paths config
                main_config_clone, // Pass the main config
            ).await {
                // Print an error message if the web server fails
                eprintln!("Web server error: {}", e);
            }
        });

        // Log that the web server has started
        log_and_print(&log_file, "Web server started", verbose).await?;
    } else {
        // Log that the web server is disabled
        log_and_print(&log_file, "Web server disabled", verbose).await?;
    }

    process_existing_files(queue_dir, &config, &log_file, verbose, &process_map, &gpu_status).await?;

    let (tx, mut rx) = tokio::sync::mpsc::channel(100);
    let mut watcher = notify::RecommendedWatcher::new(
        move |res| { let _ = tx.blocking_send(res); },
        NotifyConfig::default(),
    )?;
    watcher.watch(queue_dir, RecursiveMode::Recursive)?;

    log_and_print(&log_file, &format!("Watching {} for .MSB files...", queue_dir.display()), verbose).await?;

    while let Some(event) = rx.recv().await {
        if let Ok(notify::Event { kind: notify::EventKind::Create(_), paths, .. }) = event {
            for path in paths {
                if is_msb_file(&path) {
                    log_and_print(&log_file, &format!("Detected new .MSB file: {:?}", path), verbose).await?;
                    let process_map_clone = Arc::clone(&process_map);
                    let gpu_status_clone = Arc::clone(&gpu_status);
                    let log_file_clone = Arc::clone(&log_file);
                    let path_clone = path.to_path_buf();
                    let verbose_clone = verbose;
                    let config = config.clone();
                    
                    tokio::spawn(async move {
                        match process_msb_file(
                            &path_clone,
                            &config,
                            &log_file_clone,
                            verbose_clone,
                            process_map_clone,
                            gpu_status_clone
                        ).await {
                            Ok(_) => {
                                if let Err(e) = log_and_print(&log_file_clone, &format!("Successfully processed file: {:?}", path_clone), verbose_clone).await {
                                    eprintln!("Error logging success: {}", e);
                                }
                            },
                            Err(e) => {
                                if let Err(log_err) = log_and_print(&log_file_clone, &format!("Error processing file {:?}: {}", path_clone, e), verbose_clone).await {
                                    eprintln!("Error logging failure: {}", log_err);
                                }
                            },
                        }
                    });
                }
            }
        }
    }

    Ok(())
}

async fn process_existing_files(dir: &Path, config: &Config, log_file: &Arc<TokioMutex<File>>, verbose: bool, process_map: &ProcessMap, gpu_status: &GpuStatusList) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut entries = tokio_fs::read_dir(dir).await?;
    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        if is_msb_file(&path) {
            log_and_print(log_file, &format!("Found existing .MSB file: {:?}", path), verbose).await?;
            let process_map_clone = Arc::clone(process_map);
            let gpu_status_clone = Arc::clone(gpu_status);
            match process_msb_file(&path, config, log_file, verbose, process_map_clone, gpu_status_clone).await {
                Ok(_) => log_and_print(log_file, &format!("Successfully processed file: {:?}", path), verbose).await?,
                Err(e) => log_and_print(log_file, &format!("Error processing file {:?}: {}", path, e), verbose).await?,
            }
        }
    }
    Ok(())
}

fn is_msb_file(path: &Path) -> bool {
    path.extension()
        .and_then(OsStr::to_str)
        .map(|ext| ext.eq_ignore_ascii_case("msb"))
        .unwrap_or(false)
}

async fn wait_for_file_availability(path: &Path, timeout: Duration, log_file: &Arc<TokioMutex<File>>, verbose: bool) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let start_time = TokioInstant::now();
    let mut last_size = 0;
    let mut last_hash = String::new();
    let mut consecutive_matches = 0;

    while start_time.elapsed() < timeout {
        match tokio_fs::metadata(path).await {
            Ok(metadata) => {
                let current_size = metadata.len();
                if current_size > last_size {
                    log_and_print(log_file, &format!("File size increased: {} bytes (was {} bytes)", current_size, last_size), verbose).await?;
                    last_size = current_size;
                    consecutive_matches = 0;
                } else {
                    let path_clone = path.to_path_buf();
                    let current_hash = task::spawn_blocking(move || {
                        let mut file = std::fs::File::open(path_clone)?;
                        let mut hasher = Context::new();
                        std::io::copy(&mut file, &mut hasher)?;
                        Ok::<_, std::io::Error>(format!("{:x}", hasher.compute()))
                    }).await??;

                    if current_hash == last_hash {
                        consecutive_matches += 1;
                        if consecutive_matches >= 3 {
                            log_and_print(log_file, "File copy completed and verified", verbose).await?;
                            return Ok(());
                        }
                    } else {
                        consecutive_matches = 0;
                    }
                    last_hash = current_hash;
                }
            },
            Err(e) => {
                log_and_print(log_file, &format!("Error checking file: {}", e), verbose).await?;
            }
        }
        sleep(Duration::from_secs(1)).await;
    }
    Err(Box::new(io::Error::new(ErrorKind::TimedOut, "File not fully copied within timeout")))
}

async fn process_msb_file(
    path: &Path,
    config: &Config,
    log_file: &Arc<TokioMutex<File>>, 
    verbose: bool, 
    process_map: ProcessMap, 
    gpu_status: GpuStatusList
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Add file size validation at the start
    let file_size = path.metadata()?.len();
    let max_size = config.file_handling.max_file_size_mb * 1024 * 1024;
    if file_size > max_size {
        let err_msg = format!(
            "File size {} bytes exceeds maximum allowed size of {} bytes",
            file_size, max_size
        );
        log_and_print(log_file, &err_msg, verbose).await?;
        return Err(err_msg.into());
    }

    // Add file type validation
    if !config.file_handling.allowed_file_types.iter()
        .any(|allowed| allowed.to_lowercase() == "msb") {
        let err_msg = "MSB files are not in allowed types list".to_string();
        log_and_print(log_file, &err_msg, verbose).await?;
        return Err(err_msg.into());
    }

    wait_for_file_availability(path, Duration::from_secs(1800), log_file, verbose).await?;

    let file_stem = path.file_stem()
        .and_then(OsStr::to_str)
        .ok_or_else(|| io::Error::new(ErrorKind::InvalidInput, "Invalid file name"))?;
    let timestamp = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let new_dir_name = sanitize_filename(&format!("{}_{}", file_stem, timestamp));
    let new_dir = path.parent()
        .ok_or_else(|| io::Error::new(ErrorKind::NotFound, "Parent directory not found"))?
        .join(new_dir_name);
    
    tokio_fs::create_dir(&new_dir).await?;
    log_and_print(log_file, &format!("Created new directory: {:?}", new_dir), verbose).await?;

    let new_file_path = new_dir.join(path.file_name().unwrap());
    tokio_fs::rename(path, &new_file_path).await?;
    log_and_print(log_file, &format!("Moved file to: {:?}", new_file_path), verbose).await?;

    wait_for_file_availability(&new_file_path, Duration::from_secs(300), log_file, verbose).await?;

    log_and_print(log_file, "Running unpack_msb.py...", verbose).await?;
    let parent_dir = path.parent().ok_or_else(|| io::Error::new(ErrorKind::NotFound, "Parent directory not found"))?;
    
    let command = format!("python3 unpack_msb.py \"{}\" \"{}\"", new_file_path.display(), new_dir.display());
    log_and_print(log_file, &format!("Executing command: {}", command), verbose).await?;

    let unpack_output = Command::new("sh")
        .arg("-c")
        .arg(&command)
        .current_dir(parent_dir)
        .output()?;

    if !unpack_output.status.success() {
        let error_msg = format!("unpack_msb.py failed with exit code: {}", unpack_output.status);
        log_and_print(log_file, &error_msg, verbose).await?;
        log_and_print(log_file, &format!("unpack_msb.py stdout: {}", String::from_utf8_lossy(&unpack_output.stdout)), verbose).await?;
        log_and_print(log_file, &format!("unpack_msb.py stderr: {}", String::from_utf8_lossy(&unpack_output.stderr)), verbose).await?;
        return Err(Box::new(io::Error::new(ErrorKind::Other, error_msg)));
    } else {
        log_and_print(log_file, "unpack_msb.py completed successfully", verbose).await?;
        log_and_print(log_file, &format!("unpack_msb.py stdout: {}", String::from_utf8_lossy(&unpack_output.stdout)), verbose).await?;
        if !unpack_output.stderr.is_empty() {
            log_and_print(log_file, &format!("unpack_msb.py stderr (warnings): {}", String::from_utf8_lossy(&unpack_output.stderr)), verbose).await?;
        }
    }

    log_and_print(log_file, "Running mstar-cfd-mgpu...", verbose).await?;
    
    let new_dir_clone = new_dir.clone();
    let process_map_clone = process_map.clone();

    let msb_file = sanitize_filename(path.file_name()
        .and_then(OsStr::to_str)
        .unwrap_or("unknown"));

    let timestamp = Local::now().format("%Y%m%d_%H%M%S").to_string();
    let output_filename = format!("output_{}.txt", timestamp);
    let output_file = new_dir_clone.join(output_filename);

    // Open the file for writing
    let file = tokio::fs::File::create(&output_file).await?;
    let mut writer = tokio::io::BufWriter::new(file);

    // Update the mstar-cfd-mgpu path to use config
    let mstar_cfd_mgpu_path = &config.paths.mstar_executable;

    // Get the GPU with no running processes or lowest memory utilization
    let gpu_id = get_gpu_with_lowest_utilization(&gpu_status, &process_map, config).await?;

    // Construct the full command string
    let full_command = format!("{} -i input.xml -o out --gpu-ids={}", mstar_cfd_mgpu_path.display(), gpu_id);

    // Log the full command
    log_and_print(log_file, &format!("Full mstar-cfd-mgpu command: {}", full_command), verbose).await?;

    let mut child = TokioCommand::new(mstar_cfd_mgpu_path)
        .arg("-i")
        .arg("input.xml")
        .arg("-o")
        .arg("out")
        .arg(format!("--gpu-ids={}", gpu_id))
        .current_dir(&new_dir_clone)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    let pid = child.id().unwrap();

    let process_info = ProcessInfo {
        pid,
        gpu_id,
        msb_file: msb_file.clone(),
        output_file: output_file.to_str().unwrap().to_string(),
    };
    process_map_clone.write().await.insert(pid, process_info);

    // Log the start of the mstar-cfd-mgpu process
    log_and_print(log_file, &format!("Started mstar-cfd-mgpu with PID: {} on GPU: {}, solving file: {}", pid, gpu_id, msb_file), verbose).await?;

    // Clone variables for the logging task
    let log_file_clone = Arc::clone(log_file); // Clone the log file Arc
    let verbose_clone = verbose; // Clone the verbose flag
    // Clone the config for potential use in the spawned task (e.g., for conditional logging based on config)
    // Prefix with _ to indicate it might not be used immediately, silencing unused variable warning.
    let _config_clone = config.clone(); 

    // Take ownership of stdout and stderr from the child process
    let stdout = child.stdout.take().expect("Failed to capture stdout"); // Expect stdout to be available
    let stderr = child.stderr.take().expect("Failed to capture stderr"); // Expect stderr to be available

    tokio::spawn(async move {
        let mut stdout_reader = tokio::io::BufReader::new(stdout);
        let mut stderr_reader = tokio::io::BufReader::new(stderr);
        let mut stdout_line = String::new();
        let mut stderr_line = String::new();

        loop {
            tokio::select! {
                result = stdout_reader.read_line(&mut stdout_line) => {
                    if result.unwrap() == 0 {
                        break;
                    }
                    if let Err(e) = writer.write_all(stdout_line.as_bytes()).await {
                        eprintln!("Failed to write stdout: {}", e);
                    }
                    stdout_line.clear();
                }
                result = stderr_reader.read_line(&mut stderr_line) => {
                    if result.unwrap() == 0 {
                        break;
                    }
                    if let Err(e) = writer.write_all(stderr_line.as_bytes()).await {
                        eprintln!("Failed to write stderr: {}", e);
                    }
                    stderr_line.clear();
                }
                result = child.wait() => {
                    if let Ok(status) = result {
                        if status.success() {
                            let _ = log_and_print(&log_file_clone, "mstar-cfd-mgpu completed successfully", verbose_clone).await;
                        } else {
                            let error_msg = format!("mstar-cfd-mgpu failed with exit code: {}", status);
                            let _ = log_and_print(&log_file_clone, &error_msg, verbose_clone).await;
                        }
                    }
                    break;
                }
            }
        }

        if let Err(e) = writer.flush().await {
            eprintln!("Failed to flush output: {}", e);
        }

        process_map_clone.write().await.remove(&pid);
        let _ = log_and_print(&log_file_clone, &format!("Finished processing file: {:?}", new_file_path), verbose_clone).await;
    });

    Ok(())
}

fn sanitize_filename(filename: &str) -> String {
    let re = Regex::new(r"[^a-zA-Z0-9_.]").unwrap();
    re.replace_all(filename, "_").to_string()
} 

async fn log_and_print(log_file: &Arc<TokioMutex<File>>, message: &str, verbose: bool) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let timestamp = Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    let log_entry = format!("[{}] {}\n", timestamp, message);
    
    let mut file = log_file.lock().await;
    file.write_all(log_entry.as_bytes())?;
    
    if verbose {
        println!("{}", log_entry.trim());
    }
    Ok(())
}

pub fn get_gpu_info() -> Result<Vec<GpuInfo>, Box<dyn std::error::Error + Send + Sync>> {
    let output = Command::new("nvidia-smi")
        .args(&["--query-gpu=name,utilization.gpu,power.draw,power.limit,memory.used,memory.total", 
                "--format=csv,noheader,nounits"])
        .output()?;
    let output_str = String::from_utf8(output.stdout)?;
    
    let mut gpu_info = Vec::new();
    for line in output_str.lines() {
        let values: Vec<&str> = line.split(',').map(str::trim).collect();
        if values.len() == 6 {
            gpu_info.push(GpuInfo {
                name: values[0].to_string(),
                utilization: values[1].parse().unwrap_or(0.0),
                power_usage: values[2].parse().unwrap_or(0.0),
                power_limit: values[3].parse().unwrap_or(0.0),
                memory_used: values[4].parse().unwrap_or(0),
                memory_total: values[5].parse().unwrap_or(0),
            });
        }
    }

    // If no GPUs were found, return an error
    if gpu_info.is_empty() {
        return Err("No GPUs found".into());
    }

    Ok(gpu_info)
}

async fn initialize_gpu_status(log_file: &Arc<TokioMutex<File>>, verbose: bool, config: &Config) -> Result<GpuStatusList, Box<dyn std::error::Error + Send + Sync>> {
    // Get the current GPU information
    let gpu_info_vec = get_gpu_info()?;
    // Initialize a vector to store GpuStatus structs
    let mut gpu_status_list: Vec<GpuStatus> = Vec::new();

    // Iterate over the retrieved GPU information
    for info in gpu_info_vec {
        // Format a message with GPU details for logging
        let message = format!("GPU: {}, Utilization: {}%, Power: {:.2}W / {:.2}W, Memory: {} MB / {} MB",
                 info.name, info.utilization, info.power_usage, info.power_limit,
                 info.memory_used, info.memory_total);
        // Log the GPU details
        log_and_print(log_file, &message, verbose).await?;
        
        // Calculate initial memory usage percentage for this GPU
        let initial_memory_usage_percent = if info.memory_total > 0 {
            // Calculate percentage if memory_total is not zero
            (info.memory_used as f32 / info.memory_total as f32) * 100.0
        } else {
            // If memory_total is zero, consider usage as 100% to be safe (or 0% if that makes more sense, but 100% makes it likely to be seen as busy)
            100.0 
        };

        // Determine if the GPU is preallocated based on its initial utilization OR memory usage
        let is_preallocated = info.utilization > config.gpu_selection.reserved_gpu_max_utilization || 
                              initial_memory_usage_percent > config.gpu_selection.reserved_gpu_max_memory_usage_percent;

        // Push the GpuStatus to the list
        gpu_status_list.push(GpuStatus {
            preallocated: is_preallocated, // Set the preallocated status based on combined criteria
            info, // Store the GpuInfo
        });
    }

    // Return the GpuStatusList wrapped in Arc and TokioMutex
    Ok(Arc::new(TokioMutex::new(gpu_status_list)))
}

async fn get_gpu_with_lowest_utilization(
    gpu_status_handle: &GpuStatusList, 
    process_map: &ProcessMap, 
    config: &Config
) -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {
    // Lock the GPU status list for reading
    let status_list = gpu_status_handle.lock().await;
    // Lock the process map for reading to check current process assignments
    let processes = process_map.read().await;
    
    // Lists to hold candidate GPUs based on criteria
    // Group 1: GPUs that are not preallocated and not running our managed processes
    let mut completely_free_gpus: Vec<(usize, u64)> = Vec::new(); // Stores (index, memory_used)
    // Group 2: Preallocated GPUs that are not running our managed processes and meet utilization/memory criteria
    let mut conditionally_free_preallocated_gpus: Vec<(usize, u64)> = Vec::new(); // Stores (index, memory_used)

    // Iterate over the available GPUs with their status
    for (index, status) in status_list.iter().enumerate() {
        // Check if this GPU is currently running any process managed by this application
        let is_running_managed_process = processes.values().any(|p_info| p_info.gpu_id == index);

        // If the GPU is already running one of our managed processes, it's not available for a new task.
        if is_running_managed_process {
            continue; // Skip to the next GPU
        }

        // If the GPU is NOT running a managed process, evaluate its availability based on preallocation status
        if !status.preallocated {
            // This GPU is not preallocated and not busy with our tasks: considered "completely free"
            completely_free_gpus.push((index, status.info.memory_used));
        } else {
            // This GPU is preallocated. Check if it meets the criteria to be used.
            // Calculate current memory usage percentage for this preallocated GPU
            let memory_usage_percent = if status.info.memory_total > 0 {
                // Calculate percentage if memory_total is not zero
                (status.info.memory_used as f32 / status.info.memory_total as f32) * 100.0
            } else {
                // Assume 100% usage if memory_total is zero to prevent division by zero; effectively makes it unavailable if percent check is strict
                100.0 
            };

            // Check if it meets the configured thresholds for utilization and memory to be considered "conditionally free"
            if status.info.utilization < config.gpu_selection.reserved_gpu_max_utilization && 
               memory_usage_percent < config.gpu_selection.reserved_gpu_max_memory_usage_percent {
                // If criteria are met, add it to the list of conditionally free preallocated GPUs
                conditionally_free_preallocated_gpus.push((index, status.info.memory_used));
            }
        }
    }

    // Prioritize completely free GPUs (Group 1)
    if !completely_free_gpus.is_empty() {
        // If there are completely free GPUs, select the one with the minimum memory usage
        return completely_free_gpus.into_iter()
            .min_by_key(|&(_, mem_used)| mem_used) // Find by minimum memory_used
            .map(|(index, _)| index) // Return the index of that GPU
            .ok_or_else(|| "Logic error: Could not select from non-empty completely_free_gpus list".into()); // Should not happen
    }

    // If no completely free GPUs, try conditionally free preallocated GPUs (Group 2)
    if !conditionally_free_preallocated_gpus.is_empty() {
        // If there are conditionally free preallocated GPUs, select the one with the minimum memory usage
        return conditionally_free_preallocated_gpus.into_iter()
            .min_by_key(|&(_, mem_used)| mem_used) // Find by minimum memory_used
            .map(|(index, _)| index) // Return the index of that GPU
            .ok_or_else(|| "Logic error: Could not select from non-empty conditionally_free_preallocated_gpus list".into()); // Should not happen
    }

    // If neither group has suitable GPUs, return an error
    Err("No suitable GPU available. All GPUs are either busy, or preallocated GPUs do not meet idle criteria.".into())
}

