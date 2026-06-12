#!/usr/bin/env python3
"""
Patch PhysicsNeMo 1.3.0 Transolver to not hard-require transformer-engine.

PhysicsNeMo 1.3.0 has an unguarded `import transformer_engine.pytorch as te`
in Physics_Attention.py. This script patches it to use a try/except guard,
matching the pattern already used in transolver.py.

Run after any PhysicsNeMo upgrade:
    python3 scripts/patch_physicsnemo_te.py
"""
import importlib
import sys
import os


def patch():
    try:
        import physicsnemo
    except ImportError:
        print("PhysicsNeMo not installed — nothing to patch")
        return

    pkg_dir = os.path.dirname(physicsnemo.__file__)
    pa_path = os.path.join(pkg_dir, "models", "transolver", "Physics_Attention.py")
    ts_path = os.path.join(pkg_dir, "models", "transolver", "transolver.py")

    patched = 0

    # Patch 1: Physics_Attention.py — unguarded TE import
    if os.path.isfile(pa_path):
        with open(pa_path, "r") as f:
            content = f.read()
        old = "import transformer_engine.pytorch as te  # noqa: F401"
        new = (
            "try:\n"
            "    import transformer_engine.pytorch as te  # noqa: F401\n"
            "except (ImportError, RuntimeError):\n"
            "    te = None  # TE not available — use_te=False path only"
        )
        if old in content and "try:" not in content.split(old)[0][-20:]:
            content = content.replace(old, new, 1)
            with open(pa_path, "w") as f:
                f.write(content)
            print(f"  ✓ Patched {pa_path}")
            patched += 1
        else:
            print(f"  ⊘ {pa_path} already patched or pattern not found")

    # Patch 2: transolver.py — catch RuntimeError from TE meta-package
    if os.path.isfile(ts_path):
        with open(ts_path, "r") as f:
            content = f.read()
        old_except = "except ImportError:\n    TE_AVAILABLE = False"
        new_except = (
            "except (ImportError, RuntimeError):\n"
            "    te = None\n"
            "    TE_AVAILABLE = False"
        )
        if old_except in content:
            content = content.replace(old_except, new_except, 1)
            with open(ts_path, "w") as f:
                f.write(content)
            print(f"  ✓ Patched {ts_path}")
            patched += 1
        else:
            print(f"  ⊘ {ts_path} already patched or pattern not found")

    if patched > 0:
        print(f"\n{patched} file(s) patched. PhysicsNeMo Transolver can now run without transformer-engine.")
    else:
        print("\nNo patches needed — all files already up to date.")


if __name__ == "__main__":
    patch()
