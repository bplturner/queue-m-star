#!/usr/bin/env python3
"""
Script to generate video frames (screenshots) and videos for all cases in sweep.xml
Iterates through each sweep case and renders timesteps using ParaView

Features:
  - Automatic sweep case iteration from XML file
  - Multi-view rendering (separate or combined/tiled)
  - Configurable resolution, framerate, and quality
  - Automatic video generation with ffmpeg
  - GPU selection for rendering
  - Transparent background support
  - PNG compression control
  - Font scaling control

Run 'pvpython sweep-videos.py --help' for detailed usage information
"""

from paraview.simple import *
import os
import sys
import argparse
import xml.etree.ElementTree as ET
import multiprocessing as mp
from multiprocessing import Pool, cpu_count
import time

# ===== DEFAULT CONFIGURATION =====
DEFAULT_SWEEP_XML = "sweep.xml"  # Default sweep XML file name
STATE_SUBPATH = "out/Output"  # Subdirectory within each case containing the .pvsm state file
OUT_SUBDIR = "video_frames"  # Output subdirectory within each case for frames
OVERRIDE_RESOLUTION = None  # Set to (width, height) tuple to override state resolution, or None to use state's resolution
TRANSPARENT = False  # Whether to use transparent background
COMPRESSION_LEVEL = 0  # PNG compression level (0 = uncompressed, faster)
DEFAULT_GPU_ID = 0  # Default GPU ID to use

# ===== PARALLEL PROCESSING CONFIGURATION =====
# For high-end systems with many cores/GPUs, optimal worker count is typically:
# - Match number of GPUs (8-16 workers for 8 GPUs)
# - Reserve cores for I/O and system overhead
# - Each ParaView instance uses ~2-4GB RAM
MAX_RECOMMENDED_WORKERS = 16  # Sweet spot for 8-GPU systems
OPTIMAL_WORKERS_PER_GPU = 2  # 2 workers per GPU maximizes throughput

# ===== FUNCTIONS =====

