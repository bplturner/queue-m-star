// build.rs
// Import necessary modules from the standard library
use std::env; // For accessing environment variables like OUT_DIR and PROFILE
use std::fs; // For file system operations like creating directories and copying files
use std::path::Path; // For working with file system paths
use std::path::PathBuf; // For constructing and manipulating file system paths

// Function to copy a directory and its contents recursively
fn copy_dir_all(src: impl AsRef<Path>, dst: impl AsRef<Path>) -> std::io::Result<()> {
    // Create the destination directory if it doesn't already exist. 
    // fs::create_dir_all will create parent directories as needed.
    fs::create_dir_all(&dst)?;
    // Iterate over the entries in the source directory
    for entry in fs::read_dir(src)? {
        // Get the DirEntry for the current item
        let entry = entry?;
        // Get the file type (e.g., file, directory, symlink) of the current item
        let ty = entry.file_type()?;
        // Construct the full path to the destination for the current item
        let dst_path = dst.as_ref().join(entry.file_name());
        // If the entry is a directory, recursively call copy_dir_all for this subdirectory
        if ty.is_dir() {
            copy_dir_all(entry.path(), &dst_path)?;
        } else {
            // If the entry is a file, copy it to the destination path.
            // fs::copy will overwrite the destination file if it already exists.
            fs::copy(entry.path(), &dst_path)?;
        }
    }
    // Return Ok if all operations were successful
    Ok(())
}

// The main function for the build script
fn main() {
    // Tell Cargo to re-run this build script if the content of the "static" directory changes.
    // This ensures that changes to static assets are picked up in subsequent builds.
    println!("cargo:rerun-if-changed=static");

    // Get the CARGO_MANIFEST_DIR environment variable, which is the directory containing Cargo.toml
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR not set"));
    // Get the PROFILE environment variable (e.g., "debug" or "release")
    let profile = env::var("PROFILE").expect("PROFILE not set");
    
    // Define the path to the source "static" directory, relative to the manifest directory (project root)
    let static_src_path = manifest_dir.join("static");
    // Define the path to the target directory (e.g., target/debug/ or target/release/)
    let target_profile_dir = manifest_dir.join("target").join(profile);
    // Define the destination path for the "static" directory within the target profile directory
    let static_dest_path = target_profile_dir.join("static");

    // Check if the source "static" directory exists and is actually a directory
    if static_src_path.exists() && static_src_path.is_dir() {
        // Attempt to copy the entire "static" directory to the destination
        if let Err(e) = copy_dir_all(&static_src_path, &static_dest_path) {
            // If copying fails, print a warning message to Cargo
            eprintln!("cargo:warning=Failed to copy static directory from {} to {}: {}", static_src_path.display(), static_dest_path.display(), e);
        } else {
            // Success — no need to print anything
        }
    } else {
        // If the source "static" directory does not exist or is not a directory, print a warning
        println!("cargo:warning=Source static directory not found at {}, not copying.", static_src_path.display());
    }
} 