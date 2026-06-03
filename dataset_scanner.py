#!/usr/bin/env python3
"""
dataset_scanner.py — Scan M-Star simulation output for training data inventory.

Scans a sweep directory to catalog ALL available data:
  1. Stats files (out/Stats/*.txt) — columns, row counts, time ranges, sampling dt
  2. PVD-indexed outputs (out/Output/*.pvd) — 2D slices, 3D volumes, fields
  3. VTI/VTP probing — grid dimensions, field names, component counts
  4. Cross-case validation — consistency checks, training readiness scoring

Usage:
  python3 dataset_scanner.py scan /path/to/sweep_root
  python3 dataset_scanner.py scan_case /path/to/case_dir

Returns JSON to stdout. Called by the Rust backend.
"""

import json
import os
import sys
import xml.etree.ElementTree as ET
from typing import Any, Dict, List, Optional


# ---------------------------------------------------------------------------
# Stats scanning
# ---------------------------------------------------------------------------

def scan_stats_dir(stats_dir: str) -> List[Dict[str, Any]]:
    """Scan out/Stats/ for tab-delimited .txt files.

    Returns a list of dicts, one per file:
      {filename, columns: [{name, unit}], num_rows, time_range: [min, max],
       sampling_dt, is_uniform_dt, file_size_bytes}
    """
    results = []
    if not os.path.isdir(stats_dir):
        return results

    for fname in sorted(os.listdir(stats_dir)):
        if not fname.lower().endswith(".txt"):
            continue
        fpath = os.path.join(stats_dir, fname)
        if not os.path.isfile(fpath):
            continue

        try:
            info = _parse_stats_file(fpath, fname)
            if info:
                results.append(info)
        except Exception as e:
            results.append({
                "filename": fname,
                "error": str(e),
                "columns": [],
                "num_rows": 0,
            })

    return results


def _parse_stats_file(fpath: str, fname: str) -> Optional[Dict[str, Any]]:
    """Parse a single tab-delimited stats file header and row count."""
    file_size = os.path.getsize(fpath)

    with open(fpath, "r", encoding="utf-8", errors="replace") as f:
        header_line = f.readline().rstrip("\n")
        if not header_line:
            return None

        # Parse column names — tab-separated, often with units in brackets
        raw_cols = header_line.split("\t")
        columns = []
        for col in raw_cols:
            col = col.strip()
            if not col:
                continue
            # Try to extract unit from brackets: "Kinetic Energy [J]" -> name="Kinetic Energy", unit="J"
            name, unit = _parse_column_name(col)
            columns.append({"name": name, "unit": unit, "raw": col})

        if not columns:
            return None

        # Count data rows and extract time range + sampling dt
        num_rows = 0
        first_time = None
        last_time = None
        prev_time = None
        dt_values = []  # Collect first N dt values for uniformity check
        max_dt_samples = 20

        for line in f:
            line = line.strip()
            if not line:
                continue
            num_rows += 1
            # Extract first column (Time) for time range
            parts = line.split("\t", 1)
            if parts:
                try:
                    t = float(parts[0])
                    if first_time is None:
                        first_time = t
                    last_time = t
                    # Compute dt
                    if prev_time is not None and len(dt_values) < max_dt_samples:
                        dt = t - prev_time
                        if dt > 0:
                            dt_values.append(dt)
                    prev_time = t
                except (ValueError, IndexError):
                    pass

    time_range = None
    if first_time is not None and last_time is not None:
        time_range = [first_time, last_time]

    # Determine sampling dt and uniformity
    sampling_dt = None
    is_uniform_dt = None
    if dt_values:
        sampling_dt = dt_values[0]
        if len(dt_values) >= 3:
            # Check uniformity — all dt values within 1% of each other
            avg_dt = sum(dt_values) / len(dt_values)
            if avg_dt > 0:
                max_deviation = max(abs(dt - avg_dt) / avg_dt for dt in dt_values)
                is_uniform_dt = max_deviation < 0.01
                sampling_dt = avg_dt

    return {
        "filename": fname,
        "columns": columns,
        "num_columns": len(columns),
        "num_rows": num_rows,
        "time_range": time_range,
        "sampling_dt": sampling_dt,
        "is_uniform_dt": is_uniform_dt,
        "file_size_bytes": file_size,
    }


def _parse_column_name(raw: str) -> tuple:
    """Extract name and unit from 'Column Name [unit]' format."""
    raw = raw.strip()
    if raw.endswith("]") and "[" in raw:
        idx = raw.rindex("[")
        name = raw[:idx].strip()
        unit = raw[idx + 1 : -1].strip()
        return name, unit
    elif raw.endswith(")") and "(" in raw:
        idx = raw.rindex("(")
        name = raw[:idx].strip()
        unit = raw[idx + 1 : -1].strip()
        return name, unit
    return raw, ""


# ---------------------------------------------------------------------------
# PVD / VTK scanning
# ---------------------------------------------------------------------------