def parse_arguments():
    """
    Parse command-line arguments

    Returns:
        argparse.Namespace: Parsed arguments
    """
    parser = argparse.ArgumentParser(
        description="""
╔══════════════════════════════════════════════════════════════════════════════╗
║                   ParaView Sweep Video Frame Generator                      ║
╚══════════════════════════════════════════════════════════════════════════════╝

Generate video frames and MP4 videos from ParaView state files for all cases
defined in a sweep XML file. Automatically iterates through cases, renders 
timesteps, and creates videos with configurable quality and resolution.
        """,
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
════════════════════════════════════════════════════════════════════════════════
                                  EXAMPLES
════════════════════════════════════════════════════════════════════════════════

BASIC USAGE:
  pvpython sweep-videos.py
    → Use defaults: sweep.xml, auto-find state files, 25 FPS, state resolution

INPUT FILES:
  pvpython sweep-videos.py --sweep my-sweep.xml
    → Use custom sweep XML file
  
  pvpython sweep-videos.py --state my-visualization.pvsm
    → Use same state file for all cases
  
  pvpython sweep-videos.py --state-dir simulation/output
    → Search for state files in custom subdirectory
  
  pvpython sweep-videos.py --case-path ./dasbox-250-rpm40
    → Render single case by path (bypasses sweep XML)
  
  pvpython sweep-videos.py --case-path ./my-case --case-name experiment-01
    → Render single case with custom output name

OUTPUT CONTROL:
  pvpython sweep-videos.py --output-dir renders
    → Save frames/videos to custom subdirectory
   
  pvpython sweep-videos.py --no-video
    → Generate frames only, skip video creation
  
  pvpython sweep-videos.py --separate-views
    → Save each view as separate image/video files

QUALITY & RESOLUTION:
  pvpython sweep-videos.py --resolution 3840x2160
    → Override to 4K resolution
  
  pvpython sweep-videos.py --fps 60 --video-quality 18
    → High quality 60 FPS video (CRF 18)
  
  pvpython sweep-videos.py --compression 9
    → Maximum PNG compression (slower, smaller files)
  
  pvpython sweep-videos.py --transparent
    → Render with transparent background

RENDERING OPTIONS:
  pvpython sweep-videos.py --gpu-id 1
    → Use GPU 1 instead of default GPU 0
  
  pvpython sweep-videos.py --scale-fonts
    → Enable font scaling (disabled by default)
  
  pvpython sweep-videos.py --restart
    → Resume rendering from last completed frame (useful for interrupted renders)

PARALLEL PROCESSING (renders multiple CASES simultaneously):
  NOTE: Each case is rendered sequentially (timestep-by-timestep is fastest).
        Parallel mode lets you render 3 different cases on 3 GPUs at once.
        For single case: DON'T use --parallel, it won't help!
  
  pvpython sweep-videos.py --parallel --gpu-per-worker
    → Render 3 cases simultaneously on GPUs 0,1,2 (3x faster for multiple cases)

COMMON WORKFLOWS:
  # High-quality production render (4K, 60fps, best quality)
  pvpython sweep-videos.py --resolution 3840x2160 --fps 60 --video-quality 18
  
  # Quick preview (720p, fast encoding)
  pvpython sweep-videos.py --resolution 1280x720 --video-quality 28 --fps 15
  
  # Transparent frames for compositing (no video, max compression)
  pvpython sweep-videos.py --transparent --compression 9 --no-video
  
  # Render single case without sweep XML (great for testing)
  pvpython sweep-videos.py --case-path ./dasbox-250-rpm40
  
  # Resume interrupted render from where it left off
  pvpython sweep-videos.py --case-path "/simulations/Zoetis/Tulip Tank/simulations/200L-ZG2-Recirc" \\
    --state "/simulations/Zoetis/Tulip Tank/simulations/200L-ZG2-Recirc-Vel-NNN.pvsm" \\
    --parallel --restart
  
  # BEAST MODE: Render 3 cases simultaneously on 3 different GPUs
  pvpython sweep-videos.py --parallel --gpu-per-worker
  
  # Complete custom workflow with parallel processing
  pvpython sweep-videos.py \\
    --sweep my-sweep.xml \\
    --state-dir data/paraview \\
    --output-dir production \\
    --resolution 1920x1080 \\
    --fps 30 \\
    --video-quality 20 \\
    --parallel \\
    --max-workers 8

════════════════════════════════════════════════════════════════════════════════
For more information, visit: https://www.paraview.org/
════════════════════════════════════════════════════════════════════════════════
        """
    )
    
    # ═══ INPUT FILES ═══
    input_group = parser.add_argument_group('📁 Input Files', 'Options for specifying input sweep and state files')
    
    input_group.add_argument(
        '--sweep',
        type=str,
        default=None,
        metavar='FILE',
        help=f'path to sweep XML file (default: search for {DEFAULT_SWEEP_XML})'
    )
    
    input_group.add_argument(
        '--state',
        type=str,
        default=None,
        metavar='FILE',
        help='path to ParaView state file (.pvsm) to use for all cases (default: auto-find in each case)'
    )
    
    input_group.add_argument(
        '--state-dir',
        type=str,
        default=STATE_SUBPATH,
        metavar='DIR',
        help=f'subdirectory within each case to search for .pvsm files (default: "{STATE_SUBPATH}")'
    )
    
    input_group.add_argument(
        '--case-path',
        type=str,
        default=None,
        metavar='PATH',
        help='render single case by specifying the case directory path (bypasses sweep XML)'
    )
    
    input_group.add_argument(
        '--case-name',
        type=str,
        default=None,
        metavar='NAME',
        help='output name for single case rendering (default: use directory name from --case-path)'
    )
    
    # ═══ OUTPUT CONTROL ═══
    output_group = parser.add_argument_group('💾 Output Control', 'Options for controlling output files and directories')
    
    output_group.add_argument(
        '--output-dir',
        type=str,
        default=OUT_SUBDIR,
        metavar='DIR',
        help=f'output subdirectory name within each case for frames/video (default: "{OUT_SUBDIR}")'
    )
    
    output_group.add_argument(
        '--separate-views',
        action='store_true',
        help='save each view as separate image/video files (default: combine all views into single tiled image)'
    )
    
    output_group.add_argument(
        '--no-video',
        action='store_true',
        help='skip video generation, only create PNG frames (default: generate video)'
    )
    
    # ═══ QUALITY & RESOLUTION ═══
    quality_group = parser.add_argument_group('🎨 Quality & Resolution', 'Options for controlling output quality and dimensions')
    
    quality_group.add_argument(
        '--resolution',
        type=str,
        default=None,
        metavar='WxH',
        help='override output resolution as WIDTHxHEIGHT (e.g., 1920x1080, 3840x2160) (default: use state file resolution)'
    )
    
    quality_group.add_argument(
        '--fps',
        type=int,
        default=25,
        metavar='N',
        help='framerate for video generation in frames per second (default: 25)'
    )
    
    quality_group.add_argument(
        '--video-quality',
        type=int,
        default=23,
        choices=range(0, 52),
        metavar='[0-51]',
        help='video quality using CRF: 0=lossless, 18=high, 23=default, 28=low (lower is better) (default: 23)'
    )
    
    quality_group.add_argument(
        '--compression',
        type=int,
        default=0,
        choices=range(0, 10),
        metavar='[0-9]',
        help='PNG compression level: 0=none (fastest), 5=balanced, 9=max (slowest) (default: 0)'
    )
    
    quality_group.add_argument(
        '--transparent',
        action='store_true',
        help='use transparent background for frames (default: use background from state file)'
    )
    
    # ═══ RENDERING OPTIONS ═══
    render_group = parser.add_argument_group('🖥️  Rendering Options', 'Options for controlling ParaView rendering behavior')
    
    render_group.add_argument(
        '--gpu-id',
        type=int,
        default=DEFAULT_GPU_ID,
        metavar='N',
        help=f'GPU device ID to use for rendering (default: {DEFAULT_GPU_ID})'
    )
    
    render_group.add_argument(
        '--scale-fonts',
        action='store_true',
        help='enable font scaling when rendering (default: fonts are NOT scaled)'
    )
    
    # ═══ PARALLEL PROCESSING ═══
    parallel_group = parser.add_argument_group('⚡ Parallel Processing', 'Options for utilizing multiple CPUs and GPUs')
    
    parallel_group.add_argument(
        '--parallel',
        action='store_true',
        help='enable parallel processing across multiple CPU cores (default: sequential processing)'
    )
    
    parallel_group.add_argument(
        '--max-workers',
        type=int,
        default=None,
        metavar='N',
        help=f'maximum number of parallel workers (default: {MAX_RECOMMENDED_WORKERS} for optimal performance, system has {cpu_count()} cores)'
    )
    
    parallel_group.add_argument(
        '--gpu-per-worker',
        action='store_true',
        help='assign different GPU to each parallel worker (requires --parallel)'
    )
    
    # ═══ RESTART OPTION ═══
    restart_group = parser.add_argument_group('🔄 Restart Options', 'Options for resuming interrupted renders')
    
    restart_group.add_argument(
        '--restart',
        action='store_true',
        help='resume rendering from last completed frame (scans existing PNGs in output directory)'
    )
    
    return parser.parse_args()

def parse_resolution(resolution_str):
    """
    Parse resolution string in format WIDTHxHEIGHT
    
    Args:
        resolution_str (str or None): Resolution string like "1920x1080"
        
    Returns:
        tuple or None: (width, height) or None if invalid/not provided
    """
    if resolution_str is None:
        return None
    
    try:
        # Split by 'x' or 'X'
        parts = resolution_str.lower().split('x')
        if len(parts) != 2:
            print(f"Warning: Invalid resolution format '{resolution_str}'. Expected WIDTHxHEIGHT (e.g., 1920x1080)")
            return None
        
        width = int(parts[0])
        height = int(parts[1])
        
        if width <= 0 or height <= 0:
            print(f"Warning: Invalid resolution dimensions '{resolution_str}'. Width and height must be positive")
            return None
        
        return (width, height)
    except ValueError:
        print(f"Warning: Could not parse resolution '{resolution_str}'. Expected WIDTHxHEIGHT (e.g., 1920x1080)")
        return None

def worker_render_case(case_data):
    """
    Worker function for parallel case rendering
    NOTE: Parallelizes CASES, not timesteps within a case.
    Each worker renders ONE complete case sequentially through all its timesteps.
    
    Args:
        case_data (tuple): (case_path, case_name, state_file, out_dir, args_dict, worker_gpu_id)
        
    Returns:
        tuple: (case_name, success, error_message)
    """
    case_path, case_name, state_file, out_dir, args_dict, worker_gpu_id = case_data
    
    try:
        # Configure GPU for this worker
        if worker_gpu_id is not None:
            configure_gpu(worker_gpu_id)
        else:
            configure_gpu(args_dict.get('gpu_id', 0))
        
        # Parse resolution override
        override_resolution = parse_resolution(args_dict.get('resolution'))
        
        # Render the case (all timesteps sequentially)
        render_case_frames(
            case_path,
            case_name,
            state_file,
            out_dir,
            override_resolution,
            args_dict.get('transparent', False),
            args_dict.get('compression', 0),
            args_dict.get('separate_views', False),
            args_dict.get('scale_fonts', False),
            args_dict.get('fps', 25),
            not args_dict.get('no_video', False),
            args_dict.get('video_quality', 23),
            args_dict.get('restart', False)
        )
        
        return (case_name, True, None)
        
    except Exception as e:
        import traceback
        return (case_name, False, f"{str(e)}\n{traceback.format_exc()}")

def calculate_smart_grid_resolution(views, view_sizes):
    """
    Calculate resolution for a grid layout considering different view sizes
    
    Args:
        views (list): List of view objects
        view_sizes (list): List of (width, height) tuples for each view
        
    Returns:
        tuple: (combined_width, combined_height)
    """
    if len(views) == 1:
        return view_sizes[0]
    
    # For multiple views, we need to determine the layout arrangement
    # This is a simplified approach - in practice, you'd want to analyze the actual layout
    
    if len(views) == 2:
        # Two views: try to determine if they're arranged horizontally or vertically
        # by comparing their relative positions (if available)
        try:
            layout = GetLayout()
            if hasattr(layout, 'GetViewPosition'):
                pos1 = layout.GetViewPosition(views[0])
                pos2 = layout.GetViewPosition(views[1])
                if pos1 and pos2:
                    # If views are side by side (similar Y positions), arrange horizontally
                    if abs(pos1[1] - pos2[1]) < 50:  # Similar Y positions
                        combined_width = view_sizes[0][0] + view_sizes[1][0]
                        combined_height = max(view_sizes[0][1], view_sizes[1][1])
                    else:  # Views are stacked vertically
                        combined_width = max(view_sizes[0][0], view_sizes[1][0])
                        combined_height = view_sizes[0][1] + view_sizes[1][1]
                    return combined_width, combined_height
        except:
            pass
        
        # Fallback: assume horizontal arrangement
        combined_width = view_sizes[0][0] + view_sizes[1][0]
        combined_height = max(view_sizes[0][1], view_sizes[1][1])
        return combined_width, combined_height
    
    else:
        # For more than 2 views, use a grid approach but consider different sizes
        import math
        num_views = len(views)
        cols = math.ceil(math.sqrt(num_views))
        rows = math.ceil(num_views / cols)
        
        # Calculate total width and height considering different view sizes
        total_width = 0
        total_height = 0
        
        for i in range(rows):
            row_width = 0
            row_height = 0
            for j in range(cols):
                view_idx = i * cols + j
                if view_idx < num_views:
                    row_width += view_sizes[view_idx][0]
                    row_height = max(row_height, view_sizes[view_idx][1])
            total_width = max(total_width, row_width)
            total_height += row_height
        
        return total_width, total_height

def calculate_grid_resolution(num_views, base_width, base_height):
    """
    Calculate resolution for a grid layout of views (legacy function for uniform sizes)
    
    Args:
        num_views (int): Number of views to arrange
        base_width (int): Width of each individual view
        base_height (int): Height of each individual view
        
    Returns:
        tuple: (combined_width, combined_height)
    """
    import math
    
    if num_views == 1:
        return base_width, base_height
    elif num_views == 2:
        # Two views: arrange horizontally
        return base_width * 2, base_height
    elif num_views == 3:
        # Three views: arrange in 2x2 grid (one empty space)
        return base_width * 2, base_height * 2
    elif num_views == 4:
        # Four views: arrange in 2x2 grid
        return base_width * 2, base_height * 2
    else:
        # For other numbers, try to arrange in a reasonable grid
        cols = math.ceil(math.sqrt(num_views))
        rows = math.ceil(num_views / cols)
        return base_width * cols, base_height * rows

def find_sweep_xml():
    """
    Search for sweep XML file in current directory

    Returns:
        str: Path to sweep.xml file, or None if not found
    """
    # First try the default name
    if os.path.isfile(DEFAULT_SWEEP_XML):
        return DEFAULT_SWEEP_XML
    
    # Otherwise look for any XML file with "sweep" in the name
    for filename in os.listdir('.'):
        if filename.lower().endswith('.xml') and 'sweep' in filename.lower():
            print(f"  Found sweep XML file: {filename}")
            return filename
    
    return None

def find_highest_frame(out_dir, case_name, separate_views=False, view_idx=0):
    """
    Find the highest numbered frame that exists in the output directory
    
    Args:
        out_dir (str): Output directory containing frames
        case_name (str): Name of the case (used in frame filenames)
        separate_views (bool): Whether frames are saved with view indices
        view_idx (int): View index to check (for separate views mode)
        
    Returns:
        int or None: Highest frame number found, or None if no frames exist
    """
    import re
    
    # Check if output directory exists
    if not os.path.isdir(out_dir):
        return None
    
    # Pattern to match frame files
    if separate_views:
        pattern = re.compile(rf'^{re.escape(case_name)}_view_{view_idx:02d}_frame_(\d+)\.png$')
    else:
        pattern = re.compile(rf'^{re.escape(case_name)}_frame_(\d+)\.png$')
    
    # Find all matching frame files and extract frame numbers
    frame_numbers = []
    for filename in os.listdir(out_dir):
        match = pattern.match(filename)
        if match:
            frame_num = int(match.group(1))
            frame_numbers.append(frame_num)
    
    # Return the highest frame number, or None if no frames found
    if frame_numbers:
        return max(frame_numbers)
    else:
        return None

def configure_gpu(gpu_id):
    """
    Configure ParaView to use a specific GPU
    
    Args:
        gpu_id (int): GPU ID to use for rendering
    """
    try:
        # Set environment variable for GPU selection
        os.environ['CUDA_VISIBLE_DEVICES'] = str(gpu_id)
        
        # Try to configure ParaView's GPU settings
        # This needs to be done before any ParaView operations
        print(f"  Configuring GPU ID: {gpu_id}")
        
        # Set ParaView's GPU device selection
        # Note: This may need to be adjusted based on your ParaView version
        if hasattr(paraview, 'servermanager'):
            # For newer ParaView versions
            try:
                from paraview import servermanager
                servermanager.SetUseGPU(True)
                print(f"  GPU acceleration enabled")
            except:
                print(f"  Note: Could not explicitly enable GPU acceleration")
        
    except Exception as e:
        print(f"  Warning: Could not configure GPU {gpu_id}: {e}")
        print(f"  ParaView will use default GPU selection")

def parse_sweep_xml(xml_file):
    """
    Parse sweep.xml to extract case information

    Args:
        xml_file (str): Path to sweep XML file

    Returns:
        list: List of tuples (case_path, case_name)
    """
    try:
        tree = ET.parse(xml_file)
        root = tree.getroot()
    except ET.ParseError as e:
        raise ValueError(f"Failed to parse sweep XML file: {xml_file}\n" +
                        f"       XML parse error: {str(e)}")
    except Exception as e:
        raise ValueError(f"Failed to read sweep XML file: {xml_file}\n" +
                        f"       Error: {str(e)}")

    # Get the directory containing the XML file for relative path resolution
    xml_dir = os.path.dirname(os.path.abspath(xml_file))
    
    cases = []
    # Find all Case elements in the XML
    for idx, case in enumerate(root.findall('Case')):
        case_path = case.get('CasePath')
        case_name = case.get('Name')
        
        # Validate that both attributes exist
        if not case_path:
            print(f"  ⚠️  Warning: Case #{idx+1} missing 'CasePath' attribute, skipping")
            continue
        if not case_name:
            print(f"  ⚠️  Warning: Case #{idx+1} missing 'Name' attribute, skipping")
            continue
        
        # Resolve case path relative to the XML file's directory
        if not os.path.isabs(case_path):
            # If it's a relative path, make it relative to the XML file's directory
            resolved_case_path = os.path.join(xml_dir, case_path)
        else:
            # If it's already an absolute path, use it as-is
            resolved_case_path = case_path
        
        cases.append((resolved_case_path, case_name))

    return cases

def find_state_file(case_path, state_subpath):
    """
    Find the ParaView state file (.pvsm) in the case directory

    Args:
        case_path (str): Path to the case directory
        state_subpath (str): Subdirectory to search for state file

    Returns:
        str: Path to state file, or None if not found
    """
    search_dir = os.path.join(case_path, state_subpath)

    # Check if the directory exists
    if not os.path.isdir(search_dir):
        print(f"    Warning: State directory not found: {search_dir}")
        return None

    # Find all .pvsm files in the directory
    pvsm_files = [f for f in os.listdir(search_dir) if f.endswith('.pvsm')]

    if len(pvsm_files) == 0:
        print(f"    Warning: No .pvsm state files found in: {search_dir}")
        print(f"    To create a state file, open ParaView, load your simulation data,")
        print(f"    set up the visualization, then File -> Save State")
        return None
    elif len(pvsm_files) == 1:
        return os.path.join(search_dir, pvsm_files[0])
    else:
        # If multiple state files, use the first one (or could prompt user)
        print(f"    Warning: Multiple .pvsm files found, using: {pvsm_files[0]}")
        return os.path.join(search_dir, pvsm_files[0])

def render_case_frames(case_path, case_name, state_file, out_dir, override_resolution, transparent, compression, separate_views, scale_fonts, fps, generate_video_flag, video_quality, restart=False):
    """
    Load ParaView state and render frames for all timesteps and all views
    
    NOTE: Timesteps are rendered SEQUENTIALLY within each case. This is the fastest approach because:
    - ParaView state is loaded once and reused for all timesteps
    - Parallelizing timesteps would require loading state 1501 times (massive overhead)
    - GPU rendering is already fast; bottleneck is usually I/O, not computation

    Args:
        case_path (str): Path to case directory
        case_name (str): Name of the case
        state_file (str): Path to ParaView state file
        out_dir (str): Output directory for frames
        override_resolution (tuple or None): Optional (width, height) to override state resolution
        transparent (bool): Use transparent background
        compression (int): PNG compression level
        separate_views (bool): Whether to save each view separately or combine them
        scale_fonts (bool): Whether to scale fonts when rendering
        fps (int): Framerate for video generation
        generate_video_flag (bool): Whether to generate video from frames
        video_quality (int): Video quality CRF value (0-51)
        restart (bool): Resume rendering from last completed frame
    """
    # Create output directory
    os.makedirs(out_dir, exist_ok=True)
    
    # Initialize starting frame index (may be updated after view detection)
    start_frame = 0

    # Get the data directory (where the simulation output files are)
    data_dir = os.path.join(case_path, "out")
    
    # Verify data directory exists
    if not os.path.isdir(data_dir):
        raise ValueError(f"Data directory not found: {data_dir}\n" +
                        f"       Expected simulation output in '{case_path}/out'")
    
    # Verify state file exists
    if not os.path.isfile(state_file):
        raise ValueError(f"State file not found: {state_file}")

    # Load the ParaView state file with data directory
    print(f"    Loading state: {state_file}")
    try:
        LoadState(state_file, data_directory=data_dir, restrict_to_data_directory=True)
    except Exception as e:
        raise ValueError(f"Failed to load ParaView state file: {state_file}\n" +
                        f"       Error: {str(e)}")
    
    # Disable first-render camera reset to preserve cameras exactly as saved in the .pvsm
    print(f"    Disabling first-render camera reset")
    try:
        from paraview.simple import _DisableFirstRenderCameraReset
        _DisableFirstRenderCameraReset()
        print(f"    Camera reset disabled - preserving state file cameras")
    except Exception as e:
        print(f"    Warning: Could not disable camera reset: {e}")

    # Configure font scaling
    if scale_fonts:
        print(f"    Font scaling enabled")
    else:
        print(f"    Font scaling disabled (default)")
        # Disable font scaling for all views
        try:
            from paraview import servermanager
            # Set font scaling to 1.0 (no scaling) for all views
            for view in GetRenderViews():
                if hasattr(view, 'FontScaling'):
                    view.FontScaling = 1.0
        except:
            pass  # If font scaling property doesn't exist, continue

    # Ensure minimal consistency settings that don't override state file settings
    print(f"    Applying minimal consistency settings")
    try:
        from paraview import servermanager
        
        # Only apply settings that help with rendering consistency without overriding state
        for view in GetRenderViews():
            # Ensure consistent font scaling (already handled above, but double-check)
            if hasattr(view, 'FontScaling') and not scale_fonts:
                view.FontScaling = 1.0
            
            # Ensure consistent view size for rendering (but don't reset camera)
            # This helps with layout consistency without changing the actual view
            if hasattr(view, 'ViewSize'):
                # Store original size to maintain state file settings
                original_size = view.ViewSize
                print(f"      View size: {original_size}")
        
        print(f"    Preserved state file settings while ensuring rendering consistency")
    except Exception as e:
        print(f"    Warning: Could not apply consistency settings: {e}")

    # Get all render views from the state
    views = GetRenderViews()
    if not views:
        # Fallback to active view if no views found
        views = [GetActiveViewOrCreate('RenderView')]
    
    print(f"    Found {len(views)} view(s) to render")

    # Determine starting frame once views are known (handles separate view layouts)
    if restart:
        if separate_views and len(views) > 1:
            view_highest_frames = []
            missing_view_indices = []
            
            for view_idx in range(len(views)):
                highest_for_view = find_highest_frame(out_dir, case_name, True, view_idx)
                if highest_for_view is None:
                    missing_view_indices.append(view_idx)
                else:
                    view_highest_frames.append(highest_for_view)
            
            if missing_view_indices:
                print(f"    Restart mode: View(s) {', '.join(str(idx) for idx in missing_view_indices)} have no frames; re-rendering all frames for consistency")
                start_frame = 0
            elif view_highest_frames:
                min_highest = min(view_highest_frames)
                max_highest = max(view_highest_frames)
                
                if min_highest != max_highest:
                    print(f"    Restart mode: Detected uneven frame counts across views (min {min_highest}, max {max_highest}); resuming from frame_{min_highest + 1:04d}")
                else:
                    print(f"    Restart mode: Found frames up to frame_{max_highest:04d} across all views; resuming from frame_{max_highest + 1:04d}")
                
                start_frame = min_highest + 1
            else:
                print(f"    Restart mode: No existing frames detected; starting from frame_0000")
                start_frame = 0
        else:
            highest_frame = find_highest_frame(out_dir, case_name, False)
            if highest_frame is not None:
                start_frame = highest_frame + 1
                print(f"    Restart mode: Found frames up to frame_{highest_frame:04d}, resuming from frame_{start_frame:04d}")
            else:
                print(f"    Restart mode: No existing frames detected; starting from frame_0000")
                start_frame = 0

    # Get animation scene and update with data timesteps
    scene = GetAnimationScene()
    scene.UpdateAnimationUsingDataTimeSteps()
    tkeeper = GetTimeKeeper()

    # Get total number of timesteps
    num_timesteps = len(tkeeper.TimestepValues)
    print(f"    Found {num_timesteps} timesteps")
    
    # Check if we have any timesteps to render
    if num_timesteps == 0:
        raise ValueError(f"No timesteps found in the simulation data!\n" +
                        f"       Check that simulation output files exist in: {data_dir}")
    
    # Check if restart mode indicates all frames are already complete
    if restart and start_frame >= num_timesteps:
        print(f"    ℹ️  All frames already rendered (found frames 0-{start_frame-1}, total timesteps: {num_timesteps})")
        print(f"    Skipping frame rendering, proceeding to video generation (if enabled)")
        # Skip to video generation
        if generate_video_flag:
            generate_video(out_dir, case_name, fps, separate_views, len(views), video_quality)
        else:
            print(f"    Skipping video generation (--no-video specified)")
        return

    # Iterate through each timestep and save screenshots
    import time as time_module
    start_render_time = time_module.time()
    
    # Track number of frames actually rendered (for accurate ETA calculation)
    frames_rendered_count = 0
    
    # Enumerate all timesteps but skip those before start_frame
    for i, t in enumerate(tkeeper.TimestepValues):
        # Skip frames that were already rendered (restart mode)
        if i < start_frame:
            continue
            
        timestep_start = time_module.time()
        
        # Jump to this timestep
        tkeeper.Time = t

        if separate_views:
            # Render each view separately
            for view_idx, view in enumerate(views):
                # Get resolution - either from override or from state
                if override_resolution is not None:
                    width, height = override_resolution
                    # DON'T modify view.ViewSize - this affects the camera/viewport
                    # Just use the override resolution for the screenshot
                else:
                    # Use the resolution from the state file
                    width, height = view.ViewSize

                # Set transparent background if requested
                if transparent:
                    view.UseTransparentBackground = 1

                # Render the view
                Render(view)

                # Create filename with case name and view index
                if len(views) > 1:
                    frame_filename = os.path.join(out_dir, f"{case_name}_view_{view_idx:02d}_frame_{i:04d}.png")
                else:
                    frame_filename = os.path.join(out_dir, f"{case_name}_frame_{i:04d}.png")

                # Save screenshot
                try:
                    SaveScreenshot(
                        frame_filename,
                        view,
                        ImageResolution=[width, height],
                        CompressionLevel=compression,
                        TransparentBackground=int(transparent)
                    )
                except Exception as e:
                    raise RuntimeError(f"Failed to save screenshot: {frame_filename}\n" +
                                     f"       Error: {str(e)}")
        else:
            # Render all views combined (tiled layout)
            if len(views) > 1:
                # Use the existing layout from the state file
                layout = GetLayout()
                if layout is None:
                    # Fallback: create a simple layout
                    layout = CreateLayout('TiledLayout')
                
                # Equalize view sizes to ensure consistent pane proportions
                try:
                    from paraview.simple import layout as layoutmod
                    layoutmod.EqualizeViewsBoth(layout)
                    print(f"    Equalized view sizes for consistent proportions")
                except Exception as e:
                    print(f"    Note: Could not equalize views: {e}")
                
                # Set transparent background if requested
                if transparent:
                    for view in views:
                        view.UseTransparentBackground = 1

                # Save screenshot of the entire layout using SaveAllViews
                # This preserves each view's camera and aspect ratio correctly
                frame_filename = os.path.join(out_dir, f"{case_name}_frame_{i:04d}.png")
                try:
                    SaveScreenshot(
                        frame_filename,
                        layout,
                        SaveAllViews=1,  # Let ParaView handle the layout rendering correctly
                        CompressionLevel=compression,
                        TransparentBackground=int(transparent)
                    )
                except Exception as e:
                    raise RuntimeError(f"Failed to save screenshot: {frame_filename}\n" +
                                     f"       Error: {str(e)}")
            else:
                # Single view case
                view = views[0]
                
                # Get resolution - either from override or from state
                if override_resolution is not None:
                    width, height = override_resolution
                    # DON'T modify view.ViewSize - this affects the camera/viewport
                    # Just use the override resolution for the screenshot
                else:
                    # Use the resolution from the state file
                    width, height = view.ViewSize

                # Set transparent background if requested
                if transparent:
                    view.UseTransparentBackground = 1

                # Render the view
                Render(view)

                # Save screenshot
                frame_filename = os.path.join(out_dir, f"{case_name}_frame_{i:04d}.png")
                try:
                    SaveScreenshot(
                        frame_filename,
                        view,
                        ImageResolution=[width, height],
                        CompressionLevel=compression,
                        TransparentBackground=int(transparent)
                    )
                except Exception as e:
                    raise RuntimeError(f"Failed to save screenshot: {frame_filename}\n" +
                                     f"       Error: {str(e)}")

        # Increment count of frames actually rendered
        frames_rendered_count += 1
        
        # Print progress with estimated time remaining
        timestep_duration = time_module.time() - timestep_start
        elapsed_time = time_module.time() - start_render_time
        
        if frames_rendered_count > 1:  # Only estimate after first rendered frame
            avg_time_per_timestep = elapsed_time / frames_rendered_count
            remaining_timesteps = num_timesteps - (i + 1)
            estimated_remaining = avg_time_per_timestep * remaining_timesteps
            
            # Format time strings
            if estimated_remaining < 60:
                eta_str = f"{estimated_remaining:.0f}s"
            elif estimated_remaining < 3600:
                eta_str = f"{estimated_remaining/60:.1f}m"
            else:
                eta_str = f"{estimated_remaining/3600:.1f}h"
            
            progress_percent = ((i + 1) / num_timesteps) * 100
            
            if separate_views and len(views) > 1:
                print(f"      [{progress_percent:5.1f}%] Saved {len(views)} views for timestep {i+1}/{num_timesteps} ({timestep_duration:.2f}s, ETA: {eta_str})")
            else:
                print(f"      [{progress_percent:5.1f}%] Saved timestep {i+1}/{num_timesteps} ({timestep_duration:.2f}s, ETA: {eta_str})")
        else:
            # First timestep rendered - no ETA yet
            progress_percent = ((i + 1) / num_timesteps) * 100
            if separate_views and len(views) > 1:
                print(f"      [{progress_percent:5.1f}%] Saved {len(views)} separate views for timestep {i+1}/{num_timesteps} ({timestep_duration:.2f}s)")
            else:
                print(f"      [{progress_percent:5.1f}%] Saved timestep {i+1}/{num_timesteps} ({timestep_duration:.2f}s)")

    # Calculate total rendering time
    total_render_time = time_module.time() - start_render_time
    if total_render_time < 60:
        time_str = f"{total_render_time:.1f}s"
    elif total_render_time < 3600:
        time_str = f"{total_render_time/60:.1f}m"
    else:
        time_str = f"{total_render_time/3600:.1f}h"
    
    # Report frames rendered in this session
    if restart and start_frame > 0:
        if separate_views:
            print(f"    ✅ Completed rendering {frames_rendered_count} timesteps (frames {start_frame}-{num_timesteps-1}) across {len(views)} separate view(s) in {time_str}")
        else:
            print(f"    ✅ Completed rendering {frames_rendered_count} timesteps (frames {start_frame}-{num_timesteps-1}) with combined view layout in {time_str}")
    else:
        if separate_views:
            print(f"    ✅ Completed rendering {frames_rendered_count} timesteps across {len(views)} separate view(s) in {time_str}")
        else:
            print(f"    ✅ Completed rendering {frames_rendered_count} timesteps with combined view layout in {time_str}")
    
    # Generate video from the frames if requested
    if generate_video_flag:
        generate_video(out_dir, case_name, fps, separate_views, len(views), video_quality)
    else:
        print(f"    Skipping video generation (--no-video specified)")

def check_ffmpeg_available():
    """
    Check if ffmpeg is available in the system PATH
    
    Returns:
        bool: True if ffmpeg is available, False otherwise
    """
    import subprocess
    try:
        # Try to run ffmpeg with version flag
        result = subprocess.run(['ffmpeg', '-version'], capture_output=True, text=True, check=False)
        return result.returncode == 0
    except FileNotFoundError:
        return False

def generate_video(out_dir, case_name, fps, separate_views, num_views, video_quality):
    """
    Generate MP4 video from PNG frames using ffmpeg
    
    Args:
        out_dir (str): Directory containing the PNG frames
        case_name (str): Name of the case (used for video filename)
        fps (int): Framerate for the video
        separate_views (bool): Whether separate view videos should be generated
        num_views (int): Number of views (for separate view mode)
        video_quality (int): Video quality CRF value (0-51, lower is better)
    """
    import subprocess
    
    # Check if ffmpeg is available
    if not check_ffmpeg_available():
        print(f"    ❌ Error: ffmpeg not found in system PATH")
        print(f"    Please install ffmpeg to generate videos")
        print(f"    Frames have been saved, but video generation is skipped")
        return
    
    print(f"    Generating video(s) at {fps} FPS...")
    
    if separate_views and num_views > 1:
        # Generate separate videos for each view
        for view_idx in range(num_views):
            video_filename = os.path.join(out_dir, f"{case_name}_view_{view_idx:02d}.mp4")
            frame_pattern = os.path.join(out_dir, f"{case_name}_view_{view_idx:02d}_frame_%04d.png")
            
            # Check if frames exist
            first_frame = os.path.join(out_dir, f"{case_name}_view_{view_idx:02d}_frame_0000.png")
            if not os.path.exists(first_frame):
                print(f"    Warning: No frames found for view {view_idx}, skipping video generation")
                continue
            
            try:
                # Run ffmpeg command with quality control
                cmd = [
                    'ffmpeg', '-y',  # -y to overwrite output files
                    '-framerate', str(fps),
                    '-i', frame_pattern,
                    '-vf', 'scale=ceil(iw/2)*2:ceil(ih/2)*2',  # Ensure even dimensions
                    '-c:v', 'libx264',
                    '-crf', str(video_quality),  # Quality control (lower is better)
                    '-pix_fmt', 'yuv420p',
                    video_filename
                ]
                
                print(f"    Creating video: {video_filename} (CRF={video_quality})")
                result = subprocess.run(cmd, capture_output=True, text=True, check=True)
                print(f"    Success: {video_filename}")
                
            except subprocess.CalledProcessError as e:
                print(f"    ❌ Error creating video for view {view_idx}: {e}")
                if e.stderr:
                    print(f"    ffmpeg error: {e.stderr}")
                print(f"    Frames are saved, but video generation failed")
            except FileNotFoundError:
                print(f"    ❌ Error: ffmpeg not found. Please install ffmpeg to generate videos.")
                return
            except Exception as e:
                print(f"    ❌ Unexpected error during video generation: {e}")
                return
    else:
        # Generate single video for combined views
        video_filename = os.path.join(out_dir, f"{case_name}.mp4")
        frame_pattern = os.path.join(out_dir, f"{case_name}_frame_%04d.png")
        
        # Check if frames exist
        first_frame = os.path.join(out_dir, f"{case_name}_frame_0000.png")
        if not os.path.exists(first_frame):
            print(f"    Warning: No frames found, skipping video generation")
            return
        
        try:
            # Run ffmpeg command with quality control
            cmd = [
                'ffmpeg', '-y',  # -y to overwrite output files
                '-framerate', str(fps),
                '-i', frame_pattern,
                '-vf', 'scale=ceil(iw/2)*2:ceil(ih/2)*2',  # Ensure even dimensions
                '-c:v', 'libx264',
                '-crf', str(video_quality),  # Quality control (lower is better)
                '-pix_fmt', 'yuv420p',
                video_filename
            ]
            
            print(f"    Creating video: {video_filename} (CRF={video_quality})")
            result = subprocess.run(cmd, capture_output=True, text=True, check=True)
            print(f"    Success: {video_filename}")
            
        except subprocess.CalledProcessError as e:
            print(f"    ❌ Error creating video: {e}")
            if e.stderr:
                print(f"    ffmpeg error: {e.stderr}")
            print(f"    Frames are saved, but video generation failed")
        except FileNotFoundError:
            print(f"    ❌ Error: ffmpeg not found. Please install ffmpeg to generate videos.")
        except Exception as e:
            print(f"    ❌ Unexpected error during video generation: {e}")

def main():
    """Main function to process all sweep cases"""

    print("="*60)
    print("ParaView Sweep Video Frame Generator")
    print("="*60)
    
    # Check if running with pvpython
    try:
        from paraview.simple import GetActiveViewOrCreate
        # If we can import ParaView, we're good
    except ImportError:
        print("\n" + "="*60)
        print("❌ ERROR: ParaView module not found!")
        print("="*60)
        print("\nThis script must be run with pvpython, not regular python.")
        print("Usage: pvpython sweep-videos.py [options]")
        print("\nIf pvpython is not in your PATH, you can use the full path:")
        print("  /path/to/ParaView/bin/pvpython sweep-videos.py")
        return

    # Parse command-line arguments
    args = parse_arguments()
    
    # Validate command-line arguments
    print("\nValidating arguments...")
    validation_errors = []
    
    # Validate FPS
    if args.fps <= 0:
        validation_errors.append(f"  ❌ FPS must be positive (got {args.fps})")
    elif args.fps > 120:
        print(f"  ⚠️  Warning: FPS is very high ({args.fps}), typical values are 24-60")
    
    # Validate video quality (already constrained by argparse, but double-check)
    if not (0 <= args.video_quality <= 51):
        validation_errors.append(f"  ❌ Video quality (CRF) must be 0-51 (got {args.video_quality})")
    
    # Validate compression level (already constrained by argparse, but double-check)
    if not (0 <= args.compression <= 9):
        validation_errors.append(f"  ❌ Compression level must be 0-9 (got {args.compression})")
    
    # Validate GPU ID
    if args.gpu_id < 0:
        validation_errors.append(f"  ❌ GPU ID must be non-negative (got {args.gpu_id})")
    
    # Validate max_workers if specified
    if args.max_workers is not None:
        if args.max_workers <= 0:
            validation_errors.append(f"  ❌ Max workers must be positive (got {args.max_workers})")
        elif args.max_workers > cpu_count():
            print(f"  ⚠️  Warning: Max workers ({args.max_workers}) exceeds CPU count ({cpu_count()})")
    
    # Check for gpu-per-worker without parallel
    if args.gpu_per_worker and not args.parallel:
        print(f"  ⚠️  Warning: --gpu-per-worker has no effect without --parallel")
    
    # If there are validation errors, print them and exit
    if validation_errors:
        print("\n" + "="*60)
        print("❌ ARGUMENT VALIDATION ERRORS:")
        print("="*60)
        for error in validation_errors:
            print(error)
        return
    
    print("  ✅ All arguments validated successfully")

    # Configure GPU before any ParaView operations
    configure_gpu(args.gpu_id)
    
    # Parse resolution override if provided
    override_resolution = parse_resolution(args.resolution)
    if args.resolution and override_resolution:
        print(f"\nOverriding output resolution: {override_resolution[0]}x{override_resolution[1]}")

    # Check if single case mode is requested
    if args.case_path:
        # Single case rendering mode
        print(f"\n🎯 Single Case Rendering Mode")
        case_path = args.case_path
        
        # Verify the case path exists
        if not os.path.isdir(case_path):
            print(f"Error: Case directory not found: {case_path}")
            return
        
        # Determine case name (use provided name or derive from directory)
        if args.case_name:
            case_name = args.case_name
        else:
            # Use the directory name as the case name
            norm_path = os.path.normpath(case_path)
            case_name = os.path.basename(norm_path)
            
            # Handle special case where current directory ('.') results in '.' as name
            if case_name == '.':
                # Use the parent directory name instead, or a default name
                parent_dir = os.path.basename(os.path.dirname(os.path.abspath(norm_path)))
                if parent_dir and parent_dir != os.path.basename(os.path.abspath('.')):
                    case_name = f"{parent_dir}_curr"
                else:
                    case_name = "curr_dir"
        
        print(f"  Case path: {case_path}")
        print(f"  Case name: {case_name}")
        
        # Create a single-case list for processing
        cases = [(case_path, case_name)]
    else:
        # Sweep XML mode (original behavior)
        # Determine sweep XML file to use
        if args.sweep:
            sweep_xml = args.sweep
            if not os.path.isfile(sweep_xml):
                print(f"Error: Specified sweep XML file not found: {sweep_xml}")
                return
        else:
            # Try to find sweep XML automatically
            sweep_xml = find_sweep_xml()
            if sweep_xml is None:
                print(f"Error: No sweep XML file found. Please specify with --sweep or ensure '{DEFAULT_SWEEP_XML}' exists.")
                print(f"       Alternatively, use --case-path to render a single case without sweep XML.")
                return

        # Parse the sweep XML to get all cases
        print(f"\nParsing sweep XML: {sweep_xml}")
        try:
            cases = parse_sweep_xml(sweep_xml)
            print(f"Found {len(cases)} cases in sweep")
            
            # Check if sweep XML contained any cases at all
            if len(cases) == 0:
                print(f"\n" + "="*60)
                print(f"❌ ERROR: No valid cases found in sweep XML!")
                print(f"="*60)
                print(f"\nThe sweep XML file exists but contains no valid <Case> elements")
                print(f"with both 'CasePath' and 'Name' attributes.")
                return
        except Exception as e:
            print(f"\n" + "="*60)
            print(f"❌ ERROR: Failed to parse sweep XML!")
            print(f"="*60)
            print(f"{e}")
            return

    # Check if a global state file was provided
    global_state_file = args.state
    if global_state_file:
        if not os.path.isfile(global_state_file):
            print(f"Error: Specified state file not found: {global_state_file}")
            return
        print(f"\nUsing global state file: {global_state_file}")
    else:
        print(f"\nState files will be auto-detected in each case directory")

    # Prepare case data for processing
    print(f"\nPreparing cases for processing...")
    case_data_list = []
    skipped_cases = []
    
    for case_path, case_name in cases:
        # Check if case directory exists
        if not os.path.isdir(case_path):
            print(f"  ⚠️  Warning: Case directory not found, skipping: {case_path}")
            skipped_cases.append((case_name, "directory not found"))
            continue

        # Determine which state file to use
        if global_state_file:
            state_file = global_state_file
        else:
            state_file = find_state_file(case_path, args.state_dir)
            if state_file is None:
                print(f"  ⚠️  Skipping case (no state file found): {case_name}")
                skipped_cases.append((case_name, "no state file"))
                continue

        # Define output directory for this case
        out_dir = os.path.join(case_path, args.output_dir)
        
        # Prepare arguments dictionary for worker
        args_dict = {
            'gpu_id': args.gpu_id,
            'resolution': args.resolution,
            'transparent': args.transparent,
            'compression': args.compression,
            'separate_views': args.separate_views,
            'scale_fonts': args.scale_fonts,
            'fps': args.fps,
            'no_video': args.no_video,
            'video_quality': args.video_quality,
            'restart': args.restart
        }
        
        # Worker GPU ID will be assigned later if --gpu-per-worker is used
        case_data_list.append((case_path, case_name, state_file, out_dir, args_dict, None))
        print(f"  ✅ Prepared: {case_name}")
    
    # Print summary of case preparation
    print(f"\n" + "-"*60)
    print(f"Case Preparation Summary:")
    print(f"  Total cases in sweep: {len(cases)}")
    print(f"  Cases ready to process: {len(case_data_list)}")
    print(f"  Cases skipped: {len(skipped_cases)}")
    if skipped_cases:
        print(f"\n  Skipped cases:")
        for case_name, reason in skipped_cases:
            print(f"    - {case_name}: {reason}")
    print("-"*60)

    # Check if we have any valid cases to process
    if not case_data_list:
        print("\n" + "="*60)
        print("❌ ERROR: No valid cases to process!")
        print("="*60)
        print("\nPossible reasons:")
        print("  1. No case directories found in sweep XML")
        print("  2. Case directories don't exist")
        print("  3. No .pvsm state files found in case directories")
        print("\nSuggestions:")
        print("  - Verify case paths in sweep XML are correct")
        print("  - Check that out/Output directories contain .pvsm files")
        print("  - Use --state to specify a global state file")
        print("  - Use --state-dir to specify custom state file location")
        return

    # Process cases (parallel or sequential)
    if args.parallel and len(case_data_list) > 1:
        # Parallel processing - use intelligent default for high-end systems
        if args.max_workers:
            max_workers = args.max_workers
        else:
            # Auto-detect optimal worker count
            # For systems with many GPUs, limit workers to prevent overhead
            max_workers = min(MAX_RECOMMENDED_WORKERS, len(case_data_list))
        
        print(f"\n🚀 Starting parallel CASE processing with {max_workers} workers...")
        print(f"   System: {cpu_count()} CPU cores detected")
        print(f"   NOTE: Each worker renders ONE complete case (all timesteps) sequentially")
        
        # Assign GPU IDs to workers if --gpu-per-worker is enabled
        if args.gpu_per_worker:
            print(f"   GPU Mode: Each case assigned to different GPU (cycling through 8 GPUs)")
            updated_case_data = []
            for idx, (case_path, case_name, state_file, out_dir, args_dict, _) in enumerate(case_data_list):
                gpu_id = idx % 8  # Cycle through 8 GPUs
                updated_case_data.append((case_path, case_name, state_file, out_dir, args_dict, gpu_id))
            case_data_list = updated_case_data
        else:
            print(f"   Single GPU Mode: All cases use GPU {args.gpu_id}")
        
        start_time = time.time()
        
        with Pool(processes=max_workers) as pool:
            results = pool.map(worker_render_case, case_data_list)
        
        end_time = time.time()
        total_time = end_time - start_time
        
        # Process results
        successful_cases = 0
        failed_cases = 0
        
        for case_name, success, error_msg in results:
            if success:
                print(f"  ✅ Success: {case_name}")
                successful_cases += 1
            else:
                print(f"  ❌ Failed: {case_name} - {error_msg}")
                failed_cases += 1
        
        print(f"\n⚡ Parallel processing completed in {total_time:.1f} seconds")
        print(f"   Successful: {successful_cases}, Failed: {failed_cases}")
        
    else:
        # Sequential processing (original behavior)
        print(f"\n🔄 Starting sequential processing...")
        start_time = time.time()
        
        for idx, (case_path, case_name, state_file, out_dir, args_dict, worker_gpu_id) in enumerate(case_data_list):
            print(f"\n[{idx+1}/{len(case_data_list)}] Processing case: {case_name}")
            print(f"  Case path: {case_path}")
            
            if global_state_file:
                print(f"    Using global state file")
            
            try:
                render_case_frames(
                    case_path,
                    case_name,
                    state_file,
                    out_dir,
                    override_resolution,
                    args.transparent,
                    args.compression,
                    args.separate_views,
                    args.scale_fonts,
                    args.fps,
                    not args.no_video,
                    args.video_quality,
                    args.restart
                )
                print(f"  Success! Frames saved to: {out_dir}")
            except Exception as e:
                print(f"  Error rendering case: {e}")
                import traceback
                traceback.print_exc()
                continue
        
        end_time = time.time()
        total_time = end_time - start_time
        print(f"\n🔄 Sequential processing completed in {total_time:.1f} seconds")

    print("\n" + "="*60)
    print("All cases processed!")
    print("="*60)

if __name__ == "__main__":
    main()
