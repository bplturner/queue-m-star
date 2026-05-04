#!/bin/bash

# Deploys the mstar_queue application as a systemd service.
# This script should be run from the root of the mstar_queue project directory.

# Exit immediately if a command exits with a non-zero status.
set -e

# --- Configuration ---
PROJECT_NAME="mstar_queue"
SYSTEM_USER="mstar_user"
SYSTEM_GROUP="mstar_user"

# Paths relative to the script's location (assumed to be project root)
SOURCE_DIR=$(pwd)
BINARY_NAME="${PROJECT_NAME}"
CONFIG_FILE_NAME="config.toml"
SERVICE_FILE_NAME="${PROJECT_NAME}.service"

# System paths
INSTALL_BIN_DIR="/usr/local/bin"
# CONFIG_DIR_SYSTEM="/etc/${PROJECT_NAME}" # Removed, config will go to WORKING_DIR_DAEMON
WORKING_DIR_DAEMON="/opt/${PROJECT_NAME}" # Matches WorkingDirectory in service file, and will hold config
QUEUE_SUBDIR="queue" # Subdirectory within WORKING_DIR_DAEMON for the queue
SERVICE_FILE_SYSTEM_DIR="/etc/systemd/system"

# --- Helper Functions ---
log() {
    echo "[INFO] $(date +'%Y-%m-%d %H:%M:%S') - $1"
}

error_exit() {
    echo "[ERROR] $(date +'%Y-%m-%d %H:%M:%S') - $1" >&2
    exit 1
}

# --- Pre-flight Checks ---
log "Performing pre-flight checks..."
if [ "$(id -u)" -eq 0 ]; then
    error_exit "This script should not be run as root directly. It will use sudo where necessary."
fi

if ! command -v cargo &> /dev/null; then
    error_exit "cargo command could not be found. Please install Rust/Cargo."
fi

if [ ! -f "${SOURCE_DIR}/Cargo.toml" ]; then
    error_exit "Cargo.toml not found in ${SOURCE_DIR}. Please run this script from the project root."
fi

if [ ! -f "${SOURCE_DIR}/${CONFIG_FILE_NAME}" ]; then
    error_exit "${CONFIG_FILE_NAME} not found in ${SOURCE_DIR}. Please ensure it exists and contains ABSOLUTE paths for log_file and queue_directory (e.g., referencing ${WORKING_DIR_DAEMON})."
fi

if [ ! -f "${SOURCE_DIR}/${SERVICE_FILE_NAME}" ]; then
    error_exit "${SERVICE_FILE_NAME} not found in ${SOURCE_DIR}."
fi
log "Pre-flight checks passed."

log "Starting deployment of ${PROJECT_NAME}..."

# --- 1. Build the application ---
log "Building release version of ${PROJECT_NAME}..."
if ! cargo build --release; then
    error_exit "Cargo build failed."
fi

BUILT_BINARY_PATH="${SOURCE_DIR}/target/release/${BINARY_NAME}"
if [ ! -f "${BUILT_BINARY_PATH}" ]; then
    error_exit "Built binary not found at ${BUILT_BINARY_PATH}. Check build output. Ensure .cargo/config.toml (if any) does not redirect target-dir unexpectedly."
fi
log "Build successful. Binary at ${BUILT_BINARY_PATH}"

# --- 2. Create User and Group ---
log "Ensuring system user '${SYSTEM_USER}' and group '${SYSTEM_GROUP}' exist..."
if ! getent group "${SYSTEM_GROUP}" > /dev/null; then
    sudo groupadd "${SYSTEM_GROUP}"
    log "Group '${SYSTEM_GROUP}' created."
else
    log "Group '${SYSTEM_GROUP}' already exists."
fi

if ! id -u "${SYSTEM_USER}" > /dev/null 2>&1; then
    sudo useradd -r -g "${SYSTEM_GROUP}" -M -s /sbin/nologin -d "${WORKING_DIR_DAEMON}" "${SYSTEM_USER}"
    log "User '${SYSTEM_USER}' created (no home dir, nologin shell, home set to ${WORKING_DIR_DAEMON})."
else
    log "User '${SYSTEM_USER}' already exists."
fi

# --- 3. Create Directories ---
log "Creating necessary directories..."
sudo mkdir -p "${INSTALL_BIN_DIR}"
# sudo mkdir -p "${CONFIG_DIR_SYSTEM}" # Removed
sudo mkdir -p "${WORKING_DIR_DAEMON}/${QUEUE_SUBDIR}"

