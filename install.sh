#!/usr/bin/env bash
# =============================================================================
# M-Star Queue Manager — Interactive Installer
# =============================================================================
# Usage:
#   ./install.sh                  Interactive installation (prompts for all settings)
#   ./install.sh --non-interactive   Accept all defaults (automated deployment)
#   ./install.sh --dry-run           Show what would be done without modifying the system
#   ./install.sh --help              Show this help message
#
# This script:
#   1. Prompts for every configurable path and setting (with sensible defaults)
#   2. Generates config.toml from your answers
#   3. Generates and installs a systemd service file
#   4. Creates the system user, directories, and permissions
#   5. Starts the M-Star Queue daemon
#
# No manual file editing required.
# =============================================================================

set -euo pipefail

# --- Script metadata --------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSION="$(grep -m1 '^version' "${SCRIPT_DIR}/Cargo.toml" 2>/dev/null | sed 's/.*"\(.*\)".*/\1/' || echo "unknown")"
PROJECT_NAME="mstar_queue"
BINARY_NAME="mstar_queue"

# --- Flags -------------------------------------------------------------------
NON_INTERACTIVE=false
DRY_RUN=false

for arg in "$@"; do
    case "$arg" in
        --non-interactive) NON_INTERACTIVE=true ;;
        --dry-run)         DRY_RUN=true ;;
        --help|-h)
            head -n 17 "$0" | tail -n +3 | sed 's/^# \?//'
            exit 0
            ;;
        *)
            echo "Unknown option: $arg"
            echo "Run '$0 --help' for usage."
            exit 1
            ;;
    esac
done

# --- Colors & formatting ----------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

banner() {
    echo ""
    echo -e "${CYAN}${BOLD}====================================================${NC}"
    echo -e "${CYAN}${BOLD}  M-Star Queue Manager — Installer (v${VERSION})${NC}"
    echo -e "${CYAN}${BOLD}====================================================${NC}"
    echo ""
}

section() {
    echo ""
    echo -e "${BOLD}── $1 ──${NC}"
}

log()   { echo -e "  ${GREEN}✓${NC} $1"; }
warn()  { echo -e "  ${YELLOW}⚠${NC} $1"; }
err()   { echo -e "  ${RED}✗${NC} $1" >&2; }
info()  { echo -e "  ${DIM}$1${NC}"; }
drylog(){ echo -e "  ${YELLOW}[DRY-RUN]${NC} $1"; }

# --- Prompt helper -----------------------------------------------------------
# prompt VAR "Description" "default"
prompt() {
    local var_name="$1"
    local description="$2"
    local default="$3"

    if $NON_INTERACTIVE; then
        eval "$var_name=\"$default\""
        return
    fi

    local input
    read -rp "  $(echo -e "${BOLD}${description}${NC}") [${default}]: " input
    eval "$var_name=\"${input:-$default}\""
}

# prompt_yn VAR "Description" "y/n default"
prompt_yn() {
    local var_name="$1"
    local description="$2"
    local default="$3"

    if $NON_INTERACTIVE; then
        eval "$var_name=\"$default\""
        return
    fi

    local input
    read -rp "  $(echo -e "${BOLD}${description}${NC}") [${default}]: " input
    input="${input:-$default}"
    input="${input,,}" # lowercase
    if [[ "$input" == "y" || "$input" == "yes" ]]; then
        eval "$var_name=y"
    else
        eval "$var_name=n"
    fi
}

# prompt_secret VAR "Description" "default"
# Like prompt() but hides input (for passwords)
prompt_secret() {
    local var_name="$1"
    local description="$2"
    local default="$3"

    if $NON_INTERACTIVE; then
        eval "$var_name=\"$default\""
        return
    fi

    local input
    read -srp "  $(echo -e "${BOLD}${description}${NC}") [${default:+****}]: " input
    echo "" # newline after hidden input
    eval "$var_name=\"${input:-$default}\""
}

