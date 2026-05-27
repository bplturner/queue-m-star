// Render Page — loaded by scripts.js renderRender()
// This file contains the HTML template and logic for the Render tab.

function getRenderPageHTML() {
    return `
    <div class="page-enter">
        <div class="page-header">
            <h1>Render Simulation</h1>
            <p>Generate video/frames from completed simulation output using ParaView</p>
        </div>
        <div class="submit-layout">
            <div>
                <div class="card" style="margin-bottom:16px;">
                    <div class="card-header"><span class="card-title">Simulation Source</span></div>
                    <div style="display:flex;gap:0;margin-bottom:12px;">
                        <button class="btn btn-sm msb-tab active" id="src-tab-job" style="flex:1;border-radius:8px 0 0 8px;justify-content:center;">From Job</button>
                        <button class="btn btn-sm msb-tab" id="src-tab-browse" style="flex:1;border-radius:0;justify-content:center;">Browse Server</button>
                        <button class="btn btn-sm msb-tab" id="src-tab-path" style="flex:1;border-radius:0 8px 8px 0;justify-content:center;">Enter Path</button>
                    </div>
                    <div id="src-job-panel">
                        <select id="render-source-job" class="form-select">
                            <option value="">Loading completed jobs...</option>
                        </select>
                        <div class="dropzone-hint" style="margin-top:4px;">Select a completed simulation job</div>
                    </div>
                    <div id="src-browse-panel" style="display:none;">
                        <div id="src-browse-path-bar" style="display:flex;align-items:center;gap:6px;margin-bottom:8px;font-size:12px;color:var(--text-secondary);overflow-x:auto;white-space:nowrap;"></div>
                        <div id="src-browse-list" style="max-height:280px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;"></div>
                    </div>
                    <div id="src-path-panel" style="display:none;">
                        <div style="display:flex;align-items:center;gap:10px;padding:16px;border:1px solid var(--border);border-radius:8px;background:rgba(99,115,156,0.04);">
                            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--accent-blue)" stroke-width="2" style="flex-shrink:0;"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
                            <input type="text" class="form-input" id="src-path-input" placeholder="/simulations/ProjectName/CaseName" style="flex:1;margin:0;">
                        </div>
                        <button class="btn btn-primary btn-sm" id="src-path-set-btn" style="margin-top:8px;align-self:flex-end;padding:8px 20px;">Set Source Path</button>
                        <div class="dropzone-hint" style="margin-top:4px;">Enter the full path to a simulation output directory (must contain out/ folder)</div>
                    </div>
                    <div id="src-info-container"></div>
                </div>

                <div class="card" style="margin-bottom:16px;">
                    <div class="card-header"><span class="card-title">State File (.pvsm)</span></div>
                    <div style="display:flex;gap:0;margin-bottom:12px;">
                        <button class="btn btn-sm msb-tab active" id="pvsm-tab-browse" style="flex:1;border-radius:8px 0 0 8px;justify-content:center;">Browse Server</button>
                        <button class="btn btn-sm msb-tab" id="pvsm-tab-upload" style="flex:1;border-radius:0;justify-content:center;">Upload File</button>
                        <button class="btn btn-sm msb-tab" id="pvsm-tab-url" style="flex:1;border-radius:0 8px 8px 0;justify-content:center;">From URL</button>
                    </div>
                    <div id="pvsm-browse-panel">
                        <div id="pvsm-browse-path-bar" style="display:flex;align-items:center;gap:6px;margin-bottom:8px;font-size:12px;color:var(--text-secondary);overflow-x:auto;white-space:nowrap;"></div>
                        <div id="pvsm-browse-list" style="max-height:280px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;"></div>
                    </div>
                    <div id="pvsm-upload-panel" style="display:none;">
                        <div class="dropzone" id="pvsm-dropzone">
                            <div class="dropzone-icon">
                                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>
                            </div>
                            <div class="dropzone-text">Drop your <strong>.pvsm</strong> file here or click to browse</div>
                            <div class="dropzone-hint">Maximum size: 500 MB</div>
                        </div>
                        <input type="file" id="pvsm-file-input" accept=".pvsm" style="display:none">
                    </div>
                    <div id="pvsm-url-panel" style="display:none;">
                        <div style="display:flex;align-items:center;gap:10px;padding:16px;border:1px solid var(--border);border-radius:8px;background:rgba(99,115,156,0.04);">
                            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--accent-blue)" stroke-width="2" style="flex-shrink:0;"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>
                            <input type="text" class="form-input" id="pvsm-url-input" placeholder="https://example.com/path/to/state.pvsm" style="flex:1;margin:0;">
                        </div>
                        <button class="btn btn-primary btn-sm" id="pvsm-url-fetch-btn" style="margin-top:8px;padding:8px 20px;">Set URL</button>
                        <div class="dropzone-hint" style="margin-top:4px;">Paste a direct link to a .pvsm state file</div>
                    </div>
                    <div id="pvsm-info-container"></div>
                </div>

                <div class="card">
                    <div class="card-header"><span class="card-title">Render Settings</span></div>
                    <div class="form-group">
                        <label class="form-label">Render Name</label>
                        <input type="text" class="form-input" id="render-name" placeholder="Auto-generated from source name">
                    </div>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
                        <div class="form-group">
                            <label class="form-label">Resolution</label>
                            <select class="form-select" id="render-resolution">
                                <option value="">State File Default</option>
                                <option value="1280,720">720p (1280×720)</option>
                                <option value="1920,1080" selected>1080p (1920×1080)</option>
                                <option value="2560,1440">1440p (2560×1440)</option>
                                <option value="3840,2160">4K (3840×2160)</option>
                                <option value="custom">Custom...</option>
                            </select>
                        </div>
                        <div class="form-group" id="render-custom-res-group" style="display:none;">
                            <label class="form-label">Custom (W × H)</label>
                            <div style="display:flex;gap:8px;">
                                <input type="number" class="form-input" id="render-width" placeholder="W" min="100" max="7680" value="1920" style="flex:1;">
                                <span style="align-self:center;">×</span>
                                <input type="number" class="form-input" id="render-height" placeholder="H" min="100" max="4320" value="1080" style="flex:1;">
                            </div>
                        </div>
                    </div>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
                        <div class="form-group">
                            <label class="form-label">FPS</label>
                            <select class="form-select" id="render-fps">
                                <option value="15">15</option>
                                <option value="25" selected>25</option>
                                <option value="30">30</option>
                                <option value="60">60</option>
                            </select>
                        </div>
                        <div class="form-group">
                            <label class="form-label">Video Quality</label>
                            <select class="form-select" id="render-quality">
                                <option value="28">Low (CRF 28)</option>
                                <option value="23" selected>Medium (CRF 23)</option>
                                <option value="18">High (CRF 18)</option>
                                <option value="0">Lossless (CRF 0)</option>
                            </select>
                        </div>
                    </div>
                    <div class="form-checkbox"><input type="checkbox" id="render-transparent"><label for="render-transparent">Transparent background</label></div>
                    <div class="form-checkbox"><input type="checkbox" id="render-separate-views"><label for="render-separate-views">Separate views</label></div>
                    <div class="form-checkbox"><input type="checkbox" id="render-scale-fonts"><label for="render-scale-fonts">Scale fonts with resolution</label></div>
                    <div class="form-checkbox"><input type="checkbox" id="render-generate-video" checked><label for="render-generate-video">Generate video (MP4)</label></div>
                </div>
            </div>

            <div>
                <div class="card" style="margin-bottom:16px;">
                    <div class="card-header"><span class="card-title">M-Star Version</span></div>
                    <select class="form-select" id="render-version">
                        <option value="latest">Loading versions...</option>
                    </select>
                </div>

                <div class="card" style="margin-bottom:16px;">
                    <div class="card-header"><span class="card-title">GPU Selection</span></div>
                    <div id="render-gpu-grid" class="gpu-select-grid">
                        <div class="skeleton" style="height:60px"></div>
                    </div>
                </div>

                <div class="card" style="margin-bottom:16px;">
                    <div class="card-header"><span class="card-title">Active Renders</span></div>
                    <div id="render-active-list" style="max-height:300px;overflow-y:auto;">
                        <div style="padding:16px;color:var(--text-muted);text-align:center;">Loading...</div>
                    </div>
                </div>

                <button class="btn btn-primary" id="render-submit-btn" style="width:100%;justify-content:center;padding:14px;font-size:15px;" disabled>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                    Start Render
                </button>
            </div>
        </div>
    </div>`;
}
