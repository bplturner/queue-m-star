#!/bin/bash

# Deploys the mstar_queue application as a systemd service.
# This script should be run from the root of the mstar_queue project directory.

set -e

# --- Configuration ---
PROJECT_NAME="mstar_queue"
SYSTEM_USER="mstar_user"
SYSTEM_GROUP="mstar_user"

SOURCE_DIR=$(pwd)
BINARY_NAME="${PROJECT_NAME}"
CONFIG_FILE_NAME="config.toml"
SERVICE_FILE_NAME="${PROJECT_NAME}.service"

# System paths
INSTALL_BIN_DIR="/usr/local/bin"
WORKING_DIR_DAEMON="/opt/${PROJECT_NAME}"
QUEUE_SUBDIR="queue"
JOBS_SUBDIR="jobs"
ARCHIVE_SUBDIR="archive"
STATIC_SUBDIR="static"
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
    error_exit "${CONFIG_FILE_NAME} not found in ${SOURCE_DIR}."
fi

if [ ! -f "${SOURCE_DIR}/${SERVICE_FILE_NAME}" ]; then
    error_exit "${SERVICE_FILE_NAME} not found in ${SOURCE_DIR}."
fi

if [ ! -d "${SOURCE_DIR}/static" ]; then
    error_exit "static/ directory not found. The web frontend is required."
fi

if [ ! -f "${SOURCE_DIR}/unpack_msb.py" ]; then
    error_exit "unpack_msb.py not found. This script is needed for job processing."
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
    error_exit "Built binary not found at ${BUILT_BINARY_PATH}."
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
    log "User '${SYSTEM_USER}' created."
else
    log "User '${SYSTEM_USER}' already exists."
fi

# Add video/render groups for GPU access
sudo usermod -aG video "${SYSTEM_USER}" 2>/dev/null || true
sudo usermod -aG render "${SYSTEM_USER}" 2>/dev/null || true
log "Ensured '${SYSTEM_USER}' has video/render group access for GPUs."

# --- 3. Create Directories ---
log "Creating necessary directories..."
sudo mkdir -p "${INSTALL_BIN_DIR}"
sudo mkdir -p "${WORKING_DIR_DAEMON}/${QUEUE_SUBDIR}"
sudo mkdir -p "${WORKING_DIR_DAEMON}/${JOBS_SUBDIR}"
sudo mkdir -p "${WORKING_DIR_DAEMON}/${ARCHIVE_SUBDIR}"
sudo mkdir -p "${WORKING_DIR_DAEMON}/${STATIC_SUBDIR}"

# --- 4. Stop service before replacing binary (prevents "Text file busy") ---
log "Stopping the service before file replacement..."
if sudo systemctl is-active --quiet "${SERVICE_FILE_NAME}"; then
    sudo systemctl stop "${SERVICE_FILE_NAME}"
    log "Service was running and has been stopped."
    sleep 1
else
    log "Service was not running."
fi

# --- 5. Copy Files ---
log "Copying application binary..."
sudo cp "${BUILT_BINARY_PATH}" "${INSTALL_BIN_DIR}/${BINARY_NAME}"
sudo chmod +x "${INSTALL_BIN_DIR}/${BINARY_NAME}"

log "Copying configuration file to ${WORKING_DIR_DAEMON}..."
# Generate production config with absolute paths
cat > /tmp/${CONFIG_FILE_NAME} << EOF
[paths]
log_file = "${WORKING_DIR_DAEMON}/${PROJECT_NAME}.log"
queue_directory = "/shares/office-fileserver1/Queue/"
mstar_executable = "/opt/mstar/mstar-cfd-mgpu-latest"
mstar_install_dir = "/opt/mstar/"
database_file = "${WORKING_DIR_DAEMON}/${PROJECT_NAME}.db"
jobs_directory = "/simulations/Queue/jobs/"
archive_directory = "${WORKING_DIR_DAEMON}/${ARCHIVE_SUBDIR}/"
gpu_metrics_log = "${WORKING_DIR_DAEMON}/gpu_metrics.log"

[web_server]
port = 1111
max_payload_size_mb = 500

[file_handling]
max_file_size_mb = 500
allowed_file_types = ["msb"]

[gpu_selection]
reserved_gpu_max_utilization = 5.0
reserved_gpu_max_memory_usage_percent = 10.0