# --- Pre-flight checks -------------------------------------------------------
preflight() {
    section "Pre-flight Checks"

    # Must NOT be root (we use sudo selectively)
    if [ "$(id -u)" -eq 0 ]; then
        err "Do not run this script as root. It uses sudo where needed."
        exit 1
    fi

    # Check for sudo
    if ! command -v sudo &>/dev/null; then
        err "sudo is required but not found."
        exit 1
    fi

    # Check for the binary
    if [ -f "${SCRIPT_DIR}/${BINARY_NAME}" ]; then
        log "Found pre-compiled binary: ${BINARY_NAME}"
        BINARY_SOURCE="${SCRIPT_DIR}/${BINARY_NAME}"
        BUILD_FROM_SOURCE=false
    elif [ -f "${SCRIPT_DIR}/target/release/${BINARY_NAME}" ]; then
        log "Found release binary in target/release/"
        BINARY_SOURCE="${SCRIPT_DIR}/target/release/${BINARY_NAME}"
        BUILD_FROM_SOURCE=false
    elif [ -f "${SCRIPT_DIR}/Cargo.toml" ]; then
        warn "No pre-compiled binary found. Will build from source."
        if ! command -v cargo &>/dev/null; then
            err "Rust/Cargo is required to build from source but not found."
            err "Install Rust: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
            exit 1
        fi
        BUILD_FROM_SOURCE=true
    else
        err "No binary or source code found. Cannot install."
        exit 1
    fi

    # Check for required files
    if [ ! -d "${SCRIPT_DIR}/static" ]; then
        err "static/ directory not found. The web UI is required."
        exit 1
    fi

    if [ ! -f "${SCRIPT_DIR}/unpack_msb.py" ]; then
        err "unpack_msb.py not found. This script is required for job processing."
        exit 1
    fi

    # Check for nvidia-smi (warn only, not fatal)
    if command -v nvidia-smi &>/dev/null; then
        local gpu_count
        gpu_count=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | wc -l || echo 0)
        log "nvidia-smi found — ${gpu_count} GPU(s) detected"
    else
        warn "nvidia-smi not found. GPU monitoring will not work."
    fi

    # Check for python3 (needed for unpack_msb.py)
    if command -v python3 &>/dev/null; then
        log "python3 found: $(python3 --version 2>&1)"
    else
        warn "python3 not found. Job unpacking (unpack_msb.py) will fail."
    fi

    # Check for mpirun (needed for multi-GPU jobs)
    if command -v mpirun &>/dev/null; then
        log "mpirun found: $(mpirun --version 2>&1 | head -1)"
    else
        warn "mpirun not found. Multi-GPU jobs will not work."
    fi

    log "Pre-flight checks passed"
}

