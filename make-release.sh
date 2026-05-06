#!/usr/bin/env bash
# =============================================================================
# M-Star Queue Manager — Release Packaging Script
# =============================================================================
# Builds a self-contained tarball for distribution.
#
# Usage:
#   ./make-release.sh               Build release and package tarball
#   ./make-release.sh --skip-build  Package without rebuilding (use existing binary)
#
# Output:
#   mstar-queue-<version>-linux-x86_64.tar.gz
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_NAME="mstar_queue"
BINARY_NAME="mstar_queue"

# Parse version from Cargo.toml
VERSION="$(grep -m1 '^version' "${SCRIPT_DIR}/Cargo.toml" | sed 's/.*"\(.*\)".*/\1/')"
ARCH="$(uname -m)"
RELEASE_NAME="mstar-queue-${VERSION}-linux-${ARCH}"

SKIP_BUILD=false
for arg in "$@"; do
    case "$arg" in
        --skip-build) SKIP_BUILD=true ;;
        --help|-h)
            head -n 12 "$0" | tail -n +3 | sed 's/^# \?//'
            exit 0
            ;;
    esac
done

echo ""
echo "======================================================"
echo "  M-Star Queue — Release Builder (v${VERSION})"
echo "======================================================"
echo ""

# --- Build --------------------------------------------------------------------
if ! $SKIP_BUILD; then
    echo "[BUILD] Building release binary..."
    (cd "${SCRIPT_DIR}" && cargo build --release)

    BINARY_PATH="${SCRIPT_DIR}/target/release/${BINARY_NAME}"
    if [ ! -f "${BINARY_PATH}" ]; then
        echo "[ERROR] Build failed — binary not found at ${BINARY_PATH}"
        exit 1
    fi
    echo "[BUILD] ✓ Binary built: ${BINARY_PATH}"
    echo "[BUILD]   Size: $(du -h "${BINARY_PATH}" | cut -f1)"
else
    BINARY_PATH="${SCRIPT_DIR}/target/release/${BINARY_NAME}"
    if [ ! -f "${BINARY_PATH}" ]; then
        echo "[ERROR] No binary found at ${BINARY_PATH}. Run without --skip-build first."
        exit 1
    fi
    echo "[BUILD] Using existing binary: ${BINARY_PATH}"
fi

# --- Stage files --------------------------------------------------------------
STAGING_DIR="${SCRIPT_DIR}/target/${RELEASE_NAME}"
echo ""
echo "[PACKAGE] Staging release in: ${STAGING_DIR}"

rm -rf "${STAGING_DIR}"
mkdir -p "${STAGING_DIR}"

# Copy binary
cp "${BINARY_PATH}" "${STAGING_DIR}/${BINARY_NAME}"
chmod +x "${STAGING_DIR}/${BINARY_NAME}"
echo "[PACKAGE]   ✓ Binary"

# Copy installer
cp "${SCRIPT_DIR}/install.sh" "${STAGING_DIR}/install.sh"
chmod +x "${STAGING_DIR}/install.sh"
echo "[PACKAGE]   ✓ install.sh"

# Copy Cargo.toml (for version detection in install.sh)
cp "${SCRIPT_DIR}/Cargo.toml" "${STAGING_DIR}/Cargo.toml"
echo "[PACKAGE]   ✓ Cargo.toml (version metadata)"

# Copy static web files
cp -r "${SCRIPT_DIR}/static" "${STAGING_DIR}/static"
echo "[PACKAGE]   ✓ static/ (web UI)"

# Copy unpack_msb.py
cp "${SCRIPT_DIR}/unpack_msb.py" "${STAGING_DIR}/unpack_msb.py"
echo "[PACKAGE]   ✓ unpack_msb.py"

# Copy logrotate config
cp "${SCRIPT_DIR}/mstar_queue.logrotate" "${STAGING_DIR}/mstar_queue.logrotate"
echo "[PACKAGE]   ✓ mstar_queue.logrotate"

# Copy M-Star management scripts
if [ -d "${SCRIPT_DIR}/scripts" ]; then
    cp -r "${SCRIPT_DIR}/scripts" "${STAGING_DIR}/scripts"
    echo "[PACKAGE]   ✓ scripts/ (M-Star management)"
fi

# Copy README
cp "${SCRIPT_DIR}/README.md" "${STAGING_DIR}/README.md"
echo "[PACKAGE]   ✓ README.md"

# --- Create tarball -----------------------------------------------------------
echo ""
TARBALL="${SCRIPT_DIR}/target/${RELEASE_NAME}.tar.gz"
echo "[PACKAGE] Creating tarball..."
(cd "${SCRIPT_DIR}/target" && tar -czf "${RELEASE_NAME}.tar.gz" "${RELEASE_NAME}/")

TARBALL_SIZE=$(du -h "${TARBALL}" | cut -f1)
echo ""
echo "======================================================"
echo "  ✓ Release packaged successfully!"
echo ""
echo "  Tarball:  ${TARBALL}"
echo "  Size:     ${TARBALL_SIZE}"
echo "  Version:  ${VERSION}"
echo "  Arch:     linux-${ARCH}"
echo ""
echo "  Distribution:"
echo "    1. Copy ${RELEASE_NAME}.tar.gz to the target machine"
echo "    2. tar xzf ${RELEASE_NAME}.tar.gz"
echo "    3. cd ${RELEASE_NAME}"
echo "    4. ./install.sh"
echo "======================================================"
echo ""