def scan_output_dir(output_dir: str) -> Dict[str, Any]:
    """Scan out/Output/ for .pvd files and their VTK data.

    Returns:
      {
        slices_2d: [...],
        slices_body: [...],
        volumes_3d: [...],
        boundary_conditions: [...],
        other: [...]
      }
    """
    result = {
        "slices_2d": [],
        "slices_body": [],
        "volumes_3d": [],
        "boundary_conditions": [],
        "other": [],
    }

    if not os.path.isdir(output_dir):
        return result

    pvd_files = sorted(
        f for f in os.listdir(output_dir)
        if f.lower().endswith(".pvd") and os.path.isfile(os.path.join(output_dir, f))
    )

    for pvd_fname in pvd_files:
        pvd_path = os.path.join(output_dir, pvd_fname)
        pvd_name = pvd_fname[:-4]  # Strip .pvd

        try:
            pvd_info = _parse_pvd_file(pvd_path, pvd_name, output_dir)
        except Exception as e:
            pvd_info = {
                "pvd_name": pvd_name,
                "pvd_file": pvd_fname,
                "error": str(e),
            }

        # Classify
        category = _classify_pvd(pvd_name)
        result[category].append(pvd_info)

    return result


def _parse_pvd_file(
    pvd_path: str, pvd_name: str, output_dir: str
) -> Dict[str, Any]:
    """Parse a PVD file to extract timestep list and probe one VTK file."""
    tree = ET.parse(pvd_path)
    root = tree.getroot()

    timesteps = []
    vtk_files = []

    for dataset in root.iter("DataSet"):
        ts = dataset.get("timestep")
        fpath = dataset.get("file")
        if ts is not None:
            try:
                timesteps.append(float(ts))
            except ValueError:
                pass
        if fpath:
            vtk_files.append(fpath)

    timesteps.sort()
    time_range = [timesteps[0], timesteps[-1]] if timesteps else None

    # Compute dt for PVD timesteps
    pvd_dt = None
    is_uniform_pvd_dt = None
    if len(timesteps) >= 3:
        dts = [timesteps[i + 1] - timesteps[i] for i in range(min(20, len(timesteps) - 1))]
        dts = [d for d in dts if d > 0]
        if dts:
            pvd_dt = sum(dts) / len(dts)
            if pvd_dt > 0:
                max_dev = max(abs(d - pvd_dt) / pvd_dt for d in dts)
                is_uniform_pvd_dt = max_dev < 0.01

    # Determine format from the first VTK file path
    vtk_format = None
    if vtk_files:
        ext = os.path.splitext(vtk_files[0])[1].lower()
        vtk_format = ext.lstrip(".")  # "vti", "vtp", "vtu", etc.

    # Probe one VTK file for grid and field info + file size
    grid_info = None
    fields = []
    sample_file_size = 0
    if vtk_files:
        sample_path = os.path.join(output_dir, vtk_files[0])
        if os.path.isfile(sample_path):
            sample_file_size = os.path.getsize(sample_path)
            probe = _probe_vtk_file(sample_path)
            grid_info = probe.get("grid")
            fields = probe.get("fields", [])

    # Estimate total size
    estimated_size_bytes = sample_file_size * len(vtk_files) if sample_file_size else 0

    info = {
        "pvd_name": pvd_name,
        "pvd_file": os.path.basename(pvd_path),
        "format": vtk_format,
        "num_timesteps": len(timesteps),
        "time_range": time_range,
        "sampling_dt": pvd_dt,
        "is_uniform_dt": is_uniform_pvd_dt,
        "fields": fields,
        "sample_file_size": sample_file_size,
        "estimated_size_bytes": estimated_size_bytes,
    }

    if grid_info:
        info["grid"] = grid_info

    # Extract slice plane info from the name
    plane_info = _extract_plane_info(pvd_name)
    if plane_info:
        info["plane"] = plane_info

    # Detect static geometry — single-timestep VTP/VTU files are usually
    # walls, baffles, vessels, or other fixed solid bodies
    is_static = False
    static_reason = None
    if len(timesteps) <= 1:
        lower = pvd_name.lower()
        # Name-based detection
        static_keywords = ["staticbody", "vessel", "baffles", "baffle", "cad",
                           "wall", "boundary", "boundarycondition"]
        for kw in static_keywords:
            if kw in lower:
                is_static = True
                static_reason = f"name contains '{kw}'"
                break
        # If single timestep + VTP format, very likely static geometry
        if not is_static and vtk_format == "vtp" and len(timesteps) == 1:
            is_static = True
            static_reason = "single timestep VTP"

    info["is_static"] = is_static
    if static_reason:
        info["static_reason"] = static_reason

    # Don't count static geometry toward training data size estimates
    if is_static:
        info["estimated_size_bytes"] = sample_file_size  # Just one file, not multiplied

    return info