# --- Collect configuration ----------------------------------------------------
collect_config() {
    section "Installation Paths"
    info "Press Enter to accept the default value shown in [brackets]."
    echo ""

    prompt INSTALL_DIR       "Install directory"                "/opt/${PROJECT_NAME}"
    prompt WEB_PORT          "Web server port"                  "1111"
    prompt MSTAR_INSTALL_DIR "M-Star CFD install directory"     "/opt/mstar"
    prompt DATA_ROOT         "Data root (security boundary for file browsing)"  "/opt/mstar_queue/data"
    prompt QUEUE_DIRECTORY   "Queue watch directory (legacy file intake)"  "/opt/mstar_queue/queue/"
    prompt JOBS_DIRECTORY    "Jobs working directory"           "${INSTALL_DIR}/jobs"
    prompt ARCHIVE_DIRECTORY "Archive directory"                "${INSTALL_DIR}/archive"

    section "Limits & Tuning"
    echo ""

    prompt MAX_PAYLOAD_MB     "Max file upload size (MB)"       "500"
    prompt MAX_FILE_SIZE_MB   "Max MSB file size (MB)"          "500"
    prompt MAX_CONCURRENT     "Max concurrent jobs"             "8"
    prompt DEFAULT_VERSION    "Default M-Star version"          "latest"
    prompt RETENTION_DAYS     "Job output retention (days, 0=forever)"  "90"
    prompt POLL_INTERVAL      "Queue poll interval (seconds)"   "5"
    prompt GPU_MAX_UTIL       "Reserved GPU max utilization (%)" "5.0"
    prompt GPU_MAX_MEM        "Reserved GPU max memory usage (%)" "10.0"

    section "Production Settings"
    echo ""

    prompt_yn AUTO_REQUEUE    "Auto-requeue running jobs after reboot?" "y"
    prompt STARTUP_DELAY      "Startup delay for NFS/GPUs (seconds)"    "10"

    section "System User"
    echo ""

    prompt SYSTEM_USER  "System user to run the daemon"   "mstar_user"
    prompt SYSTEM_GROUP "System group"                     "${SYSTEM_USER}"

    section "Security"
    echo ""

    prompt EMAIL_DOMAIN "Restrict registration to email domain (blank = allow all)" ""

    section "M-Star Download Credentials (for nightly updates)"
    info "These are used by the 'Install Latest Version' feature."
    info "Leave blank if you don't have M-Star download credentials."
    echo ""

    prompt MSTAR_DL_USER "M-Star download username" ""
    prompt_secret MSTAR_DL_PASS "M-Star download password" ""

    # Derived paths
    LOG_FILE="${INSTALL_DIR}/${PROJECT_NAME}.log"
    DATABASE_FILE="${INSTALL_DIR}/${PROJECT_NAME}.db"
    GPU_METRICS_LOG="${INSTALL_DIR}/gpu_metrics.log"
    MSTAR_EXECUTABLE="${MSTAR_INSTALL_DIR}/mstar-cfd-mgpu-latest"
}

# --- Validate inputs ----------------------------------------------------------
validate() {
    section "Validating Configuration"

    local errors=0

    # Port validation
    if ! [[ "$WEB_PORT" =~ ^[0-9]+$ ]] || [ "$WEB_PORT" -lt 1 ] || [ "$WEB_PORT" -gt 65535 ]; then
        err "Invalid port: ${WEB_PORT} (must be 1-65535)"
        ((errors++))
    fi

    # Numeric validations
    for var in MAX_PAYLOAD_MB MAX_FILE_SIZE_MB MAX_CONCURRENT RETENTION_DAYS POLL_INTERVAL; do
        eval "val=\$$var"
        if ! [[ "$val" =~ ^[0-9]+$ ]]; then
            err "Invalid value for ${var}: ${val} (must be a positive integer)"
            ((errors++))
        fi
    done

    # Float validations
    for var in GPU_MAX_UTIL GPU_MAX_MEM; do
        eval "val=\$$var"
        if ! [[ "$val" =~ ^[0-9]+\.?[0-9]*$ ]]; then
            err "Invalid value for ${var}: ${val} (must be a number)"
            ((errors++))
        fi
    done

    # MAX_CONCURRENT must be >= 1
    if [ "$MAX_CONCURRENT" -lt 1 ] 2>/dev/null; then
        err "Max concurrent jobs must be at least 1"
        ((errors++))
    fi

    if [ "$errors" -gt 0 ]; then
        err "Found ${errors} validation error(s). Aborting."
        exit 1
    fi

    log "All inputs validated"
}

