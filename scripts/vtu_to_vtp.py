#!/usr/bin/env python3
"""
Convert VTU/VTI to VTP (PolyData) for browser rendering via vtk.js.

Usage:
  python3 vtu_to_vtp.py convert <input.vtu|input.vti> <output.vtp>
  python3 vtu_to_vtp.py info-vtu <input.vtu>
  python3 vtu_to_vtp.py info-vtp <input.vtp>
  python3 vtu_to_vtp.py info-vti <input.vti>

Uses vtkDataSetSurfaceFilter to extract the surface geometry while
preserving all cell/point data arrays (Velocity, Pressure, etc.).
"""
import sys
import os


def convert_to_vtp(input_path, output_path):
    """Convert a VTU or VTI file to VTP format.

    For 3D VTI volumes, extracts 3 orthogonal slice planes through the center
    so the interior data is visible (surface extraction would show only the
    bounding box faces).
    """
    from vtkmodules.vtkFiltersGeometry import vtkDataSetSurfaceFilter
    from vtkmodules.vtkIOXML import vtkXMLPolyDataWriter

    ext = os.path.splitext(input_path)[1].lower()

    if not os.path.exists(input_path):
        print(f"ERROR: Input file not found: {input_path}", file=sys.stderr)
        sys.exit(1)

    if ext == '.vtu':
        from vtkmodules.vtkIOXML import vtkXMLUnstructuredGridReader
        reader = vtkXMLUnstructuredGridReader()
    elif ext == '.vti':
        from vtkmodules.vtkIOXML import vtkXMLImageDataReader
        reader = vtkXMLImageDataReader()
    else:
        print(f"ERROR: Unsupported input format: {ext}", file=sys.stderr)
        sys.exit(1)

    reader.SetFileName(input_path)
    reader.Update()

    dataset = reader.GetOutput()
    if dataset is None or dataset.GetNumberOfCells() == 0:
        print(f"ERROR: No data read from {input_path}", file=sys.stderr)
        sys.exit(1)

    # Interpolate cell data to point data for smooth rendering.
    # Without this, each polygon gets a single flat color (blocky/pixelated).
    # With it, values are interpolated across vertices (smooth gradients, like ParaView).
    from vtkmodules.vtkFiltersCore import vtkCellDataToPointData
    c2p = vtkCellDataToPointData()
    c2p.SetInputData(dataset)
    c2p.PassCellDataOn()   # Keep cell data too, just add point data
    c2p.Update()

    # Check if this is a 3D VTI (dims > 1 in all 3 axes) — needs slice extraction
    is_3d_vti = False
    if ext == '.vti':
        dims = dataset.GetDimensions()
        if dims[0] > 2 and dims[1] > 2 and dims[2] > 2:
            is_3d_vti = True

    if is_3d_vti:
        # For 3D volumes, extract 3 orthogonal slice planes through the center
        # so the user sees interior data instead of just bounding box faces
        from vtkmodules.vtkFiltersCore import vtkCutter, vtkAppendPolyData
        from vtkmodules.vtkCommonDataModel import vtkPlane

        bounds = dataset.GetBounds()  # (xmin, xmax, ymin, ymax, zmin, zmax)
        center = [
            (bounds[0] + bounds[1]) / 2.0,
            (bounds[2] + bounds[3]) / 2.0,
            (bounds[4] + bounds[5]) / 2.0,
        ]

        appender = vtkAppendPolyData()

        # X-plane (YZ cross-section)
        plane_x = vtkPlane()
        plane_x.SetOrigin(center[0], center[1], center[2])
        plane_x.SetNormal(1, 0, 0)
        cutter_x = vtkCutter()
        cutter_x.SetInputConnection(c2p.GetOutputPort())
        cutter_x.SetCutFunction(plane_x)
        cutter_x.Update()
        appender.AddInputData(cutter_x.GetOutput())

        # Y-plane (XZ cross-section)
        plane_y = vtkPlane()
        plane_y.SetOrigin(center[0], center[1], center[2])
        plane_y.SetNormal(0, 1, 0)
        cutter_y = vtkCutter()
        cutter_y.SetInputConnection(c2p.GetOutputPort())
        cutter_y.SetCutFunction(plane_y)
        cutter_y.Update()
        appender.AddInputData(cutter_y.GetOutput())

        # Z-plane (XY cross-section)
        plane_z = vtkPlane()
        plane_z.SetOrigin(center[0], center[1], center[2])
        plane_z.SetNormal(0, 0, 1)
        cutter_z = vtkCutter()
        cutter_z.SetInputConnection(c2p.GetOutputPort())
        cutter_z.SetCutFunction(plane_z)
        cutter_z.Update()
        appender.AddInputData(cutter_z.GetOutput())

        appender.Update()
        polydata = appender.GetOutput()
        print(f"3D VTI: extracted 3 orthogonal slices through center {center}", file=sys.stderr)
    else:
        # 2D VTI or VTU: extract surface (existing behavior)
        surface_filter = vtkDataSetSurfaceFilter()
        surface_filter.SetInputConnection(c2p.GetOutputPort())
        surface_filter.Update()
        polydata = surface_filter.GetOutput()

    writer = vtkXMLPolyDataWriter()
    writer.SetFileName(output_path)
    writer.SetInputData(polydata)
    writer.SetDataModeToBinary()
    writer.Write()

    # Print summary for logging
    n_points = polydata.GetNumberOfPoints()
    n_polys = polydata.GetNumberOfPolys()
    n_cd = polydata.GetCellData().GetNumberOfArrays()
    n_pd = polydata.GetPointData().GetNumberOfArrays()
    pd_names = [polydata.GetPointData().GetArrayName(i) for i in range(n_pd)]
    print(f"OK: {n_points} points, {n_polys} polys, {n_pd} point arrays: {pd_names}")