def _probe_vtk_file(filepath: str) -> Dict[str, Any]:
    """Read VTK/VTI/VTP XML header to extract grid info and field names.

    Only reads the XML header — does NOT load the actual binary data arrays.
    """
    result = {"grid": None, "fields": []}

    try:
        # VTK files have binary appended data after <AppendedData>.
        # ET.parse chokes on the binary, so we read only the XML header.
        with open(filepath, "rb") as f:
            raw = f.read(32768)  # 32KB is more than enough for the XML header

        # Find the XML portion — everything before <AppendedData
        text = raw.decode("utf-8", errors="replace")
        appended_idx = text.find("<AppendedData")
        if appended_idx > 0:
            text = text[:appended_idx]
        # Close any open tags so ET can parse
        # Add closing tags for the truncated XML
        if "</VTKFile>" not in text:
            # Close any open elements
            for tag in ("Piece", "ImageData", "PolyData", "RectilinearGrid",
                        "UnstructuredGrid", "VTKFile"):
                if f"<{tag}" in text and f"</{tag}>" not in text:
                    text += f"\n</{tag}>"

        root = ET.fromstring(text)
    except (ET.ParseError, UnicodeDecodeError, OSError):
        return result

    vtk_type = root.get("type", "")
    result["grid"] = {"type": vtk_type}

    # Extract grid dimensions from ImageData, RectilinearGrid, etc.
    for img_data in root.iter("ImageData"):
        extent = img_data.get("WholeExtent", "")
        spacing = img_data.get("Spacing", "")
        origin = img_data.get("Origin", "")
        result["grid"]["extent"] = _parse_extent(extent)
        result["grid"]["spacing"] = _parse_floats(spacing)
        result["grid"]["origin"] = _parse_floats(origin)
        break

    # PolyData / UnstructuredGrid — get point/cell counts from Piece
    for piece in root.iter("Piece"):
        n_points = piece.get("NumberOfPoints")
        n_cells = piece.get("NumberOfCells") or piece.get("NumberOfPolys")
        if n_points:
            result["grid"]["n_points"] = int(n_points)
        if n_cells:
            result["grid"]["n_cells"] = int(n_cells)
        extent = piece.get("Extent")
        if extent and "extent" not in result["grid"]:
            result["grid"]["extent"] = _parse_extent(extent)
        break

    # Extract field names from PointData and CellData
    # M-Star naming patterns for solver-computed time-averaged fields:
    #   "Velocity Magnitude Mean Trim (m/s)"
    #   "Pressure Mean Trim (Pa)"
    #   "Velocity Magnitude RMS Trim (m/s)"
    _avg_keywords = ("mean trim", "meantrim", "time average", "timeaverage",
                     "time avg", "timeavg", "mean_trim", "time_average")
    _rms_keywords = ("rms trim", "rmstrim", "rms_trim", "rms")

    for data_section in ("PointData", "CellData"):
        for section in root.iter(data_section):
            for arr in section:
                name = arr.get("Name")
                if name:
                    n_comp = arr.get("NumberOfComponents", "1")
                    try:
                        n_comp = int(n_comp)
                    except ValueError:
                        n_comp = 1
                    field_name, field_unit = _parse_column_name(name)
                    low = name.lower()
                    is_avg = any(kw in low for kw in _avg_keywords)
                    is_rms = any(kw in low for kw in _rms_keywords) and not is_avg
                    result["fields"].append({
                        "name": name,
                        "display_name": field_name,
                        "unit": field_unit,
                        "components": n_comp,
                        "data_location": data_section,
                        "is_solver_averaged": is_avg,
                        "is_rms": is_rms,
                    })

    return result


def _classify_pvd(pvd_name: str) -> str:
    """Classify a PVD by its name into a category."""
    lower = pvd_name.lower()

    if lower.startswith("boundarycondition"):
        return "boundary_conditions"

    if lower.startswith("volume"):
        return "volumes_3d"

    if lower.startswith("slicemovingbody") or lower.startswith("slicestaticbody"):
        return "slices_body"

    if lower.startswith("slice"):
        return "slices_2d"

    # Fallback: check if it contains "volume" anywhere
    if "volume" in lower:
        return "volumes_3d"

    return "other"


def _extract_plane_info(pvd_name: str) -> Optional[str]:
    """Extract plane info from slice names like 'SliceX_0.000' -> 'X = 0.000'."""
    for axis in ("X", "Y", "Z"):
        prefix = f"Slice{axis}_"
        if pvd_name.startswith(prefix):
            val = pvd_name[len(prefix) :]
            return f"{axis} = {val}"
    return None


def _parse_extent(extent_str: str) -> Optional[List[int]]:
    """Parse VTK extent string '0 0 0 129 0 100' -> [0, 0, 0, 129, 0, 100]."""
    try:
        return [int(x) for x in extent_str.strip().split()]
    except (ValueError, AttributeError):
        return None


def _parse_floats(s: str) -> Optional[List[float]]:
    """Parse space-separated floats."""
    try:
        return [float(x) for x in s.strip().split()]
    except (ValueError, AttributeError):
        return None


def _format_bytes(n: int) -> str:
    """Format byte count as human-readable string."""
    if n < 1024:
        return f"{n} B"
    elif n < 1024 ** 2:
        return f"{n / 1024:.1f} KB"
    elif n < 1024 ** 3:
        return f"{n / 1024 ** 2:.1f} MB"
    else:
        return f"{n / 1024 ** 3:.2f} GB"


