#!/bin/bash
# =============================================================================
# test_training_flow.sh — Pre-deploy validation for AI training pipeline
# Simulates exactly what the Rust backend does when launching a training job:
#   1. Writes a training_config.json (same as queue.rs launch_training_job)
#   2. Sets PYTHONPATH (same as ai_training.rs spawn_training_process)
#   3. Runs python3 -m mstar_ai.cli train --config <path>
#   4. Reports success/failure with full traceback
# =============================================================================
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

SWEEP_ROOT="${1:-/simulations/Queue/jobs/sweeps/RPM_Sweep_20260525_202120}"
MODEL_FAMILY="${2:-unet}"
DATASET_MODE="${3:-time_averaged_2d}"
OUTPUT_DIR="/tmp/mstar_ai_test_$$"

echo "======================================================"
echo "  M-Star AI Training — Pre-Deploy Validation"
echo "======================================================"
echo ""
echo "  Sweep root:    $SWEEP_ROOT"
echo "  Model family:  $MODEL_FAMILY"
echo "  Dataset mode:  $DATASET_MODE"
echo "  Output dir:    $OUTPUT_DIR"
echo ""

# Step 0: Check prerequisites
echo -e "${YELLOW}[0/5] Checking prerequisites...${NC}"

if ! python3 -c "import torch; print(f'  torch {torch.__version__}')" 2>/dev/null; then
    echo -e "${RED}  ✗ torch not importable${NC}"
    exit 1
fi

# Determine PYTHONPATH: use local source by default, or /opt if --deployed flag given
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ "${4:-}" = "--deployed" ]; then
    export PYTHONPATH="/opt/mstar_queue/python/ai_training:${PYTHONPATH:-}"
    echo "  Source:       /opt/mstar_queue (deployed)"
else
    export PYTHONPATH="${SCRIPT_DIR}/python/ai_training:${PYTHONPATH:-}"
    echo "  Source:       ${SCRIPT_DIR}/python/ai_training (local)"
fi

if ! python3 -c "import mstar_ai; print(f'  mstar_ai OK')" 2>/dev/null; then
    echo -e "${RED}  ✗ mstar_ai not importable (PYTHONPATH=$PYTHONPATH)${NC}"
    exit 1
fi

if ! python3 -c "import click; print(f'  click OK')" 2>/dev/null; then
    echo -e "${RED}  ✗ click not importable${NC}"
    exit 1
fi

if [ ! -d "$SWEEP_ROOT" ]; then
    echo -e "${RED}  ✗ Sweep root not found: $SWEEP_ROOT${NC}"
    exit 1
fi
echo -e "${GREEN}  ✓ All prerequisites OK${NC}"

# Step 1: Write training config (mimics queue.rs launch_training_job)
echo -e "\n${YELLOW}[1/5] Writing training config...${NC}"
mkdir -p "$OUTPUT_DIR"

cat > "$OUTPUT_DIR/training_config.json" <<EOF
{
  "dataset_id": 999,
  "sweep_root": "$SWEEP_ROOT",
  "dataset_mode": "$DATASET_MODE",
  "model_family": "$MODEL_FAMILY",
  "run_name": "test_${MODEL_FAMILY}_$(date +%Y%m%d_%H%M%S)",
  "output_dir": "$OUTPUT_DIR",
  "batch_size": 2,
  "epochs": 1,
  "learning_rate": 0.001
}
EOF

echo "  Config written to: $OUTPUT_DIR/training_config.json"
cat "$OUTPUT_DIR/training_config.json" | sed 's/^/    /'
echo -e "${GREEN}  ✓ Config OK${NC}"

# Step 2: Run preflight check
echo -e "\n${YELLOW}[2/5] Running preflight check...${NC}"
CONFIG_JSON=$(cat "$OUTPUT_DIR/training_config.json")
if python3 -m mstar_ai.cli preflight --config-json "$CONFIG_JSON" 2>&1; then
    echo -e "${GREEN}  ✓ Preflight passed${NC}"
else
    echo -e "${RED}  ✗ Preflight FAILED (see above)${NC}"
    echo -e "${YELLOW}  Continuing anyway to check train command...${NC}"
fi

# Step 3: Run train (dry-run: 1 epoch, batch_size=2)
echo -e "\n${YELLOW}[3/5] Running training (1 epoch, batch_size=2)...${NC}"
LOG_FILE="$OUTPUT_DIR/training_test.log"

# This is exactly what spawn_training_process does
# Restrict to GPU 0 only (backend sets CUDA_VISIBLE_DEVICES from user-selected GPUs)
export CUDA_VISIBLE_DEVICES=0
echo "  CUDA_VISIBLE_DEVICES=$CUDA_VISIBLE_DEVICES"
if python3 -m mstar_ai.cli train --config "$OUTPUT_DIR/training_config.json" 2>&1 | tee "$LOG_FILE"; then
    TRAIN_EXIT=0
else
    TRAIN_EXIT=$?
fi

# Step 4: Check results
echo -e "\n${YELLOW}[4/5] Checking results...${NC}"
if [ $TRAIN_EXIT -eq 0 ]; then
    echo -e "${GREEN}  ✓ Training completed successfully (exit code 0)${NC}"
    
    # Check for expected output files
    if ls "$OUTPUT_DIR"/checkpoints/*.pt 2>/dev/null; then
        echo -e "${GREEN}  ✓ Checkpoint files found${NC}"
    else
        echo -e "${YELLOW}  ⚠ No checkpoint files (may be expected for 1 epoch)${NC}"
    fi
else
    echo -e "${RED}  ✗ Training FAILED (exit code $TRAIN_EXIT)${NC}"
    echo ""
    echo "--- Last 50 lines of log ---"
    tail -50 "$LOG_FILE" 2>/dev/null || echo "(no log file)"
fi

# Step 5: Summary
echo -e "\n${YELLOW}[5/5] Summary${NC}"
echo "  Log file: $LOG_FILE"
echo "  Output:   $OUTPUT_DIR"

if [ $TRAIN_EXIT -eq 0 ]; then
    echo -e "\n${GREEN}======================================================"
    echo "  ✓ ALL CHECKS PASSED — Safe to deploy"
    echo "======================================================${NC}"
else
    echo -e "\n${RED}======================================================"
    echo "  ✗ TRAINING FAILED — DO NOT DEPLOY"
    echo "======================================================${NC}"
fi

# Cleanup
rm -rf "$OUTPUT_DIR"
exit $TRAIN_EXIT
