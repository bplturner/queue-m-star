#!/usr/bin/env python3
"""
sweep_inspector.py — M-Star Sweep Detection & Export
=====================================================

Uses the M-Star Pre Python API to:
  1. Open an MSB file
  2. Enumerate all parameter sweeps defined in the WorkflowPartition
  3. Optionally export sweep cases as individual MSB files

Usage:
  # Detect sweeps (returns JSON to stdout)
  python3 sweep_inspector.py detect /path/to/file.msb

  # Export a specific sweep's cases
  python3 sweep_inspector.py export /path/to/file.msb <sweep_index> /output/dir

  # Export sweep for queue runner (creates unified sweep directory + manifest)
  python3 sweep_inspector.py export_for_queue /path/to/file.msb <sweep_index> /sweep/root/dir

Environment:
  PYTHONPATH must include the M-Star lib/ directory.
  LD_LIBRARY_PATH must include the M-Star lib/ directory.
  mstar_LICENSE must be set if license is required.

The caller (Rust backend) sets these based on the selected M-Star version.
"""

import json
import os
import sys
import traceback
from contextlib import contextmanager
from datetime import datetime, timezone


@contextmanager
def suppress_native_output():
    """Suppress stdout/stderr from native C/C++ libraries (like M-Star).

    M-Star's BinLDrivers prints diagnostic warnings directly to C-level
    file descriptors, bypassing Python's sys.stdout/stderr. We redirect
    the actual OS file descriptors to /dev/null during M-Star API calls
    so only our clean JSON reaches the Rust backend.
    """
    # Save original file descriptors
    stdout_fd = sys.stdout.fileno()
    stderr_fd = sys.stderr.fileno()
    saved_stdout = os.dup(stdout_fd)
    saved_stderr = os.dup(stderr_fd)

    try:
        devnull = os.open(os.devnull, os.O_WRONLY)
        os.dup2(devnull, stdout_fd)
        os.dup2(devnull, stderr_fd)
        os.close(devnull)
        yield
    finally:
        # Restore original file descriptors
        os.dup2(saved_stdout, stdout_fd)
        os.dup2(saved_stderr, stderr_fd)
        os.close(saved_stdout)
        os.close(saved_stderr)


def setup_mstar_env(mstar_dir):
    """Add M-Star lib to Python/library paths if not already present."""
    lib_dir = os.path.join(mstar_dir, "lib")
    scripts_dir = os.path.join(mstar_dir, "data", "Scripts")

    if lib_dir not in sys.path:
        sys.path.insert(0, lib_dir)
    if scripts_dir not in sys.path:
        sys.path.insert(0, scripts_dir)

    # Also update LD_LIBRARY_PATH for native .so dependencies
    ld_path = os.environ.get("LD_LIBRARY_PATH", "")
    if lib_dir not in ld_path:
        os.environ["LD_LIBRARY_PATH"] = lib_dir + ":" + ld_path


def detect_sweeps(msb_path):
    """
    Open an MSB file and enumerate all parameter sweeps.

    Returns a dict with:
      {
        "sweeps": [
          {
            "index": 0,
            "name": "Resolution Sweep",
            "num_cases": 5,
            "cases": ["LX_75", "LX_100", ...],
            "properties": [
              {"name": "Resolution LX", "values": ["75", "100", ...]}
            ]
          },
          ...
        ],
        "msb_path": "/path/to/file.msb",
        "error": null
      }
    """
    import mstar

    with suppress_native_output():
        mstar.Initialize()

        # Check out the Pre-Processor license — required for MSB loading in
        # non-GUI contexts (e.g. systemd services, headless scripts).
        if not mstar.CheckOutLicense():
            return {"sweeps": [], "msb_path": msb_path, "error": "Failed to check out M-Star Pre-Processor license"}

        try:
            model = mstar.Load(msb_path)
        except Exception as e:
            mstar.CheckInLicense()
            return {"sweeps": [], "msb_path": msb_path, "error": f"Failed to load MSB: {e}"}

        try:
            workflow_part = model.GetWorkFlowPartition()
        except Exception as e:
            mstar.CheckInLicense()
            return {"sweeps": [], "msb_path": msb_path, "error": f"No WorkflowPartition: {e}"}

    sweeps = []
    sweep_index = 0

    with suppress_native_output():
        for sweep_obj in workflow_part.IterateChildren():
            try:
                name = sweep_obj.GetName()
                cases = sweep_obj.GetCaseNames()

                # Extract properties and their values
                properties = []
                for prop in sweep_obj.IterateChildren():
                    try:
                        prop_name = prop.GetName()
                        prop_values = prop.GetStringValues()
                        properties.append({
                            "name": prop_name,
                            "values": list(prop_values),
                        })
                    except Exception:
                        # Some children might not be SweepProperty objects
                        pass

                sweeps.append({
                    "index": sweep_index,
                    "name": name,
                    "num_cases": len(cases),
                    "cases": list(cases),
                    "properties": properties,
                })
                sweep_index += 1

            except Exception as e:
                # Skip malformed sweep objects
                sweeps.append({
                    "index": sweep_index,
                    "name": f"<error: {e}>",
                    "num_cases": 0,
                    "cases": [],
                    "properties": [],
                })
                sweep_index += 1

        mstar.CheckInLicense()

    return {"sweeps": sweeps, "msb_path": msb_path, "error": None}