# ---------------------------------------------------------------------------
# Sweep-level scanning
# ---------------------------------------------------------------------------

def scan_sweep(sweep_root: str) -> Dict[str, Any]:
    """Scan an entire sweep directory for all training data.

    Expects:
      sweep_root/
      ├── sweep_manifest.json  (optional — from export_for_queue)
      ├── CaseName1/
      │   └── out/
      │       ├── Stats/*.txt
      │       └── Output/*.pvd → VTI/VTP files
      └── CaseName2/
          └── out/...

    Returns comprehensive inventory JSON with validation.
    """
    sweep_root = os.path.abspath(sweep_root)

    if not os.path.isdir(sweep_root):
        return {"error": f"Sweep root not found: {sweep_root}", "sweep_root": sweep_root}

    # Load sweep manifest if available
    manifest_path = os.path.join(sweep_root, "sweep_manifest.json")
    sweep_manifest = None
    if os.path.isfile(manifest_path):
        try:
            with open(manifest_path) as f:
                sweep_manifest = json.load(f)
        except Exception:
            pass

    # Discover cases — either from manifest or by scanning directories
    cases = _discover_cases(sweep_root, sweep_manifest)

    # ---- Per-case scanning with detailed tracking ----
    # Track per-case data for cross-case validation
    all_stats = {}       # filename -> {columns, per_case_time_ranges, per_case_num_rows, ...}
    all_pvds = {}        # pvd_name -> {fields, per_case_time_ranges, per_case_num_timesteps, ...}
    case_results = []
    warnings = []

    for case in cases:
        case_dir = case["directory"]
        case_name = case["name"]
        out_dir = os.path.join(case_dir, "out")

        case_result = {
            "name": case_name,
            "directory": case_dir,
            "has_output": os.path.isdir(out_dir),
            "parameters": case.get("parameters", {}),
        }

        if not os.path.isdir(out_dir):
            case_result["status"] = "no_output"
            case_result["time_range"] = None
            warnings.append(f"Case '{case_name}': no out/ directory found")
            case_results.append(case_result)
            continue

        # --- Scan stats ---
        stats_dir = os.path.join(out_dir, "Stats")
        case_stats = scan_stats_dir(stats_dir)
        case_result["stats_files"] = [s["filename"] for s in case_stats]

        # Track case time range from stats (use widest)
        case_time_start = None
        case_time_end = None

        for sf in case_stats:
            fname = sf["filename"]
            tr = sf.get("time_range")

            if fname not in all_stats:
                all_stats[fname] = {
                    "filename": fname,
                    "columns": sf["columns"],
                    "num_columns": sf.get("num_columns", len(sf["columns"])),
                    "cases_with_file": [],
                    "per_case_time_ranges": {},
                    "per_case_num_rows": {},
                    "per_case_sampling_dt": {},
                    "sample_num_rows": sf.get("num_rows", 0),
                    "sample_time_range": tr,
                    "sampling_dt": sf.get("sampling_dt"),
                    "is_uniform_dt": sf.get("is_uniform_dt"),
                    "file_size_bytes": sf.get("file_size_bytes", 0),
                    # Track column names per case for consistency check
                    "per_case_columns": {},
                }
            all_stats[fname]["cases_with_file"].append(case_name)
            all_stats[fname]["per_case_num_rows"][case_name] = sf.get("num_rows", 0)
            all_stats[fname]["per_case_sampling_dt"][case_name] = sf.get("sampling_dt")
            if tr:
                all_stats[fname]["per_case_time_ranges"][case_name] = tr
                if case_time_start is None or tr[0] < case_time_start:
                    case_time_start = tr[0]
                if case_time_end is None or tr[1] > case_time_end:
                    case_time_end = tr[1]
            # Store column names for this case
            col_names = [c["raw"] for c in sf.get("columns", [])]
            all_stats[fname]["per_case_columns"][case_name] = col_names

        # --- Scan PVD/VTK output ---
        output_dir = os.path.join(out_dir, "Output")
        case_pvds = scan_output_dir(output_dir)
        case_result["pvd_categories"] = {
            k: len(v) for k, v in case_pvds.items()
        }

        # Merge into global PVD inventory with per-case tracking
        for category, pvd_list in case_pvds.items():
            for pvd in pvd_list:
                pname = pvd.get("pvd_name", "unknown")
                pvd_tr = pvd.get("time_range")

                if pname not in all_pvds:
                    all_pvds[pname] = {
                        **pvd,
                        "category": category,
                        "cases_with_pvd": [],
                        "per_case_time_ranges": {},
                        "per_case_num_timesteps": {},
                        "per_case_grids": {},
                        "per_case_fields": {},
                    }
                all_pvds[pname]["cases_with_pvd"].append(case_name)
                if pvd_tr:
                    all_pvds[pname]["per_case_time_ranges"][case_name] = pvd_tr
                    if case_time_start is None or pvd_tr[0] < case_time_start:
                        case_time_start = pvd_tr[0]
                    if case_time_end is None or pvd_tr[1] > case_time_end:
                        case_time_end = pvd_tr[1]
                all_pvds[pname]["per_case_num_timesteps"][case_name] = pvd.get("num_timesteps", 0)
                # Store grid/field info per case for consistency checking
                all_pvds[pname]["per_case_grids"][case_name] = pvd.get("grid")
                all_pvds[pname]["per_case_fields"][case_name] = [
                    f["name"] for f in pvd.get("fields", [])
                ]

        case_result["time_range"] = (
            [case_time_start, case_time_end]
            if case_time_start is not None and case_time_end is not None
            else None
        )
        case_result["status"] = "scanned"
        case_results.append(case_result)

    # ---- Cross-case analysis ----
    cases_with_output = [c["name"] for c in case_results if c.get("status") == "scanned"]
    num_cases_with_output = len(cases_with_output)

    for sf in all_stats.values():
        sf["is_common"] = len(sf["cases_with_file"]) == num_cases_with_output

    for pv in all_pvds.values():
        pv["is_common"] = len(pv["cases_with_pvd"]) == num_cases_with_output

    # Separate stats into physics vs system
    system_stats = {"Timing.txt", "MemoryUsage.txt", "UnexpectedRemovalParticles.txt"}
    physics_stats = [s for s in all_stats.values() if s["filename"] not in system_stats]
    sys_stats = [s for s in all_stats.values() if s["filename"] in system_stats]

    # Build sweep parameters from manifest
    sweep_parameters = []
    if sweep_manifest:
        sweep_parameters = sweep_manifest.get("parameters", [])

    # ---- Compute validation ----
    validation = _compute_validation(
        physics_stats, all_pvds, case_results, cases_with_output, warnings
    )

    # ---- Compute total data sizes ----
    total_stats_bytes = sum(
        s.get("file_size_bytes", 0) * max(1, len(s.get("cases_with_file", [])))
        for s in all_stats.values()
    )
    total_pvd_bytes = sum(
        p.get("estimated_size_bytes", 0) * max(1, len(p.get("cases_with_pvd", [])))
        for p in all_pvds.values()
    )

    # Build final inventory
    inventory = {
        "sweep_root": sweep_root,
        "sweep_manifest_path": manifest_path if sweep_manifest else None,
        "num_cases": len(cases),
        "num_cases_with_output": num_cases_with_output,
        "sweep_parameters": sweep_parameters,
        "cases": case_results,
        "stats_inventory": {
            "physics": physics_stats,
            "system": sys_stats,
            "total_files": len(all_stats),
            "common_files": [s["filename"] for s in all_stats.values() if s["is_common"]],
        },
        "pvd_inventory": {
            "slices_2d": [p for p in all_pvds.values() if p["category"] == "slices_2d"],
            "slices_body": [p for p in all_pvds.values() if p["category"] == "slices_body"],
            "volumes_3d": [p for p in all_pvds.values() if p["category"] == "volumes_3d"],
            "boundary_conditions": [p for p in all_pvds.values() if p["category"] == "boundary_conditions"],
            "other": [p for p in all_pvds.values() if p["category"] == "other"],
        },
        "validation": validation,
        "total_stats_bytes": total_stats_bytes,
        "total_pvd_bytes": total_pvd_bytes,
        "total_data_bytes": total_stats_bytes + total_pvd_bytes,
        "total_data_human": _format_bytes(total_stats_bytes + total_pvd_bytes),
        "warnings": warnings,
        "error": None,
    }

    return inventory