# --- 4. Set Directory Ownership ---
log "Setting ownership for daemon's working directory..."
sudo chown -R "${SYSTEM_USER}:${SYSTEM_GROUP}" "${WORKING_DIR_DAEMON}"
# sudo chown -R "${SYSTEM_USER}:${SYSTEM_GROUP}" "${CONFIG_DIR_SYSTEM}" # Removed


# --- 5. Copy Files ---
log "Copying application binary..."
sudo cp "${BUILT_BINARY_PATH}" "${INSTALL_BIN_DIR}/${BINARY_NAME}"
sudo chmod +x "${INSTALL_BIN_DIR}/${BINARY_NAME}"

log "Copying configuration file to working directory (${WORKING_DIR_DAEMON})."
log "Ensure paths in config.toml are ABSOLUTE (e.g., log_file = \"${WORKING_DIR_DAEMON}/${PROJECT_NAME}.log\", queue_directory = \"${WORKING_DIR_DAEMON}/${QUEUE_SUBDIR}/\")"
# sudo cp "${SOURCE_DIR}/${CONFIG_FILE_NAME}" "${CONFIG_DIR_SYSTEM}/${CONFIG_FILE_NAME}" # Removed
sudo cp "${SOURCE_DIR}/${CONFIG_FILE_NAME}" "${WORKING_DIR_DAEMON}/${CONFIG_FILE_NAME}" # For the daemon's WorkingDirectory

# Set permissions for config file in working directory
# sudo chown "${SYSTEM_USER}:${SYSTEM_GROUP}" "${CONFIG_DIR_SYSTEM}/${CONFIG_FILE_NAME}" # Removed
# sudo chmod 640 "${CONFIG_DIR_SYSTEM}/${CONFIG_FILE_NAME}" # Removed
sudo chown "${SYSTEM_USER}:${SYSTEM_GROUP}" "${WORKING_DIR_DAEMON}/${CONFIG_FILE_NAME}"
sudo chmod 640 "${WORKING_DIR_DAEMON}/${CONFIG_FILE_NAME}"

log "Copying systemd service file..."
sudo cp "${SOURCE_DIR}/${SERVICE_FILE_NAME}" "${SERVICE_FILE_SYSTEM_DIR}/${SERVICE_FILE_NAME}"
sudo chmod 644 "${SERVICE_FILE_SYSTEM_DIR}/${SERVICE_FILE_NAME}"

# --- 6. Systemd Setup ---
log "Reloading systemd daemon..."
sudo systemctl daemon-reload

log "Enabling ${PROJECT_NAME} service to start on boot..."
sudo systemctl enable "${SERVICE_FILE_NAME}"

log "Stopping the service if it's already running (to apply changes)..."
if sudo systemctl is-active --quiet "${SERVICE_FILE_NAME}"; then
    sudo systemctl stop "${SERVICE_FILE_NAME}"
    log "Service was running and has been stopped."
else
    log "Service was not running."
fi

log "Starting ${PROJECT_NAME} service..."
sudo systemctl start "${SERVICE_FILE_NAME}"

# --- 7. Status Check ---
log "Waiting a few seconds for the service to initialize..."
sleep 5 # Give the service a moment to start up

log "Checking status of ${PROJECT_NAME} service..."
if sudo systemctl is-active --quiet "${SERVICE_FILE_NAME}"; then
    log "${PROJECT_NAME} service is active and running."
else
    echo "-------------------------------------------------------------"
    echo "[ERROR] ${PROJECT_NAME} service FAILED TO START."
    echo "Recent journal logs for ${SERVICE_FILE_NAME}:"
    sudo journalctl -u "${SERVICE_FILE_NAME}" -n 20 --no-pager
    echo "-------------------------------------------------------------"
    error_exit "Please check the logs above and the application's own log file (e.g., ${WORKING_DIR_DAEMON}/${PROJECT_NAME}.log)."
fi

log "Deployment complete for ${PROJECT_NAME}."
log "Service status: $(sudo systemctl status ${SERVICE_FILE_NAME} | grep Active)"
log "You can check logs with: sudo journalctl -fu ${SERVICE_FILE_NAME}"
log "And the application's own log file (e.g. ${WORKING_DIR_DAEMON}/${PROJECT_NAME}.log, if configured)."

exit 0 