def _get_dataset_info(dataset):
    """Extract array info from a VTK dataset."""
    arrays = []
    for i in range(dataset.GetCellData().GetNumberOfArrays()):
        arr = dataset.GetCellData().GetArray(i)
        arrays.append({
            "name": dataset.GetCellData().GetArrayName(i),
            "components": arr.GetNumberOfComponents(),
            "range": list(arr.GetRange()),
        })
    for i in range(dataset.GetPointData().GetNumberOfArrays()):
        arr = dataset.GetPointData().GetArray(i)
        arrays.append({
            "name": dataset.GetPointData().GetArrayName(i),
            "components": arr.GetNumberOfComponents(),
            "range": list(arr.GetRange()),
            "point_data": True,
        })
    return arrays


def get_vtu_info(input_path):
    """Print JSON info about a VTU file's data arrays."""
    import json
    from vtkmodules.vtkIOXML import vtkXMLUnstructuredGridReader

    if not os.path.exists(input_path):
        print(json.dumps({"error": f"File not found: {input_path}"}))
        sys.exit(1)

    reader = vtkXMLUnstructuredGridReader()
    reader.SetFileName(input_path)
    reader.Update()

    ugrid = reader.GetOutput()
    if ugrid is None:
        print(json.dumps({"error": "No data"}))
        sys.exit(1)

    arrays = _get_dataset_info(ugrid)
    print(json.dumps({
        "points": ugrid.GetNumberOfPoints(),
        "cells": ugrid.GetNumberOfCells(),
        "arrays": arrays,
    }))


def get_vtp_info(input_path):
    """Print JSON info about a VTP file's data arrays."""
    import json
    from vtkmodules.vtkIOXML import vtkXMLPolyDataReader

    if not os.path.exists(input_path):
        print(json.dumps({"error": f"File not found: {input_path}"}))
        sys.exit(1)

    reader = vtkXMLPolyDataReader()
    reader.SetFileName(input_path)
    reader.Update()

    polydata = reader.GetOutput()
    if polydata is None:
        print(json.dumps({"error": "No data"}))
        sys.exit(1)

    arrays = _get_dataset_info(polydata)
    print(json.dumps({
        "points": polydata.GetNumberOfPoints(),
        "polys": polydata.GetNumberOfPolys(),
        "arrays": arrays,
    }))


def get_vti_info(input_path):
    """Print JSON info about a VTI file's data arrays."""
    import json
    from vtkmodules.vtkIOXML import vtkXMLImageDataReader

    if not os.path.exists(input_path):
        print(json.dumps({"error": f"File not found: {input_path}"}))
        sys.exit(1)

    reader = vtkXMLImageDataReader()
    reader.SetFileName(input_path)
    reader.Update()

    image_data = reader.GetOutput()
    if image_data is None:
        print(json.dumps({"error": "No data"}))
        sys.exit(1)

    arrays = _get_dataset_info(image_data)
    print(json.dumps({
        "points": image_data.GetNumberOfPoints(),
        "cells": image_data.GetNumberOfCells(),
        "dims": list(image_data.GetDimensions()),
        "arrays": arrays,
    }))


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage:")
        print("  vtu_to_vtp.py convert <input.vtu|input.vti> <output.vtp>")
        print("  vtu_to_vtp.py info-vtu <input.vtu>")
        print("  vtu_to_vtp.py info-vtp <input.vtp>")
        print("  vtu_to_vtp.py info-vti <input.vti>")
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "convert":
        if len(sys.argv) != 4:
            print("Usage: vtu_to_vtp.py convert <input.vtu|input.vti> <output.vtp>", file=sys.stderr)
            sys.exit(1)
        convert_to_vtp(sys.argv[2], sys.argv[3])
    elif cmd == "info-vtu":
        if len(sys.argv) != 3:
            print("Usage: vtu_to_vtp.py info-vtu <input.vtu>", file=sys.stderr)
            sys.exit(1)
        get_vtu_info(sys.argv[2])
    elif cmd == "info-vtp":
        if len(sys.argv) != 3:
            print("Usage: vtu_to_vtp.py info-vtp <input.vtp>", file=sys.stderr)
            sys.exit(1)
        get_vtp_info(sys.argv[2])
    elif cmd == "info-vti":
        if len(sys.argv) != 3:
            print("Usage: vtu_to_vtp.py info-vti <input.vti>", file=sys.stderr)
            sys.exit(1)
        get_vti_info(sys.argv[2])
    else:
        print(f"Unknown command: {cmd}", file=sys.stderr)
        sys.exit(1)