# --- Show summary and confirm -------------------------------------------------
confirm() {
    section "Installation Summary"
    echo ""
    echo -e "  ${BOLD}Install directory:${NC}     ${INSTALL_DIR}"
    echo -e "  ${BOLD}Web server port:${NC}       ${WEB_PORT}"
    echo -e "  ${BOLD}M-Star install dir:${NC}    ${MSTAR_INSTALL_DIR}"
    echo -e "  ${BOLD}Data root (NFS):${NC}       ${DATA_ROOT}"
    echo -e "  ${BOLD}Queue watch dir:${NC}       ${QUEUE_DIRECTORY}"
    echo -e "  ${BOLD}Jobs directory:${NC}        ${JOBS_DIRECTORY}"
    echo -e "  ${BOLD}Archive directory:${NC}     ${ARCHIVE_DIRECTORY}"
    echo -e "  ${BOLD}Log file:${NC}              ${LOG_FILE}"
    echo -e "  ${BOLD}Database:${NC}              ${DATABASE_FILE}"
    echo -e "  ${BOLD}Max upload:${NC}            ${MAX_PAYLOAD_MB} MB"
    echo -e "  ${BOLD}Max concurrent:${NC}        ${MAX_CONCURRENT} jobs"
    echo -e "  ${BOLD}Default version:${NC}       ${DEFAULT_VERSION}"
    echo -e "  ${BOLD}Retention:${NC}             ${RETENTION_DAYS} days"
    echo -e "  ${BOLD}System user:${NC}           ${SYSTEM_USER}:${SYSTEM_GROUP}"
    echo ""

    if ! $NON_INTERACTIVE; then
        prompt_yn PROCEED "Proceed with installation?" "y"
        if [ "$PROCEED" != "y" ]; then
            echo ""
            warn "Installation cancelled."
            exit 0
        fi
    fi
}

# --- Check for existing installation -----------------------------------------
check_existing() {
    if [ -f "${INSTALL_DIR}/config.toml" ]; then
        echo ""
        warn "Existing installation detected at ${INSTALL_DIR}"
        info "Your existing config.toml and database will be preserved."
        echo ""

        if ! $NON_INTERACTIVE; then
            prompt_yn UPDATE "Update binary, static files, and service? (config/db preserved)" "y"
            if [ "$UPDATE" != "y" ]; then
                warn "Installation cancelled."
                exit 0
            fi
        fi
        PRESERVE_CONFIG=true
    else
        PRESERVE_CONFIG=false
    fi
}

# --- Build from source (if needed) -------------------------------------------
build_binary() {
    if $BUILD_FROM_SOURCE; then
        section "Building from Source"
        if $DRY_RUN; then
            drylog "Would run: cargo build --release"
            BINARY_SOURCE="${SCRIPT_DIR}/target/release/${BINARY_NAME}"
            return
        fi

        log "Running cargo build --release..."
        (cd "${SCRIPT_DIR}" && cargo build --release)

        BINARY_SOURCE="${SCRIPT_DIR}/target/release/${BINARY_NAME}"
        if [ ! -f "${BINARY_SOURCE}" ]; then
            err "Build failed — binary not found at ${BINARY_SOURCE}"
            exit 1
        fi
        log "Build successful"
    fi
}

# --- Create system user -------------------------------------------------------
create_user() {
    section "System User Setup"

    if $DRY_RUN; then
        drylog "Would create group '${SYSTEM_GROUP}' (if needed)"
        drylog "Would create user '${SYSTEM_USER}' (if needed)"
        drylog "Would add '${SYSTEM_USER}' to video and render groups"
        return
    fi

    if ! getent group "${SYSTEM_GROUP}" >/dev/null 2>&1; then
        sudo groupadd "${SYSTEM_GROUP}"
        log "Created group: ${SYSTEM_GROUP}"
    else
        log "Group already exists: ${SYSTEM_GROUP}"
    fi

    if ! id -u "${SYSTEM_USER}" >/dev/null 2>&1; then
        sudo useradd -r -g "${SYSTEM_GROUP}" -M -s /sbin/nologin -d "${INSTALL_DIR}" "${SYSTEM_USER}"
        log "Created user: ${SYSTEM_USER}"
    else
        log "User already exists: ${SYSTEM_USER}"
    fi

    # GPU access groups
    sudo usermod -aG video "${SYSTEM_USER}" 2>/dev/null || true
    sudo usermod -aG render "${SYSTEM_USER}" 2>/dev/null || true
    log "Ensured GPU access groups (video, render)"
}