def export_sweep(msb_path, sweep_index, output_dir):
    """
    Export a specific sweep's cases to individual MSB files.

    Uses the M-Star WorkflowPartition.Export() API which creates
    subdirectories for each case inside output_dir.

    Returns:
      {
        "exported_cases": [
          {"name": "LX_75", "directory": "/output/dir/LX_75", "msb_file": "..."}
        ],
        "errors": [...],
        "error": null
      }
    """
    import mstar

    mstar.Initialize()

    if not mstar.CheckOutLicense():
        return {"exported_cases": [], "errors": [], "error": "Failed to check out M-Star Pre-Processor license"}

    try:
        model = mstar.Load(msb_path)
    except Exception as e:
        mstar.CheckInLicense()
        return {"exported_cases": [], "errors": [], "error": f"Failed to load MSB: {e}"}

    try:
        workflow_part = model.GetWorkFlowPartition()
    except Exception as e:
        mstar.CheckInLicense()
        return {"exported_cases": [], "errors": [], "error": f"No WorkflowPartition: {e}"}

    # Find the target sweep by index
    target_sweep = None
    idx = 0
    for sweep_obj in workflow_part.IterateChildren():
        if idx == sweep_index:
            target_sweep = sweep_obj
            break
        idx += 1

    if target_sweep is None:
        return {
            "exported_cases": [],
            "errors": [],
            "error": f"Sweep index {sweep_index} not found (only {idx} sweeps exist)",
        }

    # Get case names before export
    case_names = list(target_sweep.GetCaseNames())

    # Ensure output directory exists
    os.makedirs(output_dir, exist_ok=True)

    # Must save the model before exporting (M-Star requirement)
    # Save to a temp location to avoid modifying the original
    import tempfile
    with tempfile.NamedTemporaryFile(suffix=".msb", delete=False) as tmp:
        tmp_path = tmp.name

    try:
        model.Save(tmp_path)

        # Export creates subdirectories under output_dir
        export_errors = target_sweep.Export(output_dir)

        # Collect results
        exported_cases = []
        for case_name in case_names:
            case_dir = os.path.join(output_dir, case_name)
            # Find the MSB file in the case directory
            msb_file = None
            if os.path.isdir(case_dir):
                for f in os.listdir(case_dir):
                    if f.lower().endswith(".msb"):
                        msb_file = os.path.join(case_dir, f)
                        break
            exported_cases.append({
                "name": case_name,
                "directory": case_dir,
                "msb_file": msb_file,
                "exists": os.path.isdir(case_dir),
            })

        errors = []
        if export_errors:
            for err in export_errors:
                errors.append({
                    "message": getattr(err, "Message", str(err)),
                    "object_name": getattr(err, "ObjectName", ""),
                    "level": str(getattr(err, "Level", "")),
                })

        return {
            "exported_cases": exported_cases,
            "errors": errors,
            "error": None,
        }

    finally:
        mstar.CheckInLicense()
        # Clean up temp file
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


