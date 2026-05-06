import sys # Import the sys module to manipulate Python runtime environment
import os # Import the os module for interacting with the operating system
import subprocess # Import the subprocess module to run shell commands

# Define the root directory for M-Star (from environment or default)
mstar_root_dir = os.environ.get("MSTAR_ROOT", "/opt/mstar/mstarcfd-latest/")  # Root directory of M-Star installation
# Define the M-Star library directory, also used for Python's sys.path
mstar_lib_dir = os.path.join(mstar_root_dir, "lib") # Path to the M-Star libraries and Python module
# Path to the M-Star environment setup script
mstar_sh_path = os.path.join(mstar_root_dir, "mstar.sh") # Full path to mstar.sh

# Flag to indicate that the environment has been sourced by this script's re-execution logic
ENV_SOURCED_FLAG = "UNPACK_MSB_MSTAR_ENV_SOURCED" # Name of the environment flag

def actual_mstar_processing_logic():
    # This function contains the core logic of the script that runs after
    # the M-Star environment is confirmed to be set up.

    # Add the M-Star CFD library path to Python's module search path (sys.path)
    # This allows Python's import mechanism to find the mstar Python module itself.
    sys.path.insert(0, mstar_lib_dir) # Insert at the beginning to ensure it's checked first.
    print(f"Python sys.path dynamically updated to include: '{mstar_lib_dir}'") # Log path modification

    # Log the current LD_LIBRARY_PATH for diagnostics; it should be set by the sourced mstar.sh
    current_ld_path = os.environ.get('LD_LIBRARY_PATH', 'LD_LIBRARY_PATH Not Set') # Get current LD_LIBRARY_PATH
    print(f"LD_LIBRARY_PATH at M-Star import attempt: '{current_ld_path}'") # Log the path

    # Optional Diagnostic: Attempt to load a critical library directly using ctypes with full path
    # This can help confirm if the dynamic linker can find dependencies.
    try:
        import ctypes # Import the ctypes module for low-level foreign function interface
        # Construct the full path to a specific .so file known to be problematic if dependencies are missing
        critical_lib_path = os.path.join(mstar_lib_dir, "libTKHLR.so.7.7") # Full path to the library file
        print(f"Attempting to load '{critical_lib_path}' with ctypes for diagnostic purposes...") # Informative message
        ctypes.CDLL(critical_lib_path) # Attempt to load the shared library by its full path
        print(f"Successfully loaded '{critical_lib_path}' with ctypes.") # Success message
    except Exception as e:
        # If loading with ctypes fails, print the error; this could be an early warning.
        print(f"Warning: Error loading '{critical_lib_path}' with ctypes: {e}") # Error message
        print("This might indicate issues with finding shared library dependencies despite a sourced environment.") # Additional warning

    print("Attempting to import mstar module...") # Informative message
    import mstar # Import the M-Star CFD library (should now succeed)
    print("Successfully imported mstar module.") # Success message

    # Define the main function that performs the MSB unpacking tasks
    def run_msb_unpack_operations():
        # Check if the correct number of command-line arguments are provided
        # sys.argv[0] is the script name, sys.argv[1] is the MSB file path, sys.argv[2] is the output directory
        if len(sys.argv) != 3:
            # Print usage instructions if the arguments are incorrect
            print("Usage: python unpack_msb.py <msb_file_path> <output_directory_path>")
            # Exit the script with an error code
            sys.exit(1)

        # Get the MSB file path from the command-line arguments
        msb_file_path = sys.argv[1] # MSB file path
        # Get the output directory path from the command-line arguments
        output_directory_path = sys.argv[2] # Output directory path

        # Check if the provided MSB file path exists
        if not os.path.exists(msb_file_path):
            # Print an error message if the MSB file does not exist
            print(f"Error: MSB file not found at {msb_file_path}")
            # Exit the script with an error code
            sys.exit(1)

        # Check if the provided output directory path exists and is a directory
        if not os.path.isdir(output_directory_path):
            # Print an error message if the output directory does not exist or is not a directory
            print(f"Error: Output directory not found or is not a directory at {output_directory_path}")
            # Exit the script with an error code
            sys.exit(1)

        try:
            # Initialize M-Star (assumed to handle licensing)
            print(f"Initializing M-Star...") # Print message: Initializing M-Star...
            mstar.Initialize() # Initialize the M-Star environment
            
            # Load the M-Star model from the MSB file
            print(f"Loading MSB file: {msb_file_path}") # Print message: Loading MSB file
            model = mstar.Load(msb_file_path) # Load the MSB file into the model object

            # Assuming mstar.Load() raises an exception on critical failure or returns a usable model.
            # The previous IsNull() check was removed due to AttributeError.
            print(f"Successfully loaded MSB file: {msb_file_path}") # Print success message (assuming Load worked)

            # Print the model contents to the screen for logging
            print(f"Printing model contents for: {msb_file_path}") # Print message: Printing model contents
            model.Print(activeOnly=False) # Print all properties of the model for comprehensive logging
            print(f"Finished printing model contents for: {msb_file_path}") # Print message: Finished printing

            # Export the solver files to the specified output directory
            print(f"Exporting solver files to: {output_directory_path}") # Print message: Exporting solver files
            export_success = model.Export(output_directory_path) # Export the model to the specified directory

            # Check if the export was successful
            if export_success: # Check if the export operation was successful
                # Print a success message if the export was successful
                print(f"Successfully exported solver files to {output_directory_path}")
            else:
                # Print an error message if the export failed
                print(f"Error: Failed to export solver files from {msb_file_path} to {output_directory_path}")
                # Exit the script with an error code
                sys.exit(1)

        except Exception as e:
            # Catch any other exceptions that may occur during the process
            # Print a general error message including the exception details
            print(f"An error occurred during M-Star operations: {e}")
            # Exit the script with an error code
            sys.exit(1)
        finally:
            # Ensure the model is closed if it was loaded and is not None
            if 'model' in locals() and model is not None: # Check if model exists and is not None
                # Close the model to release resources
                model.Close() # Attempt to close if model object exists
                # Print a message indicating the model has been closed
                print("M-Star model closed.")

    # Call the main MSB unpacking operations
    run_msb_unpack_operations()