# --- Create directories -------------------------------------------------------
create_directories() {
    section "Creating Directories"

    local dirs=(
        "${INSTALL_DIR}"
        "${INSTALL_DIR}/static"
        "${JOBS_DIRECTORY}"
        "${ARCHIVE_DIRECTORY}"
    )

    for dir in "${dirs[@]}"; do
        if $DRY_RUN; then
            drylog "Would create: ${dir}"
        else
            sudo mkdir -p "${dir}"
            log "Created: ${dir}"
        fi
    done

    # Queue directory (may be a network mount — best effort)
    if $DRY_RUN; then
        drylog "Would create queue directory: ${QUEUE_DIRECTORY} (best-effort)"
    else
        sudo mkdir -p "${QUEUE_DIRECTORY}" 2>/dev/null && log "Created: ${QUEUE_DIRECTORY}" \
            || warn "Could not create ${QUEUE_DIRECTORY} (network mount? — will work if it exists at runtime)"
    fi

    # M-Star install directory
    if $DRY_RUN; then
        drylog "Would create M-Star directory: ${MSTAR_INSTALL_DIR}"
    else
        sudo mkdir -p "${MSTAR_INSTALL_DIR}" 2>/dev/null && log "Created: ${MSTAR_INSTALL_DIR}" \
            || warn "Could not create ${MSTAR_INSTALL_DIR}"
    fi
}

# --- Generate config.toml ----------------------------------------------------
generate_config() {
    section "Generating Configuration"

    if $PRESERVE_CONFIG; then
        log "Preserving existing config.toml (not overwriting)"
        return
    fi

    local config_content

    # Convert y/n to toml boolean for config and service files
    if [ "${AUTO_REQUEUE}" = "y" ]; then
        AUTO_REQUEUE_BOOL="true"
    else
        AUTO_REQUEUE_BOOL="false"
    fi
    config_content=$(cat <<CONFIGEOF
# ============================================================================
# M-Star Queue Manager — Configuration
# Generated by install.sh on $(date -u '+%Y-%m-%d %H:%M:%S UTC')
# ============================================================================

# Paths for various files and directories
[paths]
log_file = "${LOG_FILE}"
queue_directory = "${QUEUE_DIRECTORY}"
mstar_executable = "${MSTAR_EXECUTABLE}"
mstar_install_dir = "${MSTAR_INSTALL_DIR}"
database_file = "${DATABASE_FILE}"
jobs_directory = "${JOBS_DIRECTORY}"
archive_directory = "${ARCHIVE_DIRECTORY}"
gpu_metrics_log = "${GPU_METRICS_LOG}"
data_root = "${DATA_ROOT}"

# Web server configuration
[web_server]
port = ${WEB_PORT}
max_payload_size_mb = ${MAX_PAYLOAD_MB}

# File handling configuration
[file_handling]
max_file_size_mb = ${MAX_FILE_SIZE_MB}
allowed_file_types = ["msb"]

# GPU selection configuration
[gpu_selection]
reserved_gpu_max_utilization = ${GPU_MAX_UTIL}
reserved_gpu_max_memory_usage_percent = ${GPU_MAX_MEM}

# Job queue configuration
[queue]
max_concurrent_jobs = ${MAX_CONCURRENT}
default_mstar_version = "${DEFAULT_VERSION}"
job_output_retention_days = ${RETENTION_DAYS}
poll_interval_secs = ${POLL_INTERVAL}
auto_requeue_on_restart = ${AUTO_REQUEUE_BOOL}
startup_delay_secs = ${STARTUP_DELAY}

# Security configuration
[security]
allowed_email_domain = "${EMAIL_DOMAIN}"
CONFIGEOF
)

    if $DRY_RUN; then
        drylog "Would write config.toml to ${INSTALL_DIR}/config.toml"
        echo ""
        echo -e "${DIM}--- Generated config.toml ---${NC}"
        echo "$config_content"
        echo -e "${DIM}--- End config.toml ---${NC}"
        return
    fi

    echo "$config_content" | sudo tee "${INSTALL_DIR}/config.toml" >/dev/null
    sudo chmod 640 "${INSTALL_DIR}/config.toml"
    log "Generated config.toml"

    # Write M-Star download credentials file (if provided)
    if [ -n "${MSTAR_DL_USER}" ] && [ -n "${MSTAR_DL_PASS}" ]; then
        local cred_file="${INSTALL_DIR}/.mstar_credentials"
        if $DRY_RUN; then
            drylog "Would write credentials to ${cred_file}"
        else
            cat > /tmp/.mstar_cred_tmp <<CREDEOF
# M-Star download credentials — generated by install.sh
# DO NOT commit this file to version control
MSTAR_DOWNLOAD_USER="${MSTAR_DL_USER}"
MSTAR_DOWNLOAD_PASS="${MSTAR_DL_PASS}"
CREDEOF
            sudo mv /tmp/.mstar_cred_tmp "${cred_file}"
            sudo chmod 600 "${cred_file}"
            sudo chown "${SYSTEM_USER}:${SYSTEM_GROUP}" "${cred_file}"
            log "Generated .mstar_credentials (chmod 600)"
        fi
    else
        log "No M-Star download credentials provided — skipping .mstar_credentials"
    fi
}