# ---------------------------------------------------------------------------
# Validation engine
# ---------------------------------------------------------------------------

def _compute_validation(
    physics_stats: List[Dict],
    all_pvds: Dict[str, Dict],
    case_results: List[Dict],
    cases_with_output: List[str],
    warnings: List[str],
) -> Dict[str, Any]:
    """Compute cross-case consistency and training readiness checks."""
    checks = []
    num_cases = len(cases_with_output)

    # Single-case datasets: skip cross-case checks but still validate presence
    is_single_case = num_cases <= 1

    # ---- Check 1: Stats column consistency ----
    stats_consistent = True
    stats_details = []
    for sf in physics_stats:
        per_case_cols = sf.get("per_case_columns", {})
        if len(per_case_cols) <= 1:
            continue  # Can't check consistency with one case
        reference_case = list(per_case_cols.keys())[0]
        reference_cols = per_case_cols[reference_case]
        for case_name, cols in per_case_cols.items():
            if case_name == reference_case:
                continue
            if cols != reference_cols:
                stats_consistent = False
                missing = set(reference_cols) - set(cols)
                extra = set(cols) - set(reference_cols)
                detail = f"{sf['filename']}: {case_name} differs from {reference_case}"
                if missing:
                    detail += f" (missing: {', '.join(missing)})"
                if extra:
                    detail += f" (extra: {', '.join(extra)})"
                stats_details.append(detail)

    if physics_stats:
        if is_single_case or stats_consistent:
            checks.append({
                "name": "stats_column_consistency",
                "status": "pass",
                "message": f"All {len(physics_stats)} stats files have consistent columns" +
                           (f" across {num_cases} cases" if num_cases > 1 else ""),
            })
        else:
            checks.append({
                "name": "stats_column_consistency",
                "status": "fail",
                "message": f"Column mismatch found in {len(stats_details)} file(s)",
                "details": stats_details,
            })

    # ---- Check 2: Stats time range consistency ----
    time_ranges_per_case = {}
    for sf in physics_stats:
        for case_name, tr in sf.get("per_case_time_ranges", {}).items():
            if case_name not in time_ranges_per_case:
                time_ranges_per_case[case_name] = []
            time_ranges_per_case[case_name].append(tr)

    common_time_start = None
    common_time_end = None
    time_mismatch = False

    if time_ranges_per_case:
        # For each case, get the widest time window
        case_windows = {}
        for case_name, ranges in time_ranges_per_case.items():
            starts = [r[0] for r in ranges]
            ends = [r[1] for r in ranges]
            case_windows[case_name] = [min(starts), max(ends)]

        # Common time range = intersection of all case windows
        all_starts = [w[0] for w in case_windows.values()]
        all_ends = [w[1] for w in case_windows.values()]
        common_time_start = max(all_starts)
        common_time_end = min(all_ends)

        # Check if all cases have similar ranges
        if num_cases > 1:
            range_spread_start = max(all_starts) - min(all_starts)
            range_spread_end = max(all_ends) - min(all_ends)
            avg_duration = sum(w[1] - w[0] for w in case_windows.values()) / len(case_windows)

            if avg_duration > 0:
                if range_spread_end / avg_duration > 0.1:  # >10% spread
                    time_mismatch = True

    if time_ranges_per_case:
        if common_time_start is not None and common_time_end is not None:
            if common_time_end <= common_time_start:
                checks.append({
                    "name": "time_overlap",
                    "status": "fail",
                    "message": "No time overlap between cases — cannot train",
                    "common_time_range": None,
                })
            elif time_mismatch:
                checks.append({
                    "name": "time_overlap",
                    "status": "warn",
                    "message": f"Time ranges differ: common window {common_time_start:.2f}s → {common_time_end:.1f}s "
                               f"(some cases have shorter/longer runs)",
                    "common_time_range": [common_time_start, common_time_end],
                })
            else:
                checks.append({
                    "name": "time_overlap",
                    "status": "pass",
                    "message": f"Common time window: {common_time_start:.2f}s → {common_time_end:.1f}s",
                    "common_time_range": [common_time_start, common_time_end],
                })

    # ---- Check 3: Stats sampling rate consistency ----
    dt_issues = []
    for sf in physics_stats:
        per_case_dt = sf.get("per_case_sampling_dt", {})
        dts = [d for d in per_case_dt.values() if d is not None and d > 0]
        if len(dts) > 1:
            avg_dt = sum(dts) / len(dts)
            max_dev = max(abs(d - avg_dt) / avg_dt for d in dts) if avg_dt > 0 else 0
            if max_dev > 0.05:  # >5% deviation
                dt_issues.append(f"{sf['filename']}: dt varies {min(dts):.4f}s – {max(dts):.4f}s")

    if physics_stats:
        if not dt_issues:
            sample_dt = physics_stats[0].get("sampling_dt")
            dt_str = f" (dt ≈ {sample_dt:.4f}s)" if sample_dt else ""
            checks.append({
                "name": "sampling_rate",
                "status": "pass",
                "message": f"Consistent sampling rate across cases{dt_str}",
            })
        else:
            checks.append({
                "name": "sampling_rate",
                "status": "warn",
                "message": f"Sampling rate varies in {len(dt_issues)} file(s)",
                "details": dt_issues,
            })

    # ---- Check 4: Grid consistency for 2D slices ----
    grid_issues = []
    for pname, pvd in all_pvds.items():
        if pvd.get("category") not in ("slices_2d",):
            continue
        per_case_grids = pvd.get("per_case_grids", {})
        if len(per_case_grids) <= 1:
            continue

        reference_case = list(per_case_grids.keys())[0]
        ref_grid = per_case_grids[reference_case] or {}
        for case_name, grid in per_case_grids.items():
            if case_name == reference_case:
                continue
            grid = grid or {}
            if grid.get("extent") != ref_grid.get("extent"):
                grid_issues.append(
                    f"{pname}: {case_name} grid extent {grid.get('extent')} "
                    f"differs from {reference_case} {ref_grid.get('extent')}"
                )
            if grid.get("spacing") != ref_grid.get("spacing"):
                grid_issues.append(
                    f"{pname}: {case_name} spacing {grid.get('spacing')} "
                    f"differs from {reference_case} {ref_grid.get('spacing')}"
                )

    slices_2d = [p for p in all_pvds.values() if p.get("category") == "slices_2d"]
    if slices_2d:
        if not grid_issues:
            checks.append({
                "name": "grid_consistency",
                "status": "pass",
                "message": f"All {len(slices_2d)} 2D slice grids are consistent across cases",
            })
        else:
            checks.append({
                "name": "grid_consistency",
                "status": "fail",
                "message": f"Grid mismatch in {len(grid_issues)} slice(s) — FNO training requires identical grids",
                "details": grid_issues,
            })

    # ---- Check 5: Field consistency for PVDs ----
    field_issues = []
    for pname, pvd in all_pvds.items():
        per_case_fields = pvd.get("per_case_fields", {})
        if len(per_case_fields) <= 1:
            continue
        reference_case = list(per_case_fields.keys())[0]
        ref_fields = set(per_case_fields[reference_case])
        for case_name, fields in per_case_fields.items():
            if case_name == reference_case:
                continue
            if set(fields) != ref_fields:
                missing = ref_fields - set(fields)
                extra = set(fields) - ref_fields
                detail = f"{pname}: {case_name} field set differs"
                if missing:
                    detail += f" (missing: {', '.join(missing)})"
                if extra:
                    detail += f" (extra: {', '.join(extra)})"
                field_issues.append(detail)

    pvds_with_fields = [p for p in all_pvds.values() if p.get("fields")]
    if pvds_with_fields:
        if not field_issues:
            checks.append({
                "name": "field_consistency",
                "status": "pass",
                "message": f"All output fields are consistent across cases",
            })
        else:
            checks.append({
                "name": "field_consistency",
                "status": "fail",
                "message": f"Field mismatch in {len(field_issues)} output(s)",
                "details": field_issues,
            })

    # ---- Check 6: Case completeness ----
    if num_cases > 1:
        common_stats = [s["filename"] for s in physics_stats if s.get("is_common")]
        non_common_stats = [s["filename"] for s in physics_stats if not s.get("is_common")]

        common_pvds = [p["pvd_name"] for p in all_pvds.values() if p.get("is_common")]
        non_common_pvds = [p["pvd_name"] for p in all_pvds.values() if not p.get("is_common")]

        if not non_common_stats and not non_common_pvds:
            checks.append({
                "name": "case_completeness",
                "status": "pass",
                "message": f"All {num_cases} cases have identical data files",
            })
        else:
            issues = []
            if non_common_stats:
                issues.append(f"{len(non_common_stats)} stats file(s) not in all cases: {', '.join(non_common_stats)}")
            if non_common_pvds:
                issues.append(f"{len(non_common_pvds)} PVD(s) not in all cases: {', '.join(non_common_pvds)}")
            checks.append({
                "name": "case_completeness",
                "status": "warn",
                "message": f"Some data files missing from some cases",
                "details": issues,
            })

    # ---- Check 7: Cases with no output ----
    no_output = [c["name"] for c in case_results if c.get("status") == "no_output"]
    total_cases = len(case_results)
    if no_output:
        checks.append({
            "name": "missing_output",
            "status": "warn" if num_cases > 0 else "fail",
            "message": f"{len(no_output)} of {total_cases} case(s) have no output data",
            "details": no_output,
        })

    # ---- Compute overall score ----
    fail_count = sum(1 for c in checks if c["status"] == "fail")
    warn_count = sum(1 for c in checks if c["status"] == "warn")
    pass_count = sum(1 for c in checks if c["status"] == "pass")
    total_checks = len(checks)

    if total_checks == 0:
        score = 0
        overall_status = "fail"
    else:
        # Score: pass=100, warn=50, fail=0, averaged
        score = int(round(
            (pass_count * 100 + warn_count * 50) / total_checks
        ))
        if fail_count > 0:
            overall_status = "fail"
        elif warn_count > 0:
            overall_status = "warn"
        else:
            overall_status = "pass"

    # Training readiness per data type
    stats_ready = (
        len(physics_stats) > 0
        and stats_consistent
        and not any(c["name"] == "time_overlap" and c["status"] == "fail" for c in checks)
    )
    slices_ready = (
        len(slices_2d) > 0
        and not grid_issues
        and not field_issues
    )
    volumes_3d = [p for p in all_pvds.values() if p.get("category") == "volumes_3d"]
    volumes_ready = len(volumes_3d) > 0

    return {
        "status": overall_status,
        "score": score,
        "checks": checks,
        "common_time_range": (
            [common_time_start, common_time_end]
            if common_time_start is not None and common_time_end is not None
               and common_time_end > common_time_start
            else None
        ),
        "training_ready": {
            "stats": stats_ready,
            "slices_2d": slices_ready,
            "volumes_3d": volumes_ready,
        },
        "summary": {
            "pass": pass_count,
            "warn": warn_count,
            "fail": fail_count,
            "total": total_checks,
        },
    }