# This is the main entry point of the script
if __name__ == "__main__":
    # Check if the environment flag is set
    if ENV_SOURCED_FLAG not in os.environ:
        # If the flag is not set, this is the first run (or run in an unprepared environment)
        print(f"M-Star environment flag '{ENV_SOURCED_FLAG}' not found.") # Log: Flag not found
        print(f"Attempting to re-execute script within the mstar.sh environment from '{mstar_sh_path}'...") # Log: Re-execution attempt

        # Get the Python executable path
        python_executable = sys.executable # Path to current Python interpreter
        # Get the full path to the current script
        script_path = os.path.abspath(sys.argv[0]) # Absolute path of this script
        # Get the original arguments passed to the script (excluding the script name itself)
        original_args = sys.argv[1:] # Arguments to pass to the re-executed script

        # Construct the command that will be run by bash -c
        # This command will:
        # 1. Source the mstar.sh script.
        # 2. Export the ENV_SOURCED_FLAG to mark the environment as prepared.
        # 3. Use 'exec' to replace the shell process with the new Python process,
        #    running the current script with its original arguments.
        # Arguments are individually quoted to handle spaces or special characters.
        command_for_subshell = f'export {ENV_SOURCED_FLAG}=1 && exec "{python_executable}" "{script_path}"' # Base command
        for arg in original_args: # Iterate over original arguments
            command_for_subshell += f' "{arg}"' # Append each argument, quoted

        # The full command to be executed by bash
        # It sources mstar.sh and then runs the command_for_subshell
        bash_command_to_execute = f'. "{mstar_sh_path}" && {command_for_subshell}' # Complete bash command string
        
        print(f"Executing command: bash -c '{bash_command_to_execute}'") # Log the command to be run

        # Run the command using subprocess.run
        # This will wait for the re-executed script to complete.
        # The stdout/stderr of the re-executed script will be inherited by this process's stdout/stderr by default.
        # check=False allows us to get the return code even if it's non-zero.
        completed_process = subprocess.run(['bash', '-c', bash_command_to_execute], check=False)
        
        # Exit this original script with the return code of the re-executed script
        sys.exit(completed_process.returncode) # Propagate the exit code
    else:
        # If the flag IS set, it means mstar.sh was (presumably) sourced by a previous run of this script.
        print(f"M-Star environment flag '{ENV_SOURCED_FLAG}' found.") # Log: Flag found
        print("Proceeding with M-Star processing logic in the current environment.") # Log: Proceeding
        # Call the main M-Star processing logic
        actual_mstar_processing_logic() 