# --- Generate systemd service file -------------------------------------------
generate_service() {
    section "Generating Systemd Service"

    # Build the ReadWritePaths list — every path the service must write to
    # Start with the core paths that always need write access
    local rw_paths="${INSTALL_DIR} ${MSTAR_INSTALL_DIR} /usr/local/bin"

    # Add the data root (NFS mount for jobs, copy-to, file browser)
    if [[ -n "${DATA_ROOT}" && "${DATA_ROOT}" != "${INSTALL_DIR}"* ]]; then
        rw_paths="${rw_paths} ${DATA_ROOT}"
    fi

    # Add jobs directory if it's outside both the install dir and data root
    if [[ "${JOBS_DIRECTORY}" != "${INSTALL_DIR}"* && "${JOBS_DIRECTORY}" != "${DATA_ROOT}"* ]]; then
        rw_paths="${rw_paths} ${JOBS_DIRECTORY}"
    fi

    # Add queue directory if it's outside both the install dir and data root
    if [[ "${QUEUE_DIRECTORY}" != "${INSTALL_DIR}"* && "${QUEUE_DIRECTORY}" != "${DATA_ROOT}"* ]]; then
        rw_paths="${rw_paths} ${QUEUE_DIRECTORY}"
    fi

    local service_content

    service_content=$(cat <<SERVICEEOF
[Unit]
Description=M-Star Queue - CFD Job Management System
After=network-online.target remote-fs.target
Wants=network-online.target remote-fs.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
User=${SYSTEM_USER}
Group=${SYSTEM_GROUP}
WorkingDirectory=${INSTALL_DIR}

# Binary with quiet flag for production
ExecStart=/usr/local/bin/${BINARY_NAME} --quiet

# Restart policy: always restart, even on clean exit
Restart=always
RestartSec=10

# Only kill the queue manager, NOT child simulation processes.
# The queue manager re-attaches to orphaned simulations on startup
# and auto-requeues dead jobs (if configured).
KillMode=process

# Watchdog: disabled (requires Type=notify which conflicts with ProtectSystem=strict)
# WatchdogSec=120

# Startup timeout
TimeoutStartSec=30

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${PROJECT_NAME}

# Environment
Environment="RUST_BACKTRACE=1"
Environment="RUST_LOG=info"

# GPU access — nvidia-smi and CUDA devices
SupplementaryGroups=video render

# --- Filesystem Sandbox ---
# ProtectSystem=strict makes the ENTIRE filesystem read-only except ReadWritePaths.
# PrivateTmp=true gives the service its own writable /tmp and /var/tmp.
# This is REQUIRED for OpenMPI (session dirs), CUDA, and python3 temp files.
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=${rw_paths}

# Resource limits
LimitNOFILE=65536
LimitNPROC=4096
TasksMax=infinity

[Install]
WantedBy=multi-user.target
SERVICEEOF
)

    if $DRY_RUN; then
        drylog "Would install service file to /etc/systemd/system/${PROJECT_NAME}.service"
        echo ""
        echo -e "${DIM}--- Generated ${PROJECT_NAME}.service ---${NC}"
        echo "$service_content"
        echo -e "${DIM}--- End service file ---${NC}"
        return
    fi

    echo "$service_content" | sudo tee "/etc/systemd/system/${PROJECT_NAME}.service" >/dev/null
    sudo chmod 644 "/etc/systemd/system/${PROJECT_NAME}.service"
    log "Installed systemd service file"
}