def export_for_queue(msb_path, sweep_index, sweep_root_dir):
    """
    Export a sweep into a unified directory suitable for the queue runner.

    Creates:
      sweep_root_dir/
      ├── sweep_manifest.json   (provenance + case mapping)
      ├── CaseName1/
      │   └── *.msb             (case-specific MSB from M-Star Export)
      ├── CaseName2/
      │   └── *.msb
      └── ...

    Each case subdirectory becomes a job's working_directory.
    The sweep_root_dir itself IS the training dataset.

    Returns:
      {
        "sweep_root": "/path/to/sweep_root_dir",
        "manifest": { ... },
        "cases": [
          {"name": "RPM_40.0", "directory": "...", "msb_file": "..."},
          ...
        ],
        "error": null
      }
    """
    import mstar

    with suppress_native_output():
        mstar.Initialize()

        if not mstar.CheckOutLicense():
            return {"sweep_root": sweep_root_dir, "cases": [], "error": "Failed to check out M-Star Pre-Processor license"}

        try:
            model = mstar.Load(msb_path)
        except Exception as e:
            mstar.CheckInLicense()
            return {"sweep_root": sweep_root_dir, "cases": [], "error": f"Failed to load MSB: {e}"}

        try:
            workflow_part = model.GetWorkFlowPartition()
        except Exception as e:
            mstar.CheckInLicense()
            return {"sweep_root": sweep_root_dir, "cases": [], "error": f"No WorkflowPartition: {e}"}

    # Find the target sweep by index
    target_sweep = None
    sweep_name = "Sweep"
    sweep_properties = []
    idx = 0

    with suppress_native_output():
        for sweep_obj in workflow_part.IterateChildren():
            if idx == sweep_index:
                target_sweep = sweep_obj
                try:
                    sweep_name = sweep_obj.GetName()
                except Exception:
                    pass
                # Extract properties
                for prop in sweep_obj.IterateChildren():
                    try:
                        prop_name = prop.GetName()
                        prop_values = list(prop.GetStringValues())
                        sweep_properties.append({"name": prop_name, "values": prop_values})
                    except Exception:
                        pass
                break
            idx += 1

    if target_sweep is None:
        with suppress_native_output():
            mstar.CheckInLicense()
        return {
            "sweep_root": sweep_root_dir,
            "cases": [],
            "error": f"Sweep index {sweep_index} not found (only {idx} sweeps exist)",
        }

    with suppress_native_output():
        case_names = list(target_sweep.GetCaseNames())

    # Create the sweep root directory
    os.makedirs(sweep_root_dir, exist_ok=True)

    # Must save the model before exporting (M-Star requirement)
    import tempfile
    with tempfile.NamedTemporaryFile(suffix=".msb", delete=False) as tmp:
        tmp_path = tmp.name

    try:
        with suppress_native_output():
            model.Save(tmp_path)
            export_errors = target_sweep.Export(sweep_root_dir)
            mstar.CheckInLicense()

        # Collect exported case info
        cases = []
        for case_name in case_names:
            case_dir = os.path.join(sweep_root_dir, case_name)
            msb_file = None
            if os.path.isdir(case_dir):
                for f in os.listdir(case_dir):
                    if f.lower().endswith(".msb"):
                        msb_file = os.path.join(case_dir, f)
                        break
            cases.append({
                "name": case_name,
                "directory": case_dir,
                "msb_file": msb_file,
                "exists": os.path.isdir(case_dir),
            })

        # Build and write the sweep manifest
        manifest = {
            "sweep_name": sweep_name,
            "source_msb": os.path.abspath(msb_path),
            "sweep_index": sweep_index,
            "mstar_version": os.environ.get("MSTAR_VERSION", "unknown"),
            "exported_at": datetime.now(timezone.utc).isoformat(),
            "num_cases": len(case_names),
            "cases": cases,
            "parameters": sweep_properties,
            "export_errors": [
                {"message": getattr(e, "Message", str(e))}
                for e in (export_errors or [])
            ],
        }

        manifest_path = os.path.join(sweep_root_dir, "sweep_manifest.json")
        with open(manifest_path, "w") as f:
            json.dump(manifest, f, indent=2)

        return {
            "sweep_root": sweep_root_dir,
            "manifest": manifest,
            "cases": cases,
            "error": None,
        }

    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


def main():
    if len(sys.argv) < 3:
        print(json.dumps({
            "error": "Usage: sweep_inspector.py <detect|export> <msb_path> [sweep_index] [output_dir]"
        }))
        sys.exit(1)

    command = sys.argv[1]
    msb_path = os.path.abspath(sys.argv[2])

    # Optional: M-Star directory passed as env var
    mstar_dir = os.environ.get("MSTAR_DIR", "")
    if mstar_dir:
        setup_mstar_env(mstar_dir)

    if not os.path.isfile(msb_path):
        print(json.dumps({"error": f"MSB file not found: {msb_path}"}))
        sys.exit(1)

    try:
        if command == "detect":
            result = detect_sweeps(msb_path)
            print(json.dumps(result, indent=2))

        elif command == "export":
            if len(sys.argv) < 5:
                print(json.dumps({
                    "error": "Usage: sweep_inspector.py export <msb_path> <sweep_index> <output_dir>"
                }))
                sys.exit(1)

            sweep_index = int(sys.argv[3])
            output_dir = os.path.abspath(sys.argv[4])
            result = export_sweep(msb_path, sweep_index, output_dir)
            print(json.dumps(result, indent=2))

        elif command == "export_for_queue":
            if len(sys.argv) < 5:
                print(json.dumps({
                    "error": "Usage: sweep_inspector.py export_for_queue <msb_path> <sweep_index> <sweep_root_dir>"
                }))
                sys.exit(1)

            sweep_index = int(sys.argv[3])
            sweep_root_dir = os.path.abspath(sys.argv[4])
            result = export_for_queue(msb_path, sweep_index, sweep_root_dir)
            print(json.dumps(result, indent=2))

        else:
            print(json.dumps({"error": f"Unknown command: {command}. Use 'detect', 'export', or 'export_for_queue'."}))
            sys.exit(1)

    except Exception as e:
        print(json.dumps({
            "error": f"Unexpected error: {e}",
            "traceback": traceback.format_exc(),
        }))
        sys.exit(1)


if __name__ == "__main__":
    main()
