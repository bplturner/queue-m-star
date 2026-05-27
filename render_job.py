#!/usr/bin/env python3
"""
render_job.py — M-Star Queue Render Worker

Streamlined ParaView rendering script invoked by the queue daemon.
Loads a .pvsm state file, iterates through timesteps, saves PNG frames,
and optionally generates an MP4 video via ffmpeg.

Usage:  pvpython render_job.py <config.json>

The config JSON must contain:
  - case_path:      Path to the simulation job directory
  - state_file:     Path to the .pvsm state file
  - output_dir:     Directory for output frames/video
  - status_file:    Path to write render_status.json for progress tracking
  - resolution:     [width, height] or null (use state resolution)
  - fps:            Framerate for video (default: 25)
  - video_quality:  CRF value 0-51 (default: 23)
  - transparent:    Use transparent background (default: false)
  - compression:    PNG compression 0-9 (default: 0)
  - separate_views: Render each view separately (default: false)
  - scale_fonts:    Scale fonts with resolution (default: false)
  - generate_video: Create MP4 from frames (default: true)
  - gpu_id:         GPU device to use (default: 0)
  - render_name:    Name for output files (default: "render")
"""

from __future__ import absolute_import, print_function
import json
import os
import sys
import time
import subprocess
import traceback


def write_status(status_file, state, current_frame=0, total_frames=0,
                 error=None, video_file=None):
    """Write structured progress to status file for API polling."""
    elapsed = time.time() - write_status._start_time
    percent = (current_frame / total_frames * 100) if total_frames > 0 else 0

    eta = 0
    if current_frame > 1 and total_frames > 0:
        avg = elapsed / current_frame
        eta = avg * (total_frames - current_frame)

    status = {
        "state": state,
        "current_frame": current_frame,
        "total_frames": total_frames,
        "percent": round(percent, 1),
        "elapsed_seconds": round(elapsed, 1),
        "eta_seconds": round(eta, 1),
        "error": error,
        "video_file": video_file,
    }

    try:
        tmp = status_file + ".tmp"
        with open(tmp, 'w') as f:
            json.dump(status, f)
        os.replace(tmp, status_file)
    except Exception as e:
        print(f"Warning: Could not write status file: {e}", file=sys.stderr)

write_status._start_time = time.time()


def generate_video(output_dir, render_name, fps, separate_views, num_views,
                   video_quality):
    """Generate MP4 video from PNG frames using ffmpeg."""
    try:
        result = subprocess.run(['ffmpeg', '-version'],
                                capture_output=True, check=False)
        if result.returncode != 0:
            raise FileNotFoundError
    except FileNotFoundError:
        print("Warning: ffmpeg not found, skipping video generation")
        return None

    videos = []

    if separate_views and num_views > 1:
        for view_idx in range(num_views):
            pattern = os.path.join(output_dir,
                                   f"{render_name}_view_{view_idx:02d}_frame_%04d.png")
            video_path = os.path.join(output_dir,
                                      f"{render_name}_view_{view_idx:02d}.mp4")
            first = os.path.join(output_dir,
                                 f"{render_name}_view_{view_idx:02d}_frame_0000.png")
            if not os.path.exists(first):
                continue

            cmd = [
                'ffmpeg', '-y',
                '-framerate', str(fps),
                '-i', pattern,
                '-vf', 'scale=ceil(iw/2)*2:ceil(ih/2)*2',
                '-c:v', 'libx264',
                '-crf', str(video_quality),
                '-pix_fmt', 'yuv420p',
                video_path
            ]
            print(f"Creating video: {video_path}")
            subprocess.run(cmd, capture_output=True, check=True)
            videos.append(video_path)
    else:
        pattern = os.path.join(output_dir, f"{render_name}_frame_%04d.png")
        video_path = os.path.join(output_dir, f"{render_name}.mp4")
        first = os.path.join(output_dir, f"{render_name}_frame_0000.png")

        if os.path.exists(first):
            cmd = [
                'ffmpeg', '-y',
                '-framerate', str(fps),
                '-i', pattern,
                '-vf', 'scale=ceil(iw/2)*2:ceil(ih/2)*2',
                '-c:v', 'libx264',
                '-crf', str(video_quality),
                '-pix_fmt', 'yuv420p',
                video_path
            ]
            print(f"Creating video: {video_path}")
            subprocess.run(cmd, capture_output=True, check=True)
            videos.append(video_path)

    return videos[0] if len(videos) == 1 else (videos if videos else None)


