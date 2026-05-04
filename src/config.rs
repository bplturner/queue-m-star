use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::fs;

/// Main configuration struct, loaded from config.toml
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    /// Path-related configuration
    pub paths: PathConfig,
    /// Web server configuration
    pub web_server: WebServerConfig,
    /// File handling limits
    pub file_handling: FileHandlingConfig,
    /// GPU selection thresholds
    pub gpu_selection: GpuSelectionConfig,
    /// Job queue settings
    #[serde(default)]
    pub queue: QueueConfig,
}

/// Paths for log files, executables, and directories
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PathConfig {
    /// Path to the application log file
    pub log_file: PathBuf,
    /// Directory to watch for incoming MSB files (file-watcher intake)
    pub queue_directory: PathBuf,
    /// Path to the default mstar-cfd-mgpu executable (legacy/fallback)
    pub mstar_executable: PathBuf,
    /// Root directory containing all M-Star installations (e.g., /opt/mstar)
    #[serde(default = "default_mstar_install_dir")]
    pub mstar_install_dir: PathBuf,
    /// Path to the SQLite database file
    #[serde(default = "default_database_file")]
    pub database_file: PathBuf,
    /// Directory for job working files (each job gets a subdirectory)
    #[serde(default = "default_jobs_directory")]
    pub jobs_directory: PathBuf,
    /// Directory for archived/completed job data
    #[serde(default = "default_archive_directory")]
    pub archive_directory: PathBuf,
    /// Path to the GPU metrics CSV log file
    #[serde(default = "default_gpu_metrics_log")]
    pub gpu_metrics_log: PathBuf,
}

fn default_mstar_install_dir() -> PathBuf {
    PathBuf::from("/opt/mstar")
}

fn default_database_file() -> PathBuf {
    PathBuf::from("mstar_queue.db")
}

fn default_jobs_directory() -> PathBuf {
    PathBuf::from("jobs")
}

fn default_archive_directory() -> PathBuf {
    PathBuf::from("archive")
}

fn default_gpu_metrics_log() -> PathBuf {
    PathBuf::from("gpu_metrics.log")
}

/// Web server configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebServerConfig {
    /// Port for the web server to listen on
    pub port: u16,
    /// Maximum upload payload size in MB
    pub max_payload_size_mb: u64,
}

/// File handling limits
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileHandlingConfig {
    /// Maximum allowed MSB file size in MB
    pub max_file_size_mb: u64,
    /// List of allowed file extensions (e.g., ["msb"])
    pub allowed_file_types: Vec<String>,
}

/// GPU selection thresholds for determining GPU availability
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GpuSelectionConfig {
    /// Maximum utilization percentage for a reserved GPU to be considered free
    pub reserved_gpu_max_utilization: f32,
    /// Maximum memory usage percentage for a reserved GPU to be considered free
    pub reserved_gpu_max_memory_usage_percent: f32,
}

/// Job queue configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueueConfig {
    /// Maximum number of jobs that can run concurrently
    #[serde(default = "default_max_concurrent")]
    pub max_concurrent_jobs: usize,
    /// Default M-Star version to use when not specified (e.g., "latest" or "4.4.9")
    #[serde(default = "default_mstar_version")]
    pub default_mstar_version: String,
    /// Number of days to retain job output files (0 = forever)
    #[serde(default)]
    pub job_output_retention_days: u32,
    /// Interval in seconds between queue polling cycles
    #[serde(default = "default_poll_interval")]
    pub poll_interval_secs: u64,
}

fn default_max_concurrent() -> usize {
    8
}

fn default_mstar_version() -> String {
    "latest".to_string()
}

fn default_poll_interval() -> u64 {
    5
}

impl Default for QueueConfig {
    fn default() -> Self {
        QueueConfig {
            max_concurrent_jobs: default_max_concurrent(),
            default_mstar_version: default_mstar_version(),
            job_output_retention_days: 0,
            poll_interval_secs: default_poll_interval(),
        }
    }
}

impl Config {
    /// Load configuration from config.toml in the current working directory
    pub fn load() -> Result<Self, Box<dyn std::error::Error>> {
        let config_path = "config.toml";
        let config_content = fs::read_to_string(config_path)
            .map_err(|e| format!(
                "Failed to read config file at {}: {}. Please ensure the file exists and has correct permissions.",
                config_path, e
            ))?;
        let config: Config = toml::from_str(&config_content)
            .map_err(|e| format!(
                "Failed to parse config file {}: {}. Please check the file format.",
                config_path, e
            ))?;
        Ok(config)
    }

    /// Validate the loaded configuration
    pub fn validate(&self) -> Result<(), String> {
        // Path validations
        if self.paths.log_file.as_os_str().is_empty() {
            return Err("Log file path cannot be empty".to_string());
        }
        if self.paths.queue_directory.as_os_str().is_empty() {
            return Err("Queue directory path cannot be empty".to_string());
        }
        if self.paths.mstar_executable.as_os_str().is_empty() {
            return Err("MSTAR executable path cannot be empty".to_string());
        }
        if self.paths.mstar_install_dir.as_os_str().is_empty() {
            return Err("MSTAR install directory cannot be empty".to_string());
        }

        // Web server validation
        if self.web_server.port == 0 {
            return Err("Web server port cannot be 0".to_string());
        }

        // File handling validation
        if self.file_handling.max_file_size_mb == 0 {
            return Err("Max file size cannot be 0".to_string());
        }
        if self.file_handling.allowed_file_types.is_empty() {
            return Err("Allowed file types cannot be empty".to_string());
        }

        // GPU selection validation
        if self.gpu_selection.reserved_gpu_max_utilization < 0.0
            || self.gpu_selection.reserved_gpu_max_utilization > 100.0
        {
            return Err("Reserved GPU max utilization must be between 0.0 and 100.0".to_string());
        }
        if self.gpu_selection.reserved_gpu_max_memory_usage_percent < 0.0
            || self.gpu_selection.reserved_gpu_max_memory_usage_percent > 100.0
        {
            return Err("Reserved GPU max memory usage percent must be between 0.0 and 100.0".to_string());
        }

        // Queue validation
        if self.queue.max_concurrent_jobs == 0 {
            return Err("Max concurrent jobs must be at least 1".to_string());
        }

        Ok(())
    }
}