use serde::{Deserialize, Serialize}; // Import Deserialize and Serialize
use std::path::PathBuf; // Import PathBuf
use std::fs; // Import fs for file reading

// Define the main Config struct
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    // Add paths field
    pub paths: PathConfig,
    // Add web_server field
    pub web_server: WebServerConfig,
    // Add file_handling field
    pub file_handling: FileHandlingConfig,
    // Add gpu_selection field
    pub gpu_selection: GpuSelectionConfig, // New field for GPU selection settings
}

// Define the PathConfig struct
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PathConfig {
    // Add log_file field
    pub log_file: PathBuf,
    // Add queue_directory field
    pub queue_directory: PathBuf,
    // Add mstar_executable field
    pub mstar_executable: PathBuf,
}

// Define the WebServerConfig struct
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebServerConfig {
    // Add port field
    pub port: u16,
    // Add max_payload_size_mb field
    pub max_payload_size_mb: u64,
}

// Define the FileHandlingConfig struct
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileHandlingConfig {
    // Add max_file_size_mb field
    pub max_file_size_mb: u64,
    // Add allowed_file_types field
    pub allowed_file_types: Vec<String>,
}

// Define the GpuSelectionConfig struct
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GpuSelectionConfig {
    // Maximum utilization percentage for a reserved GPU to be considered free
    pub reserved_gpu_max_utilization: f32,
    // Maximum memory usage percentage for a reserved GPU to be considered free
    pub reserved_gpu_max_memory_usage_percent: f32,
}

// Implement the load and validate methods for Config
impl Config {
    // Implement the load method
    pub fn load() -> Result<Self, Box<dyn std::error::Error>> {
        // Define the path to the configuration file
        let config_path = "config.toml";
        // Read the file content
        let config_content = fs::read_to_string(config_path)
            .map_err(|e| format!("Failed to read config file at {}: {}. Please ensure the file exists and has correct permissions.", config_path, e))?;
        // Parse the TOML content
        let config: Config = toml::from_str(&config_content)
            .map_err(|e| format!("Failed to parse config file {}: {}. Please check the file format.", config_path, e))?;
        // Return the loaded config
        Ok(config)
    }

    // Implement the validate method
    pub fn validate(&self) -> Result<(), String> {
        // Add basic validation for paths
        if self.paths.log_file.as_os_str().is_empty() {
            // Return an error if the log file path is empty
            return Err("Log file path cannot be empty".to_string());
        }
        // Check if the queue directory path is empty
        if self.paths.queue_directory.as_os_str().is_empty() {
            // Return an error if the queue directory path is empty
            return Err("Queue directory path cannot be empty".to_string());
        }
        // Check if the MSTAR executable path is empty
        if self.paths.mstar_executable.as_os_str().is_empty() {
            // Return an error if the MSTAR executable path is empty
            return Err("MSTAR executable path cannot be empty".to_string());
        }
        // Add validation for web server port
        if self.web_server.port == 0 {
            // Return an error if the web server port is 0
            return Err("Web server port cannot be 0".to_string());
        }
        // Add validation for file handling
        if self.file_handling.max_file_size_mb == 0 {
            // Return an error if the max file size is 0
            return Err("Max file size cannot be 0".to_string());
        }
        // Check if the allowed file types list is empty
        if self.file_handling.allowed_file_types.is_empty() {
            // Return an error if the allowed file types list is empty
            return Err("Allowed file types cannot be empty".to_string());
        }
        // Add validation for GPU selection parameters
        if self.gpu_selection.reserved_gpu_max_utilization < 0.0 || self.gpu_selection.reserved_gpu_max_utilization > 100.0 {
            // Return an error if the reserved GPU max utilization is not between 0 and 100
            return Err("Reserved GPU max utilization must be between 0.0 and 100.0".to_string());
        }
        // Check if the reserved GPU max memory usage percent is valid
        if self.gpu_selection.reserved_gpu_max_memory_usage_percent < 0.0 || self.gpu_selection.reserved_gpu_max_memory_usage_percent > 100.0 {
            // Return an error if the reserved GPU max memory usage percent is not between 0 and 100
            return Err("Reserved GPU max memory usage percent must be between 0.0 and 100.0".to_string());
        }
        // If all validations pass, return Ok
        Ok(())
    }
} 