[queue]
max_concurrent_jobs = 8
poll_interval_secs = 5
default_mstar_version = "latest"
job_output_retention_days = 90
EOF
sudo cp /tmp/${CONFIG_FILE_NAME} "${WORKING_DIR_DAEMON}/${CONFIG_FILE_NAME}"
rm /tmp/${CONFIG_FILE_NAME}

log "Copying static web files..."
sudo cp -r "${SOURCE_DIR}/static/"* "${WORKING_DIR_DAEMON}/${STATIC_SUBDIR}/"

log "Copying unpack_msb.py..."
sudo cp "${SOURCE_DIR}/unpack_msb.py" "${WORKING_DIR_DAEMON}/unpack_msb.py"

log "Copying systemd service file..."
sudo cp "${SOURCE_DIR}/${SERVICE_FILE_NAME}" "${SERVICE_FILE_SYSTEM_DIR}/${SERVICE_FILE_NAME}"
sudo chmod 644 "${SERVICE_FILE_SYSTEM_DIR}/${SERVICE_FILE_NAME}"

log "Copying M-Star management scripts to /opt/mstar/..."
if [ -d "${SOURCE_DIR}/scripts" ]; then
    sudo cp "${SOURCE_DIR}/scripts/download-latest.sh" "/opt/mstar/download-latest.sh"
    sudo cp "${SOURCE_DIR}/scripts/update-latest-symlink.sh" "/opt/mstar/update-latest-symlink.sh"
    sudo chmod +x /opt/mstar/download-latest.sh /opt/mstar/update-latest-symlink.sh
    sudo chown "${SYSTEM_USER}:${SYSTEM_GROUP}" /opt/mstar/download-latest.sh /opt/mstar/update-latest-symlink.sh
fi

# --- 6. Set Ownership & Permissions ---
log "Setting ownership for daemon directories..."
sudo chown -R "${SYSTEM_USER}:${SYSTEM_GROUP}" "${WORKING_DIR_DAEMON}"
sudo chmod 640 "${WORKING_DIR_DAEMON}/${CONFIG_FILE_NAME}"

# Ensure shared jobs directory exists and is writable by the service user
# NOTE: /simulations is a network mount with root_squash — chown won't work.
# Use 777 permissions so mstar_user can create job subdirectories.
SHARED_JOBS_DIR="/simulations/Queue/jobs"
sudo mkdir -p "${SHARED_JOBS_DIR}"
sudo chmod 777 "${SHARED_JOBS_DIR}"
log "Ensured ${SHARED_JOBS_DIR} is world-writable (network mount)"

# --- 7. Systemd Setup ---
log "Reloading systemd daemon..."
sudo systemctl daemon-reload

log "Enabling ${PROJECT_NAME} service to start on boot..."
sudo systemctl enable "${SERVICE_FILE_NAME}"

log "Starting ${PROJECT_NAME} service..."
sudo systemctl start "${SERVICE_FILE_NAME}"

# --- 7. Status Check ---
log "Waiting for the service to initialize..."
sleep 5

log "Checking status of ${PROJECT_NAME} service..."
if sudo systemctl is-active --quiet "${SERVICE_FILE_NAME}"; then
    log "✓ ${PROJECT_NAME} service is active and running."
    log ""
    log "=== Deployment Summary ==="
    log "  Binary:    ${INSTALL_BIN_DIR}/${BINARY_NAME}"
    log "  Config:    ${WORKING_DIR_DAEMON}/${CONFIG_FILE_NAME}"
    log "  Database:  ${WORKING_DIR_DAEMON}/${PROJECT_NAME}.db"
    log "  Jobs dir:  ${WORKING_DIR_DAEMON}/${JOBS_SUBDIR}/"
    log "  Static:    ${WORKING_DIR_DAEMON}/${STATIC_SUBDIR}/"
    log "  Web UI:    http://localhost:1111/"
    log "  Service:   ${SERVICE_FILE_NAME}"
    log ""
    log "  Default login: admin / admin"
    log "  !! CHANGE THE DEFAULT PASSWORD IMMEDIATELY !!"
    log ""
    log "  Check logs: sudo journalctl -fu ${SERVICE_FILE_NAME}"
    log "=========================="
else
    echo "-------------------------------------------------------------"
    echo "[ERROR] ${PROJECT_NAME} service FAILED TO START."
    echo "Recent journal logs:"
    sudo journalctl -u "${SERVICE_FILE_NAME}" -n 30 --no-pager
    echo "-------------------------------------------------------------"
    error_exit "Please check the logs above."
fi

exit 0
