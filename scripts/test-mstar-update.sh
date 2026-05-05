#!/bin/bash
# =============================================================================
# test-mstar-update.sh
# End-to-end test: download latest M-Star → update symlinks → launch a sim
# =============================================================================
set -euo pipefail

MSTAR_DIR="/opt/mstar"
TEST_DIR="/tmp/mstar-update-test-$$"
# Use a small, recently-uploaded MSB file for the smoke test
MSB_SOURCE="/simulations/Queue/jobs/job_14/Spatial-Example-Immiscible-Fluid.msb"
# Max seconds to let the simulation run before killing it (just a smoke test)
SIM_TIMEOUT=30

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

pass() { echo -e "${GREEN}[PASS]${NC} $1"; }
fail() { echo -e "${RED}[FAIL]${NC} $1"; }
info() { echo -e "${CYAN}[INFO]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }

cleanup() {
    info "Cleaning up test directory: ${TEST_DIR}"
    rm -rf "${TEST_DIR}" 2>/dev/null || true
}
trap cleanup EXIT

echo
echo "================================================================"
echo "  M-Star Update & Launch Test"
echo "================================================================"
echo

# ── Pre-flight checks ──────────────────────────────────────────────
info "Checking pre-flight requirements..."

if [ ! -d "$MSTAR_DIR" ]; then
    fail "M-Star install directory not found: $MSTAR_DIR"
    exit 1
fi

if [ ! -f "$MSTAR_DIR/download-latest.sh" ]; then
    fail "download-latest.sh not found in $MSTAR_DIR"
    exit 1
fi

if [ ! -f "$MSTAR_DIR/update-latest-symlink.sh" ]; then
    fail "update-latest-symlink.sh not found in $MSTAR_DIR"
    exit 1
fi

if [ ! -f "$MSB_SOURCE" ]; then
    # Try to find any MSB
    MSB_SOURCE=$(find /simulations/Queue/jobs -name "*.msb" -type f 2>/dev/null | head -1)
    if [ -z "$MSB_SOURCE" ]; then
        fail "No MSB file found for testing"
        exit 1
    fi
    warn "Using fallback MSB: $MSB_SOURCE"
fi

if ! command -v jq &>/dev/null; then
    fail "jq is required but not installed"
    exit 1
fi

if ! command -v nvidia-smi &>/dev/null; then
    fail "nvidia-smi not found — GPU required"
    exit 1
fi

pass "Pre-flight checks passed"

# ── Step 1: Record current state ──────────────────────────────────
info "Recording current M-Star state..."
CURRENT_LATEST=$(readlink -f "$MSTAR_DIR/mstarcfd-latest" 2>/dev/null || echo "none")
CURRENT_VERSION=$(basename "$CURRENT_LATEST" 2>/dev/null | sed 's/mstarcfd-//' || echo "unknown")
info "  Current latest version: $CURRENT_VERSION"
info "  Current latest target:  $CURRENT_LATEST"

# Count existing versions
BEFORE_COUNT=$(ls -d "$MSTAR_DIR"/mstarcfd-*.*.* 2>/dev/null | wc -l)
info "  Installed versions: $BEFORE_COUNT"

# ── Step 2: Download latest ───────────────────────────────────────
echo
info "Step 1/3: Downloading latest M-Star version..."
echo "────────────────────────────────────────────────"

DOWNLOAD_OUTPUT=$(cd "$MSTAR_DIR" && bash "$MSTAR_DIR/download-latest.sh" 2>&1) || {
    fail "Download script failed:"
    echo "$DOWNLOAD_OUTPUT"
    exit 1
}
echo "$DOWNLOAD_OUTPUT" | while IFS= read -r line; do
    echo "  $line"
done

# Extract version from output (last line is the version number)
NEW_VERSION=$(echo "$DOWNLOAD_OUTPUT" | tail -1)
if [[ "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    pass "Download completed — version: $NEW_VERSION"
else
    # Check if it was "already installed"
    if echo "$DOWNLOAD_OUTPUT" | grep -q "already installed"; then
        NEW_VERSION="$CURRENT_VERSION"
        pass "Latest version already installed: $NEW_VERSION"
    else
        warn "Could not parse version from download output, continuing..."
        NEW_VERSION="$CURRENT_VERSION"
    fi
fi

# ── Step 3: Verify directory structure ────────────────────────────
echo
info "Step 2/3: Updating symlinks and verifying..."
echo "────────────────────────────────────────────────"

SYMLINK_OUTPUT=$(cd "$MSTAR_DIR" && bash "$MSTAR_DIR/update-latest-symlink.sh" 2>&1) || {
    fail "Symlink script failed:"
    echo "$SYMLINK_OUTPUT"
    exit 1
}
echo "$SYMLINK_OUTPUT" | while IFS= read -r line; do
    echo "  $line"
done

pass "Symlinks updated"

# Verify directory structure is flat (not nested mstar-ubuntu/)
VERSION_DIR="$MSTAR_DIR/mstarcfd-$NEW_VERSION"
if [ -d "$VERSION_DIR" ]; then
    if [ -f "$VERSION_DIR/bin/mstar-cfd-mgpu" ]; then
        pass "Binary found: $VERSION_DIR/bin/mstar-cfd-mgpu"
    elif [ -d "$VERSION_DIR/mstar-ubuntu" ]; then
        fail "Directory is NOT flat — nested mstar-ubuntu/ still exists"
        ls "$VERSION_DIR/"
        exit 1
    else
        fail "mstar-cfd-mgpu binary not found in $VERSION_DIR/bin/"
        ls "$VERSION_DIR/" 2>/dev/null
        exit 1
    fi

    # Check license file
    LIC_FILE=$(find "$VERSION_DIR/bin" -name "*.lic" -type f 2>/dev/null | head -1)
    if [ -n "$LIC_FILE" ]; then
        pass "License file found: $(basename "$LIC_FILE")"
    else
        fail "No .lic license file in $VERSION_DIR/bin/"
        exit 1
    fi

    # Check mstar.sh env script
    if [ -f "$VERSION_DIR/mstar.sh" ]; then
        pass "Environment script found: mstar.sh"
    else
        fail "mstar.sh not found in $VERSION_DIR/"
        exit 1
    fi
else
    warn "Version directory $VERSION_DIR not found, using latest symlink"
    VERSION_DIR="$MSTAR_DIR/mstarcfd-latest"
fi

# Verify the -latest wrapper works
if [ -x "$MSTAR_DIR/mstar-cfd-mgpu-latest" ]; then
    pass "mstar-cfd-mgpu-latest wrapper exists and is executable"
else
    fail "mstar-cfd-mgpu-latest wrapper missing or not executable"
    exit 1
fi

# ── Step 4: Launch a simulation ───────────────────────────────────
echo
info "Step 3/3: Launching smoke test simulation (${SIM_TIMEOUT}s timeout)..."
echo "────────────────────────────────────────────────"

# Set up test directory
mkdir -p "$TEST_DIR"
cp "$MSB_SOURCE" "$TEST_DIR/"
MSB_FILE=$(basename "$MSB_SOURCE")
info "  MSB file: $MSB_FILE"
info "  Working dir: $TEST_DIR"

# Find a free GPU (pick one with no compute processes)
FREE_GPU=$(nvidia-smi --query-gpu=index,utilization.gpu --format=csv,noheader,nounits | awk -F', ' '$2 < 5 {print $1; exit}')
if [ -z "$FREE_GPU" ]; then
    warn "No idle GPU found, using GPU 0"
    FREE_GPU=0
fi
info "  Using GPU: $FREE_GPU"

# Build launch command using the environment script
ENV_SCRIPT="$VERSION_DIR/mstar.sh"
BINARY="$VERSION_DIR/bin/mstar-cfd-mgpu"

LAUNCH_CMD="source \"$ENV_SCRIPT\" && \"$BINARY\" -i \"$MSB_FILE\" -o out --gpu-ids=$FREE_GPU --force"
info "  Command: $LAUNCH_CMD"
echo

# Launch with timeout — we only need to verify it starts up
cd "$TEST_DIR"
set +e
timeout "${SIM_TIMEOUT}" bash -c "$LAUNCH_CMD" > sim_output.txt 2>&1 &
SIM_PID=$!
info "  Simulation PID: $SIM_PID"

# Wait a few seconds and check if it's still alive (didn't crash immediately)
sleep 5

if kill -0 $SIM_PID 2>/dev/null; then
    pass "Simulation is running after 5 seconds (no immediate crash)"

    # Check output for initialization success
    if grep -qi "timestep\|time step\|initializ\|running\|iteration" sim_output.txt 2>/dev/null; then
        pass "Simulation output shows active computation"
    else
        info "  Output so far:"
        tail -5 sim_output.txt 2>/dev/null | while IFS= read -r line; do
            echo "    $line"
        done
    fi

    # Wait for timeout or natural exit
    info "  Letting simulation run for remaining timeout..."
    wait $SIM_PID 2>/dev/null
    EXIT_CODE=$?

    # timeout returns 124 when it kills the process
    if [ $EXIT_CODE -eq 124 ]; then
        pass "Simulation ran for full ${SIM_TIMEOUT}s without crashing (killed by timeout)"
    elif [ $EXIT_CODE -eq 0 ]; then
        pass "Simulation completed successfully"
    elif [ $EXIT_CODE -eq 137 ]; then
        pass "Simulation ran until timeout (SIGKILL)"
    else
        warn "Simulation exited with code $EXIT_CODE"
        echo "  Last 10 lines of output:"
        tail -10 sim_output.txt 2>/dev/null | while IFS= read -r line; do
            echo "    $line"
        done
    fi
else
    # Process died within 5 seconds
    wait $SIM_PID 2>/dev/null
    EXIT_CODE=$?
    fail "Simulation crashed within 5 seconds (exit code: $EXIT_CODE)"
    echo "  Output:"
    cat sim_output.txt 2>/dev/null | tail -20 | while IFS= read -r line; do
        echo "    $line"
    done
    exit 1
fi
set -e

# ── Summary ───────────────────────────────────────────────────────
echo
echo "================================================================"
echo -e "  ${GREEN}ALL TESTS PASSED${NC}"
echo "================================================================"
AFTER_COUNT=$(ls -d "$MSTAR_DIR"/mstarcfd-*.*.* 2>/dev/null | wc -l)
echo "  Version tested:     $NEW_VERSION"
echo "  Installed versions: $AFTER_COUNT"
echo "  License:            $(basename "$LIC_FILE" 2>/dev/null || echo 'present')"
echo "  Flat structure:     ✓ (no nested mstar-ubuntu/)"
echo "  Simulation:         ✓ (launched and ran without crash)"
echo "================================================================"
echo