# ---------------------------------------------------------------------------
# Case discovery
# ---------------------------------------------------------------------------

def _discover_cases(
    sweep_root: str, manifest: Optional[Dict]
) -> List[Dict[str, Any]]:
    """Discover sweep cases from manifest or directory scan."""
    cases = []

    if manifest and "cases" in manifest:
        # Use manifest for case info (has parameters)
        for idx, case in enumerate(manifest["cases"]):
            name = case.get("name", case.get("case_name", ""))
            directory = case.get("directory", os.path.join(sweep_root, name))
            params = case.get("parameters", {})

            # If per-case parameters are empty, try to populate from global
            # sweep parameters array (older manifests stored params globally)
            if not params:
                for sp in manifest.get("parameters", []):
                    pname = sp.get("name", "Sweep Property")
                    pvals = sp.get("values", [])
                    if idx < len(pvals):
                        raw = pvals[idx]
                        try:
                            params[pname] = float(raw) if '.' in str(raw) else int(raw)
                        except (ValueError, TypeError):
                            params[pname] = raw

            cases.append({
                "name": name,
                "directory": directory,
                "parameters": params,
            })

        # Try to improve parameter names from sweep.xml (has PropertyDisplayName)
        sweep_xml = os.path.join(sweep_root, "sweep.xml")
        if os.path.isfile(sweep_xml):
            try:
                tree = ET.parse(sweep_xml)
                root = tree.getroot()
                first_case = root.find("Case")
                if first_case is not None:
                    xml_params = []
                    for pe in first_case.findall("Parameter"):
                        dn = pe.get("PropertyDisplayName", "")
                        on = pe.get("ObjectName", "")
                        pn = pe.get("PropertyName", "")
                        if dn:
                            xml_params.append(dn)
                        elif on and pn:
                            xml_params.append(f"{on}.{pn}")
                        elif pn:
                            xml_params.append(pn)
                    # Remap generic names to descriptive ones
                    global_params = manifest.get("parameters", [])
                    if xml_params and len(xml_params) == len(global_params):
                        old_names = [p.get("name", "") for p in global_params]
                        for i, new_name in enumerate(xml_params):
                            old_name = old_names[i]
                            if new_name and new_name != old_name:
                                # Update global params list
                                global_params[i]["name"] = new_name
                                # Update all case parameters
                                for c in cases:
                                    if old_name in c["parameters"]:
                                        c["parameters"][new_name] = c["parameters"].pop(old_name)
            except Exception:
                pass
    else:
        # Scan directories — look for subdirs that contain out/
        try:
            entries = sorted(os.listdir(sweep_root))
        except PermissionError:
            return cases

        for entry in entries:
            entry_path = os.path.join(sweep_root, entry)
            if not os.path.isdir(entry_path):
                continue
            # Skip hidden dirs and known non-case dirs
            if entry.startswith(".") or entry in ("__pycache__", "out"):
                continue
            # Check if it looks like a case (has out/ or has an MSB file)
            has_out = os.path.isdir(os.path.join(entry_path, "out"))
            has_msb = False
            try:
                has_msb = any(
                    f.lower().endswith(".msb")
                    for f in os.listdir(entry_path)
                    if os.path.isfile(os.path.join(entry_path, f))
                )
            except PermissionError:
                pass
            if has_out or has_msb:
                cases.append({
                    "name": entry,
                    "directory": entry_path,
                    "parameters": {},
                })

        # Fallback: if no child cases found but sweep_root itself has out/,
        # treat the sweep_root as a single case
        if not cases and os.path.isdir(os.path.join(sweep_root, "out")):
            cases.append({
                "name": os.path.basename(sweep_root),
                "directory": sweep_root,
                "parameters": {},
            })

    return cases


