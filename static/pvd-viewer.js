/**
 * PVD Viewer — vtk.js 3D Visualization for M-Star CFD Output
 * ===========================================================
 * Uses vtk.js UMD bundle (global `vtk` namespace).
 * Loaded as a regular <script> tag after vtk.js.
 */
(function() {
    'use strict';

    // vtk.js class accessors (UMD global namespace)
    function getVtkClasses() {
        if (typeof vtk === 'undefined') {
            console.error('[PVD Viewer] vtk.js not loaded');
            return null;
        }
        return {
            vtkFullScreenRenderWindow: vtk.Rendering.Misc.vtkFullScreenRenderWindow,
            vtkActor: vtk.Rendering.Core.vtkActor,
            vtkMapper: vtk.Rendering.Core.vtkMapper,
            vtkXMLPolyDataReader: vtk.IO.XML.vtkXMLPolyDataReader,
            vtkXMLImageDataReader: vtk.IO.XML.vtkXMLImageDataReader,
            vtkColorTransferFunction: vtk.Rendering.Core.vtkColorTransferFunction,
            vtkDataArray: vtk.Common.Core.vtkDataArray,
            // Vector glyph support
            vtkArrowSource: vtk.Filters.Sources.vtkArrowSource,
            vtkGlyph3DMapper: vtk.Rendering.Core.vtkGlyph3DMapper,
        };
    }

    // Colormap presets (parameter position, R, G, B)
    const COLORMAPS = {
        'Cool to Warm': [
            [0.0, 0.231, 0.298, 0.753],
            [0.5, 0.865, 0.865, 0.865],
            [1.0, 0.706, 0.016, 0.150],
        ],
        'Rainbow': [
            [0.0, 0.278, 0.278, 0.859],
            [0.143, 0.0, 0.0, 1.0],
            [0.286, 0.0, 1.0, 1.0],
            [0.429, 0.0, 1.0, 0.0],
            [0.571, 1.0, 1.0, 0.0],
            [0.714, 1.0, 0.380, 0.0],
            [0.857, 1.0, 0.0, 0.0],
            [1.0, 0.878, 0.0, 0.0],
        ],
        'Viridis': [
            [0.0, 0.267, 0.004, 0.329],
            [0.25, 0.282, 0.141, 0.457],
            [0.5, 0.127, 0.566, 0.551],
            [0.75, 0.544, 0.773, 0.247],
            [1.0, 0.993, 0.906, 0.144],
        ],
        'Plasma': [
            [0.0, 0.050, 0.030, 0.528],
            [0.25, 0.495, 0.012, 0.658],
            [0.5, 0.798, 0.280, 0.470],
            [0.75, 0.973, 0.585, 0.254],
            [1.0, 0.940, 0.975, 0.131],
        ],
        'Jet': [
            [0.0, 0.0, 0.0, 0.5],
            [0.11, 0.0, 0.0, 1.0],
            [0.34, 0.0, 1.0, 1.0],
            [0.5, 0.0, 1.0, 0.0],
            [0.65, 1.0, 1.0, 0.0],
            [0.89, 1.0, 0.0, 0.0],
            [1.0, 0.5, 0.0, 0.0],
        ],
    };

    // Viewer state
    var viewerState = null;

    function getToken() {
        return localStorage.getItem('mstar_token') || '';
    }

    /**
     * Open the PVD viewer for a given job/file
     */
    function openPvdViewer(jobId, pvdPath) {
        // Show loading overlay immediately
        var overlay = document.createElement('div');
        overlay.className = 'pvd-viewer-overlay';
        overlay.id = 'pvd-viewer-overlay';
        overlay.innerHTML =
            '<div class="pvd-viewer-header">' +
            '  <div class="pvd-viewer-title">' +
            '    <span>Loading PVD Viewer...</span>' +
            '  </div>' +
            '  <button class="pvd-viewer-close" id="pvd-close-btn">&times;</button>' +
            '</div>' +
            '<div class="pvd-controls pvd-controls-top" id="pvd-controls-top" style="display:none;"></div>' +
            '<div class="pvd-canvas-container" id="pvd-canvas-container">' +
            '  <div class="pvd-loading-overlay" id="pvd-loading">' +
            '    <div class="spinner"></div>' +
            '    <div class="pvd-loading-text">Parsing PVD file...</div>' +
            '  </div>' +
            '</div>' +
            '<div class="pvd-controls" id="pvd-controls" style="display:none;"></div>';
        document.body.appendChild(overlay);

        document.getElementById('pvd-close-btn').addEventListener('click', closePvdViewer);

        // Check vtk.js is loaded
        var vtkClasses = getVtkClasses();
        if (!vtkClasses) {
            showViewerError('vtk.js library failed to load. Check browser console.');
            return;
        }

        // Fetch PVD info
        fetch('/api/jobs/' + jobId + '/files/pvd-info?path=' + encodeURIComponent(pvdPath), {
            headers: { 'Authorization': 'Bearer ' + getToken() }
        })
        .then(function(r) { return r.json(); })
        .then(function(pvdInfo) {
            if (pvdInfo.error) {
                showViewerError(pvdInfo.error);
                return;
            }
            if (!pvdInfo.timesteps || pvdInfo.timesteps.length === 0) {
                showViewerError('No timesteps found in PVD file');
                return;
            }
            // Update title
            var fname = pvdPath.split('/').pop();
            overlay.querySelector('.pvd-viewer-title span').textContent = fname;

            initializeViewer(vtkClasses, jobId, pvdPath, pvdInfo);
        })
        .catch(function(err) {
            console.error('[PVD Viewer] Init error:', err);
            showViewerError('Failed to initialize: ' + err.message);
        });
    }

    function showViewerError(msg) {
        var loading = document.getElementById('pvd-loading');
        if (loading) {
            loading.innerHTML =
                '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--accent-red)" stroke-width="1.5">' +
                '<circle cx="12" cy="12" r="10"></circle>' +
                '<line x1="15" y1="9" x2="9" y2="15"></line>' +
                '<line x1="9" y1="9" x2="15" y2="15"></line>' +
                '</svg>' +
                '<div class="pvd-loading-text" style="color:var(--accent-red);">' + escapeHtml(msg) + '</div>' +
                '<button class="btn btn-secondary btn-sm" onclick="window._pvdViewer.closePvdViewer()">Close</button>';
        }
    }

    function initializeViewer(vtkClasses, jobId, pvdPath, pvdInfo) {
        var container = document.getElementById('pvd-canvas-container');
        var controlsEl = document.getElementById('pvd-controls');
        var controlsTopEl = document.getElementById('pvd-controls-top');

        // Initialize the VTK render window
        var fullScreenRenderWindow = vtkClasses.vtkFullScreenRenderWindow.newInstance({
            rootContainer: container,
            containerStyle: { height: '100%', width: '100%', position: 'absolute' },
            background: [0.02, 0.03, 0.06],
        });

        var renderer = fullScreenRenderWindow.getRenderer();
        var renderWindow = fullScreenRenderWindow.getRenderWindow();

        // Add HTML-based axis indicator (clean labeled arrows)
        createAxisIndicator(container, renderer, renderWindow);

        // Determine scalar arrays (single-component for coloring)
        var scalarArrays = (pvdInfo.arrays || []).filter(function(a) { return a.components === 1; });

        // Default active array
        var activeArrayName = '';
        var velMag = scalarArrays.find(function(a) { return a.name.toLowerCase().indexOf('velocity magnitude') >= 0; });
        var pressure = scalarArrays.find(function(a) { return a.name.toLowerCase().indexOf('pressure') >= 0; });
        if (velMag) activeArrayName = velMag.name;
        else if (pressure) activeArrayName = pressure.name;
        else if (scalarArrays.length > 0) activeArrayName = scalarArrays[0].name;

        // Build LUT
        var lut = vtkClasses.vtkColorTransferFunction.newInstance();
        applyColormap(lut, 'Jet', 0, 1);

        // Build viewer state
        viewerState = {
            vtkClasses: vtkClasses,
            jobId: jobId,
            pvdPath: pvdPath,
            pvdInfo: pvdInfo,
            renderer: renderer,
            renderWindow: renderWindow,
            fullScreenRenderWindow: fullScreenRenderWindow,
            actors: [],
            currentTimestepIdx: pvdInfo.timesteps.length - 1,
            activeArrayName: activeArrayName,
            colormap: 'Jet',
            rangeMin: null,
            rangeMax: null,
            autoRange: true,
            playing: false,
            playTimer: null,
            lut: lut,
            firstLoad: true,
            opacity: 1.0,
            legendPosition: 'right',
            opacityMappingEnabled: false,
            opacityPoints: [{x: 0, o: 1}, {x: 0.25, o: 1}, {x: 0.5, o: 1}, {x: 0.75, o: 1}, {x: 1, o: 1}],
            opacityEditorVisible: false,
            // Vector glyph state
            vectorGlyphsEnabled: false,
            vectorGlyphActors: [],
            vectorGlyphScale: 3.0,      // arrow length in multiples of grid spacing
            vectorGlyphDensity: 1000,    // target number of arrows
            vectorGlyphLut: vtkClasses.vtkColorTransferFunction.newInstance(),
            lastLoadedPolydatas: [],     // cached for glyph rebuild
        };

        // Build controls
        buildControls(controlsTopEl, controlsEl, pvdInfo, scalarArrays);
        controlsTopEl.style.display = 'flex';
        controlsEl.style.display = 'flex';

        // Load initial timestep
        loadTimestep(viewerState.currentTimestepIdx);
    }

    function buildControls(topEl, bottomEl, pvdInfo, scalarArrays) {
        var st = viewerState;
        var ts = pvdInfo.timesteps;
        var lastIdx = ts.length - 1;

        var arrayOpts = '';
        if (scalarArrays.length > 0) {
            arrayOpts = scalarArrays.map(function(a) {
                var sel = (a.name === st.activeArrayName) ? ' selected' : '';
                return '<option value="' + a.name + '"' + sel + '>' + a.name + '</option>';
            }).join('');
        } else {
            arrayOpts = '<option value="">No scalar data</option>';
        }

        var cmapOpts = Object.keys(COLORMAPS).map(function(name) {
            var sel = (name === st.colormap) ? ' selected' : '';
            return '<option value="' + name + '"' + sel + '>' + name + '</option>';
        }).join('');

        // TOP BAR: Transport + Time only
        topEl.innerHTML =
            '<div class="pvd-controls-group pvd-transport-group" id="pvd-transport-group">' +
            '  <button class="pvd-play-btn" id="pvd-step-back" title="Previous timestep">\u23EE</button>' +
            '  <button class="pvd-play-btn" id="pvd-play-pause" title="Play/Pause">\u25B6</button>' +
            '  <button class="pvd-play-btn" id="pvd-step-fwd" title="Next timestep">\u23ED</button>' +
            '</div>' +
            '<div class="pvd-timestep-group">' +
            '  <span class="pvd-controls-label">Time</span>' +
            '  <input type="range" class="pvd-timestep-slider" id="pvd-ts-slider" min="0" max="' + lastIdx + '" value="' + lastIdx + '" step="1">' +
            '  <span class="pvd-timestep-value" id="pvd-ts-display">' + _timestepLabel(ts[lastIdx]) + '</span>' +
            '  <div class="pvd-transport-spinner" id="pvd-transport-spinner" style="display:none;"></div>' +
            '</div>';

        // BOTTOM BAR: Rotate, Color By, Colormap, Range, Opacity, Legend
        bottomEl.innerHTML =
            '<div class="pvd-controls-group">' +
            '  <button class="pvd-play-btn" id="pvd-rotate-left" title="Rotate view left 90°">\u21B6</button>' +
            '  <button class="pvd-play-btn" id="pvd-rotate-right" title="Rotate view right 90°">\u21B7</button>' +
            '</div>' +
            '<div class="pvd-controls-group">' +
            '  <span class="pvd-controls-label">Color By</span>' +
            '  <select id="pvd-array-select">' + arrayOpts + '</select>' +
            '</div>' +
            '<div class="pvd-controls-group">' +
            '  <span class="pvd-controls-label">Colormap</span>' +
            '  <select id="pvd-cmap-select">' + cmapOpts + '</select>' +
            '</div>' +
            '<div class="pvd-controls-group">' +
            '  <span class="pvd-controls-label">Range</span>' +
            '  <input type="number" class="pvd-range-input" id="pvd-range-min" placeholder="min" step="any">' +
            '  <span style="color:var(--text-muted);">\u2013</span>' +
            '  <input type="number" class="pvd-range-input" id="pvd-range-max" placeholder="max" step="any">' +
            '  <button class="pvd-play-btn" id="pvd-range-auto" title="Auto range" style="font-size:10px;">Auto</button>' +
            '</div>' +
            '<div class="pvd-controls-group">' +
            '  <button class="pvd-play-btn pvd-opacity-toggle" id="pvd-opacity-toggle" title="Opacity Transfer Function">Opacity \u25BC</button>' +
            '</div>' +
            '<div class="pvd-controls-group pvd-vector-controls">' +
            '  <button class="pvd-play-btn" id="pvd-vector-toggle" title="Toggle velocity arrows">\u279C Arrows</button>' +
            '  <label class="pvd-controls-label" style="margin-left:6px;">Scale</label>' +
            '  <input type="range" id="pvd-vector-scale" min="0.5" max="15" step="0.5" value="3" style="width:60px;display:none;">' +
            '  <label class="pvd-controls-label" style="margin-left:6px;">Density</label>' +
            '  <input type="range" id="pvd-vector-density" min="200" max="5000" step="100" value="1000" style="width:60px;display:none;">' +
            '</div>' +
            '<div class="pvd-controls-group">' +
            '  <span class="pvd-controls-label">Legend</span>' +
            '  <select id="pvd-legend-pos">' +
            '    <option value="right" selected>Right</option>' +
            '    <option value="left">Left</option>' +
            '    <option value="top">Top</option>' +
            '    <option value="bottom">Bottom</option>' +
            '    <option value="top-left">Top-Left</option>' +
            '    <option value="top-right">Top-Right</option>' +
            '    <option value="bottom-left">Bottom-Left</option>' +
            '    <option value="bottom-right">Bottom-Right</option>' +
            '    <option value="hidden">Hidden</option>' +
            '  </select>' +
            '</div>';

        // Event listeners
        document.getElementById('pvd-ts-slider').addEventListener('input', function(e) {
            loadTimestep(parseInt(e.target.value));
        });

        document.getElementById('pvd-step-back').addEventListener('click', function() {
            if (viewerState.currentTimestepIdx > 0) {
                var newIdx = viewerState.currentTimestepIdx - 1;
                document.getElementById('pvd-ts-slider').value = newIdx;
                loadTimestep(newIdx);
            }
        });

        document.getElementById('pvd-step-fwd').addEventListener('click', function() {
            var maxIdx = viewerState.pvdInfo.timesteps.length - 1;
            if (viewerState.currentTimestepIdx < maxIdx) {
                var newIdx = viewerState.currentTimestepIdx + 1;
                document.getElementById('pvd-ts-slider').value = newIdx;
                loadTimestep(newIdx);
            }
        });

        document.getElementById('pvd-play-pause').addEventListener('click', togglePlayback);

        document.getElementById('pvd-array-select').addEventListener('change', function(e) {
            viewerState.activeArrayName = e.target.value;
            viewerState.autoRange = true;
            updateColoring();
        });

        document.getElementById('pvd-cmap-select').addEventListener('change', function(e) {
            viewerState.colormap = e.target.value;
            updateColoring();
        });

        document.getElementById('pvd-range-min').addEventListener('change', function(e) {
            viewerState.rangeMin = parseFloat(e.target.value);
            viewerState.autoRange = false;
            updateColoring();
        });

        document.getElementById('pvd-range-max').addEventListener('change', function(e) {
            viewerState.rangeMax = parseFloat(e.target.value);
            viewerState.autoRange = false;
            updateColoring();
        });

        document.getElementById('pvd-range-auto').addEventListener('click', function() {
            viewerState.autoRange = true;
            viewerState.rangeMin = null;
            viewerState.rangeMax = null;
            updateColoring();
        });

        // Rotate buttons
        document.getElementById('pvd-rotate-left').addEventListener('click', function() {
            rotateCamera(-90);
        });
        document.getElementById('pvd-rotate-right').addEventListener('click', function() {
            rotateCamera(90);
        });

        // Opacity transfer function editor toggle
        document.getElementById('pvd-opacity-toggle').addEventListener('click', function() {
            viewerState.opacityEditorVisible = !viewerState.opacityEditorVisible;
            var panel = document.getElementById('pvd-opacity-panel');
            if (viewerState.opacityEditorVisible) {
                if (!panel) {
                    createOpacityEditor();
                } else {
                    panel.style.display = 'block';
                    drawOpacityCurve();
                }
                this.classList.add('active');
                this.textContent = 'Opacity \u25B2';
            } else {
                if (panel) panel.style.display = 'none';
                this.classList.remove('active');
                this.textContent = 'Opacity \u25BC';
            }
        });

        // Vector glyph controls
        document.getElementById('pvd-vector-toggle').addEventListener('click', function() {
            var st = viewerState;
            st.vectorGlyphsEnabled = !st.vectorGlyphsEnabled;
            this.classList.toggle('active', st.vectorGlyphsEnabled);
            this.style.background = st.vectorGlyphsEnabled ? 'var(--accent-blue)' : '';
            this.style.color = st.vectorGlyphsEnabled ? '#fff' : '';
            var scaleEl = document.getElementById('pvd-vector-scale');
            var densityEl = document.getElementById('pvd-vector-density');
            if (scaleEl) scaleEl.style.display = st.vectorGlyphsEnabled ? '' : 'none';
            if (densityEl) densityEl.style.display = st.vectorGlyphsEnabled ? '' : 'none';
            if (st.vectorGlyphsEnabled) {
                buildVectorGlyphs(st);
            } else {
                removeVectorGlyphs(st);
            }
        });

        document.getElementById('pvd-vector-scale').addEventListener('input', function() {
            var st = viewerState;
            st.vectorGlyphScale = parseFloat(this.value);
            if (st.vectorGlyphsEnabled) buildVectorGlyphs(st);
        });

        document.getElementById('pvd-vector-density').addEventListener('input', function() {
            var st = viewerState;
            st.vectorGlyphDensity = parseInt(this.value);
            if (st.vectorGlyphsEnabled) buildVectorGlyphs(st);
        });

        // Legend position
        document.getElementById('pvd-legend-pos').addEventListener('change', function(e) {
            viewerState.legendPosition = e.target.value;
            updateColorbar();
        });
    }

    function loadTimestep(idx) {
        if (!viewerState) return;
        var st = viewerState;
        st.currentTimestepIdx = idx;

        var ts = st.pvdInfo.timesteps[idx];
        if (!ts) return;

        // Update display
        var display = document.getElementById('pvd-ts-display');
        if (display) display.textContent = _timestepLabel(ts);

        // Show spinner on transport controls
        showTransportSpinner();

        // Remove old actors
        st.actors.forEach(function(a) { st.renderer.removeActor(a); });
        st.actors = [];
        // Remove old glyph actors (they'll be rebuilt after new data loads)
        st.vectorGlyphActors.forEach(function(a) { st.renderer.removeActor(a); });
        st.vectorGlyphActors = [];

        // Load all parts for this timestep
        var files = ts.files || [];
        var loadPromises = files.map(function(fileInfo) {
            var filePath = fileInfo.file;
            var fetchUrl;

            if (st.aiMode) {
                // AI artifact mode: file paths in PVD are relative to PVD parent dir
                var pvdDir = st.pvdPath.substring(0, st.pvdPath.lastIndexOf('/') + 1);
                var absFilePath = pvdDir + filePath;
                fetchUrl = '/api/ai/artifacts/vtk-serve?path=' + encodeURIComponent(absFilePath);
            } else {
                // Normal mode: paths relative to job's output directory
                var pvdDir = st.pvdPath.substring(0, st.pvdPath.lastIndexOf('/') + 1);
                var fullPath = pvdDir + filePath;
                fetchUrl = '/api/jobs/' + st.jobId + '/files/vtk-serve?path=' + encodeURIComponent(fullPath);
            }

            return fetch(fetchUrl, {
                headers: { 'Authorization': 'Bearer ' + getToken() }
            })
            .then(function(response) {
                if (!response.ok) {
                    console.warn('[PVD] Failed to load ' + filePath + ': ' + response.status);
                    return null;
                }
                return response.arrayBuffer();
            })
            .then(function(arrayBuffer) {
                if (!arrayBuffer) return null;

                // Server always converts to VTP format
                var reader = st.vtkClasses.vtkXMLPolyDataReader.newInstance();
                reader.parseAsArrayBuffer(arrayBuffer);
                var polydata = reader.getOutputData(0);
                if (!polydata || polydata.getNumberOfPoints() === 0) return null;

                var mapper = st.vtkClasses.vtkMapper.newInstance();
                mapper.setInputData(polydata);

                // Configure scalar coloring — prefer point data for smooth rendering
                if (st.activeArrayName) {
                    var cellData = polydata.getCellData();
                    var pointData = polydata.getPointData();
                    var arr = pointData.getArrayByName(st.activeArrayName);
                    var isCell = false;
                    if (!arr) {
                        arr = cellData.getArrayByName(st.activeArrayName);
                        isCell = true;
                    }

                    if (arr && arr.getNumberOfComponents() === 1) {
                        if (isCell) {
                            mapper.setScalarModeToUseCellFieldData();
                            cellData.setActiveScalars(st.activeArrayName);
                        } else {
                            mapper.setScalarModeToUsePointFieldData();
                            pointData.setActiveScalars(st.activeArrayName);
                        }
                        mapper.setColorByArrayName(st.activeArrayName);
                        mapper.setScalarVisibility(true);
                        mapper.setLookupTable(st.lut);
                        mapper.setInterpolateScalarsBeforeMapping(true);
                    }
                }

                var actor = st.vtkClasses.vtkActor.newInstance();
                actor.setMapper(mapper);
                // Disable backface culling so flat slices are visible from either side
                actor.getProperty().setBackfaceCulling(false);
                actor.getProperty().setFrontfaceCulling(false);

                return { actor: actor, polydata: polydata };
            })
            .catch(function(err) {
                console.warn('[PVD] Error loading ' + fullPath + ':', err);
                return null;
            });
        });

        Promise.all(loadPromises).then(function(results) {
            var globalMin = Infinity, globalMax = -Infinity;

            // If arrays weren't discovered by backend, discover them from data
            if (st.firstLoad && (!st.pvdInfo.arrays || st.pvdInfo.arrays.length === 0)) {
                var discoveredArrays = [];
                results.forEach(function(result) {
                    if (!result) return;
                    var ds = result.polydata;
                    var cd = ds.getCellData();
                    var pd = ds.getPointData();
                    for (var i = 0; i < cd.getNumberOfArrays(); i++) {
                        var a = cd.getArrayByIndex(i);
                        var name = cd.getArrayName(i);
                        if (name && a.getNumberOfComponents() === 1) {
                            if (!discoveredArrays.find(function(x) { return x.name === name; })) {
                                var range = a.getRange();
                                discoveredArrays.push({ name: name, components: 1, range: [range[0], range[1]] });
                            }
                        }
                    }
                    for (var j = 0; j < pd.getNumberOfArrays(); j++) {
                        var pa = pd.getArrayByIndex(j);
                        var pname = pd.getArrayName(j);
                        if (pname && pa.getNumberOfComponents() === 1) {
                            if (!discoveredArrays.find(function(x) { return x.name === pname; })) {
                                var prange = pa.getRange();
                                discoveredArrays.push({ name: pname, components: 1, range: [prange[0], prange[1]] });
                            }
                        }
                    }
                });

                if (discoveredArrays.length > 0) {
                    st.pvdInfo.arrays = discoveredArrays;
                    // Pick default
                    var velMag = discoveredArrays.find(function(a) { return a.name.toLowerCase().indexOf('velocity magnitude') >= 0; });
                    var pressure = discoveredArrays.find(function(a) { return a.name.toLowerCase().indexOf('pressure') >= 0; });
                    if (velMag) st.activeArrayName = velMag.name;
                    else if (pressure) st.activeArrayName = pressure.name;
                    else st.activeArrayName = discoveredArrays[0].name;

                    // Update dropdown
                    var select = document.getElementById('pvd-array-select');
                    if (select) {
                        select.innerHTML = discoveredArrays.map(function(a) {
                            var sel = (a.name === st.activeArrayName) ? ' selected' : '';
                            return '<option value="' + escapeAttr(a.name) + '"' + sel + '>' + escapeHtml(a.name) + '</option>';
                        }).join('');
                    }

                    // Re-apply coloring to existing actors
                    results.forEach(function(result) {
                        if (!result) return;
                        var mapper = result.actor.getMapper();
                        var ds = result.polydata;
                        var cellData = ds.getCellData();
                        var pointData = ds.getPointData();
                        // Prefer point data (smooth interpolation) over cell data (flat/blocky)
                        var arr = pointData.getArrayByName(st.activeArrayName);
                        var isCell = false;
                        if (!arr) { arr = cellData.getArrayByName(st.activeArrayName); isCell = true; }
                        if (arr && arr.getNumberOfComponents() === 1) {
                            if (isCell) {
                                mapper.setScalarModeToUseCellFieldData();
                                cellData.setActiveScalars(st.activeArrayName);
                            } else {
                                mapper.setScalarModeToUsePointFieldData();
                                pointData.setActiveScalars(st.activeArrayName);
                            }
                            mapper.setColorByArrayName(st.activeArrayName);
                            mapper.setScalarVisibility(true);
                            mapper.setLookupTable(st.lut);
                            mapper.setInterpolateScalarsBeforeMapping(true);
                        }
                    });
                }
            }

            // Cache polydatas for vector glyph rebuild
            st.lastLoadedPolydatas = [];

            results.forEach(function(result) {
                if (!result) return;
                st.renderer.addActor(result.actor);
                st.actors.push(result.actor);
                st.lastLoadedPolydatas.push(result.polydata);

                // Get range for active array
                if (st.activeArrayName) {
                    var arr = result.polydata.getPointData().getArrayByName(st.activeArrayName)
                           || result.polydata.getCellData().getArrayByName(st.activeArrayName);
                    if (arr && arr.getNumberOfComponents() === 1) {
                        var range = arr.getRange();
                        if (range[0] < globalMin) globalMin = range[0];
                        if (range[1] > globalMax) globalMax = range[1];
                    }
                }
            });

            // Update range
            if (st.autoRange && globalMin < Infinity) {
                st.rangeMin = globalMin;
                st.rangeMax = globalMax;
                var minInput = document.getElementById('pvd-range-min');
                var maxInput = document.getElementById('pvd-range-max');
                if (minInput) minInput.value = globalMin.toPrecision(5);
                if (maxInput) maxInput.value = globalMax.toPrecision(5);
            }

            // Apply color range
            if (st.rangeMin !== null && st.rangeMax !== null) {
                applyColormap(st.lut, st.colormap, st.rangeMin, st.rangeMax);
                st.actors.forEach(function(a) {
                    a.getMapper().setScalarRange(st.rangeMin, st.rangeMax);
                });
            }

            updateColorbar();

            // Reset camera on first load — auto-orient for 2D slices
            if (st.firstLoad && st.actors.length > 0) {
                st.renderer.resetCamera();
                autoOrientCamera(st);
                st.firstLoad = false;
            }

            // Rebuild vector glyphs if enabled
            if (st.vectorGlyphsEnabled) {
                buildVectorGlyphs(st);
            }

            st.renderWindow.render();
            hideLoading();
        });
    }

    function updateColoring() {
        if (!viewerState || viewerState.actors.length === 0) return;
        var st = viewerState;

        if (st.rangeMin !== null && st.rangeMax !== null) {
            applyColormap(st.lut, st.colormap, st.rangeMin, st.rangeMax);
        }

        st.actors.forEach(function(actor) {
            var mapper = actor.getMapper();
            var polydata = mapper.getInputData();
            if (!polydata) return;

            if (st.activeArrayName) {
                var cellData = polydata.getCellData();
                var pointData = polydata.getPointData();
                // Prefer point data (smooth) over cell data (flat)
                var arr = pointData.getArrayByName(st.activeArrayName);
                var isCell = false;
                if (!arr) {
                    arr = cellData.getArrayByName(st.activeArrayName);
                    isCell = true;
                }

                if (arr && arr.getNumberOfComponents() === 1) {
                    if (isCell) {
                        mapper.setScalarModeToUseCellFieldData();
                        cellData.setActiveScalars(st.activeArrayName);
                    } else {
                        mapper.setScalarModeToUsePointFieldData();
                        pointData.setActiveScalars(st.activeArrayName);
                    }
                    mapper.setColorByArrayName(st.activeArrayName);
                    mapper.setScalarVisibility(true);
                    mapper.setLookupTable(st.lut);
                    mapper.setInterpolateScalarsBeforeMapping(true);

                    if (st.autoRange) {
                        var range = arr.getRange();
                        st.rangeMin = range[0];
                        st.rangeMax = range[1];
                        var minInput = document.getElementById('pvd-range-min');
                        var maxInput = document.getElementById('pvd-range-max');
                        if (minInput) minInput.value = range[0].toPrecision(5);
                        if (maxInput) maxInput.value = range[1].toPrecision(5);
                    }

                    if (st.rangeMin !== null && st.rangeMax !== null) {
                        mapper.setScalarRange(st.rangeMin, st.rangeMax);
                    }
                }
            }
        });

        updateColorbar();
        // If opacity mapping is active, re-apply it (since updateColoring resets mapper mode)
        if (st.opacityMappingEnabled) {
            applyOpacityMapping();
        }
        // Redraw opacity editor canvas if visible (colormap may have changed)
        drawOpacityCurve();
        st.renderWindow.render();
    }

    function applyColormap(lut, cmapName, min, max) {
        var nodes = COLORMAPS[cmapName] || COLORMAPS['Cool to Warm'];
        lut.removeAllPoints();
        for (var i = 0; i < nodes.length; i++) {
            var t = nodes[i][0], r = nodes[i][1], g = nodes[i][2], b = nodes[i][3];
            var val = min + t * (max - min);
            lut.addRGBPoint(val, r, g, b);
        }
        lut.setMappingRange(min, max);
        lut.updateRange();
    }

    // =========================================================================
    // Vector Glyph (Arrow) Visualization
    // =========================================================================

    /**
     * Remove all vector glyph actors from the scene.
     */
    function removeVectorGlyphs(st) {
        st.vectorGlyphActors.forEach(function(a) { st.renderer.removeActor(a); });
        st.vectorGlyphActors = [];
        st.renderWindow.render();
    }

    /**
     * Find a 3-component vector array in the polydata (cell or point data).
     * Returns { array, name, isCell } or null.
     */
    function findVectorArray(polydata) {
        var cd = polydata.getCellData();
        var pd = polydata.getPointData();

        // Search cell data first (M-Star uses cell-centered data)
        for (var i = 0; i < cd.getNumberOfArrays(); i++) {
            var arr = cd.getArrayByIndex(i);
            var name = cd.getArrayName(i);
            if (arr.getNumberOfComponents() === 3 && name && name.toLowerCase().indexOf('velocity') >= 0) {
                return { array: arr, name: name, isCell: true };
            }
        }
        // Then point data
        for (var j = 0; j < pd.getNumberOfArrays(); j++) {
            var parr = pd.getArrayByIndex(j);
            var pname = pd.getArrayName(j);
            if (parr.getNumberOfComponents() === 3 && pname && pname.toLowerCase().indexOf('velocity') >= 0) {
                return { array: parr, name: pname, isCell: false };
            }
        }
        // Fallback: any 3-component array
        for (var k = 0; k < cd.getNumberOfArrays(); k++) {
            if (cd.getArrayByIndex(k).getNumberOfComponents() === 3) {
                return { array: cd.getArrayByIndex(k), name: cd.getArrayName(k), isCell: true };
            }
        }
        return null;
    }

    /**
     * Find a 1-component magnitude array in the polydata.
     */
    function findMagnitudeArray(polydata) {
        var cd = polydata.getCellData();
        var pd = polydata.getPointData();
        var sources = [
            { data: cd, isCell: true },
            { data: pd, isCell: false }
        ];
        for (var s = 0; s < sources.length; s++) {
            var src = sources[s];
            for (var i = 0; i < src.data.getNumberOfArrays(); i++) {
                var arr = src.data.getArrayByIndex(i);
                var name = src.data.getArrayName(i);
                if (arr.getNumberOfComponents() === 1 && name &&
                    (name.toLowerCase().indexOf('magnitude') >= 0 ||
                     name.toLowerCase().indexOf('velocity magnitude') >= 0)) {
                    return { array: arr, name: name, isCell: src.isCell };
                }
            }
        }
        return null;
    }

    /**
     * Build vector glyph actors from cached polydatas.
     * Downsamples to st.vectorGlyphDensity arrows, each oriented by the
     * velocity vector and scaled/colored by magnitude.
     */
    function buildVectorGlyphs(st) {
        // Remove existing glyphs first
        removeVectorGlyphs(st);

        if (!st.lastLoadedPolydatas || st.lastLoadedPolydatas.length === 0) return;

        st.lastLoadedPolydatas.forEach(function(polydata) {
            var vecInfo = findVectorArray(polydata);
            if (!vecInfo) return; // No vector data — can't draw arrows

            var magInfo = findMagnitudeArray(polydata);

            var numCells = polydata.getNumberOfCells();
            var numPoints = polydata.getNumberOfPoints();
            var totalItems = vecInfo.isCell ? numCells : numPoints;
            if (totalItems === 0) return;

            // Compute stride for downsampling
            var targetCount = Math.max(50, st.vectorGlyphDensity);
            var stride = Math.max(1, Math.floor(totalItems / targetCount));
            var sampledCount = Math.ceil(totalItems / stride);

            // Build arrays for the downsampled polydata:
            //   - positions (3 floats per point)
            //   - orientations (3 floats per point — velocity vector)
            //   - magnitudes (1 float per point — for color + scale)
            var positions = new Float32Array(sampledCount * 3);
            var orientations = new Float32Array(sampledCount * 3);
            var magnitudes = new Float32Array(sampledCount);

            var bounds = polydata.getBounds();
            // Estimate grid spacing from bounds and point count
            var dx = (bounds[1] - bounds[0]) || 1;
            var dy = (bounds[3] - bounds[2]) || 1;
            var dz = (bounds[5] - bounds[4]) || 1;
            // For a 2D slice, one dimension will be ~0
            var dims = [];
            if (dx > 1e-6) dims.push(dx);
            if (dy > 1e-6) dims.push(dy);
            if (dz > 1e-6) dims.push(dz);
            var estimatedSpacing = dims.length > 0
                ? Math.sqrt(dims.reduce(function(a, b) { return a * b; }, 1) / totalItems)
                : 0.01;

            var maxMag = 0;
            var idx = 0;

            // Pre-compute cell centers for cell data using the polys connectivity
            var cellCenters = null;
            if (vecInfo.isCell) {
                var allPoints = polydata.getPoints();
                var polysData = polydata.getPolys().getData();
                cellCenters = [];
                var offset = 0;
                while (offset < polysData.length) {
                    var nPts = polysData[offset];
                    var cx = 0, cy = 0, cz = 0;
                    for (var p = 0; p < nPts; p++) {
                        var ptIdx = polysData[offset + 1 + p];
                        var pt = allPoints.getPoint(ptIdx);
                        cx += pt[0]; cy += pt[1]; cz += pt[2];
                    }
                    cellCenters.push([cx / nPts, cy / nPts, cz / nPts]);
                    offset += nPts + 1;
                }
            }

            for (var i = 0; i < totalItems && idx < sampledCount; i += stride) {
                // Get position
                var pos;
                if (vecInfo.isCell) {
                    if (i >= cellCenters.length) continue;
                    pos = cellCenters[i];
                } else {
                    pos = polydata.getPoints().getPoint(i);
                }

                var vec = vecInfo.array.getTuple(i);
                var mag;
                if (magInfo) {
                    mag = magInfo.array.getTuple(i)[0];
                } else {
                    mag = Math.sqrt(vec[0] * vec[0] + vec[1] * vec[1] + vec[2] * vec[2]);
                }

                positions[idx * 3] = pos[0];
                positions[idx * 3 + 1] = pos[1];
                positions[idx * 3 + 2] = pos[2];
                orientations[idx * 3] = vec[0];
                orientations[idx * 3 + 1] = vec[1];
                orientations[idx * 3 + 2] = vec[2];
                magnitudes[idx] = mag;
                if (mag > maxMag) maxMag = mag;
                idx++;
            }

            // Trim to actual count (some cells might be skipped)
            sampledCount = idx;
            if (sampledCount === 0) return;

            // Build a vtkPolyData with the sampled points
            var vtkPD = vtk.Common.DataModel.vtkPolyData.newInstance();

            var pointsTypedArray = positions.subarray(0, sampledCount * 3);
            var vtkPoints = vtk.Common.Core.vtkPoints.newInstance();
            vtkPoints.setData(pointsTypedArray, 3);
            vtkPD.setPoints(vtkPoints);

            // Add vertex cells so Glyph3DMapper has cells to iterate
            var verts = new Uint32Array(sampledCount * 2);
            for (var v = 0; v < sampledCount; v++) {
                verts[v * 2] = 1;
                verts[v * 2 + 1] = v;
            }
            vtkPD.getVerts().setData(verts);

            // Add orientation array
            var oriArray = vtk.Common.Core.vtkDataArray.newInstance({
                numberOfComponents: 3,
                values: orientations.subarray(0, sampledCount * 3),
                name: 'Velocity',
            });
            vtkPD.getPointData().addArray(oriArray);

            // Add magnitude array for coloring
            var magArray = vtk.Common.Core.vtkDataArray.newInstance({
                numberOfComponents: 1,
                values: magnitudes.subarray(0, sampledCount),
                name: 'Magnitude',
            });
            vtkPD.getPointData().addArray(magArray);
            vtkPD.getPointData().setActiveScalars('Magnitude');

            // Create arrow source
            var arrowSource = st.vtkClasses.vtkArrowSource.newInstance({
                tipResolution: 12,
                tipRadius: 0.08,
                tipLength: 0.3,
                shaftResolution: 8,
                shaftRadius: 0.025,
            });

            // Create Glyph3DMapper
            var glyphMapper = st.vtkClasses.vtkGlyph3DMapper.newInstance();
            glyphMapper.setInputData(vtkPD, 0);
            glyphMapper.setInputConnection(arrowSource.getOutputPort(), 1);

            // Orientation: use the 'Velocity' array for direction
            glyphMapper.setOrientationArray('Velocity');
            glyphMapper.setOrientationModeToDirection();

            // Scale: uniform scale based on user's scale factor and grid spacing
            // Scale factor = scaleSetting * gridSpacing
            // This makes arrows sized relative to the grid, not the velocity magnitude
            // (magnitude is already encoded in the color)
            var scaleFactor = st.vectorGlyphScale * estimatedSpacing;
            if (maxMag > 0) {
                // Normalize so the longest arrow = scaleFactor
                glyphMapper.setScaleFactor(scaleFactor / maxMag);
            } else {
                glyphMapper.setScaleFactor(scaleFactor);
            }
            glyphMapper.setScaleArray('Magnitude');
            glyphMapper.setScaleModeToScaleByMagnitude();

            // Color by magnitude using the viewer's colormap
            var glyphLut = st.vtkClasses.vtkColorTransferFunction.newInstance();
            applyColormap(glyphLut, st.colormap, 0, maxMag > 0 ? maxMag : 1);
            glyphMapper.setLookupTable(glyphLut);
            glyphMapper.setScalarVisibility(true);
            glyphMapper.setScalarModeToUsePointFieldData();
            glyphMapper.setColorByArrayName('Magnitude');
            glyphMapper.setScalarRange(0, maxMag > 0 ? maxMag : 1);

            // Create actor
            var glyphActor = st.vtkClasses.vtkActor.newInstance();
            glyphActor.setMapper(glyphMapper);
            glyphActor.getProperty().setBackfaceCulling(false);

            st.renderer.addActor(glyphActor);
            st.vectorGlyphActors.push(glyphActor);
        });

        st.renderWindow.render();
    }

    function updateColorbar() {
        if (!viewerState) return;
        var container = document.getElementById('pvd-canvas-container');
        var old = container.querySelector('.pvd-legend-container');
        if (old) old.remove();

        var pos = viewerState.legendPosition || 'right';
        if (pos === 'hidden') return;
        if (!viewerState.activeArrayName || viewerState.rangeMin === null) return;

        var min = viewerState.rangeMin;
        var max = viewerState.rangeMax;
        var cmapNodes = COLORMAPS[viewerState.colormap] || COLORMAPS['Cool to Warm'];

        // Determine orientation
        var isHorizontal = (pos === 'top' || pos === 'bottom');

        // Build gradient stops
        var gradDir = isHorizontal ? 'to right' : 'to top';
        var gradStops = cmapNodes.map(function(n) {
            var pct = n[0] * 100;
            return 'rgb(' + Math.round(n[1]*255) + ',' + Math.round(n[2]*255) + ',' + Math.round(n[3]*255) + ') ' + pct + '%';
        }).join(', ');

        // Create wrapper
        var wrapper = document.createElement('div');
        wrapper.className = 'pvd-legend-container pvd-legend-' + pos;

        // Title
        var title = document.createElement('div');
        title.className = 'pvd-legend-title';
        title.textContent = viewerState.activeArrayName;

        // Bar
        var bar = document.createElement('div');
        bar.className = 'pvd-legend-bar' + (isHorizontal ? ' pvd-legend-bar-h' : '');
        bar.style.background = 'linear-gradient(' + gradDir + ', ' + gradStops + ')';

        // Labels
        var labels = document.createElement('div');
        labels.className = 'pvd-legend-labels' + (isHorizontal ? ' pvd-legend-labels-h' : '');
        var count = 5;
        for (var i = 0; i < count; i++) {
            var frac = isHorizontal ? (i / (count - 1)) : (i / (count - 1));
            var val = isHorizontal ? (min + frac * (max - min)) : (max - frac * (max - min));
            var label = document.createElement('div');
            label.className = 'pvd-legend-label';
            label.textContent = val.toPrecision(4);
            labels.appendChild(label);
        }

        wrapper.appendChild(title);
        if (isHorizontal) {
            wrapper.appendChild(bar);
            wrapper.appendChild(labels);
        } else {
            // For vertical: labels on left, bar on right
            var row = document.createElement('div');
            row.className = 'pvd-legend-row';
            row.appendChild(labels);
            row.appendChild(bar);
            wrapper.appendChild(row);
        }
        container.appendChild(wrapper);
    }

    // ============================================================
    // Opacity Transfer Function (ParaView-style)
    // ============================================================

    /**
     * Sample a colormap at parameter t (0-1), returning [r, g, b] in 0-1 range
     */
    function sampleColormap(cmapName, t) {
        var nodes = COLORMAPS[cmapName] || COLORMAPS['Cool to Warm'];
        t = Math.max(0, Math.min(1, t));
        var lo = nodes[0], hi = nodes[nodes.length - 1];
        for (var i = 0; i < nodes.length - 1; i++) {
            if (t >= nodes[i][0] && t <= nodes[i + 1][0]) {
                lo = nodes[i];
                hi = nodes[i + 1];
                break;
            }
        }
        var f = (hi[0] === lo[0]) ? 0 : (t - lo[0]) / (hi[0] - lo[0]);
        return [lo[1] + f * (hi[1] - lo[1]), lo[2] + f * (hi[2] - lo[2]), lo[3] + f * (hi[3] - lo[3])];
    }

    /**
     * Sample the piecewise opacity function at parameter t (0-1)
     */
    function sampleOpacity(points, t) {
        t = Math.max(0, Math.min(1, t));
        if (points.length === 0) return 1;
        if (t <= points[0].x) return points[0].o;
        if (t >= points[points.length - 1].x) return points[points.length - 1].o;
        for (var i = 0; i < points.length - 1; i++) {
            if (t >= points[i].x && t <= points[i + 1].x) {
                var f = (points[i + 1].x === points[i].x) ? 0 : (t - points[i].x) / (points[i + 1].x - points[i].x);
                return points[i].o + f * (points[i + 1].o - points[i].o);
            }
        }
        return 1;
    }

    /**
     * Create the opacity editor floating panel
     */
    function createOpacityEditor() {
        var container = document.getElementById('pvd-canvas-container');
        var panel = document.createElement('div');
        panel.className = 'pvd-opacity-panel';
        panel.id = 'pvd-opacity-panel';

        panel.innerHTML =
            '<div class="pvd-opacity-header">' +
            '  <span class="pvd-opacity-header-title">Opacity Mapping</span>' +
            '  <div class="pvd-opacity-header-actions">' +
            '    <label class="pvd-opacity-enable-label"><input type="checkbox" id="pvd-opacity-enable" ' +
                    (viewerState.opacityMappingEnabled ? 'checked' : '') + '> Enable</label>' +
            '    <button class="pvd-play-btn pvd-opacity-reset-btn" id="pvd-opacity-reset" title="Reset to fully opaque">Reset</button>' +
            '  </div>' +
            '</div>' +
            '<div class="pvd-opacity-hint">Drag points to set opacity. Double-click to add. Right-click to remove.</div>' +
            '<canvas id="pvd-opacity-canvas" width="280" height="120"></canvas>';

        container.appendChild(panel);

        // Draw initial state
        drawOpacityCurve();

        // Enable checkbox
        document.getElementById('pvd-opacity-enable').addEventListener('change', function(e) {
            viewerState.opacityMappingEnabled = e.target.checked;
            if (e.target.checked) {
                applyOpacityMapping();
            } else {
                removeOpacityMapping();
            }
        });

        // Reset button
        document.getElementById('pvd-opacity-reset').addEventListener('click', function() {
            viewerState.opacityPoints = [{x: 0, o: 1}, {x: 0.25, o: 1}, {x: 0.5, o: 1}, {x: 0.75, o: 1}, {x: 1, o: 1}];
            drawOpacityCurve();
            if (viewerState.opacityMappingEnabled) applyOpacityMapping();
        });

        // Canvas interaction
        setupCanvasInteraction();

        // Drag-to-move the panel by its header
        setupPanelDrag(panel);
    }

    /**
     * Make a panel draggable by its header
     */
    function setupPanelDrag(panel) {
        var header = panel.querySelector('.pvd-opacity-header');
        if (!header) return;
        var dragging = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;

        header.addEventListener('mousedown', function(e) {
            // Don't drag if clicking on buttons/checkboxes inside header
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
            e.preventDefault();
            dragging = true;
            var rect = panel.getBoundingClientRect();
            startX = e.clientX;
            startY = e.clientY;
            startLeft = rect.left;
            startTop = rect.top;
            // Switch to fixed positioning for smooth dragging
            panel.style.position = 'fixed';
            panel.style.left = startLeft + 'px';
            panel.style.top = startTop + 'px';
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';
        });

        document.addEventListener('mousemove', function(e) {
            if (!dragging) return;
            e.preventDefault();
            var dx = e.clientX - startX;
            var dy = e.clientY - startY;
            panel.style.left = (startLeft + dx) + 'px';
            panel.style.top = (startTop + dy) + 'px';
        });

        document.addEventListener('mouseup', function() {
            dragging = false;
        });
    }

    /**
     * Draw the opacity curve and colorbar gradient on the canvas
     */
    function drawOpacityCurve() {
        var canvas = document.getElementById('pvd-opacity-canvas');
        if (!canvas) return;
        var ctx = canvas.getContext('2d');
        var W = canvas.width, H = canvas.height;
        var barH = 20; // height of colorbar strip at bottom
        var curveH = H - barH - 4; // curve area height
        var curveTop = 2;

        ctx.clearRect(0, 0, W, H);

        // Draw colorbar gradient strip at bottom
        var cmapName = viewerState.colormap || 'Jet';
        for (var px = 0; px < W; px++) {
            var t = px / (W - 1);
            var rgb = sampleColormap(cmapName, t);
            ctx.fillStyle = 'rgb(' + Math.round(rgb[0]*255) + ',' + Math.round(rgb[1]*255) + ',' + Math.round(rgb[2]*255) + ')';
            ctx.fillRect(px, H - barH, 1, barH);
        }

        // Draw semi-transparent fill under the opacity curve
        var points = viewerState.opacityPoints;
        ctx.beginPath();
        ctx.moveTo(0, curveTop + curveH); // bottom-left
        for (var i = 0; i < points.length; i++) {
            var px = points[i].x * (W - 1);
            var py = curveTop + (1 - points[i].o) * curveH;
            if (i === 0) ctx.lineTo(px, py);
            else ctx.lineTo(px, py);
        }
        ctx.lineTo(W - 1, curveTop + curveH); // bottom-right
        ctx.closePath();
        ctx.fillStyle = 'rgba(99, 102, 241, 0.2)';
        ctx.fill();

        // Draw opacity curve line
        ctx.beginPath();
        for (var i = 0; i < points.length; i++) {
            var px = points[i].x * (W - 1);
            var py = curveTop + (1 - points[i].o) * curveH;
            if (i === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
        }
        ctx.strokeStyle = '#818cf8';
        ctx.lineWidth = 2;
        ctx.stroke();

        // Draw control points
        for (var i = 0; i < points.length; i++) {
            var px = points[i].x * (W - 1);
            var py = curveTop + (1 - points[i].o) * curveH;
            ctx.beginPath();
            ctx.arc(px, py, 5, 0, Math.PI * 2);
            ctx.fillStyle = (i === 0 || i === points.length - 1) ? '#f59e0b' : '#ffffff';
            ctx.fill();
            ctx.strokeStyle = '#6366f1';
            ctx.lineWidth = 1.5;
            ctx.stroke();
        }

        // Draw 0% and 100% labels
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.font = '9px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('100%', 2, curveTop + 9);
        ctx.fillText('0%', 2, curveTop + curveH - 2);
    }

    /**
     * Setup mouse interaction on the opacity canvas
     */
    function setupCanvasInteraction() {
        var canvas = document.getElementById('pvd-opacity-canvas');
        if (!canvas) return;

        var W = canvas.width, H = canvas.height;
        var barH = 20;
        var curveH = H - barH - 4;
        var curveTop = 2;
        var dragging = -1;

        function getCanvasPos(e) {
            var rect = canvas.getBoundingClientRect();
            return { x: e.clientX - rect.left, y: e.clientY - rect.top };
        }

        function findPoint(mx, my) {
            var points = viewerState.opacityPoints;
            for (var i = 0; i < points.length; i++) {
                var px = points[i].x * (W - 1);
                var py = curveTop + (1 - points[i].o) * curveH;
                var dx = mx - px, dy = my - py;
                if (dx * dx + dy * dy < 64) return i; // 8px radius
            }
            return -1;
        }

        canvas.addEventListener('mousedown', function(e) {
            e.preventDefault();
            var pos = getCanvasPos(e);
            dragging = findPoint(pos.x, pos.y);
        });

        canvas.addEventListener('mousemove', function(e) {
            if (dragging < 0) return;
            e.preventDefault();
            var pos = getCanvasPos(e);
            var points = viewerState.opacityPoints;

            // Endpoints: only allow vertical drag
            if (dragging === 0 || dragging === points.length - 1) {
                points[dragging].o = Math.max(0, Math.min(1, 1 - (pos.y - curveTop) / curveH));
            } else {
                // Interior points: drag both x and y, but clamp x between neighbors
                var minX = points[dragging - 1].x + 0.01;
                var maxX = points[dragging + 1].x - 0.01;
                points[dragging].x = Math.max(minX, Math.min(maxX, pos.x / (W - 1)));
                points[dragging].o = Math.max(0, Math.min(1, 1 - (pos.y - curveTop) / curveH));
            }

            drawOpacityCurve();
            if (viewerState.opacityMappingEnabled) applyOpacityMapping();
        });

        canvas.addEventListener('mouseup', function() { dragging = -1; });
        canvas.addEventListener('mouseleave', function() { dragging = -1; });

        // Double-click to add a point
        canvas.addEventListener('dblclick', function(e) {
            e.preventDefault();
            var pos = getCanvasPos(e);
            if (pos.y > H - barH) return; // clicked on colorbar, ignore

            var newX = pos.x / (W - 1);
            var newO = Math.max(0, Math.min(1, 1 - (pos.y - curveTop) / curveH));
            var points = viewerState.opacityPoints;

            // Insert at correct position
            var insertIdx = points.length;
            for (var i = 0; i < points.length; i++) {
                if (points[i].x > newX) { insertIdx = i; break; }
            }
            points.splice(insertIdx, 0, {x: newX, o: newO});
            drawOpacityCurve();
            if (viewerState.opacityMappingEnabled) applyOpacityMapping();
        });

        // Right-click to remove a point (not endpoints)
        canvas.addEventListener('contextmenu', function(e) {
            e.preventDefault();
            var pos = getCanvasPos(e);
            var idx = findPoint(pos.x, pos.y);
            if (idx > 0 && idx < viewerState.opacityPoints.length - 1) {
                viewerState.opacityPoints.splice(idx, 1);
                drawOpacityCurve();
                if (viewerState.opacityMappingEnabled) applyOpacityMapping();
            }
        });
    }

    /**
     * Apply opacity mapping — compute RGBA per cell/point and use DIRECT_SCALARS
     */
    function applyOpacityMapping() {
        if (!viewerState || viewerState.actors.length === 0) return;
        var st = viewerState;

        st.actors.forEach(function(actor) {
            var mapper = actor.getMapper();
            var polydata = mapper.getInputData();
            if (!polydata) return;

            // Get the scalar data to map
            var scalars = null;
            var isCell = false;
            if (st.activeArrayName) {
                scalars = polydata.getPointData().getArrayByName(st.activeArrayName);
                if (!scalars) {
                    scalars = polydata.getCellData().getArrayByName(st.activeArrayName);
                    isCell = true;
                }
            }
            if (!scalars || scalars.getNumberOfComponents() !== 1) return;

            var nTuples = scalars.getNumberOfTuples();
            var min = st.rangeMin;
            var max = st.rangeMax;
            var range = max - min;
            if (range === 0) range = 1;

            // Build RGBA array
            var rgba = new Uint8Array(nTuples * 4);
            var scalarData = scalars.getData();
            for (var i = 0; i < nTuples; i++) {
                var val = scalarData[i];
                var t = (val - min) / range;
                t = Math.max(0, Math.min(1, t));

                // Color from our colormap
                var rgb = sampleColormap(st.colormap, t);
                // Opacity from transfer function
                var opacity = sampleOpacity(st.opacityPoints, t);

                rgba[i * 4]     = Math.round(rgb[0] * 255);
                rgba[i * 4 + 1] = Math.round(rgb[1] * 255);
                rgba[i * 4 + 2] = Math.round(rgb[2] * 255);
                rgba[i * 4 + 3] = Math.round(opacity * 255);
            }

            // Create a new vtkDataArray with RGBA values
            var colorArray = st.vtkClasses.vtkDataArray.newInstance({
                name: '_OpacityMappedRGBA',
                numberOfComponents: 4,
                values: rgba,
            });

            if (isCell) {
                polydata.getCellData().addArray(colorArray);
                polydata.getCellData().setActiveScalars('_OpacityMappedRGBA');
                mapper.setScalarModeToUseCellFieldData();
            } else {
                polydata.getPointData().addArray(colorArray);
                polydata.getPointData().setActiveScalars('_OpacityMappedRGBA');
                mapper.setScalarModeToUsePointFieldData();
            }

            mapper.setColorByArrayName('_OpacityMappedRGBA');
            mapper.setColorModeToDirectScalars();
            mapper.setScalarVisibility(true);
            mapper.setInterpolateScalarsBeforeMapping(false);
        });

        st.renderWindow.render();
    }

    /**
     * Remove opacity mapping — revert to LUT-based coloring
     */
    function removeOpacityMapping() {
        if (!viewerState) return;
        updateColoring(); // This restores the LUT-based coloring
    }

    function togglePlayback() {
        if (!viewerState) return;
        var btn = document.getElementById('pvd-play-pause');

        if (viewerState.playing) {
            viewerState.playing = false;
            if (viewerState.playTimer) clearInterval(viewerState.playTimer);
            viewerState.playTimer = null;
            if (btn) { btn.textContent = '\u25B6'; btn.classList.remove('active'); }
        } else {
            viewerState.playing = true;
            if (btn) { btn.textContent = '\u23F8'; btn.classList.add('active'); }
            viewerState.playTimer = setInterval(function() {
                if (!viewerState || !viewerState.playing) return;
                var maxIdx = viewerState.pvdInfo.timesteps.length - 1;
                var nextIdx = viewerState.currentTimestepIdx + 1;
                if (nextIdx > maxIdx) nextIdx = 0;
                var slider = document.getElementById('pvd-ts-slider');
                if (slider) slider.value = nextIdx;
                loadTimestep(nextIdx);
            }, 1000);
        }
    }

    function showLoading(text) {
        var loading = document.getElementById('pvd-loading');
        if (!loading) {
            loading = document.createElement('div');
            loading.className = 'pvd-loading-overlay';
            loading.id = 'pvd-loading';
            var c = document.getElementById('pvd-canvas-container');
            if (c) c.appendChild(loading);
        }
        loading.innerHTML = '<div class="spinner"></div><div class="pvd-loading-text">' + (text || 'Loading...') + '</div>';
        loading.style.display = 'flex';
    }

    function hideLoading() {
        var loading = document.getElementById('pvd-loading');
        if (loading) loading.style.display = 'none';
        hideTransportSpinner();
    }

    function showTransportSpinner() {
        var sp = document.getElementById('pvd-transport-spinner');
        if (sp) sp.style.display = 'block';
    }

    function hideTransportSpinner() {
        var sp = document.getElementById('pvd-transport-spinner');
        if (sp) sp.style.display = 'none';
    }

    /**
     * Auto-orient camera for 2D slice data.
     * Detects which axis has zero/near-zero extent and positions
     * the camera perpendicular to that axis (standard ParaView behavior).
     */
    function autoOrientCamera(st) {
        if (!st.actors.length) return;

        var renderer = st.renderer;
        var bounds = renderer.computeVisiblePropBounds();
        // bounds = [xmin, xmax, ymin, ymax, zmin, zmax]
        if (!bounds || bounds[0] === Infinity) return;

        var xExt = bounds[1] - bounds[0];
        var yExt = bounds[3] - bounds[2];
        var zExt = bounds[5] - bounds[4];
        var maxExt = Math.max(xExt, yExt, zExt);

        if (maxExt === 0) return;

        // Threshold: if an axis extent is <1% of max, it's a flat slice
        var threshold = maxExt * 0.01;
        var camera = renderer.getActiveCamera();

        // Center of bounds
        var cx = (bounds[0] + bounds[1]) / 2;
        var cy = (bounds[2] + bounds[3]) / 2;
        var cz = (bounds[4] + bounds[5]) / 2;

        // Also detect from PVD filename (e.g. SliceX_0.000.pvd → flat in X)
        var pvdName = (st.pvdPath || '').toLowerCase();
        var sliceAxis = '';
        if (pvdName.indexOf('slicex') >= 0 || xExt < threshold) {
            sliceAxis = 'x';
        } else if (pvdName.indexOf('slicey') >= 0 || yExt < threshold) {
            sliceAxis = 'y';
        } else if (pvdName.indexOf('slicez') >= 0 || zExt < threshold) {
            sliceAxis = 'z';
        }

        // M-Star convention: Y+ is up
        if (sliceAxis === 'x') {
            // Looking along -X at the YZ plane (Y up)
            var dist = Math.max(yExt, zExt) * 1.5;
            camera.setPosition(cx - dist, cy, cz);
            camera.setFocalPoint(cx, cy, cz);
            camera.setViewUp(0, 1, 0);
            camera.setParallelProjection(true);
        } else if (sliceAxis === 'y') {
            // Looking along -Y at the XZ plane (Z up)
            var dist = Math.max(xExt, zExt) * 1.5;
            camera.setPosition(cx, cy - dist, cz);
            camera.setFocalPoint(cx, cy, cz);
            camera.setViewUp(0, 0, 1);
            camera.setParallelProjection(true);
        } else if (sliceAxis === 'z') {
            // Looking along -Z at the XY plane (Y up)
            var dist = Math.max(xExt, yExt) * 1.5;
            camera.setPosition(cx, cy, cz - dist);
            camera.setFocalPoint(cx, cy, cz);
            camera.setViewUp(0, 1, 0);
            camera.setParallelProjection(true);
        } else {
            // 3D data — nice isometric angle with Y+ up
            var dist = maxExt * 2.0;
            camera.setPosition(cx + dist * 0.7, cy + dist * 0.5, cz + dist * 0.5);
            camera.setFocalPoint(cx, cy, cz);
            camera.setViewUp(0, 1, 0);
        }

        renderer.resetCameraClippingRange();
    }

    /**
     * Rotate camera around the Y-up axis by the given angle in degrees.
     */
    function rotateCamera(angleDeg) {
        if (!viewerState) return;
        var st = viewerState;
        var camera = st.renderer.getActiveCamera();
        var fp = camera.getFocalPoint();
        var pos = camera.getPosition();

        // Vector from focal point to camera
        var dx = pos[0] - fp[0];
        var dy = pos[1] - fp[1];
        var dz = pos[2] - fp[2];

        // Rotate around the camera's ViewUp vector (Y axis by default)
        var up = camera.getViewUp();
        var ux = up[0], uy = up[1], uz = up[2];
        // Normalize the up vector
        var uLen = Math.sqrt(ux*ux + uy*uy + uz*uz);
        if (uLen > 0) { ux /= uLen; uy /= uLen; uz /= uLen; }

        var rad = angleDeg * Math.PI / 180;
        var cosA = Math.cos(rad);
        var sinA = Math.sin(rad);

        // Rodrigues' rotation formula: v_rot = v*cos + (u x v)*sin + u*(u·v)*(1-cos)
        var dot = dx*ux + dy*uy + dz*uz;
        var cx = uy*dz - uz*dy;
        var cy = uz*dx - ux*dz;
        var cz = ux*dy - uy*dx;

        var newDx = dx*cosA + cx*sinA + ux*dot*(1-cosA);
        var newDy = dy*cosA + cy*sinA + uy*dot*(1-cosA);
        var newDz = dz*cosA + cz*sinA + uz*dot*(1-cosA);

        camera.setPosition(fp[0] + newDx, fp[1] + newDy, fp[2] + newDz);
        st.renderer.resetCameraClippingRange();
        st.renderWindow.render();
        updateAxisIndicator();
    }

    /**
     * HTML-based axis indicator — shows labeled X/Y/Z arrows
     * that update orientation as the camera moves.
     */
    function createAxisIndicator(container, renderer, renderWindow) {
        var el = document.createElement('div');
        el.id = 'pvd-axis-indicator';
        el.className = 'pvd-axis-indicator';
        el.innerHTML =
            '<svg width="80" height="80" viewBox="-40 -40 80 80" id="pvd-axis-svg">' +
            '  <line id="pvd-ax-x" x1="0" y1="0" x2="30" y2="0" stroke="#ef4444" stroke-width="2.5" stroke-linecap="round"/>' +
            '  <text id="pvd-ax-xl" x="30" y="0" fill="#ef4444" font-size="11" font-weight="700" text-anchor="middle" dominant-baseline="central">X</text>' +
            '  <line id="pvd-ax-y" x1="0" y1="0" x2="0" y2="-30" stroke="#22c55e" stroke-width="2.5" stroke-linecap="round"/>' +
            '  <text id="pvd-ax-yl" x="0" y="-30" fill="#22c55e" font-size="11" font-weight="700" text-anchor="middle" dominant-baseline="central">Y</text>' +
            '  <line id="pvd-ax-z" x1="0" y1="0" x2="0" y2="0" stroke="#3b82f6" stroke-width="2.5" stroke-linecap="round"/>' +
            '  <text id="pvd-ax-zl" x="0" y="0" fill="#3b82f6" font-size="11" font-weight="700" text-anchor="middle" dominant-baseline="central">Z</text>' +
            '  <circle cx="0" cy="0" r="3" fill="#94a3b8"/>' +
            '</svg>';
        container.appendChild(el);

        // Update on camera changes
        var interactor = renderWindow.getInteractor();
        if (interactor) {
            interactor.onAnimation(updateAxisIndicator);
            interactor.onEndAnimation(updateAxisIndicator);
        }

        // Initial update after a short delay
        setTimeout(updateAxisIndicator, 100);
    }

    function updateAxisIndicator() {
        if (!viewerState) return;
        var camera = viewerState.renderer.getActiveCamera();
        if (!camera) return;

        var vm = camera.getViewMatrix();
        if (!vm) return;

        // vm is a 4x4 column-major matrix from vtk.js
        // Project world axes to screen: multiply (1,0,0), (0,1,0), (0,0,1) by upper-left 3x3
        var axisLen = 28;
        var axes = [
            { id: 'x', wx: 1, wy: 0, wz: 0 },
            { id: 'y', wx: 0, wy: 1, wz: 0 },
            { id: 'z', wx: 0, wy: 0, wz: 1 },
        ];

        // vtk.js view matrix is column-major Float64Array (16 elements)
        // Row i, Col j → vm[j*4 + i]
        axes.forEach(function(ax) {
            var sx = vm[0] * ax.wx + vm[4] * ax.wy + vm[8]  * ax.wz;
            var sy = vm[1] * ax.wx + vm[5] * ax.wy + vm[9]  * ax.wz;
            // Screen: right = +sx, up = +sy  → SVG: right = +x, up = -y
            var ex = sx * axisLen;
            var ey = -sy * axisLen;
            var line = document.getElementById('pvd-ax-' + ax.id);
            var label = document.getElementById('pvd-ax-' + ax.id + 'l');
            if (line) {
                line.setAttribute('x2', ex.toFixed(1));
                line.setAttribute('y2', ey.toFixed(1));
            }
            if (label) {
                var lx = ex * 1.3;
                var ly = ey * 1.3;
                label.setAttribute('x', lx.toFixed(1));
                label.setAttribute('y', ly.toFixed(1));
            }
        });
    }

    function closePvdViewer() {
        if (viewerState) {
            if (viewerState.playTimer) clearInterval(viewerState.playTimer);
            viewerState.actors.forEach(function(a) { viewerState.renderer.removeActor(a); });
            viewerState.vectorGlyphActors.forEach(function(a) { viewerState.renderer.removeActor(a); });
            try { viewerState.fullScreenRenderWindow.delete(); } catch (e) {}
            viewerState = null;
        }
        var overlay = document.getElementById('pvd-viewer-overlay');
        if (overlay) overlay.remove();
    }

    // Helpers
    function formatTime(t) {
        if (typeof t !== 'number' || isNaN(t)) return '0';
        return t.toFixed(4);
    }

    /** Get a display label for a PVD timestep. Uses label if available, otherwise time. */
    function _timestepLabel(ts) {
        if (ts && ts.label) return ts.label;
        return formatTime(ts ? ts.time : 0) + ' s';
    }

    function escapeHtml(str) {
        var div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function escapeAttr(str) {
        return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;');
    }

    // ============================================================
    // Multi-Layer Viewer (Visuals Tab)
    // ============================================================

    function openMultiLayerViewer(jobId) {
        // Close any existing viewer
        closePvdViewer();

        var overlay = document.createElement('div');
        overlay.className = 'pvd-viewer-overlay';
        overlay.id = 'pvd-viewer-overlay';
        overlay.innerHTML =
            '<div class="pvd-viewer-header">' +
            '  <div class="pvd-viewer-title">' +
            '    <div class="pvd-icon">\uD83C\uDF0D</div>' +
            '    <span>Loading Visuals...</span>' +
            '  </div>' +
            '  <div class="pvd-header-tools">' +
            '    <button class="pvd-header-btn" id="pvd-rotate-left" title="Rotate left 90\u00b0">\u21B6</button>' +
            '    <button class="pvd-header-btn" id="pvd-rotate-right" title="Rotate right 90\u00b0">\u21B7</button>' +
            '    <button class="pvd-header-btn" id="pvd-zoom-fit" title="Zoom to fit all">\u2922</button>' +
            '  </div>' +
            '  <button class="pvd-viewer-close" id="pvd-close-btn">&times;</button>' +

            '</div>' +
            '<div class="pvd-controls pvd-controls-top" id="pvd-controls-top" style="display:none;"></div>' +
            '<div style="display:flex;flex:1;min-height:0;position:relative;">' +
            '  <div class="pvd-layer-panel" id="pvd-layer-panel">' +
            '    <div class="pvd-layer-header">Layers</div>' +
            '    <div class="pvd-layer-list" id="pvd-layer-list"><div class="pvd-loading-text">Scanning layers...</div></div>' +
            '  </div>' +
            '  <div class="pvd-panel-resize" id="pvd-panel-resize"></div>' +
            '  <div class="pvd-canvas-container" id="pvd-canvas-container" style="flex:1;">' +
            '    <div class="pvd-loading-overlay" id="pvd-loading">' +
            '      <div class="spinner"></div>' +
            '      <div class="pvd-loading-text">Initializing...</div>' +
            '    </div>' +
            '  </div>' +
            '  <canvas id="pvd-axes-canvas" class="pvd-axes-canvas" width="100" height="100"></canvas>' +
            '</div>';
        document.body.appendChild(overlay);

        document.getElementById('pvd-close-btn').addEventListener('click', closePvdViewer);

        var token = getToken();
        var vtkClasses = getVtkClasses();
        if (!vtkClasses) {
            document.getElementById('pvd-loading').querySelector('.pvd-loading-text').textContent = 'vtk.js not available';
            return;
        }
        vtkClasses.vtkSTLReader = vtk.IO.Geometry.vtkSTLReader;

        // Fetch layer list from backend
        fetch('/api/jobs/' + jobId + '/visuals-layers', {
            headers: { 'Authorization': 'Bearer ' + token }
        })
        .then(function(r) { return r.json(); })
        .then(function(resp) {
            if (!resp.layers || resp.layers.length === 0) {
                document.getElementById('pvd-loading').querySelector('.pvd-loading-text').textContent = 'No visual layers found';
                return;
            }
            initMultiLayerViewer(vtkClasses, jobId, resp.layers);
        })
        .catch(function(err) {
            document.getElementById('pvd-loading').querySelector('.pvd-loading-text').textContent = 'Error: ' + err.message;
        });
    }

    function initMultiLayerViewer(vtkClasses, jobId, layerDefs) {
        var container = document.getElementById('pvd-canvas-container');
        var controlsTopEl = document.getElementById('pvd-controls-top');

        // Initialize VTK render window
        var fullScreenRenderWindow = vtkClasses.vtkFullScreenRenderWindow.newInstance({
            rootContainer: container,
            containerStyle: { height: '100%', width: '100%', position: 'absolute' },
            background: [0.02, 0.03, 0.06],
        });
        var renderer = fullScreenRenderWindow.getRenderer();
        var renderWindow = fullScreenRenderWindow.getRenderWindow();

        // Set up camera (Y-up default)
        var camera = renderer.getActiveCamera();
        camera.setViewUp(0, 1, 0);
        camera.setPosition(0, 0.5, 1);
        camera.setFocalPoint(0, 0, 0);

        // Multi-layer state
        var mlState = {
            vtkClasses: vtkClasses,
            jobId: jobId,
            renderer: renderer,
            renderWindow: renderWindow,
            layers: [],         // layer objects
            masterTimeline: [], // union of all timesteps (numbers)
            currentTimeIdx: 0,
            playing: false,
            playInterval: null,
            colormap: 'Jet',
            expandedLayer: -1,   // which layer's settings panel is open (-1 = none)
        };

        // Initialize each layer — all visible by default
        layerDefs.forEach(function(def, idx) {
            // Smart opacity defaults:
            // - STLs (static bodies): 0.1 to see through
            // - MovingBody surfaces: 1.0 (opaque)
            // - Slices/boundaries: use linear opacity transfer (handled in coloring)
            var isMoving = def.name.toLowerCase().indexOf('moving') >= 0;
            var defaultOpacity = (def.category === 'stl') ? 0.1 :
                                 (isMoving ? 1.0 : 1.0);

            mlState.layers.push({
                name: def.name,
                type: def.type,
                path: def.path,
                fileType: def.file_type || 'vtp',
                category: def.category || 'surface',
                visible: true, // all layers visible
                loaded: false,
                pvdInfo: null,
                actors: [],
                activeArrayName: null,
                rangeMin: null,
                rangeMax: null,
                baseOpacity: defaultOpacity,
                useLinearOpacity: (def.category === 'slice' || def.category === 'boundary'),
            });
        });

        // Render the layer panel
        renderLayerPanel(mlState);

        // Fetch PVD info for all PVD layers in parallel
        var loadingText = document.getElementById('pvd-loading').querySelector('.pvd-loading-text');
        loadingText.textContent = 'Loading layer info...';

        var pvdPromises = mlState.layers.map(function(layer) {
            if (layer.type === 'stl') {
                return Promise.resolve(null);
            }
            return fetch('/api/jobs/' + jobId + '/files/pvd-info?path=' + encodeURIComponent(layer.path), {
                headers: { 'Authorization': 'Bearer ' + getToken() }
            }).then(function(r) { return r.json(); }).catch(function() { return null; });
        });

        Promise.all(pvdPromises).then(function(results) {
            results.forEach(function(info, idx) {
                if (info && info.timesteps) {
                    mlState.layers[idx].pvdInfo = info;
                    if (info.arrays && info.arrays.length > 0) {
                        mlState.layers[idx].activeArrayName = info.arrays[0].name;
                    }
                }
            });

            // Build master timeline
            buildMasterTimeline(mlState);

            // Build controls
            buildMultiLayerControls(mlState, controlsTopEl);
            controlsTopEl.style.display = 'flex';

            // Update header
            var titleSpan = document.querySelector('#pvd-viewer-overlay .pvd-viewer-title span');
            if (titleSpan) titleSpan.textContent = 'Visuals — ' + mlState.layers.length + ' layers';

            // Load visible layers
            loadingText.textContent = 'Loading geometry...';
            loadVisibleLayers(mlState, function() {
                var loadingEl = document.getElementById('pvd-loading');
                if (loadingEl) loadingEl.style.display = 'none';
                renderer.resetCamera();
                renderWindow.render();
            });
        });
    }

    function buildMasterTimeline(mlState) {
        var timeSet = {};
        mlState.layers.forEach(function(layer) {
            if (layer.pvdInfo && layer.pvdInfo.timesteps) {
                layer.pvdInfo.timesteps.forEach(function(ts) {
                    timeSet[ts.time] = true;
                });
            }
        });
        mlState.masterTimeline = Object.keys(timeSet).map(Number).sort(function(a, b) { return a - b; });
        if (mlState.masterTimeline.length === 0) mlState.masterTimeline = [0];
        mlState.currentTimeIdx = mlState.masterTimeline.length - 1;
    }

    function buildMultiLayerControls(mlState, topEl) {
        var lastIdx = mlState.masterTimeline.length - 1;
        var lastTime = mlState.masterTimeline[lastIdx] || 0;

        topEl.innerHTML =
            '<div class="pvd-controls-group pvd-transport-group">' +
            '  <button class="pvd-play-btn" id="pvd-step-back" title="Previous timestep">\u23EE</button>' +
            '  <button class="pvd-play-btn" id="pvd-play-pause" title="Play/Pause">\u25B6</button>' +
            '  <button class="pvd-play-btn" id="pvd-step-fwd" title="Next timestep">\u23ED</button>' +
            '</div>' +
            '<div class="pvd-timestep-group">' +
            '  <span class="pvd-controls-label">Time</span>' +
            '  <input type="range" class="pvd-timestep-slider" id="pvd-ts-slider" min="0" max="' + lastIdx + '" value="' + lastIdx + '" step="1">' +
            '  <span class="pvd-timestep-value" id="pvd-ts-display">' + formatTime(lastTime) + ' s</span>' +
            '</div>';

        // Event listeners — time controls
        document.getElementById('pvd-ts-slider').addEventListener('input', function(e) {
            mlState.currentTimeIdx = parseInt(e.target.value);
            var time = mlState.masterTimeline[mlState.currentTimeIdx] || 0;
            document.getElementById('pvd-ts-display').textContent = formatTime(time) + ' s';
            loadVisibleLayers(mlState);
        });

        document.getElementById('pvd-play-pause').addEventListener('click', function() {
            mlState.playing = !mlState.playing;
            this.textContent = mlState.playing ? '\u23F8' : '\u25B6';
            if (mlState.playing) {
                mlState.playInterval = setInterval(function() {
                    mlState.currentTimeIdx++;
                    if (mlState.currentTimeIdx >= mlState.masterTimeline.length) mlState.currentTimeIdx = 0;
                    document.getElementById('pvd-ts-slider').value = mlState.currentTimeIdx;
                    var time = mlState.masterTimeline[mlState.currentTimeIdx] || 0;
                    document.getElementById('pvd-ts-display').textContent = formatTime(time) + ' s';
                    loadVisibleLayers(mlState);
                }, 500);
            } else {
                clearInterval(mlState.playInterval);
            }
        });

        document.getElementById('pvd-step-back').addEventListener('click', function() {
            if (mlState.currentTimeIdx > 0) {
                mlState.currentTimeIdx--;
                document.getElementById('pvd-ts-slider').value = mlState.currentTimeIdx;
                var time = mlState.masterTimeline[mlState.currentTimeIdx] || 0;
                document.getElementById('pvd-ts-display').textContent = formatTime(time) + ' s';
                loadVisibleLayers(mlState);
            }
        });

        document.getElementById('pvd-step-fwd').addEventListener('click', function() {
            if (mlState.currentTimeIdx < mlState.masterTimeline.length - 1) {
                mlState.currentTimeIdx++;
                document.getElementById('pvd-ts-slider').value = mlState.currentTimeIdx;
                var time = mlState.masterTimeline[mlState.currentTimeIdx] || 0;
                document.getElementById('pvd-ts-display').textContent = formatTime(time) + ' s';
                loadVisibleLayers(mlState);
            }
        });

        // Header tools — rotate, zoom, opacity
        document.getElementById('pvd-rotate-left').addEventListener('click', function() {
            rotateMLCamera(mlState, -90);
        });
        document.getElementById('pvd-rotate-right').addEventListener('click', function() {
            rotateMLCamera(mlState, 90);
        });

        document.getElementById('pvd-zoom-fit').addEventListener('click', function() {
            mlState.renderer.resetCamera();
            mlState.renderWindow.render();
            drawOrientationAxes(mlState);
        });

        // Panel resize handle
        var resizeHandle = document.getElementById('pvd-panel-resize');
        var layerPanel = document.getElementById('pvd-layer-panel');
        if (resizeHandle && layerPanel) {
            var resizing = false;
            resizeHandle.addEventListener('mousedown', function(e) {
                e.preventDefault();
                resizing = true;
                document.body.style.cursor = 'col-resize';
                document.body.style.userSelect = 'none';
            });
            document.addEventListener('mousemove', function(e) {
                if (!resizing) return;
                var panelRect = layerPanel.getBoundingClientRect();
                var newWidth = e.clientX - panelRect.left;
                if (newWidth < 180) newWidth = 180;
                if (newWidth > 500) newWidth = 500;
                layerPanel.style.width = newWidth + 'px';
                layerPanel.style.minWidth = newWidth + 'px';
                if (mlState.renderWindow) mlState.renderWindow.resize();
            });
            document.addEventListener('mouseup', function() {
                if (resizing) {
                    resizing = false;
                    document.body.style.cursor = '';
                    document.body.style.userSelect = '';
                    if (mlState.renderWindow) mlState.renderWindow.resize();
                }
            });
        }

        // Update orientation axes whenever camera changes
        if (mlState.renderer) {
            mlState.renderer.getActiveCamera().onModified(function() {
                drawOrientationAxes(mlState);
            });
            drawOrientationAxes(mlState);
        }
    }

    function rotateMLCamera(mlState, degrees) {
        var cam = mlState.renderer.getActiveCamera();
        var fp = cam.getFocalPoint();
        var pos = cam.getPosition();
        var rad = (degrees * Math.PI) / 180;
        var dx = pos[0] - fp[0], dz = pos[2] - fp[2];
        cam.setPosition(
            fp[0] + dx * Math.cos(rad) - dz * Math.sin(rad),
            pos[1],
            fp[2] + dx * Math.sin(rad) + dz * Math.cos(rad)
        );
        mlState.renderWindow.render();
    }

    /**
     * Draw XYZ orientation axes gizmo on a 2D canvas overlay
     */
    function drawOrientationAxes(mlState) {
        var canvas = document.getElementById('pvd-axes-canvas');
        if (!canvas || !mlState.renderer) return;
        var ctx = canvas.getContext('2d');
        var W = canvas.width, H = canvas.height;
        var cx = W / 2, cy = H / 2;
        var axLen = 30;

        ctx.clearRect(0, 0, W, H);

        // Build view coordinate system
        var cam = mlState.renderer.getActiveCamera();
        var vDir = cam.getDirectionOfProjection(); // into screen
        var vUp = cam.getViewUp();

        function normalize(v) {
            var len = Math.sqrt(v[0]*v[0] + v[1]*v[1] + v[2]*v[2]);
            if (len < 1e-8) return [0, 0, 0];
            return [v[0]/len, v[1]/len, v[2]/len];
        }
        function cross(a, b) {
            return [a[1]*b[2] - a[2]*b[1], a[2]*b[0] - a[0]*b[2], a[0]*b[1] - a[1]*b[0]];
        }
        function dot(a, b) { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]; }

        // Right-handed: right = up × forward (forward = direction of projection)
        var forward = normalize(vDir);
        var right = normalize(cross(vUp, forward));
        var up = normalize(cross(forward, right));

        var axes = [
            { label: 'X', color: '#ef4444', dir: [1, 0, 0] },
            { label: 'Y', color: '#22c55e', dir: [0, 1, 0] },
            { label: 'Z', color: '#3b82f6', dir: [0, 0, 1] }
        ];

        // Project each axis onto screen coords and compute depth
        axes.forEach(function(a) {
            a.sx = dot(a.dir, right);   // screen X (right)
            a.sy = -dot(a.dir, up);     // screen Y (up → canvas down)
            a.depth = dot(a.dir, forward);
        });
        // Sort: draw axes pointing away from camera first
        axes.sort(function(a, b) { return b.depth - a.depth; });

        axes.forEach(function(a) {
            var ex = cx + a.sx * axLen;
            var ey = cy + a.sy * axLen;
            var alpha = a.depth > 0.1 ? 0.3 : 1.0;

            // Line
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.lineTo(ex, ey);
            ctx.strokeStyle = a.color;
            ctx.globalAlpha = alpha;
            ctx.lineWidth = 2.5;
            ctx.stroke();

            // Tip dot
            ctx.beginPath();
            ctx.arc(ex, ey, 4, 0, Math.PI * 2);
            ctx.fillStyle = a.color;
            ctx.fill();

            // Label — offset outward from tip
            var lx = ex + (a.sx > 0 ? 8 : a.sx < 0 ? -8 : 0);
            var ly = ey + (a.sy > 0 ? 12 : a.sy < 0 ? -8 : 0);
            ctx.font = 'bold 11px Inter, sans-serif';
            ctx.fillStyle = a.color;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(a.label, lx, ly);
            ctx.globalAlpha = 1.0;
        });
    }

    /**
     * Create opacity transfer function editor for the multi-layer viewer.
     * Operates on the currently expanded layer.
     */
    function createMLOpacityEditor(mlState) {
        var container = document.getElementById('pvd-canvas-container');
        if (!container) return;

        // Find active layer (expanded or first visible PVD layer)
        var targetIdx = mlState.expandedLayer >= 0 ? mlState.expandedLayer : -1;
        if (targetIdx < 0) {
            for (var i = 0; i < mlState.layers.length; i++) {
                if (mlState.layers[i].type !== 'stl' && mlState.layers[i].visible) { targetIdx = i; break; }
            }
        }
        if (targetIdx < 0) return;
        var layer = mlState.layers[targetIdx];

        // Init opacity state if not present
        if (!layer.opacityPoints) {
            layer.opacityPoints = [{x: 0, o: 1}, {x: 0.25, o: 1}, {x: 0.5, o: 1}, {x: 0.75, o: 1}, {x: 1, o: 1}];
        }
        if (layer.opacityEnabled === undefined) layer.opacityEnabled = false;

        var panel = document.createElement('div');
        panel.className = 'pvd-opacity-panel';
        panel.id = 'pvd-ml-opacity-panel';

        panel.innerHTML =
            '<div class="pvd-opacity-header">' +
            '  <span class="pvd-opacity-header-title">Opacity — ' + escapeHtml(layer.name) + '</span>' +
            '  <div class="pvd-opacity-header-actions">' +
            '    <label class="pvd-opacity-enable-label"><input type="checkbox" id="pvd-ml-opacity-enable" ' +
                    (layer.opacityEnabled ? 'checked' : '') + '> Enable</label>' +
            '    <button class="pvd-play-btn pvd-opacity-reset-btn" id="pvd-ml-opacity-reset" title="Reset to fully opaque">Reset</button>' +
            '  </div>' +
            '</div>' +
            '<div class="pvd-opacity-hint">Drag points to set opacity. Double-click to add. Right-click to remove.</div>' +
            '<canvas id="pvd-ml-opacity-canvas" width="280" height="120"></canvas>';

        container.appendChild(panel);

        // Draw initial curve
        drawMLOpacityCurve(mlState, targetIdx);

        // Enable checkbox
        document.getElementById('pvd-ml-opacity-enable').addEventListener('change', function(e) {
            layer.opacityEnabled = e.target.checked;
            if (e.target.checked) {
                applyMLOpacityMapping(mlState, targetIdx);
            } else {
                removeMLOpacityMapping(mlState, targetIdx);
            }
        });

        // Reset button
        document.getElementById('pvd-ml-opacity-reset').addEventListener('click', function() {
            layer.opacityPoints = [{x: 0, o: 1}, {x: 0.25, o: 1}, {x: 0.5, o: 1}, {x: 0.75, o: 1}, {x: 1, o: 1}];
            drawMLOpacityCurve(mlState, targetIdx);
            if (layer.opacityEnabled) applyMLOpacityMapping(mlState, targetIdx);
        });

        // Canvas interaction
        setupMLCanvasInteraction(mlState, targetIdx);

        // Drag-to-move by header
        setupPanelDrag(panel);
    }

    function drawMLOpacityCurve(mlState, layerIdx) {
        var canvas = document.getElementById('pvd-ml-opacity-canvas');
        if (!canvas) return;
        var layer = mlState.layers[layerIdx];
        var ctx = canvas.getContext('2d');
        var W = canvas.width, H = canvas.height;
        var barH = 20;
        var curveH = H - barH - 4;
        var curveTop = 2;

        ctx.clearRect(0, 0, W, H);

        // Draw colorbar gradient
        var cmap = layer.layerColormap || mlState.colormap;
        var cmapNodes = COLORMAPS[cmap] || COLORMAPS['Jet'];
        var grad = ctx.createLinearGradient(0, 0, W, 0);
        cmapNodes.forEach(function(n) { grad.addColorStop(n[0], 'rgb(' + Math.round(n[1]*255) + ',' + Math.round(n[2]*255) + ',' + Math.round(n[3]*255) + ')'); });
        ctx.fillStyle = grad;
        ctx.fillRect(0, H - barH, W, barH);

        // Draw fill under opacity curve
        var points = layer.opacityPoints;
        ctx.beginPath();
        ctx.moveTo(0, curveTop + curveH);
        points.forEach(function(p) { ctx.lineTo(p.x * (W - 1), curveTop + (1 - p.o) * curveH); });
        ctx.lineTo(W - 1, curveTop + curveH);
        ctx.closePath();
        ctx.fillStyle = 'rgba(59, 130, 246, 0.15)';
        ctx.fill();

        // Draw curve line
        ctx.beginPath();
        points.forEach(function(p, i) {
            var x = p.x * (W - 1), y = curveTop + (1 - p.o) * curveH;
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.strokeStyle = '#60a5fa';
        ctx.lineWidth = 2;
        ctx.stroke();

        // Draw control points
        points.forEach(function(p) {
            var x = p.x * (W - 1), y = curveTop + (1 - p.o) * curveH;
            ctx.beginPath();
            ctx.arc(x, y, 5, 0, Math.PI * 2);
            ctx.fillStyle = '#fff';
            ctx.fill();
            ctx.strokeStyle = '#3b82f6';
            ctx.lineWidth = 2;
            ctx.stroke();
        });

        // Labels
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.font = '9px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('100%', 2, curveTop + 9);
        ctx.fillText('0%', 2, curveTop + curveH - 2);
    }

    function setupMLCanvasInteraction(mlState, layerIdx) {
        var canvas = document.getElementById('pvd-ml-opacity-canvas');
        if (!canvas) return;
        var layer = mlState.layers[layerIdx];
        var W = canvas.width, H = canvas.height;
        var barH = 20, curveH = H - barH - 4, curveTop = 2;
        var dragging = -1;

        function getPos(e) { var r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
        function findPt(mx, my) {
            var pts = layer.opacityPoints;
            for (var i = 0; i < pts.length; i++) {
                var dx = mx - pts[i].x * (W - 1), dy = my - (curveTop + (1 - pts[i].o) * curveH);
                if (dx * dx + dy * dy < 64) return i;
            }
            return -1;
        }

        canvas.addEventListener('mousedown', function(e) { e.preventDefault(); dragging = findPt(getPos(e).x, getPos(e).y); });
        canvas.addEventListener('mousemove', function(e) {
            if (dragging < 0) return;
            e.preventDefault();
            var pos = getPos(e), pts = layer.opacityPoints;
            if (dragging === 0 || dragging === pts.length - 1) {
                pts[dragging].o = Math.max(0, Math.min(1, 1 - (pos.y - curveTop) / curveH));
            } else {
                pts[dragging].x = Math.max(pts[dragging - 1].x + 0.01, Math.min(pts[dragging + 1].x - 0.01, pos.x / (W - 1)));
                pts[dragging].o = Math.max(0, Math.min(1, 1 - (pos.y - curveTop) / curveH));
            }
            drawMLOpacityCurve(mlState, layerIdx);
            if (layer.opacityEnabled) applyMLOpacityMapping(mlState, layerIdx);
        });
        canvas.addEventListener('mouseup', function() { dragging = -1; });
        canvas.addEventListener('mouseleave', function() { dragging = -1; });

        canvas.addEventListener('dblclick', function(e) {
            e.preventDefault();
            var pos = getPos(e);
            if (pos.y > H - barH) return;
            var newX = pos.x / (W - 1), newO = Math.max(0, Math.min(1, 1 - (pos.y - curveTop) / curveH));
            var pts = layer.opacityPoints, ins = pts.length;
            for (var i = 0; i < pts.length; i++) { if (pts[i].x > newX) { ins = i; break; } }
            pts.splice(ins, 0, {x: newX, o: newO});
            drawMLOpacityCurve(mlState, layerIdx);
            if (layer.opacityEnabled) applyMLOpacityMapping(mlState, layerIdx);
        });

        canvas.addEventListener('contextmenu', function(e) {
            e.preventDefault();
            var pos = getPos(e), idx = findPt(pos.x, pos.y);
            if (idx > 0 && idx < layer.opacityPoints.length - 1) {
                layer.opacityPoints.splice(idx, 1);
                drawMLOpacityCurve(mlState, layerIdx);
                if (layer.opacityEnabled) applyMLOpacityMapping(mlState, layerIdx);
            }
        });
    }

    function applyMLOpacityMapping(mlState, layerIdx) {
        var layer = mlState.layers[layerIdx];
        if (!layer.loaded || !layer.actors.length) return;

        layer.actors.forEach(function(actor) {
            var mapper = actor.getMapper();
            if (!mapper) return;
            var dataset = mapper.getInputData();
            if (!dataset) return;

            var arrName = layer.activeArrayName;
            if (!arrName) return;
            var pd = dataset.getPointData ? dataset.getPointData() : null;
            var cd = dataset.getCellData ? dataset.getCellData() : null;
            var dataArr = (pd && pd.getArrayByName(arrName)) || (cd && cd.getArrayByName(arrName));
            if (!dataArr) return;

            var numTuples = dataArr.getNumberOfTuples();
            if (numTuples === 0) return;

            var rMin = layer.rangeMin, rMax = layer.rangeMax;
            var span = rMax - rMin;
            if (span <= 0) span = 1;

            var cmap = layer.layerColormap || mlState.colormap;
            var lut = mlState.vtkClasses.vtkColorTransferFunction.newInstance();
            applyColormap(lut, cmap, rMin, rMax);

            var rgba = new Uint8Array(numTuples * 4);
            var rgb = [0, 0, 0];
            for (var i = 0; i < numTuples; i++) {
                var val = dataArr.getTuple(i)[0];
                var t = (val - rMin) / span;
                if (t < 0) t = 0; if (t > 1) t = 1;
                lut.getColor(val, rgb);
                rgba[i * 4] = Math.round(rgb[0] * 255);
                rgba[i * 4 + 1] = Math.round(rgb[1] * 255);
                rgba[i * 4 + 2] = Math.round(rgb[2] * 255);
                rgba[i * 4 + 3] = Math.round(sampleOpacity(layer.opacityPoints, t) * 255);
            }

            var vtkDA = vtk.Common.Core.vtkDataArray.newInstance({ numberOfComponents: 4, values: rgba, name: 'OpacityMappedColors' });
            var isPoint = pd && pd.getArrayByName(arrName);
            if (isPoint) { dataset.getPointData().setScalars(vtkDA); } else { dataset.getCellData().setScalars(vtkDA); }
            mapper.setColorModeToDirectScalars();
            mapper.setScalarVisibility(true);
            if (isPoint) { mapper.setScalarModeToUsePointFieldData(); } else { mapper.setScalarModeToUseCellFieldData(); }
            mapper.setColorByArrayName('OpacityMappedColors');
        });
        mlState.renderWindow.render();
    }

    function removeMLOpacityMapping(mlState, layerIdx) {
        var layer = mlState.layers[layerIdx];
        if (!layer.loaded) return;
        // Reload the layer to reset to normal LUT coloring
        loadSingleLayer(mlState, layerIdx, function() {
            mlState.renderWindow.render();
        });
    }

    function renderLayerPanel(mlState) {
        var listEl = document.getElementById('pvd-layer-list');
        if (!listEl) return;

        var html = '';
        mlState.layers.forEach(function(layer, idx) {
            var typeClass = 'pvd-layer-badge-' + layer.category;
            var typeLabel = layer.category === 'slice' ? 'Slice' :
                            layer.category === 'boundary' ? 'BC' :
                            layer.category === 'stl' ? 'STL' : 'Surface';
            var eyeClass = layer.visible ? 'pvd-eye-visible' : 'pvd-eye-hidden';
            var expanded = (mlState.expandedLayer === idx);
            html +=
                '<div class="pvd-layer-row ' + (layer.visible ? '' : 'pvd-layer-hidden') + (expanded ? ' pvd-layer-expanded' : '') + '" data-idx="' + idx + '">' +
                '  <button class="pvd-eye-btn ' + eyeClass + '" data-idx="' + idx + '" title="Toggle visibility">' +
                '    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
                (layer.visible ?
                    '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>' :
                    '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>') +
                '    </svg>' +
                '  </button>' +
                '  <span class="pvd-layer-name pvd-layer-name-click" data-idx="' + idx + '">' + escapeHtml(layer.name) + '</span>' +
                '  <span class="pvd-layer-badge ' + typeClass + '">' + typeLabel + '</span>' +
                '  <button class="pvd-gear-btn' + (expanded ? ' active' : '') + '" data-idx="' + idx + '" title="Layer settings">' +
                '    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.604.852.997 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>' +
                '  </button>' +
                '</div>';

            // Expanded settings panel
            if (expanded && layer.type !== 'stl') {
                var arrays = (layer.pvdInfo && layer.pvdInfo.arrays) ? layer.pvdInfo.arrays : [];
                var arrOpts = arrays.filter(function(a) { return a.components === 1; }).map(function(a) {
                    var sel = (a.name === layer.activeArrayName) ? ' selected' : '';
                    return '<option value="' + escapeHtml(a.name) + '"' + sel + '>' + escapeHtml(a.name) + '</option>';
                }).join('');

                var cmapOpts = Object.keys(COLORMAPS).map(function(name) {
                    var sel = (name === (layer.layerColormap || mlState.colormap)) ? ' selected' : '';
                    return '<option value="' + name + '"' + sel + '>' + name + '</option>';
                }).join('');

                html +=
                    '<div class="pvd-layer-settings" data-idx="' + idx + '">' +
                    '  <div class="pvd-layer-setting-row">' +
                    '    <label>Array</label>' +
                    '    <select class="pvd-layer-array-select" data-idx="' + idx + '">' + arrOpts + '</select>' +
                    '  </div>' +
                    '  <div class="pvd-layer-setting-row">' +
                    '    <label>Colormap</label>' +
                    '    <select class="pvd-layer-cmap-select" data-idx="' + idx + '">' + cmapOpts + '</select>' +
                    '  </div>' +
                    '  <div class="pvd-layer-setting-row pvd-range-row">' +
                    '    <label>Range</label>' +
                    '    <input type="number" class="pvd-range-min" data-idx="' + idx + '" value="' + (layer.rangeMin !== null ? layer.rangeMin : '') + '" step="any" placeholder="min">' +
                    '    <span class="pvd-range-sep">—</span>' +
                    '    <input type="number" class="pvd-range-max" data-idx="' + idx + '" value="' + (layer.rangeMax !== null ? layer.rangeMax : '') + '" step="any" placeholder="max">' +
                    '    <button class="pvd-range-reset" data-idx="' + idx + '" title="Reset to auto range">↺</button>' +
                    '  </div>' +
                    '  <div class="pvd-layer-setting-row">' +
                    '    <label>Opacity</label>' +
                    '    <button class="pvd-layer-opacity-btn" data-idx="' + idx + '">Edit Transfer Function</button>' +
                    '  </div>' +
                    '</div>';
            } else if (expanded && layer.type === 'stl') {
                // STL: just opacity control
                html +=
                    '<div class="pvd-layer-settings" data-idx="' + idx + '">' +
                    '  <div class="pvd-layer-setting-row">' +
                    '    <label>Opacity</label>' +
                    '    <input type="range" class="pvd-stl-opacity" data-idx="' + idx + '" min="0" max="1" step="0.05" value="' + (layer.baseOpacity || 0.1) + '">' +
                    '    <span class="pvd-opacity-val">' + Math.round((layer.baseOpacity || 0.1) * 100) + '%</span>' +
                    '  </div>' +
                    '</div>';
            }
        });
        listEl.innerHTML = html;

        // Eye toggle events
        listEl.querySelectorAll('.pvd-eye-btn').forEach(function(btn) {
            btn.addEventListener('click', function(e) {
                e.stopPropagation();
                var idx = parseInt(this.getAttribute('data-idx'));
                var layer = mlState.layers[idx];
                layer.visible = !layer.visible;
                renderLayerPanel(mlState);

                if (layer.visible) {
                    if (layer.loaded) {
                        layer.actors.forEach(function(a) { a.setVisibility(true); });
                        mlState.renderWindow.render();
                    } else {
                        loadSingleLayer(mlState, idx, function() {
                            mlState.renderWindow.render();
                        });
                    }
                } else {
                    layer.actors.forEach(function(a) { a.setVisibility(false); });
                    mlState.renderWindow.render();
                }
            });
        });

        // Gear button + layer name click → expand/collapse settings
        listEl.querySelectorAll('.pvd-gear-btn, .pvd-layer-name-click').forEach(function(btn) {
            btn.addEventListener('click', function(e) {
                e.stopPropagation();
                var idx = parseInt(this.getAttribute('data-idx'));
                mlState.expandedLayer = (mlState.expandedLayer === idx) ? -1 : idx;
                renderLayerPanel(mlState);
            });
        });

        // Array select events
        listEl.querySelectorAll('.pvd-layer-array-select').forEach(function(sel) {
            sel.addEventListener('change', function() {
                var idx = parseInt(this.getAttribute('data-idx'));
                var layer = mlState.layers[idx];
                layer.activeArrayName = this.value;
                layer.rangeMin = null; // auto-range on new array
                layer.rangeMax = null;
                if (layer.loaded) {
                    loadSingleLayer(mlState, idx, function() {
                        mlState.renderWindow.render();
                        renderLayerPanel(mlState); // update range inputs
                    });
                }
            });
        });

        // Per-layer colormap events
        listEl.querySelectorAll('.pvd-layer-cmap-select').forEach(function(sel) {
            sel.addEventListener('change', function() {
                var idx = parseInt(this.getAttribute('data-idx'));
                var layer = mlState.layers[idx];
                layer.layerColormap = this.value;
                if (layer.loaded) {
                    recolorSingleLayer(mlState, idx);
                }
            });
        });

        // Range inputs — apply on Enter or blur
        listEl.querySelectorAll('.pvd-range-min, .pvd-range-max').forEach(function(input) {
            var apply = function() {
                var idx = parseInt(input.getAttribute('data-idx'));
                var layer = mlState.layers[idx];
                var minEl = listEl.querySelector('.pvd-range-min[data-idx="' + idx + '"]');
                var maxEl = listEl.querySelector('.pvd-range-max[data-idx="' + idx + '"]');
                var newMin = parseFloat(minEl.value);
                var newMax = parseFloat(maxEl.value);
                if (!isNaN(newMin) && !isNaN(newMax) && newMin < newMax) {
                    layer.rangeMin = newMin;
                    layer.rangeMax = newMax;
                    if (layer.loaded) {
                        recolorSingleLayer(mlState, idx);
                    }
                }
            };
            input.addEventListener('keydown', function(e) { if (e.key === 'Enter') apply(); });
            input.addEventListener('blur', apply);
        });

        // Range reset button
        listEl.querySelectorAll('.pvd-range-reset').forEach(function(btn) {
            btn.addEventListener('click', function() {
                var idx = parseInt(this.getAttribute('data-idx'));
                var layer = mlState.layers[idx];
                layer.rangeMin = null;
                layer.rangeMax = null;
                if (layer.loaded) {
                    loadSingleLayer(mlState, idx, function() {
                        mlState.renderWindow.render();
                        renderLayerPanel(mlState);
                    });
                }
            });
        });

        // STL opacity slider
        listEl.querySelectorAll('.pvd-stl-opacity').forEach(function(slider) {
            slider.addEventListener('input', function() {
                var idx = parseInt(this.getAttribute('data-idx'));
                var layer = mlState.layers[idx];
                layer.baseOpacity = parseFloat(this.value);
                this.nextElementSibling.textContent = Math.round(layer.baseOpacity * 100) + '%';
                layer.actors.forEach(function(a) { a.getProperty().setOpacity(layer.baseOpacity); });
                mlState.renderWindow.render();
            });
        });

        // Per-layer opacity editor button
        listEl.querySelectorAll('.pvd-layer-opacity-btn').forEach(function(btn) {
            btn.addEventListener('click', function() {
                var idx = parseInt(this.getAttribute('data-idx'));
                // Close existing panel if open
                var existing = document.getElementById('pvd-ml-opacity-panel');
                if (existing) existing.remove();
                // Set expanded layer and open editor
                mlState.expandedLayer = idx;
                createMLOpacityEditor(mlState);
            });
        });
    }

    function recolorSingleLayer(mlState, layerIdx) {
        var layer = mlState.layers[layerIdx];
        if (layer.type === 'stl' || !layer.loaded) return;
        var cmap = layer.layerColormap || mlState.colormap;
        layer.actors.forEach(function(actor) {
            var mapper = actor.getMapper();
            if (!mapper) return;
            if (layer.rangeMin !== null) {
                var lut = mlState.vtkClasses.vtkColorTransferFunction.newInstance();
                applyColormap(lut, cmap, layer.rangeMin, layer.rangeMax);
                mapper.setLookupTable(lut);
                mapper.setScalarRange(layer.rangeMin, layer.rangeMax);
            }
        });
        mlState.renderWindow.render();
    }

    function loadVisibleLayers(mlState, callback) {
        var targetTime = mlState.masterTimeline[mlState.currentTimeIdx] || 0;
        var pending = 0;
        // Double-buffer: collect new actors per layer, then swap atomically
        var newActorSets = {};

        mlState.layers.forEach(function(layer, idx) {
            if (!layer.visible) return;
            if (layer.type === 'stl') {
                // STLs are static, load once
                if (!layer.loaded) {
                    pending++;
                    loadSTLLayer(mlState, idx, function() {
                        pending--;
                        if (pending <= 0) { mlState.renderWindow.render(); if (callback) callback(); }
                    });
                }
                return;
            }
            if (!layer.pvdInfo) return;

            // Find nearest timestep for this layer
            var ts = layer.pvdInfo.timesteps;
            var bestIdx = 0;
            var bestDiff = Infinity;
            ts.forEach(function(t, i) {
                var diff = Math.abs(t.time - targetTime);
                if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
            });

            pending++;
            loadLayerTimestepBuffered(mlState, idx, bestIdx, function(actors) {
                newActorSets[idx] = actors;
                pending--;
                if (pending <= 0) {
                    // Atomic swap: remove old, add new for all layers at once
                    Object.keys(newActorSets).forEach(function(k) {
                        var li = parseInt(k);
                        var lay = mlState.layers[li];
                        // Remove old actors
                        lay.actors.forEach(function(a) { mlState.renderer.removeActor(a); });
                        // Add new actors
                        lay.actors = newActorSets[li];
                        lay.actors.forEach(function(a) { mlState.renderer.addActor(a); });
                        lay.loaded = true;
                    });
                    mlState.renderWindow.render();
                    if (callback) callback();
                }
            });
        });

        if (pending === 0 && callback) callback();
    }

    function loadSingleLayer(mlState, idx, callback) {
        var layer = mlState.layers[idx];
        if (layer.type === 'stl') {
            loadSTLLayer(mlState, idx, callback);
            return;
        }
        if (!layer.pvdInfo) { if (callback) callback(); return; }

        var targetTime = mlState.masterTimeline[mlState.currentTimeIdx] || 0;
        var ts = layer.pvdInfo.timesteps;
        var bestIdx = 0, bestDiff = Infinity;
        ts.forEach(function(t, i) {
            var diff = Math.abs(t.time - targetTime);
            if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
        });
        loadLayerTimestep(mlState, idx, bestIdx, callback);
    }

    function loadLayerTimestep(mlState, layerIdx, tsIdx, callback) {
        var layer = mlState.layers[layerIdx];
        var ts = layer.pvdInfo.timesteps[tsIdx];
        if (!ts || !ts.files) { if (callback) callback(); return; }

        // Remove old actors
        layer.actors.forEach(function(a) { mlState.renderer.removeActor(a); });
        layer.actors = [];

        var files = ts.files;
        var filesLoaded = 0;

        files.forEach(function(fileInfo) {
            var filePath = fileInfo.file;
            // Build the serve URL — filePath is relative to the PVD's directory
            var pvdDir = layer.path.replace(/[^/]*$/, ''); // e.g. "Output/SliceX_0.000/"... but PVD is at Output/SliceX_0.000.pvd
            // Actually the pvd-info response's file paths are relative to the PVD file
            // The PVD file is at Output/<name>.pvd, so pvd dir is Output/
            // But wait — the pvd-info handler resolves file paths relative to the PVD file's directory
            // For vtk-serve, we need the path relative to out/
            var pvdBaseName = layer.path; // e.g. "Output/SliceX_0.000.pvd"
            var pvdDirParts = pvdBaseName.split('/');
            pvdDirParts.pop(); // remove filename
            var pvdDirPath = pvdDirParts.join('/'); // e.g. "Output"
            var fullPath = pvdDirPath + '/' + filePath;

            fetch('/api/jobs/' + mlState.jobId + '/files/vtk-serve?path=' + encodeURIComponent(fullPath), {
                headers: { 'Authorization': 'Bearer ' + getToken() }
            })
            .then(function(r) { return r.arrayBuffer(); })
            .then(function(buffer) {
                // vtk-serve always returns VTP (converts VTI/VTU → VTP on backend)
                var reader = mlState.vtkClasses.vtkXMLPolyDataReader.newInstance();
                reader.parseAsArrayBuffer(buffer);
                var output = reader.getOutputData(0);
                if (!output) { filesLoaded++; return; }

                var mapper = mlState.vtkClasses.vtkMapper.newInstance();
                mapper.setInputData(output);

                // Apply coloring
                var activeArr = layer.activeArrayName;
                if (activeArr) {
                    var pd = output.getPointData ? output.getPointData() : null;
                    var cd = output.getCellData ? output.getCellData() : null;
                    var arr = (pd && pd.getArrayByName(activeArr)) || (cd && cd.getArrayByName(activeArr));
                    if (arr) {
                        var range = arr.getRange();
                        if (layer.rangeMin === null) { layer.rangeMin = range[0]; layer.rangeMax = range[1]; }
                        var lut = mlState.vtkClasses.vtkColorTransferFunction.newInstance();
                        var cmap = layer.layerColormap || mlState.colormap;
                        applyColormap(lut, cmap, layer.rangeMin, layer.rangeMax);
                        mapper.setLookupTable(lut);
                        mapper.setScalarRange(layer.rangeMin, layer.rangeMax);
                        mapper.setScalarVisibility(true);
                        if (pd && pd.getArrayByName(activeArr)) {
                            mapper.setScalarModeToUsePointFieldData();
                        } else {
                            mapper.setScalarModeToUseCellFieldData();
                        }
                        mapper.setColorByArrayName(activeArr);
                    }
                }

                var actor = mlState.vtkClasses.vtkActor.newInstance();
                actor.setMapper(mapper);
                actor.setVisibility(layer.visible);

                // Apply linear opacity transfer for slices/boundaries
                if (layer.useLinearOpacity && activeArr && arr) {
                    applyLinearOpacityMapping(mlState, mapper, output, arr, layer);
                }

                actor.getProperty().setOpacity(layer.baseOpacity);
                layer.actors.push(actor);
                mlState.renderer.addActor(actor);
                layer.loaded = true;

                filesLoaded++;
                if (filesLoaded >= files.length) {
                    mlState.renderWindow.render();
                    if (callback) callback();
                }
            })
            .catch(function() {
                filesLoaded++;
                if (filesLoaded >= files.length) {
                    mlState.renderWindow.render();
                    if (callback) callback();
                }
            });
        });

        if (files.length === 0 && callback) callback();
    }

    /**
     * Buffered version: builds actors off-screen and returns them via callback
     * without touching the renderer. Used for double-buffered playback.
     */
    function loadLayerTimestepBuffered(mlState, layerIdx, tsIdx, callback) {
        var layer = mlState.layers[layerIdx];
        var ts = layer.pvdInfo.timesteps[tsIdx];
        if (!ts || !ts.files) { if (callback) callback([]); return; }

        var files = ts.files;
        var filesLoaded = 0;
        var newActors = [];

        files.forEach(function(fileInfo) {
            var filePath = fileInfo.file;
            var pvdBaseName = layer.path;
            var pvdDirParts = pvdBaseName.split('/');
            pvdDirParts.pop();
            var pvdDirPath = pvdDirParts.join('/');
            var fullPath = pvdDirPath + '/' + filePath;

            fetch('/api/jobs/' + mlState.jobId + '/files/vtk-serve?path=' + encodeURIComponent(fullPath), {
                headers: { 'Authorization': 'Bearer ' + getToken() }
            })
            .then(function(r) { return r.arrayBuffer(); })
            .then(function(buffer) {
                var reader = mlState.vtkClasses.vtkXMLPolyDataReader.newInstance();
                reader.parseAsArrayBuffer(buffer);
                var output = reader.getOutputData(0);
                if (!output) { filesLoaded++; if (filesLoaded >= files.length && callback) callback(newActors); return; }

                var mapper = mlState.vtkClasses.vtkMapper.newInstance();
                mapper.setInputData(output);

                var activeArr = layer.activeArrayName;
                if (activeArr) {
                    var pd = output.getPointData ? output.getPointData() : null;
                    var cd = output.getCellData ? output.getCellData() : null;
                    var arr = (pd && pd.getArrayByName(activeArr)) || (cd && cd.getArrayByName(activeArr));
                    if (arr) {
                        var range = arr.getRange();
                        if (layer.rangeMin === null) { layer.rangeMin = range[0]; layer.rangeMax = range[1]; }
                        var lut = mlState.vtkClasses.vtkColorTransferFunction.newInstance();
                        var cmap = layer.layerColormap || mlState.colormap;
                        applyColormap(lut, cmap, layer.rangeMin, layer.rangeMax);
                        mapper.setLookupTable(lut);
                        mapper.setScalarRange(layer.rangeMin, layer.rangeMax);
                        mapper.setScalarVisibility(true);
                        if (pd && pd.getArrayByName(activeArr)) {
                            mapper.setScalarModeToUsePointFieldData();
                        } else {
                            mapper.setScalarModeToUseCellFieldData();
                        }
                        mapper.setColorByArrayName(activeArr);

                        // Apply linear opacity for slices
                        if (layer.useLinearOpacity) {
                            applyLinearOpacityMapping(mlState, mapper, output, arr, layer);
                        }
                    }
                }

                var actor = mlState.vtkClasses.vtkActor.newInstance();
                actor.setMapper(mapper);
                actor.setVisibility(layer.visible);
                actor.getProperty().setOpacity(layer.baseOpacity);
                newActors.push(actor);

                filesLoaded++;
                if (filesLoaded >= files.length && callback) callback(newActors);
            })
            .catch(function() {
                filesLoaded++;
                if (filesLoaded >= files.length && callback) callback(newActors);
            });
        });

        if (files.length === 0 && callback) callback([]);
    }

    function loadSTLLayer(mlState, layerIdx, callback) {
        var layer = mlState.layers[layerIdx];
        if (layer.loaded) { if (callback) callback(); return; }

        fetch('/api/jobs/' + mlState.jobId + '/files/vtk-serve?path=' + encodeURIComponent(layer.path), {
            headers: { 'Authorization': 'Bearer ' + getToken() }
        })
        .then(function(r) { return r.arrayBuffer(); })
        .then(function(buffer) {
            var reader = mlState.vtkClasses.vtkSTLReader.newInstance();
            reader.parseAsArrayBuffer(buffer);
            var output = reader.getOutputData(0);
            if (!output) { if (callback) callback(); return; }

            var mapper = mlState.vtkClasses.vtkMapper.newInstance();
            mapper.setInputData(output);
            mapper.setScalarVisibility(false);

            var actor = mlState.vtkClasses.vtkActor.newInstance();
            actor.setMapper(mapper);
            actor.getProperty().setColor(0.7, 0.7, 0.75);
            actor.getProperty().setOpacity(layer.baseOpacity || 0.1);
            actor.setVisibility(layer.visible);

            layer.actors.push(actor);
            mlState.renderer.addActor(actor);
            layer.loaded = true;

            mlState.renderWindow.render();
            if (callback) callback();
        })
        .catch(function() {
            if (callback) callback();
        });
    }

    /**
     * Apply linear opacity transfer (0 at rangeMin → 255 at rangeMax) to a layer's dataset.
     * Uses direct RGBA scalars like the single-PVD opacity mapping system.
     */
    function applyLinearOpacityMapping(mlState, mapper, dataset, dataArray, layer) {
        try {
            var numTuples = dataArray.getNumberOfTuples();
            if (numTuples === 0) return;

            var rangeMin = layer.rangeMin;
            var rangeMax = layer.rangeMax;
            var span = rangeMax - rangeMin;
            if (span <= 0) span = 1;

            // Get colormap LUT
            var lut = mlState.vtkClasses.vtkColorTransferFunction.newInstance();
            applyColormap(lut, mlState.colormap, rangeMin, rangeMax);

            // Build RGBA array
            var rgba = new Uint8Array(numTuples * 4);
            var rgb = [0, 0, 0];
            for (var i = 0; i < numTuples; i++) {
                var val = dataArray.getTuple(i)[0];
                var t = (val - rangeMin) / span;
                if (t < 0) t = 0;
                if (t > 1) t = 1;

                lut.getColor(val, rgb);
                rgba[i * 4]     = Math.round(rgb[0] * 255);
                rgba[i * 4 + 1] = Math.round(rgb[1] * 255);
                rgba[i * 4 + 2] = Math.round(rgb[2] * 255);
                rgba[i * 4 + 3] = Math.round(t * 255); // linear opacity: 0→255
            }

            // Attach as color scalars
            var vtkDA = vtk.Common.Core.vtkDataArray.newInstance({
                numberOfComponents: 4,
                values: rgba,
                name: 'OpacityMappedColors',
            });

            // Determine if point or cell data
            var isPoint = dataset.getPointData && dataset.getPointData().getArrayByName(dataArray.getName());
            if (isPoint) {
                dataset.getPointData().setScalars(vtkDA);
            } else {
                dataset.getCellData().setScalars(vtkDA);
            }

            mapper.setColorModeToDirectScalars();
            mapper.setScalarVisibility(true);
            if (isPoint) {
                mapper.setScalarModeToUsePointFieldData();
            } else {
                mapper.setScalarModeToUseCellFieldData();
            }
            mapper.setColorByArrayName('OpacityMappedColors');
        } catch (e) {
            // Fallback: no opacity mapping
            console.warn('Linear opacity mapping failed for layer ' + layer.name, e);
        }
    }

    function recolorAllLayers(mlState) {
        mlState.layers.forEach(function(layer) {
            if (layer.type === 'stl' || !layer.loaded) return;
            layer.actors.forEach(function(actor) {
                var mapper = actor.getMapper();
                if (!mapper) return;
                var lut = mapper.getLookupTable();
                if (lut && layer.rangeMin !== null) {
                    applyColormap(lut, mlState.colormap, layer.rangeMin, layer.rangeMax);
                    mapper.setLookupTable(lut);
                }
            });
        });
        mlState.renderWindow.render();
    }

    /**
     * Open the PVD viewer for an AI prediction result (absolute path)
     */
    function openAiPvdViewer(absPath) {
        // Show loading overlay
        var overlay = document.createElement('div');
        overlay.className = 'pvd-viewer-overlay';
        overlay.id = 'pvd-viewer-overlay';
        overlay.innerHTML =
            '<div class="pvd-viewer-header">' +
            '  <div class="pvd-viewer-title">' +
            '    <div class="pvd-loading-text">Loading prediction...</div>' +
            '    <span>Loading AI Prediction...</span>' +
            '  </div>' +
            '  <button class="pvd-viewer-close" id="pvd-close-btn">&times;</button>' +
            '</div>' +
            '<div class="pvd-controls pvd-controls-top" id="pvd-controls-top" style="display:none;"></div>' +
            '<div class="pvd-canvas-container" id="pvd-canvas-container">' +
            '  <div class="pvd-loading-overlay" id="pvd-loading">' +
            '    <div class="spinner"></div>' +
            '    <div class="pvd-loading-text">Loading prediction...</div>' +
            '  </div>' +
            '</div>' +
            '<div class="pvd-controls" id="pvd-controls" style="display:none;"></div>';
        document.body.appendChild(overlay);

        document.getElementById('pvd-close-btn').addEventListener('click', closePvdViewer);

        var vtkClasses = getVtkClasses();
        if (!vtkClasses) {
            showViewerError('vtk.js library failed to load.');
            return;
        }

        // Fetch PVD info from AI artifacts endpoint
        fetch('/api/ai/artifacts/pvd-info?path=' + encodeURIComponent(absPath), {
            headers: { 'Authorization': 'Bearer ' + getToken() }
        })
        .then(function(r) { return r.json(); })
        .then(function(pvdInfo) {
            if (pvdInfo.error) {
                showViewerError(pvdInfo.error);
                return;
            }
            if (!pvdInfo.timesteps || pvdInfo.timesteps.length === 0) {
                showViewerError('No timesteps found in prediction PVD');
                return;
            }
            var fname = absPath.split('/').pop();
            overlay.querySelector('.pvd-viewer-title span').textContent = fname;

            // Use jobId = -1 as sentinel for AI mode
            initializeViewer(vtkClasses, -1, absPath, pvdInfo);
            // Mark AI mode on viewerState
            if (viewerState) viewerState.aiMode = true;
        })
        .catch(function(err) {
            console.error('[PVD Viewer] AI init error:', err);
            showViewerError('Failed to load prediction: ' + err.message);
        });
    }

    // Expose globally for scripts.js
    window._pvdViewer = {
        openPvdViewer: openPvdViewer,
        closePvdViewer: closePvdViewer,
        openMultiLayerViewer: openMultiLayerViewer,
        openAiPvdViewer: openAiPvdViewer
    };
})();
