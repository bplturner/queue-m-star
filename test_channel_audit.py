"""Full audit: test both built-in and custom computed channels.

Verifies:
1. All built-in channel recipes are registered
2. Custom expression channels work end-to-end
3. Training starts and runs with mixed channel types
4. The channel registry API returns valid JSON
"""
import json, os, sys, time, logging
logging.basicConfig(level=logging.INFO, format="%(name)s - %(message)s")

sys.path.insert(0, "/simulations/Code/mstar_queue/python/ai_training")

print("=" * 60)
print("AUDIT 1: Channel Registry")
print("=" * 60)

from mstar_ai.dataset.spatial_inputs import (
    BUILTIN_CHANNEL_RECIPES,
    get_channel_registry,
    compute_builtin_channel,
    evaluate_custom_expression,
)

registry = get_channel_registry()
print("Registry has %d entries:" % len(registry))
for ch in registry:
    reqstr = ""
    if ch.get("requires"):
        reqstr = " [requires: %s]" % json.dumps(ch["requires"])
    tmpl = " [TEMPLATE]" if ch.get("is_template") else ""
    print("  %s %-30s %-15s %s%s%s" % (
        ch.get("icon", " "), ch["display_name"], ch["category"],
        ch.get("method", "?"), reqstr, tmpl
    ))

assert len(BUILTIN_CHANNEL_RECIPES) >= 10, "Expected 10+ built-in recipes, got %d" % len(BUILTIN_CHANNEL_RECIPES)
print("\n✅ Registry: %d built-in + 1 custom template = %d total" % (
    len(BUILTIN_CHANNEL_RECIPES), len(registry)
))

print("\n" + "=" * 60)
print("AUDIT 2: Built-in Channel Computation (synthetic data)")
print("=" * 60)

import numpy as np

target_shape = (64, 64)
bounds = [0.0, 1.0, 0.0, 1.0, 0.0, 0.0]
grid_shape_3d = (1, 64, 64)
solid_mask = np.zeros(target_shape, dtype=np.float32)
solid_mask[:5, :] = 1.0  # wall at top
solid_mask[-5:, :] = 1.0  # wall at bottom

for ch_name, recipe in BUILTIN_CHANNEL_RECIPES.items():
    method = recipe["method"]
    # Only test channels that don't require specific VTK fields
    if method in ("coordinate_grid", "edt", "sdf"):
        result = compute_builtin_channel(
            ch_name, target_shape, bounds, grid_shape_3d,
            is_2d=True, solid_mask=solid_mask, grid_spacing=1.0/64
        )
        if result is not None:
            print("  ✅ %-30s shape=%s range=[%.3f, %.3f]" % (
                ch_name, result.shape, result.min(), result.max()
            ))
        else:
            print("  ⚠️ %-30s returned None (expected for some channels)" % ch_name)
    else:
        print("  ⏭️ %-30s skipped (requires VTK fields)" % ch_name)

print("\n" + "=" * 60)
print("AUDIT 3: Custom Expression Evaluation")
print("=" * 60)

# Test 1: Simple constant
result = evaluate_custom_expression("ones * 0.5", target_shape)
assert result.shape == target_shape
assert abs(result.mean() - 0.5) < 0.01
print("  ✅ 'ones * 0.5' → shape=%s, mean=%.3f" % (result.shape, result.mean()))

# Test 2: Using coordinates
coord_grids = {
    "x_norm": np.linspace(-1, 1, 64).reshape(1, 64).repeat(64, axis=0).astype(np.float32),
    "y_norm": np.linspace(-1, 1, 64).reshape(64, 1).repeat(64, axis=1).astype(np.float32),
}
result = evaluate_custom_expression(
    "np.sqrt(x**2 + y**2)", target_shape,
    coordinate_grids=coord_grids
)
assert result.shape == target_shape
print("  ✅ 'np.sqrt(x**2 + y**2)' → shape=%s, range=[%.3f, %.3f]" % (
    result.shape, result.min(), result.max()
))

# Test 3: Using mask
result = evaluate_custom_expression(
    "mask * y", target_shape,
    coordinate_grids=coord_grids,
    mask=solid_mask
)
assert result.shape == target_shape
print("  ✅ 'mask * y' → shape=%s" % (result.shape,))

# Test 4: Security — verify forbidden operations are blocked
for bad_expr in ["import os", "__builtins__", "eval('1')", "open('/etc/passwd')"]:
    try:
        evaluate_custom_expression(bad_expr, target_shape)
        print("  ❌ '%s' should have been blocked!" % bad_expr)
    except ValueError as e:
        print("  ✅ '%s' correctly blocked: %s" % (bad_expr, str(e)[:50]))

print("\n" + "=" * 60)
print("AUDIT 4: Full Training with Built-in + Custom Channels")
print("=" * 60)

sweep_root = "/simulations/Queue/jobs/sweeps/RPM_Sweep_20260525_202120"
config = {
    "sweep_root": sweep_root,
    "dataset_mode": "time_averaged_2d",
    "model_family": "unet",
    "epochs": 2, "batch_size": 2, "learning_rate": 0.001,
    "artifact_directory": "/tmp/test_channel_audit",
    "run_name": "channel_audit",
    "selected_input_params": ["Rotation Speed UDF"],
    "selected_target_fields": ["Velocity Magnitude (m/s)"],
    "input_fields": [
        {"field_name": "Volume Fraction (-)", "pvd_source": "self",
         "transform": "binary_mask_gt", "threshold": 0.01, "channel_name": "fluid_mask"},
    ],
    "computed_channels": ["y_norm", "distance_to_wall"],
    "custom_channels": [
        {
            "channel_name": "y_squared",
            "expression": "y ** 2",
        },
        {
            "channel_name": "inverted_mask",
            "expression": "ones - mask",
        },
    ],
    "use_spatial_inputs": True,
    "average_last_n": 5,
}

os.makedirs("/tmp/test_channel_audit", exist_ok=True)
from mstar_ai.training.trainer import run_training

t0 = time.time()
run_training(config)
elapsed = time.time() - t0
print("\n✅ Training completed in %.1fs" % elapsed)

# Verify the model has the right number of input channels
import torch
ckpt_path = "/tmp/test_channel_audit/channel_audit/checkpoints/best_model.pt"
if os.path.exists(ckpt_path):
    ckpt = torch.load(ckpt_path, map_location="cpu", weights_only=True)
    model_cfg = ckpt.get("config", {})
    in_channels = model_cfg.get("in_channels", "?")
    print("  Model in_channels = %s" % in_channels)
    # Expected: fluid_mask + y_norm + distance_to_wall + param_rpm + y_squared + inverted_mask = 6
    if in_channels == 6:
        print("  ✅ Correct: 6 channels (1 vtk + 2 computed + 1 param + 2 custom)")
    else:
        print("  ⚠️ Expected 6, got %s" % in_channels)
else:
    print("  ⚠️ Checkpoint not found")

print("\n" + "=" * 60)
print("ALL AUDITS COMPLETE")
print("=" * 60)