def scan_single_case(case_dir: str) -> Dict[str, Any]:
    """Scan a single case directory for output data.

    Useful for testing or scanning individual jobs.
    """
    case_dir = os.path.abspath(case_dir)
    out_dir = os.path.join(case_dir, "out")

    result = {
        "case_directory": case_dir,
        "has_output": os.path.isdir(out_dir),
    }

    if not os.path.isdir(out_dir):
        result["error"] = f"No out/ directory found in {case_dir}"
        return result

    # Stats
    stats_dir = os.path.join(out_dir, "Stats")
    result["stats"] = scan_stats_dir(stats_dir)

    # PVD/VTK
    output_dir = os.path.join(out_dir, "Output")
    result["pvd_output"] = scan_output_dir(output_dir)

    result["error"] = None
    return result


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    if len(sys.argv) < 3:
        print(json.dumps({
            "error": "Usage: dataset_scanner.py <scan|scan_case> <path>"
        }))
        sys.exit(1)

    command = sys.argv[1]
    path = os.path.abspath(sys.argv[2])

    try:
        if command == "scan":
            result = scan_sweep(path)
        elif command == "scan_case":
            result = scan_single_case(path)
        else:
            result = {"error": f"Unknown command: {command}. Use 'scan' or 'scan_case'."}
            sys.exit(1)

        print(json.dumps(result, indent=2))
    except Exception as e:
        import traceback
        print(json.dumps({
            "error": f"Unexpected error: {e}",
            "traceback": traceback.format_exc(),
        }))
        sys.exit(1)


if __name__ == "__main__":
    main()