# --- Stop existing service (before file replacement) -------------------------
stop_service() {
    if $DRY_RUN; then
        drylog "Would stop ${PROJECT_NAME} service if running"
        return
    fi

    if sudo systemctl is-active --quiet "${PROJECT_NAME}.service" 2>/dev/null; then
        sudo systemctl stop "${PROJECT_NAME}.service"
        log "Stopped running service"
        sleep 1
    fi
}

# --- Copy files ---------------------------------------------------------------
copy_files() {
    section "Installing Files"

    if $DRY_RUN; then
        drylog "Would copy binary to /usr/local/bin/${BINARY_NAME}"
        drylog "Would copy static/ to ${INSTALL_DIR}/static/"
        drylog "Would copy unpack_msb.py to ${INSTALL_DIR}/"
        drylog "Would copy M-Star management scripts to ${MSTAR_INSTALL_DIR}/"
        drylog "Would install logrotate config to /etc/logrotate.d/${PROJECT_NAME}"
        return
    fi

    # Binary
    sudo cp "${BINARY_SOURCE}" "/usr/local/bin/${BINARY_NAME}"
    sudo chmod +x "/usr/local/bin/${BINARY_NAME}"
    log "Installed binary: /usr/local/bin/${BINARY_NAME}"

    # Static web files
    sudo cp -r "${SCRIPT_DIR}/static/"* "${INSTALL_DIR}/static/"
    log "Installed static web files"

    # unpack_msb.py
    sudo cp "${SCRIPT_DIR}/unpack_msb.py" "${INSTALL_DIR}/unpack_msb.py"
    sudo chmod +x "${INSTALL_DIR}/unpack_msb.py"
    log "Installed unpack_msb.py"

    # M-Star management scripts
    if [ -d "${SCRIPT_DIR}/scripts" ]; then
        for script in "${SCRIPT_DIR}"/scripts/*.sh; do
            [ -f "$script" ] || continue
            local basename
            basename=$(basename "$script")
            sudo cp "$script" "${MSTAR_INSTALL_DIR}/${basename}"
            sudo chmod +x "${MSTAR_INSTALL_DIR}/${basename}"
            sudo chown "${SYSTEM_USER}:${SYSTEM_GROUP}" "${MSTAR_INSTALL_DIR}/${basename}"
        done
        log "Installed M-Star management scripts to ${MSTAR_INSTALL_DIR}/"
    fi

    # Log rotation config
    if [ -f "${SCRIPT_DIR}/mstar_queue.logrotate" ]; then
        sudo cp "${SCRIPT_DIR}/mstar_queue.logrotate" "/etc/logrotate.d/${PROJECT_NAME}"
        sudo chmod 644 "/etc/logrotate.d/${PROJECT_NAME}"
        log "Installed logrotate config: /etc/logrotate.d/${PROJECT_NAME}"
    fi
}

# --- Set ownership & permissions ----------------------------------------------
set_permissions() {
    section "Setting Permissions"

    if $DRY_RUN; then
        drylog "Would set ownership of ${INSTALL_DIR} to ${SYSTEM_USER}:${SYSTEM_GROUP}"
        drylog "Would set permissions on jobs and queue directories"
        return
    fi

    sudo chown -R "${SYSTEM_USER}:${SYSTEM_GROUP}" "${INSTALL_DIR}"
    log "Set ownership: ${INSTALL_DIR} → ${SYSTEM_USER}:${SYSTEM_GROUP}"

    # Jobs directory may be on a network mount — best effort
    if [[ "${JOBS_DIRECTORY}" != "${INSTALL_DIR}"* ]]; then
        sudo chown -R "${SYSTEM_USER}:${SYSTEM_GROUP}" "${JOBS_DIRECTORY}" 2>/dev/null \
            || warn "Could not set ownership on ${JOBS_DIRECTORY} (network mount?)"
    fi

    # Queue directory permissions — best effort
    sudo chmod 777 "${QUEUE_DIRECTORY}" 2>/dev/null \
        || info "Queue directory permissions not changed (network mount — should already be writable)"
}

# --- Start service ------------------------------------------------------------
start_service() {
    section "Starting Service"

    if $DRY_RUN; then
        drylog "Would run: systemctl daemon-reload"
        drylog "Would run: systemctl enable ${PROJECT_NAME}.service"
        drylog "Would run: systemctl start ${PROJECT_NAME}.service"
        return
    fi

    sudo systemctl daemon-reload
    log "Reloaded systemd"

    sudo systemctl enable "${PROJECT_NAME}.service"
    log "Enabled service (auto-start on boot)"

    sudo systemctl start "${PROJECT_NAME}.service"
    log "Started service"
}

# --- Health check & summary ---------------------------------------------------
health_check() {
    section "Health Check"

    if $DRY_RUN; then
        drylog "Would wait 5s and check service status"
        print_summary
        return
    fi

    log "Waiting for service to initialize..."
    sleep 5

    if sudo systemctl is-active --quiet "${PROJECT_NAME}.service"; then
        log "${PROJECT_NAME} is ${GREEN}active and running${NC}"
        print_summary
    else
        echo ""
        err "${PROJECT_NAME} FAILED TO START"
        echo ""
        echo "Recent journal logs:"
        sudo journalctl -u "${PROJECT_NAME}.service" -n 30 --no-pager
        echo ""
        err "Check the logs above for details."
        exit 1
    fi
}

print_summary() {
    echo ""
    echo -e "${CYAN}${BOLD}====================================================${NC}"
    echo -e "${CYAN}${BOLD}  Installation Complete!${NC}"
    echo -e "${CYAN}${BOLD}====================================================${NC}"
    echo ""
    echo -e "  ${BOLD}Binary:${NC}      /usr/local/bin/${BINARY_NAME}"
    echo -e "  ${BOLD}Config:${NC}      ${INSTALL_DIR}/config.toml"
    echo -e "  ${BOLD}Database:${NC}    ${DATABASE_FILE}"
    echo -e "  ${BOLD}Jobs:${NC}        ${JOBS_DIRECTORY}"
    echo -e "  ${BOLD}Static:${NC}      ${INSTALL_DIR}/static/"
    echo -e "  ${BOLD}Logs:${NC}        ${LOG_FILE}"
    echo -e "  ${BOLD}Service:${NC}     ${PROJECT_NAME}.service"
    echo ""
    echo -e "  ${BOLD}Web UI:${NC}      ${GREEN}http://$(hostname -I 2>/dev/null | awk '{print $1}' || echo 'localhost'):${WEB_PORT}/${NC}"
    echo ""
    echo -e "  ${BOLD}Default login:${NC}  admin / admin"
    echo -e "  ${RED}${BOLD}  !! CHANGE THE DEFAULT PASSWORD IMMEDIATELY !!${NC}"
    echo ""
    echo -e "  ${DIM}View logs:     sudo journalctl -fu ${PROJECT_NAME}.service${NC}"
    echo -e "  ${DIM}Stop service:  sudo systemctl stop ${PROJECT_NAME}.service${NC}"
    echo -e "  ${DIM}Edit config:   sudo nano ${INSTALL_DIR}/config.toml${NC}"
    echo ""
}

# =============================================================================
# Main
# =============================================================================
main() {
    banner
    preflight
    collect_config
    validate
    check_existing
    confirm
    build_binary
    stop_service
    create_user
    create_directories
    generate_config
    generate_service
    copy_files
    set_permissions
    start_service
    health_check
}

main "$@"
