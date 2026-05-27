# AI Training Integration

PhysicsNeMo AI training support for M-Star Queue.

## Overview

The AI Training module extends M-Star Queue with the ability to take output from
M-Star CFD parameter sweeps and train AI surrogate models using
[NVIDIA PhysicsNeMo](https://github.com/NVIDIA/physicsnemo).

### Key Features

- **Sweep discovery** — Parses `sweep.xml` and/or scans case directories to identify
  cases, parameters, and output files.
- **Output discovery** — Detects VTK files (.vti, .vtp, .vtk) and statistics files in
  each case's `out/` directory.
- **Manifest generation** — Creates a versioned, reproducible manifest capturing sweep
  structure, field selections, train/val/test splits, and normalization statistics.
- **Preflight checks** — Validates dependencies, hardware, permissions, and configuration
  before training begins.
- **Dataset conversion** — Converts raw M-Star output (VTI grids, stats tables) into
  ML-ready tensor formats (NPZ, HDF5, Zarr, PyTorch).
- **Model adapters** — FNO (PhysicsNeMo, required), MLP (PyTorch), and GNN
  (MeshGraphNet stub for future development).
- **Training orchestration** — Full training loop with mini-batch training, validation,
  checkpointing, and metrics logging.
- **GPU coordination** — Coordinates GPU allocation between M-Star simulations and AI
  training jobs.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                     M-Star Queue (Rust)                       │
│                                                              │
│  config.rs ─── AiTrainingConfig  (enabled, python, GPUs)     │
│  db.rs     ─── ai_datasets, ai_training_jobs tables          │
│  ai_training.rs ─ GPU coordination, process management       │
│  api.rs    ─── /api/ai/* REST endpoints                      │
│                                                              │
│  ↕ spawns mstar-ai CLI via subprocess                        │
│                                                              │
│  python/ai_training/                                          │
│    mstar_ai/cli.py              (Click CLI)                  │
│    mstar_ai/sweep_discovery.py  (sweep.xml + directory scan) │
│    mstar_ai/output_discovery.py (VTK + stats detection)      │
│    mstar_ai/manifest.py         (versioned manifest)         │
│    mstar_ai/preflight.py        (validation checks)          │
│    mstar_ai/dataset/            (data conversion pipeline)   │
│    mstar_ai/models/             (FNO, MLP, GNN adapters)     │
│    mstar_ai/training/           (trainer, metrics, ckpt)     │
└──────────────────────────────────────────────────────────────┘
```

## Configuration

Add the `[ai_training]` section to your `config.toml`:

```toml
[ai_training]
enabled = true
python_executable = "/path/to/venv/bin/python3"
max_concurrent_training_jobs = 2
gpu_selection_policy = "least_utilized"
default_model_family = "fno"
default_epochs = 100
default_learning_rate = 0.001
```

See `config.toml.example` for all available options.

### Container Mode

For environments using the NVIDIA NGC container:

```toml
[ai_training]
enabled = true
container_mode = true
container_image = "nvcr.io/nvidia/physicsnemo:latest"
```

## Quick Start

### 1. Install the Python package

```bash
cd python/ai_training
pip install -e ".[all]"  # Development install with all optional deps
```

Or for minimal install (CLI + sweep discovery only, no training):

```bash
pip install -e .
```

> **Note:** PhysicsNeMo (`nvidia-physicsnemo>=1.0`) is a required dependency for
> FNO training and is installed automatically with `pip install -e ".[training]"` 
> or `.[all]`.

### 2. Inspect a sweep

```bash
mstar-ai inspect-sweep --sweep-root /path/to/my/sweep
```

With parameter metadata:

```bash
mstar-ai inspect-sweep \
  --sweep-root /path/to/my/sweep \
  --parameters-file parameters.csv
```

### 3. Run preflight checks

```bash
mstar-ai preflight --config training_config.json
```

### 4. Build a training manifest

```bash
mstar-ai build-manifest --config training_config.json --output manifest.json
```

### 5. Convert dataset

```bash
mstar-ai convert-dataset --manifest manifest.json --format npz --output-dir ./cache
```

### 6. Train

```bash
mstar-ai train --config training_config.json
```

## Training Configuration

Training configuration is a JSON file with these fields:

```json
{
  "sweep_root": "/path/to/sweep",
  "dataset_mode": "stats_table",
  "model_family": "mlp",
  "parameters_file": "parameters.csv",
  "target_stats_file": "Forces.txt",
  "target_stats_columns": ["Force_X", "Torque"],
  "batch_size": 8,
  "epochs": 100,
  "learning_rate": 0.001,
  "optimizer": "adam",
  "scheduler": "reduce_on_plateau",
  "artifact_directory": "ai_artifacts",
  "device": "cuda",
  "val_fraction": 0.15,
  "test_fraction": 0.15,
  "random_seed": 42
}
```

### Dataset Modes

| Mode | Description | Input Data |
|------|-------------|------------|
| `stats_table` | Parameter → scalar regression | Tab-separated stats files |
| `time_averaged_2d` | Parameter → 2D field prediction | Time-averaged VTI planes |
| `time_averaged_3d` | Parameter → 3D field prediction | Time-averaged VTI volumes |
| `transient_2d` | Temporal 2D sequences | Time-series VTI planes |
| `transient_3d` | Temporal 3D sequences | Time-series VTI volumes |

### Model Families

| Family | Architecture | Best For | GPU Required |
|--------|-------------|----------|-------------|
| `fno` | Fourier Neural Operator | Structured grid fields | Yes |
| `mlp` | Multi-Layer Perceptron | Scalar regression | No (CPU ok) |
| `gnn` | MeshGraphNet | Unstructured meshes | Yes (future) |

## Parameter Discovery

Since `sweep.xml` only contains case paths and names (not parameter values),
the system uses a three-strategy approach:

1. **User-supplied CSV/JSON** (recommended) — Provide a `parameters.csv` or
   `parameters.json` mapping case names to parameter values.
2. **XML diff auto-detection** — Compare `input.xml` files across cases to
   find elements that vary.
3. **Case index fallback** — Use sequential case index as input when no
   parameters are available.

### Parameter CSV Format

```csv
case_name,rpm,viscosity,fill_level
case_001,100,0.001,0.5
case_002,200,0.001,0.5
```

### Parameter JSON Format

```json
{
  "columns": ["rpm", "viscosity", "fill_level"],
  "cases": {
    "case_001": {"rpm": 100, "viscosity": 0.001, "fill_level": 0.5},
    "case_002": {"rpm": 200, "viscosity": 0.001, "fill_level": 0.5}
  }
}
```

## Security

- **Path validation** — All user-provided paths are validated against `data_root`
  and `allowed_training_roots`.
- **No arbitrary code execution** — Training uses only the `mstar-ai` CLI with
  pre-defined subcommands. Custom Python entrypoints are disabled by default.
- **GPU coordination** — Training GPU reservations are checked against simulation
  reservations to prevent conflicts.

## Testing

```bash
cd python/ai_training
pip install -e ".[dev]"
python -m pytest tests/ -v
```

### Test Markers

```bash
# Run only tests that don't require GPU
python -m pytest tests/ -v -m "not gpu"

# Run only tests that don't require PhysicsNeMo
python -m pytest tests/ -v -m "not physicsnemo"
```

## Development

### Adding a New Model Family

1. Create `mstar_ai/models/your_adapter.py`
2. Implement `BaseModelAdapter` interface
3. Register with `@register("your_family")`
4. Add lazy import in `mstar_ai/models/registry.py`
5. Add tests in `tests/test_models.py`

### Adding a New Dataset Mode

1. Create `mstar_ai/dataset/your_mode.py`
2. Implement `BaseDataset` interface
3. Add mode to `DATASET_MODES` in `mstar_ai/manifest.py`
4. Add conversion support in `mstar_ai/dataset/cache.py`
5. Add tests

## Troubleshooting

### "PhysicsNeMo is required for FNO models"

Install PhysicsNeMo from NVIDIA:

```bash
pip install nvidia-physicsnemo>=1.0
```

PhysicsNeMo is a **required** dependency for FNO model training.
If you only need scalar regression, use `model_family = "mlp"` which
only requires PyTorch.

### "No CUDA GPU available" error

- Ensure NVIDIA drivers are installed: `nvidia-smi`
- Ensure PyTorch CUDA is installed: `python -c "import torch; print(torch.cuda.is_available())"`
- For CPU-only training, use `model_family = "mlp"` and `device = "cpu"`

### "Path is outside allowed directories"

All sweep roots and output directories must be under `data_root` or listed in
`allowed_training_roots` in config.toml.
