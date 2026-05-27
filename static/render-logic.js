// Render Page Logic — called after DOM is ready
function initRenderPage(api, state, toast, escapeHtml, formatFileSize, navigate) {
    let selectedSourceJobId = null;
    let selectedSourcePath = null;
    let selectedStateFile = null;
    let selectedGpus = new Set();

    // --- Source tabs ---
    const srcTabs = {job: 'src-tab-job', browse: 'src-tab-browse', path: 'src-tab-path'};
    const srcPanels = {job: 'src-job-panel', browse: 'src-browse-panel', path: 'src-path-panel'};
    function activateSrcTab(key) {
        Object.keys(srcTabs).forEach(k => {
            document.getElementById(srcTabs[k]).classList.toggle('active', k===key);
            document.getElementById(srcPanels[k]).style.display = k===key ? '' : 'none';
        });
    }
    Object.keys(srcTabs).forEach(k => {
        document.getElementById(srcTabs[k]).addEventListener('click', () => activateSrcTab(k));
    });

    // --- PVSM tabs ---
    const pvsmTabs = {browse: 'pvsm-tab-browse', upload: 'pvsm-tab-upload', url: 'pvsm-tab-url'};
    const pvsmPanels = {browse: 'pvsm-browse-panel', upload: 'pvsm-upload-panel', url: 'pvsm-url-panel'};
    function activatePvsmTab(key) {
        Object.keys(pvsmTabs).forEach(k => {
            document.getElementById(pvsmTabs[k]).classList.toggle('active', k===key);
            document.getElementById(pvsmPanels[k]).style.display = k===key ? '' : 'none';
        });
    }
    Object.keys(pvsmTabs).forEach(k => {
        document.getElementById(pvsmTabs[k]).addEventListener('click', () => activatePvsmTab(k));
    });

    // --- Resolution toggle ---
    document.getElementById('render-resolution').addEventListener('change', function() {
        document.getElementById('render-custom-res-group').style.display = this.value === 'custom' ? '' : 'none';
    });

    // --- Update submit button ---
    function updateSubmitBtn() {
        const hasSource = !!(selectedSourceJobId || selectedSourcePath);
        const hasState = !!selectedStateFile;
        const hasGpu = selectedGpus.size > 0;
        document.getElementById('render-submit-btn').disabled = !(hasSource && hasState && hasGpu);
    }

    function setSourceInfo(text) {
        document.getElementById('src-info-container').innerHTML = `
            <div class="file-info">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>
                <span>${escapeHtml(text)}</span>
            </div>`;
    }
    function setStateInfo(text) {
        document.getElementById('pvsm-info-container').innerHTML = `
            <div class="file-info">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>
                <span>${escapeHtml(text)}</span>
            </div>`;
    }

    // --- Load jobs ---
    async function loadJobs() {
        const data = await api.get('/jobs?status=completed&limit=200');
        const jobSelect = document.getElementById('render-source-job');
        const jobs = (Array.isArray(data) ? data : []).filter(j => j.job_type !== 'render');
        if (jobs.length === 0) {
            jobSelect.innerHTML = '<option value="">No completed jobs available</option>';
        } else {
            jobSelect.innerHTML = '<option value="">Select a job...</option>' +
                jobs.map(j => `<option value="${j.id}">#${j.id} — ${escapeHtml(j.name)} (${j.resolved_version || j.mstar_version})</option>`).join('');
        }
    }

    // Job select handler
    document.getElementById('render-source-job').addEventListener('change', function() {
        selectedSourcePath = null;
        if (this.value) {
            selectedSourceJobId = parseInt(this.value, 10);
            setSourceInfo('Job #' + selectedSourceJobId);
        } else {
            selectedSourceJobId = null;
            document.getElementById('src-info-container').innerHTML = '';
        }
        updateSubmitBtn();
    });

    // --- Source browse (dirs only) ---
    async function loadSrcBrowse(path) {
        const data = await api.get(`/browse?path=${encodeURIComponent(path)}&mode=dirs`);
        if (!data || data.error) { toast(data?.error || 'Browse failed', 'error'); return; }

        const bar = document.getElementById('src-browse-path-bar');
        const parts = data.path.split('/').filter(Boolean);
        let crumbs = '<span style="cursor:pointer;color:var(--accent-blue);" data-src-path="/simulations">simulations</span>';
        let acc = '';
        for (const part of parts) {
            acc += '/' + part;
            if (acc === '/simulations') continue;
            crumbs += ' <span style="color:var(--text-muted);">/</span> ';
            crumbs += `<span style="cursor:pointer;color:var(--accent-blue);" data-src-path="${acc}">${part}</span>`;
        }
        bar.innerHTML = crumbs;
        bar.querySelectorAll('[data-src-path]').forEach(el => el.addEventListener('click', () => loadSrcBrowse(el.dataset.srcPath)));

        const list = document.getElementById('src-browse-list');
        let html = '';
        if (data.parent) html += `<div class="browse-entry browse-dir" data-src-nav="${data.parent}" style="padding:10px 14px;display:flex;align-items:center;gap:10px;cursor:pointer;border-bottom:1px solid var(--border);"><span style="font-size:18px;">⬆️</span><span style="color:var(--text-secondary);">..</span></div>`;
        for (const e of data.entries) {
            const hasOut = false; // We check on select
            html += `<div class="browse-entry browse-dir" data-src-nav="${e.path}" data-src-select="${e.path}" style="padding:10px 14px;display:flex;align-items:center;gap:10px;cursor:pointer;border-bottom:1px solid var(--border);${selectedSourcePath===e.path?'background:rgba(59,130,246,0.15);':''}"><span style="font-size:18px;">📁</span><span style="flex:1;">${escapeHtml(e.name)}</span></div>`;
        }
        if (!data.entries.length && !data.parent) html = '<div style="padding:20px;text-align:center;color:var(--text-muted);">Empty directory</div>';
        list.innerHTML = html;

        // Double-click enters dir, single-click selects as source
        list.querySelectorAll('[data-src-nav]').forEach(el => {
            el.addEventListener('dblclick', () => loadSrcBrowse(el.dataset.srcNav));
            if (el.dataset.srcSelect) {
                el.addEventListener('click', (ev) => {
                    if (ev.detail > 1) return; // skip dblclick
                    selectedSourcePath = el.dataset.srcSelect;
                    selectedSourceJobId = null;
                    setSourceInfo('Path: ' + selectedSourcePath);
                    list.querySelectorAll('[data-src-select]').forEach(x => x.style.background='');
                    el.style.background = 'rgba(59,130,246,0.15)';
                    updateSubmitBtn();
                });
            }
        });
        // Parent nav is navigate only
        list.querySelectorAll('[data-src-nav]:not([data-src-select])').forEach(el => {
            el.addEventListener('click', () => loadSrcBrowse(el.dataset.srcNav));
        });
    }
    loadSrcBrowse('/simulations');

    // --- Source path input ---
    document.getElementById('src-path-set-btn').addEventListener('click', () => {
        const p = document.getElementById('src-path-input').value.trim();
        if (!p) { toast('Enter a path', 'error'); return; }
        selectedSourcePath = p;
        selectedSourceJobId = null;
        setSourceInfo('Path: ' + p);
        updateSubmitBtn();
    });

    // --- PVSM browse ---
    async function loadPvsmBrowse(path) {
        const data = await api.get(`/browse?path=${encodeURIComponent(path)}&mode=pvsm`);
        if (!data || data.error) { toast(data?.error || 'Browse failed', 'error'); return; }

        const bar = document.getElementById('pvsm-browse-path-bar');
        const parts = data.path.split('/').filter(Boolean);
        let crumbs = '<span style="cursor:pointer;color:var(--accent-blue);" data-pvsm-path="/simulations">simulations</span>';
        let acc = '';
        for (const part of parts) {
            acc += '/' + part;
            if (acc === '/simulations') continue;
            crumbs += ' <span style="color:var(--text-muted);">/</span> ';
            crumbs += `<span style="cursor:pointer;color:var(--accent-blue);" data-pvsm-path="${acc}">${part}</span>`;
        }
        bar.innerHTML = crumbs;
        bar.querySelectorAll('[data-pvsm-path]').forEach(el => el.addEventListener('click', () => loadPvsmBrowse(el.dataset.pvsmPath)));

        const list = document.getElementById('pvsm-browse-list');
        let html = '';
        if (data.parent) html += `<div class="browse-entry browse-dir" data-pvsm-nav="${data.parent}" style="padding:10px 14px;display:flex;align-items:center;gap:10px;cursor:pointer;border-bottom:1px solid var(--border);"><span style="font-size:18px;">⬆️</span><span style="color:var(--text-secondary);">..</span></div>`;
        for (const e of data.entries) {
            if (e.is_dir) {
                html += `<div class="browse-entry browse-dir" data-pvsm-nav="${e.path}" style="padding:10px 14px;display:flex;align-items:center;gap:10px;cursor:pointer;border-bottom:1px solid var(--border);"><span style="font-size:18px;">📁</span><span>${escapeHtml(e.name)}</span></div>`;
            } else {
                html += `<div class="browse-entry browse-msb" data-pvsm-select="${e.path}" style="padding:10px 14px;display:flex;align-items:center;gap:10px;cursor:pointer;border-bottom:1px solid var(--border);${selectedStateFile===e.path?'background:rgba(59,130,246,0.15);':''}"><span style="font-size:18px;">📄</span><span style="flex:1;">${escapeHtml(e.name)}</span><span style="font-size:12px;color:var(--text-muted);">${formatFileSize(e.size)}</span></div>`;
            }
        }
        if (!data.entries.length && !data.parent) html = '<div style="padding:20px;text-align:center;color:var(--text-muted);">No .pvsm files found</div>';
        list.innerHTML = html;

        list.querySelectorAll('[data-pvsm-nav]').forEach(el => el.addEventListener('click', () => loadPvsmBrowse(el.dataset.pvsmNav)));
        list.querySelectorAll('[data-pvsm-select]').forEach(el => {
            el.addEventListener('click', () => {
                selectedStateFile = el.dataset.pvsmSelect;
                setStateInfo(selectedStateFile.split('/').pop());
                list.querySelectorAll('[data-pvsm-select]').forEach(x => x.style.background='');
                el.style.background = 'rgba(59,130,246,0.15)';
                updateSubmitBtn();
            });
        });
    }
    loadPvsmBrowse('/simulations');

    // --- PVSM Upload ---
    const pvsmDropzone = document.getElementById('pvsm-dropzone');
    const pvsmFileInput = document.getElementById('pvsm-file-input');
    pvsmDropzone.addEventListener('click', () => pvsmFileInput.click());
    pvsmDropzone.addEventListener('dragover', (e) => { e.preventDefault(); pvsmDropzone.classList.add('dragover'); });
    pvsmDropzone.addEventListener('dragleave', () => pvsmDropzone.classList.remove('dragover'));
    pvsmDropzone.addEventListener('drop', (e) => { e.preventDefault(); pvsmDropzone.classList.remove('dragover'); if (e.dataTransfer.files.length) handlePvsmUpload(e.dataTransfer.files[0]); });
    pvsmFileInput.addEventListener('change', (e) => { if (e.target.files.length) handlePvsmUpload(e.target.files[0]); });

    async function handlePvsmUpload(file) {
        if (!file.name.toLowerCase().endsWith('.pvsm')) { toast('File must be .pvsm', 'error'); return; }
        // If we have a source job, upload to it; otherwise just note the path
        if (selectedSourceJobId) {
            pvsmDropzone.innerHTML = '<div class="spinner"></div> Uploading...';
            const formData = new FormData();
            formData.append('file', file);
            try {
                const resp = await fetch(`/api/jobs/${selectedSourceJobId}/upload-state`, {
                    method: 'POST', headers: { 'Authorization': `Bearer ${state.token}` }, body: formData,
                });
                const result = await resp.json();
                if (result.error) { toast(result.error, 'error'); } 
                else {
                    selectedStateFile = result.path || file.name;
                    setStateInfo('Uploaded: ' + file.name);
                    toast('State file uploaded', 'success');
                }
            } catch(e) { toast('Upload failed: ' + e.message, 'error'); }
            pvsmDropzone.innerHTML = `<div class="dropzone-icon"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg></div><div class="dropzone-text">Drop your <strong>.pvsm</strong> file here or click to browse</div><div class="dropzone-hint">Maximum size: 500 MB</div>`;
        } else {
            toast('Select a source job first to upload a state file', 'error');
        }
        updateSubmitBtn();
    }

    // --- PVSM URL ---
    document.getElementById('pvsm-url-fetch-btn').addEventListener('click', () => {
        const url = document.getElementById('pvsm-url-input').value.trim();
        if (!url) { toast('Enter a URL', 'error'); return; }
        try { new URL(url); } catch { toast('Invalid URL', 'error'); return; }
        selectedStateFile = url;
        setStateInfo('URL: ' + url.split('/').pop().split('?')[0]);
        updateSubmitBtn();
        toast('State file URL set', 'success');
    });

    // --- Load versions ---
    async function loadVersions() {
        const versions = await api.get('/versions');
        const sel = document.getElementById('render-version');
        if (Array.isArray(versions)) {
            sel.innerHTML = versions.map(v => `<option value="${v.version}" ${v.is_latest ? 'selected' : ''}>${v.label}</option>`).join('');
        }
    }

    // --- Load GPUs (card grid, matching Submit page) ---
    async function loadGpus() {
        const gpus = await api.get('/gpus');
        const grid = document.getElementById('render-gpu-grid');
        if (!Array.isArray(gpus)) return;
        grid.innerHTML = gpus.map(gpu => {
            const reserved = !!gpu.running_job || gpu.externally_busy;
            let statusLabel = reserved ? (gpu.running_job ? `In use: ${gpu.running_job.job_name}` : 'External Workload') : 'Available';
            let statusColor = reserved ? (gpu.running_job ? 'var(--accent-amber)' : 'var(--accent-red)') : 'var(--accent-green)';
            return `<div class="gpu-select-card ${reserved?'reserved':''}" data-gpu-id="${gpu.index}">
                <div class="gpu-select-name">GPU ${gpu.index}: ${gpu.name.split(' ').pop()}</div>
                <div class="gpu-select-meta">${formatFileSize(gpu.memory_total * 1024 * 1024)} VRAM</div>
                <div class="gpu-select-meta" style="color:${statusColor}">${statusLabel}</div>
            </div>`;
        }).join('');

        grid.querySelectorAll('.gpu-select-card:not(.reserved)').forEach(card => {
            card.addEventListener('click', () => {
                const id = parseInt(card.dataset.gpuId);
                if (selectedGpus.has(id)) { selectedGpus.delete(id); card.classList.remove('selected'); }
                else { selectedGpus.add(id); card.classList.add('selected'); }
                updateSubmitBtn();
            });
        });
    }

    // --- Active Renders ---
    async function loadActiveRenders() {
        const listEl = document.getElementById('render-active-list');
        if (!listEl) return;
        const allJobs = await api.get('/jobs?limit=50');
        const renderJobs = (Array.isArray(allJobs) ? allJobs : []).filter(j => j.job_type === 'render').slice(0, 15);
        if (renderJobs.length === 0) { listEl.innerHTML = '<div style="padding:16px;color:var(--text-muted);text-align:center;">No render jobs yet</div>'; return; }
        listEl.innerHTML = renderJobs.map(j => {
            const cls = j.status === 'running' ? 'badge-running' : j.status === 'completed' ? 'badge-completed' : j.status === 'failed' ? 'badge-failed' : 'badge-queued';
            // Show progress bar for running AND failed jobs (so users see where it stopped)
            const showProgress = j.status === 'running' || j.status === 'failed';
            return `<div class="render-history-item"><div class="render-history-header"><span class="text-mono">#${j.id}</span><span>${escapeHtml(j.name)}</span><span class="badge ${cls}">${j.status}</span></div>
                ${showProgress?`<div class="render-progress-bar" id="render-progress-${j.id}"><div class="render-progress-fill" style="width:0%"></div></div>`:''}
                ${j.error_message?`<div class="text-sm" style="color:var(--accent-red);margin-top:4px;">${escapeHtml(j.error_message)}</div>`:''}
                <div id="render-error-${j.id}"></div></div>`;
        }).join('');

        // Poll status for running AND failed jobs (failed jobs have stale progress info)
        for (const j of renderJobs.filter(j => j.status === 'running' || j.status === 'failed')) {
            const data = await api.get(`/render/${j.id}/status`);
            if (data && !data.error) {
                const bar = document.getElementById(`render-progress-${j.id}`);
                if (bar) {
                    const fill = bar.querySelector('.render-progress-fill');
                    if (fill) {
                        const pct = data.percent || 0;
                        fill.style.width = `${pct}%`;
                        const frameText = `${data.current_frame||0}/${data.total_frames||'?'}`;
                        if (j.status === 'failed') {
                            fill.style.background = 'var(--accent-red, #ef4444)';
                            fill.textContent = `Failed at frame ${frameText}`;
                        } else {
                            fill.textContent = `${pct}% — Frame ${frameText}`;
                        }
                    }
                }
                // Show error from status API if not already shown from job.error_message
                if (data.error && data.job_status === 'failed') {
                    const errEl = document.getElementById(`render-error-${j.id}`);
                    if (errEl && !j.error_message) {
                        errEl.innerHTML = `<div class="text-sm" style="color:var(--accent-red);margin-top:4px;">${escapeHtml(data.error)}</div>`;
                    }
                }
            }
        }
    }

    // --- Submit ---
    document.getElementById('render-submit-btn').addEventListener('click', async () => {
        if (!selectedStateFile || selectedGpus.size === 0) return;
        if (!selectedSourceJobId && !selectedSourcePath) return;

        const btn = document.getElementById('render-submit-btn');
        btn.disabled = true;
        btn.innerHTML = '<div class="spinner"></div> Submitting...';

        let resolution = null;
        const resVal = document.getElementById('render-resolution').value;
        if (resVal === 'custom') {
            const w = parseInt(document.getElementById('render-width').value, 10);
            const h = parseInt(document.getElementById('render-height').value, 10);
            if (w > 0 && h > 0) resolution = [w, h];
        } else if (resVal) {
            resolution = resVal.split(',').map(Number);
        }

        const body = {
            state_file: selectedStateFile,
            name: document.getElementById('render-name').value || null,
            mstar_version: document.getElementById('render-version').value,
            gpu_id: parseInt([...selectedGpus][0], 10),
            resolution, fps: parseInt(document.getElementById('render-fps').value, 10),
            video_quality: parseInt(document.getElementById('render-quality').value, 10),
            transparent: document.getElementById('render-transparent').checked,
            separate_views: document.getElementById('render-separate-views').checked,
            scale_fonts: document.getElementById('render-scale-fonts').checked,
            generate_video: document.getElementById('render-generate-video').checked,
            compression: 0,
        };
        if (selectedSourceJobId) body.source_job_id = selectedSourceJobId;
        if (selectedSourcePath) body.source_path = selectedSourcePath;

        try {
            const result = await api.post('/render', body);
            if (result.error) { toast(result.error, 'error'); }
            else { toast(`Render job #${result.job_id} created`, 'success'); loadActiveRenders(); }
        } catch(e) { toast('Failed: ' + e.message, 'error'); }
        finally {
            btn.disabled = false;
            btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg> Start Render';
            updateSubmitBtn();
        }
    });

    // --- Init ---
    loadJobs();
    loadVersions();
    loadGpus();
    loadActiveRenders();
    const timer = setInterval(loadActiveRenders, 5000);
    state.refreshTimers.push(timer);
}