def render(config):
    """Main render function — loads state, iterates timesteps, saves frames."""
    from paraview.simple import (
        LoadState, GetRenderViews, GetActiveViewOrCreate,
        GetAnimationScene, GetTimeKeeper, Render, SaveScreenshot,
        GetLayout
    )

    case_path = config['case_path']
    state_file = config['state_file']
    output_dir = config['output_dir']
    status_file = config['status_file']
    resolution = config.get('resolution')  # [w,h] or None
    fps = config.get('fps', 25)
    video_quality = config.get('video_quality', 23)
    transparent = config.get('transparent', False)
    compression = config.get('compression', 0)
    separate_views = config.get('separate_views', False)
    scale_fonts = config.get('scale_fonts', False)
    generate_video_flag = config.get('generate_video', True)
    gpu_id = config.get('gpu_id', 0)
    render_name = config.get('render_name', 'render')

    # Configure GPU
    os.environ['CUDA_VISIBLE_DEVICES'] = str(gpu_id)
    print(f"Using GPU {gpu_id}")

    # Validate paths
    data_dir = os.path.join(case_path, "out")
    if not os.path.isdir(data_dir):
        raise ValueError(f"Data directory not found: {data_dir}")
    if not os.path.isfile(state_file):
        raise ValueError(f"State file not found: {state_file}")

    os.makedirs(output_dir, exist_ok=True)

    # Write initial status
    write_status(status_file, "loading", 0, 0)

    # Load the ParaView state
    print(f"Loading state: {state_file}")
    print(f"Data directory: {data_dir}")
    LoadState(state_file, data_directory=data_dir,
              restrict_to_data_directory=True)

    # Disable camera reset to preserve saved camera positions
    try:
        from paraview.simple import _DisableFirstRenderCameraReset
        _DisableFirstRenderCameraReset()
    except Exception:
        pass

    # Configure font scaling
    if not scale_fonts:
        try:
            for view in GetRenderViews():
                if hasattr(view, 'FontScaling'):
                    view.FontScaling = 1.0
        except Exception:
            pass

    # Get views
    views = GetRenderViews()
    if not views:
        views = [GetActiveViewOrCreate('RenderView')]
    print(f"Found {len(views)} view(s)")

    # Get timesteps
    scene = GetAnimationScene()
    scene.UpdateAnimationUsingDataTimeSteps()
    tkeeper = GetTimeKeeper()
    num_timesteps = len(tkeeper.TimestepValues)
    print(f"Found {num_timesteps} timesteps")

    if num_timesteps == 0:
        raise ValueError("No timesteps found in simulation data")

    write_status(status_file, "rendering", 0, num_timesteps)

    # Parse resolution override
    override_res = None
    if resolution and len(resolution) == 2:
        override_res = (int(resolution[0]), int(resolution[1]))
        print(f"Override resolution: {override_res[0]}x{override_res[1]}")

    # Render loop
    for i, t in enumerate(tkeeper.TimestepValues):
        tkeeper.Time = t

        if separate_views:
            for view_idx, view in enumerate(views):
                if override_res:
                    width, height = override_res
                else:
                    width, height = view.ViewSize

                if transparent:
                    view.UseTransparentBackground = 1

                Render(view)

                if len(views) > 1:
                    fname = os.path.join(
                        output_dir,
                        f"{render_name}_view_{view_idx:02d}_frame_{i:04d}.png")
                else:
                    fname = os.path.join(
                        output_dir, f"{render_name}_frame_{i:04d}.png")

                SaveScreenshot(
                    fname, view,
                    ImageResolution=[width, height],
                    CompressionLevel=compression,
                    TransparentBackground=int(transparent))
        else:
            if len(views) > 1:
                layout = GetLayout()
                if transparent:
                    for view in views:
                        view.UseTransparentBackground = 1

                fname = os.path.join(
                    output_dir, f"{render_name}_frame_{i:04d}.png")
                SaveScreenshot(
                    fname, layout,
                    SaveAllViews=1,
                    CompressionLevel=compression,
                    TransparentBackground=int(transparent))
            else:
                view = views[0]
                if override_res:
                    width, height = override_res
                else:
                    width, height = view.ViewSize

                if transparent:
                    view.UseTransparentBackground = 1

                Render(view)

                fname = os.path.join(
                    output_dir, f"{render_name}_frame_{i:04d}.png")
                SaveScreenshot(
                    fname, view,
                    ImageResolution=[width, height],
                    CompressionLevel=compression,
                    TransparentBackground=int(transparent))

        # Update progress
        write_status(status_file, "rendering", i + 1, num_timesteps)

        if (i + 1) % 50 == 0 or i == 0:
            pct = (i + 1) / num_timesteps * 100
            print(f"  [{pct:5.1f}%] Frame {i+1}/{num_timesteps}")

    print(f"Rendered {num_timesteps} frames")

    # Generate video
    video_file = None
    if generate_video_flag:
        write_status(status_file, "encoding", num_timesteps, num_timesteps)
        print("Generating video...")
        video_file = generate_video(
            output_dir, render_name, fps, separate_views,
            len(views), video_quality)
        if video_file:
            print(f"Video created: {video_file}")

    # Final status
    write_status(status_file, "completed", num_timesteps, num_timesteps,
                 video_file=video_file if isinstance(video_file, str) else None)
    print("Render complete!")


def main():
    if len(sys.argv) != 2:
        print("Usage: pvpython render_job.py <config.json>", file=sys.stderr)
        sys.exit(1)

    config_path = sys.argv[1]
    if not os.path.isfile(config_path):
        print(f"Config file not found: {config_path}", file=sys.stderr)
        sys.exit(1)

    with open(config_path, 'r') as f:
        config = json.load(f)

    status_file = config.get('status_file', 'render_status.json')
    write_status._start_time = time.time()

    try:
        render(config)
    except Exception as e:
        error_msg = f"{str(e)}\n{traceback.format_exc()}"
        print(f"RENDER ERROR: {error_msg}", file=sys.stderr)
        write_status(status_file, "failed", error=error_msg)
        sys.exit(1)


if __name__ == "__main__":
    main()
