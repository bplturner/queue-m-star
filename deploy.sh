#!/usr/bin/env bash
# =============================================================================
# M-Star Queue — Fast Deploy
# =============================================================================
# Builds, stops, deploys, and restarts the service in one command.
#
# Usage:
#   ./deploy.sh              Build and deploy
#   ./deploy.sh --skip-build Deploy without rebuilding (use existing binary)
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BINARY_NAME="mstar_queue"
SERVICE_NAME="mstar_queue.service"
INSTALL_DIR="/opt/mstar_queue"

SKIP_BUILD=false
for arg in "$@"; do
    case "$arg" in
        --skip-build) SKIP_BUILD=true ;;
        --help|-h)
            head -n 10 "$0" | tail -n +3 | sed 's/^# \?//'
            exit 0
            ;;
    esac
done

echo ""
echo "======================================================"
echo "  M-Star Queue — Deploy"
echo "======================================================"
echo ""

# --- Build -------------------------------------------------------------------
if ! $SKIP_BUILD; then
    echo "[1/6] Building release binary..."
    (cd "${SCRIPT_DIR}" && cargo build --release)
    echo "      ✓ Build complete"
else
    echo "[1/6] Skipping build (--skip-build)"
fi

BINARY="${SCRIPT_DIR}/target/release/${BINARY_NAME}"
if [ ! -f "${BINARY}" ]; then
    echo "ERROR: Binary not found at ${BINARY}"
    exit 1
fi

# --- Stop --------------------------------------------------------------------
echo "[2/6] Stopping service..."
sudo systemctl stop "${SERVICE_NAME}" 2>/dev/null && echo "      ✓ Service stopped" \
    || echo "      ⚠ Service was not running"

# Brief pause to ensure the binary file handle is released
sleep 1

# --- Deploy binary -----------------------------------------------------------
echo "[3/6] Installing binary..."
sudo cp "${BINARY}" "/usr/local/bin/${BINARY_NAME}"
sudo chmod +x "/usr/local/bin/${BINARY_NAME}"
echo "      ✓ /usr/local/bin/${BINARY_NAME}"

# --- Deploy service + config files -------------------------------------------
echo "[4/6] Installing service files..."
sudo cp "${SCRIPT_DIR}/mstar_queue.service" "/etc/systemd/system/${SERVICE_NAME}"
sudo chmod 644 "/etc/systemd/system/${SERVICE_NAME}"
echo "      ✓ systemd service"

if [ -f "${SCRIPT_DIR}/mstar_queue.logrotate" ]; then
    sudo cp "${SCRIPT_DIR}/mstar_queue.logrotate" "/etc/logrotate.d/${BINARY_NAME}"
    sudo chmod 644 "/etc/logrotate.d/${BINARY_NAME}"
    echo "      ✓ logrotate config"
fi

# --- Deploy static files & scripts ------------------------------------------
echo "[5/6] Installing static files..."
sudo cp -r "${SCRIPT_DIR}/static/"* "${INSTALL_DIR}/static/"
sudo cp "${SCRIPT_DIR}/unpack_msb.py" "${INSTALL_DIR}/unpack_msb.py"
sudo chmod +x "${INSTALL_DIR}/unpack_msb.py"
sudo chown -R mstar_user:mstar_user "${INSTALL_DIR}"
echo "      ✓ static/ and unpack_msb.py"

# --- Start -------------------------------------------------------------------
echo "[6/6] Starting service..."
sudo systemctl daemon-reload
sudo systemctl start "${SERVICE_NAME}"
sleep 5

if sudo systemctl is-active --quiet "${SERVICE_NAME}"; then
    echo "      ✓ Service is running"
    echo ""
    echo "======================================================"
    echo "  ✓ Deploy complete!"
    echo "  Web UI: http://$(hostname -I 2>/dev/null | awk '{print $1}'):1111/"
    echo "  Logs:   sudo journalctl -fu ${SERVICE_NAME}"
    echo "======================================================"
else
    echo "      ✗ Service FAILED to start"
    echo ""
    sudo journalctl -u "${SERVICE_NAME}" -n 20 --no-pager
    exit 1
fi
