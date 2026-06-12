/**
 * AI Training Page — M-Star Queue
 * ================================
 * Three-view layout:
 *   1. Dashboard — stats, dataset table, training jobs table
 *   2. Create Dataset — full-page form with file browser
 *   3. New Training Job — full-page form with GPU grid
 *
 * Design mirrors the simulation submit workflow: GPU selection cards,
 * folder browsing starting at /simulations, two-column layout.
 */

// eslint-disable-next-line no-unused-vars
function renderTraining(container) {
    'use strict';

    // ---- Helpers ----
    const escHtml = (s) => {
        const d = document.createElement('div');
        d.textContent = s || '';
        return d.innerHTML;
    };

    const aiApi = {
        async get(path) {
            const headers = { 'Content-Type': 'application/json' };
            const token = localStorage.getItem('mstar_token');
            if (token) headers['Authorization'] = `Bearer ${token}`;
            const res = await fetch(`/api${path}`, { headers });
            return res.json();
        },
        async post(path, body) {
            const headers = { 'Content-Type': 'application/json' };
            const token = localStorage.getItem('mstar_token');
            if (token) headers['Authorization'] = `Bearer ${token}`;
            const res = await fetch(`/api${path}`, {
                method: 'POST', headers,
                body: JSON.stringify(body),
            });
            return res.json();
        }
    };

    function formatTime(ts) {
        if (!ts) return '—';
        try {
            const d = new Date(ts + 'Z');
            return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        } catch { return ts; }
    }

    function formatDuration(seconds) {
        if (!seconds || seconds < 0) return '—';
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        if (h > 0) return `${h}h ${m}m ${s}s`;
        if (m > 0) return `${m}m ${s}s`;
        return `${s}s`;
    }

    function formatFileSize(bytes) {
        if (!bytes) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }

    function formatMemory(mb) {
        if (!mb) return '—';
        if (mb >= 1024) return `${(mb / 1024).toFixed(0)} GB`;
        return `${mb} MB`;
    }

    function statusBadge(status) {
        const colors = {
            queued:    'var(--accent-amber, #f59e0b)',
            launching: 'var(--accent-cyan, #06b6d4)',
            preflight: 'var(--accent-cyan, #06b6d4)',
            running:   'var(--accent-blue, #3b82f6)',
            completed: 'var(--accent-green, #10b981)',
            failed:    'var(--accent-red, #ef4444)',
            cancelled: 'var(--text-muted, #6b7280)',
            pending:   'var(--accent-amber, #f59e0b)',
            ready:     'var(--accent-green, #10b981)',
            scanning:  'var(--accent-cyan, #06b6d4)',
            warnings:  'var(--accent-amber, #f59e0b)',
            error:     'var(--accent-red, #ef4444)',
            empty:     'var(--text-muted, #6b7280)',
            scanned:   'var(--accent-green, #10b981)',
            no_output: 'var(--accent-red, #ef4444)',
            preparing: 'var(--accent-cyan, #06b6d4)',
            prepared:  'var(--accent-purple, #8b5cf6)',
        };
        const c = colors[status] || 'var(--text-muted)';
        const isAnimated = status === 'running' || status === 'preflight' || status === 'launching' || status === 'scanning' || status === 'preparing';
        return `<span class="badge" style="background:${c}22;color:${c};border:1px solid ${c}33;">
            <span class="badge-dot" style="background:${c};${isAnimated ? 'animation:pulse-dot 1.5s infinite;' : ''}"></span>
            ${escHtml(status)}
        </span>`;
    }

    function showToast(msg, type) {
        if (typeof window.showToast === 'function') {
            window.showToast(msg, type);
        } else {
            const tc = document.getElementById('toast-container');
            if (!tc) return;
            const t = document.createElement('div');
            t.className = `toast toast-${type || 'info'}`;
            t.textContent = msg;
            tc.appendChild(t);
            setTimeout(() => t.remove(), 4000);
        }
    }

    function truncate(s, max) {
        if (!s) return '';
        return s.length > max ? s.substring(0, max) + '…' : s;
    }

    // ---- State ----
    let selectedGpus = new Set();
    let pollTimer = null;
    let currentView = 'dashboard'; // 'dashboard' | 'create-dataset' | 'new-training'
    let lastActiveTab = 'datasets'; // 'datasets' | 'training-jobs' — remembers which tab to show

    // Inject page-specific styles once
    const styleEl = document.createElement('style');
    styleEl.textContent = `
        @keyframes pulse-dot { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
        .ai-tabs { display: flex; gap: 0; margin-bottom: 24px; }
        .ai-tab { flex: 1; padding: 12px; text-align: center; cursor: pointer; border: 1px solid var(--border-color, #333); background: var(--bg-card, #1a1a2e); color: var(--text-secondary, #a0a0b0); font-weight: 500; font-size: 14px; transition: all 0.2s; }
        .ai-tab:first-child { border-radius: 10px 0 0 10px; }
        .ai-tab:last-child { border-radius: 0 10px 10px 0; }
        .ai-tab.active { background: var(--accent-blue, #3b82f6); color: #fff; border-color: var(--accent-blue, #3b82f6); }
        .ai-tab:hover:not(.active) { background: rgba(59,130,246,0.1); }
        .ai-panel { display: none; }
        .ai-panel.active { display: block; }
        .ai-form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
        @media (max-width: 768px) { .ai-form-grid { grid-template-columns: 1fr; } }
        .ai-tooltip-icon {
            display: inline-flex; align-items: center; justify-content: center;
            width: 15px; height: 15px; font-size: 10px; line-height: 1;
            border-radius: 50%; background: rgba(139,92,246,0.12); color: #a78bfa;
            cursor: help; position: relative; vertical-align: middle; margin-left: 4px;
            transition: background 0.15s;
        }
        .ai-tooltip-icon:hover { background: rgba(139,92,246,0.25); }
        .ai-tooltip-icon:hover::after {
            content: attr(data-tip);
            position: absolute; bottom: calc(100% + 6px); left: 50%; transform: translateX(-50%);
            width: max-content; max-width: 260px; padding: 8px 10px;
            background: var(--bg-card, #1a1a2e); color: var(--text-secondary, #ccc);
            border: 1px solid var(--border-color, #333); border-radius: 8px;
            font-size: 11px; font-weight: 400; line-height: 1.4;
            box-shadow: 0 4px 16px rgba(0,0,0,0.3); z-index: 100; pointer-events: none;
            white-space: normal;
        }
        .ai-tooltip-icon:hover::before {
            content: ''; position: absolute; bottom: calc(100% + 2px); left: 50%; transform: translateX(-50%);
            border: 4px solid transparent; border-top-color: var(--border-color, #333); z-index: 101;
        }
        .ai-empty { text-align: center; padding: 48px 16px; color: var(--text-muted, #6b7280); }
        .ai-empty svg { margin-bottom: 12px; opacity: 0.4; }
        .ai-empty h3 { margin: 0 0 8px; font-size: 16px; color: var(--text-secondary); }
        .ai-empty p { margin: 0; font-size: 13px; }
        .ai-card-row { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 24px; }
        .ai-stat { flex: 1; min-width: 140px; padding: 16px 20px; border-radius: 12px; background: var(--bg-card, #1a1a2e); border: 1px solid var(--border-color, #333); }
        .ai-stat-val { font-size: 28px; font-weight: 700; line-height: 1; }
        .ai-stat-label { font-size: 12px; color: var(--text-muted); margin-top: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
        .ai-job-detail { font-size: 11px; color: var(--text-muted); margin-top: 2px; max-width: 280px; word-wrap: break-word; white-space: normal; line-height: 1.3; }
        .ai-job-error { color: var(--accent-red, #ef4444); }
        .ai-back-btn { display:inline-flex;align-items:center;gap:6px;color:var(--text-secondary);cursor:pointer;font-size:13px;padding:6px 0;margin-bottom:8px;transition:color 0.2s; }
        .ai-back-btn:hover { color:var(--accent-blue); }
        .ai-submit-layout { display:grid;grid-template-columns:1fr 1fr;gap:24px; }
        @media (max-width: 900px) { .ai-submit-layout { grid-template-columns:1fr; } }
        .ai-browse-entry { padding:10px 14px;display:flex;align-items:center;gap:10px;cursor:pointer;border-bottom:1px solid var(--border);transition:background 0.15s; }
        .ai-browse-entry:hover { background:rgba(59,130,246,0.06); }
        .ai-browse-entry.selected { background:rgba(59,130,246,0.15); }
        .ai-browse-bar { display:flex;align-items:center;gap:6px;margin-bottom:8px;font-size:12px;color:var(--text-secondary);overflow-x:auto;white-space:nowrap; }
        .ai-browse-bar span[data-path] { cursor:pointer;color:var(--accent-blue); }
        .ai-browse-bar span[data-path]:hover { text-decoration:underline; }
    `;
    container.prepend(styleEl);

    // ============================================================
    // VIEW NAVIGATION
    // ============================================================
    function showView(view, resumeOpts) {
        currentView = view;
        if (view === 'dashboard') {
            // resumeOpts may carry { tab: 'datasets' | 'training-jobs' }
            if (resumeOpts && resumeOpts.tab) lastActiveTab = resumeOpts.tab;
            renderDashboard();
        }
        else if (view === 'create-dataset') renderCreateDataset();
        else if (view === 'new-training') renderNewTraining(resumeOpts);
        else if (view === 'prepare-dataset') renderPrepareDataset(resumeOpts);
    }

    // Expose showView so the metrics modal can navigate here
    window._aiTrainingModule = { showView };

    // ============================================================
    // VIEW 1: DASHBOARD
    // ============================================================
    function renderDashboard() {
        container.innerHTML = '';
        container.appendChild(styleEl);

        const wrapper = document.createElement('div');
        wrapper.className = 'page-enter';
        wrapper.innerHTML = `
            <div class="page-header" style="display:flex;justify-content:space-between;align-items:flex-start;">
                <div>
                    <h1>AI Training</h1>
                    <p style="color:var(--text-muted);margin-top:4px;">Train surrogate models from M-Star sweep results using PhysicsNeMo</p>
                </div>
                <div style="display:flex;gap:8px;">
                    <button class="btn btn-secondary" id="ai-new-dataset-btn">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"></path><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"></path></svg>
                        New Dataset
                    </button>
                    <button class="btn btn-primary" id="ai-new-training-btn">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                        New Training Job
                    </button>
                </div>
            </div>

            <div class="ai-card-row" id="ai-stats-row">
                <div class="ai-stat"><div class="ai-stat-val" id="ai-stat-datasets">—</div><div class="ai-stat-label">Datasets</div></div>
                <div class="ai-stat"><div class="ai-stat-val" id="ai-stat-running" style="color:var(--accent-blue);">—</div><div class="ai-stat-label">Running</div></div>
                <div class="ai-stat"><div class="ai-stat-val" id="ai-stat-queued" style="color:var(--accent-amber);">—</div><div class="ai-stat-label">Queued</div></div>
                <div class="ai-stat"><div class="ai-stat-val" id="ai-stat-completed" style="color:var(--accent-green);">—</div><div class="ai-stat-label">Completed</div></div>
            </div>

            <div class="ai-tabs">
                <div class="ai-tab${lastActiveTab === 'datasets' ? ' active' : ''}" data-panel="datasets">Datasets</div>
                <div class="ai-tab${lastActiveTab === 'training-jobs' ? ' active' : ''}" data-panel="training-jobs">Training Jobs</div>
            </div>

            <div class="ai-panel${lastActiveTab === 'datasets' ? ' active' : ''}" id="panel-datasets">
                <div class="card"><div id="ai-datasets-table"></div></div>
            </div>

            <div class="ai-panel${lastActiveTab === 'training-jobs' ? ' active' : ''}" id="panel-training-jobs">
                <div class="card"><div id="ai-training-table"></div></div>
            </div>
        `;
        container.appendChild(wrapper);

        // Tab switching
        wrapper.querySelectorAll('.ai-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                wrapper.querySelectorAll('.ai-tab').forEach(t => t.classList.remove('active'));
                wrapper.querySelectorAll('.ai-panel').forEach(p => p.classList.remove('active'));
                tab.classList.add('active');
                lastActiveTab = tab.dataset.panel;
                const panel = document.getElementById('panel-' + tab.dataset.panel);
                if (panel) panel.classList.add('active');
            });
        });

        // Buttons → navigate to full-page views
        document.getElementById('ai-new-dataset-btn').addEventListener('click', () => showView('create-dataset'));
        document.getElementById('ai-new-training-btn').addEventListener('click', () => showView('new-training'));

        loadAllData();
    }

    // ---- Dashboard data loading ----
    async function loadAllData() {
        const [dsData, jobData] = await Promise.all([
            aiApi.get('/ai/datasets'),
            aiApi.get('/ai/training-jobs'),
        ]);

        const datasets = dsData?.datasets || [];
        const jobs = jobData?.training_jobs || [];

        if (currentView !== 'dashboard') return; // User navigated away

        renderDatasets(datasets);
        renderTrainingJobs(jobs);
        updateStats(datasets, jobs);

        const hasActive = jobs.some(j =>
            ['queued', 'running', 'preflight', 'launching'].includes(j.status)
        );
        if (hasActive && !pollTimer) {
            pollTimer = setInterval(loadAllData, 5000);
        } else if (!hasActive && pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
    }

    function updateStats(datasets, jobs) {
        const el = (id) => document.getElementById(id);
        if (!el('ai-stat-datasets')) return;
        el('ai-stat-datasets').textContent = datasets.length;
        el('ai-stat-running').textContent = jobs.filter(j => j.status === 'running' || j.status === 'preflight' || j.status === 'launching').length;
        el('ai-stat-queued').textContent = jobs.filter(j => j.status === 'queued').length;
        el('ai-stat-completed').textContent = jobs.filter(j => j.status === 'completed').length;
    }

    function renderDatasets(datasets) {
        const el = document.getElementById('ai-datasets-table');
        if (!el) return;
        if (!datasets.length) {
            el.innerHTML = `
                <div class="ai-empty">
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"></path><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"></path></svg>
                    <h3>No datasets yet</h3>
                    <p>Create a dataset from an M-Star parameter sweep to get started</p>
                </div>`;
            return;
        }

        el.innerHTML = `
            <div class="table-container">
                <table class="data-table">
                    <thead><tr>
                        <th>ID</th><th>Name</th><th>Cases</th><th>Data</th><th>Status</th><th>Created</th><th style="width:80px;">Actions</th>
                    </tr></thead>
                    <tbody>
                        ${datasets.map(ds => {
                            const caseInfo = ds.num_cases_with_output > 0
                                ? `${ds.num_cases_with_output} / ${ds.num_cases}`
                                : (ds.num_cases > 0 ? `0 / ${ds.num_cases}` : '—');
                            const dataInfo = buildDataSummary(ds);
                            return `
                            <tr style="cursor:pointer;" onclick="window._aiShowDatasetDetail && window._aiShowDatasetDetail(${ds.id})">
                                <td class="text-mono">#${ds.id}</td>
                                <td style="font-weight:500;">${escHtml(ds.name)}</td>
                                <td><code style="font-size:11px;padding:2px 6px;background:var(--bg-tertiary);border-radius:4px;">${caseInfo}</code></td>
                                <td class="text-sm">${dataInfo}</td>
                                <td>${statusBadge(ds.status)}</td>
                                <td class="text-sm text-muted">${formatTime(ds.created_at)}</td>
                                <td style="display:flex;gap:4px;">
                                    <button class="btn btn-secondary" style="padding:4px 10px;font-size:11px;" onclick="event.stopPropagation(); window._aiShowDatasetDetail && window._aiShowDatasetDetail(${ds.id})">
                                        View
                                    </button>
                                    ${(ds.status === 'scanned' || ds.status === 'ready' || ds.status === 'prepared' || ds.status === 'warnings') ? `<button class="btn" style="padding:4px 10px;font-size:11px;background:rgba(139,92,246,0.15);color:#a78bfa;border:1px solid rgba(139,92,246,0.25);" onclick="event.stopPropagation(); window._aiTrainingModule.showView('prepare-dataset', {datasetId: ${ds.id}, datasetName: '${escHtml(ds.name)}', sweepRoot: '${escHtml(ds.sweep_root)}'})">
                                        Prepare
                                    </button>` : ''}
                                </td>
                            </tr>`;
                        }).join('')}
                    </tbody>
                </table>
            </div>`;
    }

    /** Build a short summary of what data the dataset contains */
    function buildDataSummary(ds) {
        const parts = [];
        try {
            if (ds.stats_inventory_json) {
                const stats = typeof ds.stats_inventory_json === 'string' ? JSON.parse(ds.stats_inventory_json) : ds.stats_inventory_json;
                const physicsCount = (stats.physics || []).length;
                if (physicsCount > 0) parts.push(`<span title="Stats files">${physicsCount} stats</span>`);
            }
            if (ds.pvd_inventory_json) {
                const pvd = typeof ds.pvd_inventory_json === 'string' ? JSON.parse(ds.pvd_inventory_json) : ds.pvd_inventory_json;
                const s2d = (pvd.slices_2d || []).length;
                const v3d = (pvd.volumes_3d || []).length;
                if (s2d > 0) parts.push(`<span title="2D slices">${s2d} 2D</span>`);
                if (v3d > 0) parts.push(`<span title="3D volumes">${v3d} 3D</span>`);
            }
        } catch { /* ignore parse errors */ }
        return parts.length > 0 ? parts.join(' · ') : '<span class="text-muted">—</span>';
    }

    // ========== Dataset Detail View ==========

    /** Show the dataset detail overlay — full inventory display */
    window._aiShowDatasetDetail = async function(datasetId) {
        try {
            const res = await aiApi.get(`/ai/datasets/${datasetId}`);
            if (!res || res.error) {
                showToast(res?.error || 'Failed to load dataset', 'error');
                return;
            }
            renderDatasetDetail(res.dataset || res);
        } catch {
            showToast('Failed to load dataset details', 'error');
        }
    };

    // Helper: format bytes
    function fmtBytes(n) {
        if (!n || n <= 0) return '—';
        if (n < 1024) return n + ' B';
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
        if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
        return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    }

    // Helper: format time range as string
    function fmtTimeRange(tr) {
        if (!tr || !Array.isArray(tr) || tr.length < 2) return '—';
        return `${tr[0].toFixed(2)}s → ${tr[1].toFixed(1)}s`;
    }

    // Helper: validation status icon
    function valIcon(status) {
        if (status === 'pass') return '<span style="color:#22c55e;" title="Pass">✓</span>';
        if (status === 'warn') return '<span style="color:#f59e0b;" title="Warning">⚠</span>';
        return '<span style="color:#ef4444;" title="Fail">✗</span>';
    }

    // Helper: consistency badge
    function consistencyBadge(isCommon, total, found) {
        if (total <= 1) return '<span style="color:var(--text-muted);font-size:10px;">—</span>';
        if (isCommon) return `<span style="color:#22c55e;font-size:10px;" title="Present in all cases">✓ ${found}/${total}</span>`;
        return `<span style="color:#f59e0b;font-size:10px;" title="Missing from some cases">⚠ ${found}/${total}</span>`;
    }

    function renderDatasetDetail(ds) {
        const el = document.getElementById('ai-datasets-table');
        if (!el) return;

        let stats = {}, pvd = {}, cases = [];
        try { stats = ds.stats_inventory_json ? (typeof ds.stats_inventory_json === 'string' ? JSON.parse(ds.stats_inventory_json) : ds.stats_inventory_json) : {}; } catch {}
        try { pvd = ds.pvd_inventory_json ? (typeof ds.pvd_inventory_json === 'string' ? JSON.parse(ds.pvd_inventory_json) : ds.pvd_inventory_json) : {}; } catch {}
        try { cases = ds.cases_json ? (typeof ds.cases_json === 'string' ? JSON.parse(ds.cases_json) : ds.cases_json) : []; } catch {}

        const physicsStats = stats.physics || [];
        const slices2d = pvd.slices_2d || [];
        const volumes3d = pvd.volumes_3d || [];
        const slicesBody = pvd.slices_body || [];
        const validation = stats.validation || {};
        const checks = validation.checks || [];
        const trainReady = validation.training_ready || {};
        const totalDataHuman = stats.total_data_human || '—';

        let sweepParams = [];
        try { sweepParams = ds.sweep_parameters_json ? (typeof ds.sweep_parameters_json === 'string' ? JSON.parse(ds.sweep_parameters_json) : ds.sweep_parameters_json) : []; } catch {}

        const numCases = ds.num_cases || cases.length || 0;
        const casesWithOutput = cases.filter(c => c.status === 'scanned').map(c => c.name);

        // Validation banner
        const valStatus = validation.status || 'unknown';
        const valScore = validation.score != null ? validation.score : '?';
        const valColors = {pass: '#22c55e', warn: '#f59e0b', fail: '#ef4444', unknown: '#6b7280'};
        const valLabels = {pass: 'Ready for Training', warn: 'Warnings — Review Required', fail: 'Not Ready — Issues Found', unknown: 'Scan Pending'};
        const valBg = {pass: 'rgba(34,197,94,0.08)', warn: 'rgba(245,158,11,0.08)', fail: 'rgba(239,68,68,0.08)', unknown: 'rgba(107,114,128,0.08)'};

        el.innerHTML = `
            <div style="margin-bottom:16px;display:flex;gap:8px;">
                <button class="btn btn-secondary" id="ai-ds-back" style="gap:6px;">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/></svg>
                    Back to Datasets
                </button>
                <button class="btn btn-secondary" id="ai-ds-rescan" style="gap:6px;margin-left:auto;">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6"/><path d="M2.5 22v-6h6"/><path d="M2.5 12A10 10 0 0 1 18.3 4.6"/><path d="M21.5 12A10 10 0 0 1 5.7 19.4"/></svg>
                    Rescan
                </button>
            </div>

            <!-- Validation Banner -->
            <div class="card" style="margin-bottom:16px;border-left:4px solid ${valColors[valStatus] || valColors.unknown};background:${valBg[valStatus] || valBg.unknown};">
                <div style="padding:14px 16px;display:flex;align-items:center;gap:12px;">
                    <div style="font-size:28px;font-weight:700;color:${valColors[valStatus] || valColors.unknown};min-width:50px;text-align:center;">${valScore}</div>
                    <div style="flex:1;">
                        <div style="font-weight:600;font-size:14px;color:${valColors[valStatus] || valColors.unknown};">${valLabels[valStatus] || 'Unknown'}</div>
                        <div style="font-size:12px;color:var(--text-muted);margin-top:2px;">
                            ${checks.length ? checks.map(c => `${valIcon(c.status)} ${escHtml(c.message)}`).join(' &nbsp;·&nbsp; ') : 'No validation checks available'}
                        </div>
                    </div>
                    <div style="display:flex;gap:8px;">
                        ${trainReady.stats ? '<code style="font-size:10px;padding:2px 8px;background:rgba(34,197,94,0.15);color:#22c55e;border-radius:4px;">Stats ✓</code>' : '<code style="font-size:10px;padding:2px 8px;background:rgba(239,68,68,0.1);color:#ef4444;border-radius:4px;">Stats ✗</code>'}
                        ${trainReady.slices_2d ? '<code style="font-size:10px;padding:2px 8px;background:rgba(34,197,94,0.15);color:#22c55e;border-radius:4px;">2D ✓</code>' : '<code style="font-size:10px;padding:2px 8px;background:rgba(239,68,68,0.1);color:#ef4444;border-radius:4px;">2D ✗</code>'}
                        ${trainReady.volumes_3d ? '<code style="font-size:10px;padding:2px 8px;background:rgba(34,197,94,0.15);color:#22c55e;border-radius:4px;">3D ✓</code>' : '<code style="font-size:10px;padding:2px 8px;background:rgba(239,68,68,0.1);color:#ef4444;border-radius:4px;">3D ✗</code>'}
                    </div>
                </div>
                ${checks.some(c => c.details) ? `
                <div id="ai-val-details" style="display:none;padding:0 16px 12px;border-top:1px solid var(--border-color);margin-top:0;">
                    ${checks.filter(c => c.details).map(c => `
                        <div style="margin-top:8px;">
                            <div style="font-size:11px;font-weight:600;color:${valColors[c.status]};">${valIcon(c.status)} ${escHtml(c.name)}</div>
                            <ul style="font-size:11px;color:var(--text-muted);margin:2px 0 0 16px;padding:0;">
                                ${(Array.isArray(c.details) ? c.details : [c.details]).map(d => `<li>${escHtml(String(d))}</li>`).join('')}
                            </ul>
                        </div>
                    `).join('')}
                </div>
                <button id="ai-val-toggle" style="display:block;width:100%;padding:6px;font-size:11px;color:var(--accent-primary);background:none;border:none;border-top:1px solid var(--border-color);cursor:pointer;">
                    Show check details ▾
                </button>` : ''}
            </div>

            <!-- Summary Cards -->
            <div class="card" style="margin-bottom:16px;">
                <div class="card-header" style="display:flex;align-items:center;gap:8px;">
                    <span class="card-title">${escHtml(ds.name)}</span>
                    ${statusBadge(ds.status)}
                </div>
                <div style="padding:0 16px 16px;">
                    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:12px;">
                        <div style="padding:10px 14px;background:var(--bg-tertiary);border-radius:8px;">
                            <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;">Cases</div>
                            <div style="font-size:22px;font-weight:600;color:var(--text-primary);">${ds.num_cases_with_output || 0}<span style="font-size:14px;color:var(--text-muted);font-weight:400;"> / ${numCases}</span></div>
                        </div>
                        <div style="padding:10px 14px;background:var(--bg-tertiary);border-radius:8px;">
                            <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;">Stats Files</div>
                            <div style="font-size:22px;font-weight:600;color:var(--text-primary);">${physicsStats.length}</div>
                        </div>
                        <div style="padding:10px 14px;background:var(--bg-tertiary);border-radius:8px;">
                            <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;">2D Slices</div>
                            <div style="font-size:22px;font-weight:600;color:var(--text-primary);">${slices2d.length}</div>
                        </div>
                        <div style="padding:10px 14px;background:var(--bg-tertiary);border-radius:8px;">
                            <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;">3D Volumes</div>
                            <div style="font-size:22px;font-weight:600;color:var(--text-primary);">${volumes3d.length}</div>
                        </div>
                        <div style="padding:10px 14px;background:var(--bg-tertiary);border-radius:8px;">
                            <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;">Total Data</div>
                            <div style="font-size:18px;font-weight:600;color:var(--text-primary);">${totalDataHuman}</div>
                        </div>
                        ${validation.common_time_range ? `
                        <div style="padding:10px 14px;background:var(--bg-tertiary);border-radius:8px;">
                            <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;">Common Time</div>
                            <div style="font-size:14px;font-weight:600;color:var(--text-primary);">${fmtTimeRange(validation.common_time_range)}</div>
                        </div>` : ''}
                    </div>
                    <div style="font-size:12px;color:var(--text-muted);">
                        <strong>Sweep Root:</strong> <code style="font-size:11px;">${escHtml(ds.sweep_root)}</code>
                        ${ds.scan_completed_at ? `<br><strong>Scanned:</strong> ${formatTime(ds.scan_completed_at)}` : ''}
                    </div>
                </div>
            </div>

            <!-- Tabbed content -->
            <div class="card">
                <div style="display:flex;border-bottom:1px solid var(--border-color);padding:0 16px;flex-wrap:wrap;">
                    <button class="ai-ds-tab active" data-tab="cases" style="padding:10px 16px;background:none;border:none;color:var(--text-primary);cursor:pointer;border-bottom:2px solid transparent;font-size:13px;font-weight:500;">
                        Cases (${cases.length})
                    </button>
                    <button class="ai-ds-tab" data-tab="stats" style="padding:10px 16px;background:none;border:none;color:var(--text-muted);cursor:pointer;border-bottom:2px solid transparent;font-size:13px;font-weight:500;">
                        Stats (${physicsStats.length})
                    </button>
                    <button class="ai-ds-tab" data-tab="slices2d" style="padding:10px 16px;background:none;border:none;color:var(--text-muted);cursor:pointer;border-bottom:2px solid transparent;font-size:13px;font-weight:500;">
                        2D Slices (${slices2d.length})
                    </button>
                    <button class="ai-ds-tab" data-tab="volumes3d" style="padding:10px 16px;background:none;border:none;color:var(--text-muted);cursor:pointer;border-bottom:2px solid transparent;font-size:13px;font-weight:500;">
                        3D / Bodies (${volumes3d.length + slicesBody.length})
                    </button>
                    <button class="ai-ds-tab" data-tab="matrix" style="padding:10px 16px;background:none;border:none;color:var(--text-muted);cursor:pointer;border-bottom:2px solid transparent;font-size:13px;font-weight:500;">
                        Consistency
                    </button>
                </div>

                <div id="ai-ds-tab-content" style="padding:16px;">
                    ${renderCasesTab(cases, physicsStats, pvd, sweepParams)}
                </div>
            </div>
        `;

        // Tab click handlers
        el.querySelectorAll('.ai-ds-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                el.querySelectorAll('.ai-ds-tab').forEach(t => {
                    t.classList.remove('active');
                    t.style.color = 'var(--text-muted)';
                    t.style.borderBottom = '2px solid transparent';
                });
                tab.classList.add('active');
                tab.style.color = 'var(--text-primary)';
                tab.style.borderBottom = '2px solid var(--accent-primary)';

                const content = el.querySelector('#ai-ds-tab-content');
                switch (tab.dataset.tab) {
                    case 'cases': content.innerHTML = renderCasesTab(cases, physicsStats, pvd, sweepParams); break;
                    case 'stats': content.innerHTML = renderStatsTab(physicsStats, numCases, casesWithOutput); break;
                    case 'slices2d': content.innerHTML = renderSlices2dTab(slices2d, numCases, casesWithOutput); break;
                    case 'volumes3d': content.innerHTML = renderVolumes3dTab(volumes3d, slicesBody, numCases, casesWithOutput); break;
                    case 'matrix': content.innerHTML = renderMatrixTab(physicsStats, pvd, cases); break;
                }
            });
        });

        // Set initial active tab style
        const firstTab = el.querySelector('.ai-ds-tab.active');
        if (firstTab) firstTab.style.borderBottom = '2px solid var(--accent-primary)';

        // Validation details toggle
        const valToggle = el.querySelector('#ai-val-toggle');
        if (valToggle) {
            valToggle.addEventListener('click', () => {
                const details = el.querySelector('#ai-val-details');
                if (details) {
                    const showing = details.style.display !== 'none';
                    details.style.display = showing ? 'none' : 'block';
                    valToggle.textContent = showing ? 'Show check details ▾' : 'Hide check details ▴';
                }
            });
        }

        // Back button
        el.querySelector('#ai-ds-back').addEventListener('click', () => showView('dashboard', { tab: 'datasets' }));

        // Rescan button
        el.querySelector('#ai-ds-rescan').addEventListener('click', async () => {
            const btn = el.querySelector('#ai-ds-rescan');
            btn.disabled = true;
            btn.innerHTML = '<span class="spinner" style="width:14px;height:14px;"></span> Scanning...';
            try {
                const res = await aiApi.post(`/ai/datasets/${ds.id}/rescan`, {});
                if (res && !res.error) {
                    showToast('Re-scanning dataset...', 'success');
                    setTimeout(() => window._aiShowDatasetDetail(ds.id), 4000);
                } else {
                    showToast(res?.error || 'Failed to rescan', 'error');
                    btn.disabled = false;
                    btn.innerHTML = 'Rescan';
                }
            } catch {
                showToast('Network error', 'error');
                btn.disabled = false;
                btn.innerHTML = 'Rescan';
            }
        });
    }

    // ========== Tab Renderers ==========

    // Unique ID generator for field modals
    let _fieldModalId = 0;

    /**
     * Render a compact field/column chip.
     * Shows first 2-3 names + count, clickable to open a modal with all fields.
     */
    function fieldChip(items, type = 'fields') {
        if (!items || !items.length) return '<span style="color:var(--text-muted);font-size:11px;">—</span>';
        const id = `ai-field-chip-${++_fieldModalId}`;
        const count = items.length;

        // Show first 2 names as preview
        const previewNames = items.slice(0, 2).map(f => {
            const name = typeof f === 'string' ? f : (f.display_name || f.raw || f.name || '?');
            return escHtml(name.length > 18 ? name.substring(0, 16) + '…' : name);
        });
        const suffix = count > 2 ? `, +${count - 2}` : '';
        const label = `${previewNames.join(', ')}${suffix}`;

        // Build the full list for the modal
        const dataAttr = encodeURIComponent(JSON.stringify(items.map(f => {
            if (typeof f === 'string') return { name: f };
            return { name: f.display_name || f.raw || f.name, unit: f.unit || '', components: f.components || 1, data_location: f.data_location || '' };
        })));

        return `<button class="ai-field-chip" id="${id}" data-type="${type}" data-items="${dataAttr}"
            style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:12px;font-size:10px;color:var(--text-secondary);cursor:pointer;white-space:nowrap;transition:all 0.15s ease;"
            onmouseover="this.style.borderColor='var(--accent-primary)';this.style.color='var(--text-primary)'"
            onmouseout="this.style.borderColor='var(--border-color)';this.style.color='var(--text-secondary)'"
            title="Click to view all ${count} ${type}">
            <span style="font-weight:600;color:var(--accent-primary);">${count}</span> ${type}
        </button>`;
    }

    /**
     * Open the field detail modal.
     * Reuses existing modal CSS classes from the app.
     */
    function openFieldModal(items, typeName) {
        // Remove any existing field modal
        const existing = document.getElementById('ai-field-modal');
        if (existing) existing.remove();

        // Separate scalar vs vector fields
        const scalars = items.filter(f => !f.components || f.components === 1);
        const vectors = items.filter(f => f.components && f.components > 1);

        const renderField = (f) => {
            let badge = '';
            if (f.components > 1) {
                badge = `<code style="font-size:9px;padding:1px 5px;background:rgba(99,102,241,0.15);color:#818cf8;border-radius:3px;margin-left:4px;">${f.components}c</code>`;
            }
            let unit = '';
            if (f.unit) {
                unit = `<span style="color:var(--text-muted);font-size:11px;margin-left:4px;">[${escHtml(f.unit)}]</span>`;
            }
            let loc = '';
            if (f.data_location) {
                const locLabel = f.data_location === 'PointData' ? 'Point' : (f.data_location === 'CellData' ? 'Cell' : f.data_location);
                loc = `<code style="font-size:9px;padding:1px 4px;background:var(--bg-tertiary);border-radius:3px;margin-left:auto;color:var(--text-muted);">${locLabel}</code>`;
            }
            return `<div style="display:flex;align-items:center;padding:6px 10px;border-bottom:1px solid var(--border-color);gap:6px;">
                <span style="font-size:12px;font-weight:500;color:var(--text-primary);">${escHtml(f.name)}</span>${badge}${unit}${loc}
            </div>`;
        };

        const modal = document.createElement('div');
        modal.id = 'ai-field-modal';
        modal.className = 'modal';
        modal.innerHTML = `
            <div class="modal-backdrop" id="ai-field-modal-backdrop"></div>
            <div class="modal-content" style="max-width:520px;">
                <div class="modal-header">
                    <h3>${escHtml(typeName)} — ${items.length} ${items.length === 1 ? 'item' : 'items'}</h3>
                    <button class="btn-icon" id="ai-field-modal-close" style="font-size:18px;">✕</button>
                </div>
                <div class="modal-body" style="padding:0;">
                    ${scalars.length ? `
                        <div style="padding:10px 16px 4px;font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-muted);font-weight:600;">Scalars (${scalars.length})</div>
                        ${scalars.map(renderField).join('')}
                    ` : ''}
                    ${vectors.length ? `
                        <div style="padding:10px 16px 4px;font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-muted);font-weight:600;">Vectors (${vectors.length})</div>
                        ${vectors.map(renderField).join('')}
                    ` : ''}
                    ${!scalars.length && !vectors.length ? items.map(renderField).join('') : ''}
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        const close = () => modal.remove();
        modal.querySelector('#ai-field-modal-backdrop').addEventListener('click', close);
        modal.querySelector('#ai-field-modal-close').addEventListener('click', close);
        document.addEventListener('keydown', function handler(e) {
            if (e.key === 'Escape') { close(); document.removeEventListener('keydown', handler); }
        });
    }

    // Global click handler for field chips (event delegation)
    document.addEventListener('click', (e) => {
        const chip = e.target.closest('.ai-field-chip');
        if (!chip) return;
        e.preventDefault();
        try {
            const items = JSON.parse(decodeURIComponent(chip.dataset.items));
            const type = chip.dataset.type || 'fields';
            openFieldModal(items, type.charAt(0).toUpperCase() + type.slice(1));
        } catch (err) {
            console.error('Failed to open field modal:', err);
        }
    });

    /**
     * Static geometry badge
     */
    function staticBadge(isStatic, reason) {
        if (!isStatic) return '';
        return `<code style="font-size:9px;padding:1px 6px;background:rgba(107,114,128,0.15);color:var(--text-muted);border-radius:3px;" title="${escHtml(reason || 'Static geometry — not time-varying')}">Static</code>`;
    }

    function renderStatsTab(physicsStats, numCases, casesWithOutput) {
        if (!physicsStats.length) return '<div class="text-muted" style="text-align:center;padding:24px;">No stats files found</div>';
        return `
            <div class="table-container">
                <table class="data-table" style="font-size:12px;">
                    <thead><tr>
                        <th>File</th><th>Cols</th><th>Rows</th><th>Time Range</th><th>Δt</th>${numCases > 1 ? '<th>Cases</th>' : ''}<th>Size</th><th>Columns</th>
                    </tr></thead>
                    <tbody>
                        ${physicsStats.map(s => {
                            const cols = (s.columns || []).filter(c => c.name !== 'Time');
                            const tr = s.sample_time_range || s.time_range;
                            const timeStr = fmtTimeRange(tr);
                            const dt = s.sampling_dt ? `${s.sampling_dt.toFixed(4)}s` : '—';
                            const dtColor = s.is_uniform_dt === false ? '#f59e0b' : 'var(--text-muted)';
                            const dtTitle = s.is_uniform_dt === false ? 'Non-uniform sampling' : (s.is_uniform_dt ? 'Uniform sampling' : '');
                            const caseCount = (s.cases_with_file || []).length;
                            return `
                            <tr>
                                <td style="font-weight:500;white-space:nowrap;">${escHtml(s.filename)}</td>
                                <td class="text-mono">${s.num_columns || cols.length + 1}</td>
                                <td class="text-mono">${(s.sample_num_rows || s.num_rows || 0).toLocaleString()}</td>
                                <td class="text-mono" style="white-space:nowrap;">${timeStr}</td>
                                <td class="text-mono" style="white-space:nowrap;color:${dtColor};" title="${dtTitle}">${dt}</td>
                                ${numCases > 1 ? `<td>${consistencyBadge(s.is_common, numCases, caseCount)}</td>` : ''}
                                <td class="text-mono" style="white-space:nowrap;">${fmtBytes(s.file_size_bytes)}</td>
                                <td>${fieldChip(cols, 'columns')}</td>
                            </tr>`;
                        }).join('')}
                    </tbody>
                </table>
            </div>`;
    }

    function renderSlices2dTab(slices, numCases, casesWithOutput) {
        if (!slices.length) return '<div class="text-muted" style="text-align:center;padding:24px;">No 2D slice data found</div>';
        return `
            <div class="table-container">
                <table class="data-table" style="font-size:12px;">
                    <thead><tr>
                        <th>Slice</th><th>Plane</th><th>Fmt</th><th>Timesteps</th><th>Time Range</th><th>Δt</th><th>Grid</th>${numCases > 1 ? '<th>Cases</th>' : ''}<th>Est. Size</th><th>Fields</th>
                    </tr></thead>
                    <tbody>
                        ${slices.map(s => {
                            const grid = s.grid || {};
                            const extent = grid.extent;
                            let gridStr = '—';
                            if (extent && extent.length === 6) {
                                const nx = extent[1] - extent[0];
                                const ny = extent[3] - extent[2];
                                const nz = extent[5] - extent[4];
                                const dims = [nx, ny, nz].filter(d => d > 0);
                                gridStr = dims.join(' × ');
                                if (grid.spacing) gridStr += ` @ ${grid.spacing[0]}m`;
                            }
                            const dt = s.sampling_dt ? `${s.sampling_dt.toFixed(4)}s` : '—';
                            const caseCount = (s.cases_with_pvd || []).length;
                            return `
                            <tr>
                                <td style="font-weight:500;white-space:nowrap;">${escHtml(s.pvd_name)}</td>
                                <td class="text-mono">${escHtml(s.plane || '—')}</td>
                                <td><code style="font-size:10px;padding:1px 4px;background:var(--accent-primary);color:white;border-radius:3px;">${s.format || '?'}</code></td>
                                <td class="text-mono">${(s.num_timesteps || 0).toLocaleString()}</td>
                                <td class="text-mono" style="white-space:nowrap;">${fmtTimeRange(s.time_range)}</td>
                                <td class="text-mono" style="white-space:nowrap;">${dt}</td>
                                <td class="text-mono" style="white-space:nowrap;">${gridStr}</td>
                                ${numCases > 1 ? `<td>${consistencyBadge(s.is_common, numCases, caseCount)}</td>` : ''}
                                <td class="text-mono" style="white-space:nowrap;">${fmtBytes(s.estimated_size_bytes)}</td>
                                <td>${fieldChip(s.fields || [], 'fields')}</td>
                            </tr>`;
                        }).join('')}
                    </tbody>
                </table>
            </div>`;
    }

    function renderVolumes3dTab(volumes, bodySlices, numCases, casesWithOutput) {
        const items = [...volumes, ...bodySlices];
        if (!items.length) return '<div class="text-muted" style="text-align:center;padding:24px;">No 3D volume or body data found</div>';
        return `
            <div class="table-container">
                <table class="data-table" style="font-size:12px;">
                    <thead><tr>
                        <th>Name</th><th>Type</th><th>Fmt</th><th>Timesteps</th><th>Time Range</th><th>Δt</th><th>Details</th>${numCases > 1 ? '<th>Cases</th>' : ''}<th>Est. Size</th><th>Fields</th>
                    </tr></thead>
                    <tbody>
                        ${items.map(v => {
                            const isStatic = v.is_static;
                            let type = v.category === 'volumes_3d' ? 'Volume' : 'Body';
                            let typeColor = v.category === 'volumes_3d' ? '#6366f1' : '#f59e0b';
                            // Override for static geometry
                            if (isStatic) {
                                type = 'Static';
                                typeColor = '#6b7280';
                            }
                            const grid = v.grid || {};
                            let details = '';
                            if (grid.n_points) details = `${grid.n_points.toLocaleString()} pts`;
                            else if (grid.extent) {
                                const e = grid.extent;
                                details = `${e[1]-e[0]}×${e[3]-e[2]}×${e[5]-e[4]}`;
                            }
                            const dt = v.sampling_dt ? `${v.sampling_dt.toFixed(4)}s` : '—';
                            const caseCount = (v.cases_with_pvd || []).length;
                            // For static bodies, show a muted time range
                            const timeDisplay = isStatic ? '<span style="color:var(--text-muted);font-style:italic;">—</span>' : fmtTimeRange(v.time_range);
                            const dtDisplay = isStatic ? '<span style="color:var(--text-muted);">—</span>' : dt;
                            return `
                            <tr${isStatic ? ' style="opacity:0.65;"' : ''}>
                                <td style="font-weight:500;">
                                    ${escHtml(v.pvd_name)}
                                    ${staticBadge(isStatic, v.static_reason)}
                                </td>
                                <td><code style="font-size:10px;padding:1px 4px;background:${typeColor};color:white;border-radius:3px;">${type}</code></td>
                                <td><code style="font-size:10px;">${v.format || '?'}</code></td>
                                <td class="text-mono">${(v.num_timesteps || 0).toLocaleString()}</td>
                                <td class="text-mono" style="white-space:nowrap;">${timeDisplay}</td>
                                <td class="text-mono" style="white-space:nowrap;">${dtDisplay}</td>
                                <td class="text-sm">${details || '—'}</td>
                                ${numCases > 1 ? `<td>${consistencyBadge(v.is_common, numCases, caseCount)}</td>` : ''}
                                <td class="text-mono" style="white-space:nowrap;">${fmtBytes(v.estimated_size_bytes)}</td>
                                <td>${fieldChip(v.fields || [], 'fields')}</td>
                            </tr>`;
                        }).join('')}
                    </tbody>
                </table>
            </div>`;
    }

    function renderCasesTab(cases, physicsStats, pvd, sweepParams) {
        if (!cases.length) return '<div class="text-muted" style="text-align:center;padding:24px;">No cases found</div>';

        const allPvds = [
            ...(pvd.slices_2d || []),
            ...(pvd.slices_body || []),
            ...(pvd.volumes_3d || []),
            ...(pvd.boundary_conditions || []),
            ...(pvd.other || []),
        ];
        const totalStats = physicsStats.length;
        const totalPvds = allPvds.length;

        // Collect parameter keys from sweep params or from per-case data
        const paramKeys = [];
        const paramKeySet = new Set();
        if (Array.isArray(sweepParams) && sweepParams.length > 0) {
            for (const sp of sweepParams) {
                const pname = typeof sp === 'string' ? sp : (sp.name || sp);
                if (!paramKeySet.has(pname)) { paramKeySet.add(pname); paramKeys.push(pname); }
            }
        }
        // Also check per-case parameters for any keys not in sweep params
        for (const c of cases) {
            for (const k of Object.keys(c.parameters || {})) {
                if (!paramKeySet.has(k)) { paramKeySet.add(k); paramKeys.push(k); }
            }
        }

        return `
            <div class="table-container">
                <table class="data-table" style="font-size:12px;">
                    <thead><tr>
                        <th>Case Name</th>${paramKeys.map(k => `<th style="color:var(--accent-blue,#3b82f6);">${escHtml(k)}</th>`).join('')}<th>Status</th><th>Time Range</th><th>Stats</th><th>2D</th><th>3D</th><th>Completeness</th><th>Directory</th>
                    </tr></thead>
                    <tbody>
                        ${cases.map(c => {
                            const timeStr = fmtTimeRange(c.time_range);
                            const statsCount = (c.stats_files || []).length;
                            const pvdCats = c.pvd_categories || {};
                            const sliceCount = (pvdCats.slices_2d || 0) + (pvdCats.other || 0);
                            const volCount = (pvdCats.volumes_3d || 0) + (pvdCats.slices_body || 0) + (pvdCats.boundary_conditions || 0);

                            // Completeness: does this case have all common stats and PVDs?
                            const hasAllStats = statsCount >= totalStats;
                            const hasAllPvds = sliceCount + volCount >= totalPvds;
                            let completeness = '—';
                            if (c.status === 'scanned') {
                                if (hasAllStats && hasAllPvds) completeness = '<span style="color:#22c55e;" title="All data present">✓ Complete</span>';
                                else completeness = `<span style="color:#f59e0b;" title="Some data missing">⚠ Partial</span>`;
                            }

                            // Parameter value cells
                            const paramCells = paramKeys.map(k => {
                                const v = (c.parameters || {})[k];
                                if (v === undefined) return '<td class="text-mono" style="color:var(--text-muted);">—</td>';
                                const display = typeof v === 'number' ? v.toLocaleString(undefined, {maximumFractionDigits: 4}) : String(v);
                                return `<td class="text-mono" style="font-weight:600;color:var(--accent-blue,#3b82f6);">${escHtml(display)}</td>`;
                            }).join('');

                            return `
                            <tr>
                                <td style="font-weight:500;">${escHtml(c.name)}</td>
                                ${paramCells}
                                <td>${statusBadge(c.status || 'unknown')}</td>
                                <td class="text-mono" style="white-space:nowrap;">${timeStr}</td>
                                <td class="text-mono">${statsCount}</td>
                                <td class="text-mono">${sliceCount}</td>
                                <td class="text-mono">${volCount}</td>
                                <td class="text-sm">${completeness}</td>
                                <td class="text-sm text-mono" style="max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escHtml(c.directory || '')}">${escHtml(c.directory || '—')}</td>
                            </tr>
                        `}).join('')}
                    </tbody>
                </table>
            </div>`;
    }

    function renderMatrixTab(physicsStats, pvd, cases) {
        const scannedCases = cases.filter(c => c.status === 'scanned');
        if (scannedCases.length <= 1) return '<div class="text-muted" style="text-align:center;padding:24px;">Consistency matrix requires 2+ cases</div>';

        const caseNames = scannedCases.map(c => c.name);
        const allPvds = [
            ...(pvd.slices_2d || []),
            ...(pvd.slices_body || []),
            ...(pvd.volumes_3d || []),
        ];

        // Build rows: stats files + PVD outputs
        const rows = [];
        for (const s of physicsStats) {
            rows.push({
                name: s.filename,
                type: 'Stats',
                perCase: s.per_case_time_ranges || {},
                perCaseRows: s.per_case_num_rows || {},
                caseList: s.cases_with_file || [],
                isCommon: s.is_common,
            });
        }
        for (const p of allPvds) {
            rows.push({
                name: p.pvd_name,
                type: p.category === 'slices_2d' ? '2D' : (p.category === 'volumes_3d' ? '3D' : 'Body'),
                perCase: p.per_case_time_ranges || {},
                perCaseTs: p.per_case_num_timesteps || {},
                caseList: p.cases_with_pvd || [],
                isCommon: p.is_common,
            });
        }

        if (!rows.length) return '<div class="text-muted" style="text-align:center;padding:24px;">No data to compare</div>';

        return `
            <div style="overflow-x:auto;">
                <table class="data-table" style="font-size:11px;">
                    <thead><tr>
                        <th style="position:sticky;left:0;background:var(--bg-secondary);z-index:1;">Data File</th>
                        <th>Type</th>
                        ${caseNames.map(cn => `<th style="text-align:center;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escHtml(cn)}">${escHtml(cn.length > 12 ? cn.substring(0,10) + '…' : cn)}</th>`).join('')}
                    </tr></thead>
                    <tbody>
                        ${rows.map(r => `
                            <tr>
                                <td style="font-weight:500;position:sticky;left:0;background:var(--bg-secondary);z-index:1;white-space:nowrap;">${escHtml(r.name)}</td>
                                <td><code style="font-size:9px;padding:1px 4px;background:var(--bg-tertiary);border-radius:3px;">${r.type}</code></td>
                                ${caseNames.map(cn => {
                                    const hasIt = r.caseList.includes(cn);
                                    const tr = (r.perCase || {})[cn];
                                    const rows = (r.perCaseRows || {})[cn];
                                    const ts = (r.perCaseTs || {})[cn];
                                    let cell = '';
                                    if (!hasIt) {
                                        cell = '<span style="color:#ef4444;">✗</span>';
                                    } else {
                                        cell = '<span style="color:#22c55e;">✓</span>';
                                        if (tr) cell += `<br><span style="font-size:9px;color:var(--text-muted);">${tr[1].toFixed(1)}s</span>`;
                                        if (rows) cell += `<br><span style="font-size:9px;color:var(--text-muted);">${rows.toLocaleString()} rows</span>`;
                                        if (ts) cell += `<br><span style="font-size:9px;color:var(--text-muted);">${ts.toLocaleString()} ts</span>`;
                                    }
                                    return `<td style="text-align:center;vertical-align:top;">${cell}</td>`;
                                }).join('')}
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>`;
    }

    function _openJobDetailModal(j) {
        // Remove any existing modal
        const old = document.getElementById('ai-job-detail-modal');
        if (old) old.remove();
        // Also close any standalone metrics overlay
        if (window._aiTrainingMetrics) window._aiTrainingMetrics.closeTrainingMetrics();

        const isActive = ['queued', 'running', 'preflight', 'launching'].includes(j.status);
        const isComplete = j.status === 'completed';
        const hasMetrics = j.status === 'running' || isComplete;

        const elapsed = j.started_at && !j.completed_at
            ? formatDuration((Date.now() - new Date(j.started_at + 'Z').getTime()) / 1000)
            : (j.started_at && j.completed_at
                ? formatDuration((new Date(j.completed_at + 'Z') - new Date(j.started_at + 'Z')) / 1000)
                : '—');
        const gpuDisplay = j.gpu_ids ? formatGpuList(j.gpu_ids) : 'auto';

        // Parse full training config for display
        let jobConfig = {};
        let inferParams = [];
        try {
            jobConfig = JSON.parse(j.config_json || '{}');
            inferParams = jobConfig.selected_input_params || [];
        } catch {}

        const cfgInputParams = jobConfig.selected_input_params || [];
        const cfgInputFields = jobConfig.input_fields || [];
        const cfgTargets = jobConfig.selected_target_fields || [];
        const cfgChannels = jobConfig.computed_channels || [];
        const cfgEpochs = jobConfig.epochs || '—';
        const cfgBatch = jobConfig.batch_size || '—';
        const cfgLR = jobConfig.learning_rate || '—';
        const cfgOptimizer = jobConfig.optimizer || '—';
        const cfgScheduler = jobConfig.scheduler || '—';
        const cfgCkptInterval = jobConfig.checkpoint_interval || '—';
        const cfgAmp = jobConfig.amp != null ? (jobConfig.amp ? 'On' : 'Off') : 'Auto';
        const cfgGradAccum = jobConfig.gradient_accumulation_steps || '1';
        const cfgWeightDecay = jobConfig.weight_decay != null ? jobConfig.weight_decay : '—';
        const cfgMode = jobConfig.dataset_mode || '';
        const cfgModeLabel = cfgMode === 'time_averaged_3d' ? '3D Volume'
            : cfgMode === 'time_averaged_2d' ? '2D Slice'
            : cfgMode === 'stats_table' ? 'Stats Table'
            : cfgMode || 'auto (2D)';

        const modal = document.createElement('div');
        modal.id = 'ai-job-detail-modal';
        modal.style.cssText = 'position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.6);backdrop-filter:blur(4px);';

        const actionBtnStyle = 'display:flex;align-items:center;gap:8px;padding:10px 16px;border-radius:8px;font-size:13px;font-weight:500;cursor:pointer;border:1px solid;width:100%;text-align:left;';

        modal.innerHTML = `
            <div class="ai-job-modal-inner" style="background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:12px;padding:0;min-width:520px;max-width:900px;width:60vw;max-height:85vh;box-shadow:0 20px 60px rgba(0,0,0,0.4);overflow:hidden;display:flex;flex-direction:column;">
                <!-- Header (always visible) -->
                <div style="padding:16px 24px;border-bottom:1px solid var(--border-color);display:flex;align-items:center;justify-content:space-between;flex-shrink:0;">
                    <div style="display:flex;align-items:center;gap:12px;">
                        <button class="ai-jm-back btn-icon" style="display:none;color:var(--text-muted);font-size:16px;padding:4px;" title="Back to overview">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
                        </button>
                        <div>
                            <div style="font-size:15px;font-weight:600;color:var(--text-primary);">${escHtml(j.run_name)}</div>
                            <div style="font-size:11px;color:var(--text-muted);margin-top:1px;">Job #${j.id} · ${escHtml(j.model_family)} · ${statusBadge(j.status)}</div>
                            ${j.artifact_directory ? (() => {
                                const absPath = j.artifact_directory.startsWith('/') ? j.artifact_directory : '/simulations/Queue/' + j.artifact_directory;
                                return `<div style="font-size:10px;color:var(--text-muted);margin-top:3px;font-family:var(--font-mono);word-break:break-all;opacity:0.7;user-select:all;" title="Artifact directory on server — click to select">📁 ${escHtml(absPath)}</div>`;
                            })() : ''}
                        </div>
                    </div>
                    <button class="btn-icon ai-job-detail-close" style="font-size:18px;color:var(--text-muted);">✕</button>
                </div>

                <!-- Content area (swappable) -->
                <div class="ai-jm-content" style="flex:1;overflow-y:auto;"></div>
            </div>`;

        document.body.appendChild(modal);

        const contentEl = modal.querySelector('.ai-jm-content');
        const backBtn = modal.querySelector('.ai-jm-back');
        let metricsTimer = null;

        // Close handlers
        const closeModal = () => {
            if (metricsTimer) clearInterval(metricsTimer);
            modal.remove();
        };
        modal.querySelector('.ai-job-detail-close').addEventListener('click', closeModal);
        modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

        // Back button
        backBtn.addEventListener('click', () => {
            if (metricsTimer) { clearInterval(metricsTimer); metricsTimer = null; }
            showOverview();
        });

        // ---- VIEW: Overview ----
        function showOverview() {
            backBtn.style.display = 'none';
            contentEl.innerHTML = `
                <!-- Info grid -->
                <div style="padding:16px 24px;display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;border-bottom:1px solid var(--border-color);">
                    <div>
                        <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;">Dataset</div>
                        <div style="font-size:14px;font-weight:500;margin-top:2px;font-family:var(--font-mono);">#${j.dataset_id}</div>
                    </div>
                    <div>
                        <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;">GPUs</div>
                        <div style="font-size:14px;font-weight:500;margin-top:2px;font-family:var(--font-mono);">${escHtml(gpuDisplay)}</div>
                    </div>
                    <div>
                        <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;">Duration</div>
                        <div style="font-size:14px;font-weight:500;margin-top:2px;">${elapsed}</div>
                    </div>
                    <div>
                        <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;">Submitted</div>
                        <div style="font-size:13px;margin-top:2px;">${formatTime(j.submitted_at)}</div>
                    </div>
                    ${j.started_at ? `<div>
                        <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;">Started</div>
                        <div style="font-size:13px;margin-top:2px;">${formatTime(j.started_at)}</div>
                    </div>` : ''}
                    ${j.completed_at ? `<div>
                        <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;">Completed</div>
                        <div style="font-size:13px;margin-top:2px;">${formatTime(j.completed_at)}</div>
                    </div>` : ''}
                </div>

                ${j.failure_reason ? `
                <div style="padding:12px 24px;background:rgba(239,68,68,0.08);border-bottom:1px solid var(--border-color);">
                    <div style="font-size:12px;color:#f87171;font-weight:500;">Error</div>
                    <div style="font-size:12px;color:#fca5a5;margin-top:4px;font-family:var(--font-mono);white-space:pre-wrap;">${escHtml(j.failure_reason)}</div>
                </div>` : ''}

                <!-- Training Configuration -->
                ${(cfgInputParams.length > 0 || cfgTargets.length > 0 || cfgInputFields.length > 0) ? `
                <div style="padding:14px 24px;border-bottom:1px solid var(--border-color);">
                    <div style="font-size:12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:10px;">Model & I/O Configuration</div>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px 20px;font-size:12px;">
                        <!-- Model Info -->
                        <div>
                            <div style="color:var(--text-muted);font-size:10px;text-transform:uppercase;letter-spacing:0.4px;margin-bottom:3px;">Model</div>
                            <div style="font-weight:500;color:var(--text-primary);">${escHtml(j.model_family.toUpperCase())}</div>
                        </div>
                        <div>
                            <div style="color:var(--text-muted);font-size:10px;text-transform:uppercase;letter-spacing:0.4px;margin-bottom:3px;">Data Mode</div>
                            <div style="font-weight:500;color:var(--text-primary);">${escHtml(cfgModeLabel)}</div>
                        </div>

                        <!-- Input Parameters -->
                        ${cfgInputParams.length > 0 ? `
                        <div style="grid-column:1/-1;">
                            <div style="color:var(--text-muted);font-size:10px;text-transform:uppercase;letter-spacing:0.4px;margin-bottom:4px;">Input Parameters</div>
                            <div style="display:flex;flex-wrap:wrap;gap:4px;">
                                ${cfgInputParams.map(p => `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;background:rgba(59,130,246,0.12);color:#60a5fa;border:1px solid rgba(59,130,246,0.2);">${escHtml(p)}</span>`).join('')}
                            </div>
                        </div>` : ''}

                        <!-- Input Fields (VTK) -->
                        ${cfgInputFields.length > 0 ? `
                        <div style="grid-column:1/-1;">
                            <div style="color:var(--text-muted);font-size:10px;text-transform:uppercase;letter-spacing:0.4px;margin-bottom:4px;">Input Fields</div>
                            <div style="display:flex;flex-wrap:wrap;gap:4px;">
                                ${cfgInputFields.map(f => {
                                    const fname = typeof f === 'string' ? f : (f.field_name || f.channel_name || '?');
                                    const pvd = typeof f === 'object' ? (f.pvd_source || '') : '';
                                    const pvdLabel = pvd && pvd !== 'self' && pvd !== 'derived' ? ' ← ' + pvd : '';
                                    return `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;background:rgba(139,92,246,0.12);color:#a78bfa;border:1px solid rgba(139,92,246,0.2);">${escHtml(fname)}${pvdLabel ? '<span style="color:var(--text-muted);font-size:9px;">' + escHtml(pvdLabel) + '</span>' : ''}</span>`;
                                }).join('')}
                            </div>
                        </div>` : ''}

                        <!-- Targets -->
                        ${cfgTargets.length > 0 ? `
                        <div style="grid-column:1/-1;">
                            <div style="color:var(--text-muted);font-size:10px;text-transform:uppercase;letter-spacing:0.4px;margin-bottom:4px;">Output Targets</div>
                            <div style="display:flex;flex-wrap:wrap;gap:4px;">
                                ${cfgTargets.map(t => `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;background:rgba(245,158,11,0.12);color:#fbbf24;border:1px solid rgba(245,158,11,0.2);">${escHtml(t)}</span>`).join('')}
                            </div>
                        </div>` : ''}

                        <!-- Spatial Channels -->
                        ${cfgChannels.length > 0 ? `
                        <div style="grid-column:1/-1;">
                            <div style="color:var(--text-muted);font-size:10px;text-transform:uppercase;letter-spacing:0.4px;margin-bottom:4px;">Spatial Channels</div>
                            <div style="display:flex;flex-wrap:wrap;gap:4px;">
                                ${cfgChannels.map(c => `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;background:rgba(16,185,129,0.12);color:#34d399;border:1px solid rgba(16,185,129,0.2);">${escHtml(c)}</span>`).join('')}
                            </div>
                        </div>` : ''}
                    </div>

                    <!-- Hyperparameters -->
                    <div style="margin-top:12px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.05);">
                        <div style="color:var(--text-muted);font-size:10px;text-transform:uppercase;letter-spacing:0.4px;margin-bottom:6px;">Hyperparameters</div>
                        <div style="display:flex;flex-wrap:wrap;gap:12px;font-size:11px;">
                            <div><span style="color:var(--text-muted);">Epochs:</span> <span style="color:var(--text-primary);font-weight:500;font-family:var(--font-mono);">${cfgEpochs}</span></div>
                            <div><span style="color:var(--text-muted);">Batch:</span> <span style="color:var(--text-primary);font-weight:500;font-family:var(--font-mono);">${cfgBatch}</span></div>
                            <div><span style="color:var(--text-muted);">LR:</span> <span style="color:var(--text-primary);font-weight:500;font-family:var(--font-mono);">${cfgLR}</span></div>
                            <div><span style="color:var(--text-muted);">Optimizer:</span> <span style="color:var(--text-primary);font-weight:500;">${escHtml(String(cfgOptimizer))}</span></div>
                            <div><span style="color:var(--text-muted);">Scheduler:</span> <span style="color:var(--text-primary);font-weight:500;">${escHtml(String(cfgScheduler))}</span></div>
                            <div><span style="color:var(--text-muted);">Ckpt:</span> <span style="color:var(--text-primary);font-weight:500;font-family:var(--font-mono);">every ${cfgCkptInterval}</span></div>
                            <div><span style="color:var(--text-muted);">AMP:</span> <span style="color:var(--text-primary);font-weight:500;">${cfgAmp}</span></div>
                            <div><span style="color:var(--text-muted);">Grad Accum:</span> <span style="color:var(--text-primary);font-weight:500;font-family:var(--font-mono);">${cfgGradAccum}×</span></div>
                            <div><span style="color:var(--text-muted);">Weight Decay:</span> <span style="color:var(--text-primary);font-weight:500;font-family:var(--font-mono);">${cfgWeightDecay}</span></div>
                        </div>
                    </div>
                </div>` : ''}

                <!-- Actions -->
                <div style="padding:16px 24px 20px;">
                    <div style="font-size:12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:10px;">Actions</div>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
                        <button class="ai-job-action" data-action="log" style="${actionBtnStyle}background:var(--surface-2);color:var(--text-secondary);border-color:var(--border-color);">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                            View Log
                        </button>
                        ${hasMetrics ? `
                        <button class="ai-job-action" data-action="metrics" style="${actionBtnStyle}background:rgba(99,102,241,0.1);color:#818cf8;border-color:rgba(99,102,241,0.25);">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
                            Metrics
                        </button>` : ''}
                        ${isComplete ? `
                        <button class="ai-job-action" data-action="predict" style="${actionBtnStyle}background:rgba(245,158,11,0.1);color:#fbbf24;border-color:rgba(245,158,11,0.25);">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
                            Predict
                        </button>
                        <button class="ai-job-action" data-action="export" style="${actionBtnStyle}background:rgba(16,185,129,0.1);color:#34d399;border-color:rgba(16,185,129,0.25);">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                            Export ONNX
                        </button>
                        <button class="ai-job-action" data-action="continue" style="${actionBtnStyle}background:rgba(59,130,246,0.1);color:#60a5fa;border-color:rgba(59,130,246,0.25);">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
                            Continue Training
                        </button>
                        <button class="ai-job-action" data-action="fork" style="${actionBtnStyle}background:rgba(139,92,246,0.1);color:#a78bfa;border-color:rgba(139,92,246,0.25);">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9v1a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V9"/><line x1="12" y1="12" x2="12" y2="15"/></svg>
                            Fork / Transfer
                        </button>
                        <button class="ai-job-action" data-action="restart" style="${actionBtnStyle}background:rgba(245,158,11,0.1);color:#fbbf24;border-color:rgba(245,158,11,0.25);">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
                            Restart
                        </button>` : ''}
                        ${isActive ? `
                        <button class="ai-job-action" data-action="cancel" style="${actionBtnStyle}background:rgba(239,68,68,0.1);color:#f87171;border-color:rgba(239,68,68,0.25);">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
                            Cancel Job
                        </button>` : ''}
                    </div>
                </div>`;

            // Wire action buttons
            contentEl.querySelectorAll('.ai-job-action').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const action = btn.dataset.action;
                    if (action === 'log') showLog();
                    else if (action === 'metrics') showMetrics();
                    else if (action === 'predict') showPredict();
                    else if (action === 'export') {
                        btn.disabled = true;
                        btn.style.opacity = '0.6';
                        btn.innerHTML = '<span class="spinner" style="width:14px;height:14px;"></span> Exporting…';
                        await _doExport(j.id);
                        btn.disabled = false;
                        btn.style.opacity = '1';
                        btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Export ONNX';
                    }
                    else if (action === 'continue') { closeModal(); _openTrainModal(j.dataset_id, j.model_family, j.run_name, j.id, 'continue'); }
                    else if (action === 'fork') { closeModal(); _openTrainModal(j.dataset_id, j.model_family, j.run_name, j.id, 'transfer'); }
                    else if (action === 'restart') { closeModal(); _openTrainModal(j.dataset_id, j.model_family, j.run_name, j.id, 'restart'); }
                    else if (action === 'cancel') {
                        if (!confirm('Cancel this training job?')) return;
                        try {
                            const res = await aiApi.post(`/ai/training-jobs/${j.id}/cancel`, {});
                            showToast(res?.message || 'Job cancelled', res?.error ? 'error' : 'success');
                            if (!res?.error) { closeModal(); loadAllData(); }
                        } catch { showToast('Failed to cancel job', 'error'); }
                    }
                });
            });
        }

        // ---- VIEW: Log ----
        async function showLog() {
            backBtn.style.display = '';
            contentEl.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-muted);">Loading log…</div>`;
            try {
                const res = await aiApi.get(`/ai/training-jobs/${j.id}/log`);
                const logText = res?.log || res?.message || 'No log available';
                contentEl.innerHTML = `<pre style="margin:0;padding:16px 24px;font-size:12px;font-family:var(--font-mono);white-space:pre-wrap;word-break:break-all;color:var(--text-primary);line-height:1.6;overflow-y:auto;">${escHtml(logText)}</pre>`;
            } catch {
                contentEl.innerHTML = `<div style="padding:24px;color:#f87171;">Failed to load log.</div>`;
            }
        }

        // ---- VIEW: Metrics ----
        function showMetrics() {
            backBtn.style.display = '';
            if (window._aiTrainingMetrics && window._aiTrainingMetrics.renderMetricsInto) {
                // Use the embedded render method
                metricsTimer = window._aiTrainingMetrics.renderMetricsInto(contentEl, j.id, {
                    status: j.status,
                    run_name: j.run_name,
                    model_family: j.model_family,
                });
            } else if (window._aiTrainingMetrics) {
                // Fallback: open standalone overlay, close this modal
                closeModal();
                window._aiTrainingMetrics.openTrainingMetrics(j.id, {
                    status: j.status,
                    run_name: j.run_name,
                    model_family: j.model_family,
                });
            } else {
                contentEl.innerHTML = `<div style="padding:24px;color:var(--text-muted);">Metrics module not loaded.</div>`;
            }
        }

        // ---- VIEW: Predict ----
        function showPredict() {
            backBtn.style.display = '';
            // Render the infer form into the content area
            _renderInferView(contentEl, j.id, inferParams);
        }

        // Show initial overview
        showOverview();
    }

    // Standalone export handler
    async function _doExport(jobId) {
        showToast('Exporting model…', 'info');
        try {
            const res = await aiApi.post(`/ai/training-jobs/${jobId}/export`, { formats: 'onnx,torchscript' });
            if (res.error) {
                showToast('Export failed: ' + res.error, 'error');
            } else {
                showToast('Model exported to ' + (res.output_dir || ''), 'success');
            }
        } catch { showToast('Export request failed', 'error'); }
    }

    function renderTrainingJobs(jobs) {
        const el = document.getElementById('ai-training-table');
        if (!el) return;
        if (!jobs.length) {
            el.innerHTML = `
                <div class="ai-empty">
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>
                    <h3>No training jobs</h3>
                    <p>Create a dataset first, then start a training job</p>
                </div>`;
            return;
        }

        el.innerHTML = `
            <div class="table-container">
                <table class="data-table">
                    <thead><tr>
                        <th>ID</th><th>Run Name</th><th>Model</th><th>Dataset</th><th>GPUs</th><th>Status</th><th>Submitted</th>
                    </tr></thead>
                    <tbody>
                        ${jobs.map(j => {
                            const gpuDisplay = j.gpu_ids ? formatGpuList(j.gpu_ids) : 'auto';
                            const elapsed = j.started_at && !j.completed_at
                                ? formatDuration((Date.now() - new Date(j.started_at + 'Z').getTime()) / 1000)
                                : (j.started_at && j.completed_at
                                    ? formatDuration((new Date(j.completed_at + 'Z') - new Date(j.started_at + 'Z')) / 1000)
                                    : '');
                            return `
                            <tr class="ai-job-row" data-job-id="${j.id}" style="cursor:pointer;" title="Click to open job details">
                                <td class="text-mono">#${j.id}</td>
                                <td style="font-weight:500;">${escHtml(j.run_name)}</td>
                                <td><code style="font-size:11px;padding:2px 6px;background:var(--bg-tertiary);border-radius:4px;">${escHtml(j.model_family)}</code></td>
                                <td class="text-mono text-sm">#${j.dataset_id}</td>
                                <td class="text-mono text-sm">${escHtml(gpuDisplay)}</td>
                                <td>
                                    ${statusBadge(j.status)}
                                    ${elapsed ? `<div class="ai-job-detail">${elapsed}</div>` : ''}
                                </td>
                                <td class="text-sm text-muted">${formatTime(j.submitted_at)}</td>
                            </tr>`;
                        }).join('')}
                    </tbody>
                </table>
            </div>`;

        // Click handler — open job detail modal
        el.querySelectorAll('.ai-job-row').forEach(row => {
            row.addEventListener('click', () => {
                const jobId = parseInt(row.dataset.jobId, 10);
                const job = jobs.find(j => j.id === jobId);
                if (job) _openJobDetailModal(job);
            });
        });
    }

    function _openInferModal(jobId, paramNames) {
        // Standalone wrapper — creates overlay, delegates to _renderInferView
        const modal = document.createElement('div');
        modal.className = 'modal-overlay';
        modal.style.cssText = 'position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.6);backdrop-filter:blur(4px);';
        modal.innerHTML = `<div style="background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:12px;padding:24px;min-width:420px;max-width:540px;box-shadow:0 20px 60px rgba(0,0,0,0.4);"></div>`;
        document.body.appendChild(modal);
        const container = modal.querySelector('div');
        _renderInferView(container, jobId, paramNames, () => modal.remove());
        modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
    }

    function _renderInferView(container, jobId, paramNames, onClose) {
                const inputStyle = 'width:100%;padding:8px 12px;background:var(--bg-primary);border:1px solid var(--border-color);border-radius:6px;color:var(--text-primary);font-size:14px;font-family:monospace;';
                const labelStyle = 'display:block;font-size:12px;font-weight:500;margin-bottom:4px;color:var(--text-secondary);';

                // Parameter select options (for sweep)
                const paramOpts = paramNames.map(n => `<option value="${escHtml(n)}">${escHtml(n)}</option>`).join('');

                // Single-value param inputs
                const singleInputs = paramNames.length > 0
                    ? paramNames.map(name => `
                        <div style="margin-bottom:12px;">
                            <label style="${labelStyle}">${escHtml(name)}</label>
                            <input type="number" step="any" class="ai-infer-param" data-param-name="${escHtml(name)}"
                                style="${inputStyle}" placeholder="Enter value...">
                        </div>
                    `).join('')
                    : `<div style="margin-bottom:12px;">
                        <label style="${labelStyle}">Parameters (JSON)</label>
                        <textarea class="ai-infer-raw-json" rows="3"
                            style="${inputStyle}resize:vertical;"
                            placeholder='{"RPM": 75.0}'>{}</textarea>
                       </div>`;

                container.innerHTML = `
                    <div style="padding:20px 24px;">
                        <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;">
                            <div>
                                <div style="font-size:16px;font-weight:600;">Run Prediction</div>
                                <div style="font-size:12px;color:var(--text-muted);">Job #${jobId} — enter new parameter values</div>
                            </div>
                        </div>

                        <!-- Mode tabs -->
                        <div style="display:flex;gap:4px;margin-bottom:16px;background:var(--bg-primary);border-radius:8px;padding:3px;">
                            <button class="ai-infer-tab btn btn-sm" data-tab="single"
                                style="flex:1;border-radius:6px;padding:6px 12px;font-weight:600;font-size:12px;background:linear-gradient(135deg,#f59e0b,#d97706);color:white;border:none;">
                                Single Value
                            </button>
                            <button class="ai-infer-tab btn btn-sm" data-tab="sweep"
                                style="flex:1;border-radius:6px;padding:6px 12px;font-weight:600;font-size:12px;background:transparent;color:var(--text-secondary);border:none;cursor:pointer;">
                                Sweep Range
                            </button>
                        </div>

                        <!-- Single value panel -->
                        <div class="ai-infer-panel" data-panel="single">
                            ${singleInputs}
                        </div>

                        <!-- Sweep panel -->
                        <div class="ai-infer-panel" data-panel="sweep" style="display:none;">
                            ${paramNames.length > 0 ? `
                            <div style="margin-bottom:12px;">
                                <label style="${labelStyle}">Sweep Parameter</label>
                                <select class="ai-sweep-param" style="${inputStyle}">${paramOpts}</select>
                            </div>
                            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:12px;">
                                <div>
                                    <label style="${labelStyle}">Start</label>
                                    <input type="number" step="any" class="ai-sweep-start" style="${inputStyle}" value="50" placeholder="50">
                                </div>
                                <div>
                                    <label style="${labelStyle}">End</label>
                                    <input type="number" step="any" class="ai-sweep-end" style="${inputStyle}" value="100" placeholder="100">
                                </div>
                                <div>
                                    <label style="${labelStyle}">Step</label>
                                    <input type="number" step="any" class="ai-sweep-step" style="${inputStyle}" value="1" placeholder="1">
                                </div>
                            </div>
                            <div style="font-size:11px;color:var(--text-muted);margin-bottom:8px;" class="ai-sweep-summary">
                                51 predictions will be generated
                            </div>
                            ` : '<div style="color:var(--text-muted);font-size:13px;">Sweep requires named parameters.</div>'}
                        </div>

                        <!-- Output info -->
                        <div style="margin-bottom:12px;padding:10px 12px;border-radius:8px;background:rgba(99,102,241,0.06);border:1px solid rgba(99,102,241,0.12);font-size:11px;color:var(--text-muted);">
                            <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
                                <span style="font-weight:600;color:var(--text-secondary);">Output Info</span>
                            </div>
                            Results are saved under the job's <code style="font-size:10px;padding:1px 4px;background:var(--bg-primary);border-radius:3px;">inference_output/</code> directory as VTI files with a PVD index for playback.
                            <span style="color:#f59e0b;">Re-running a sweep will overwrite previous results.</span>
                        </div>

                        <div id="ai-infer-result-${jobId}" style="display:none;margin-bottom:12px;padding:10px;border-radius:8px;font-size:12px;"></div>
                        <div style="display:flex;gap:8px;justify-content:flex-end;">
                            <button class="btn btn-sm ai-infer-run" style="background:linear-gradient(135deg,#f59e0b,#d97706);color:white;font-weight:600;padding:6px 20px;">
                                Predict
                            </button>
                        </div>
                    </div>`;

                // Tab switching
                let activeTab = 'single';
                container.querySelectorAll('.ai-infer-tab').forEach(tab => {
                    tab.addEventListener('click', () => {
                        activeTab = tab.dataset.tab;
                        container.querySelectorAll('.ai-infer-tab').forEach(t => {
                            if (t.dataset.tab === activeTab) {
                                t.style.background = 'linear-gradient(135deg,#f59e0b,#d97706)';
                                t.style.color = 'white';
                            } else {
                                t.style.background = 'transparent';
                                t.style.color = 'var(--text-secondary)';
                            }
                        });
                        container.querySelectorAll('.ai-infer-panel').forEach(p => {
                            p.style.display = p.dataset.panel === activeTab ? '' : 'none';
                        });
                    });
                });

                // Sweep summary counter
                const updateSweepSummary = () => {
                    const s = parseFloat(container.querySelector('.ai-sweep-start')?.value || 0);
                    const e = parseFloat(container.querySelector('.ai-sweep-end')?.value || 0);
                    const st = parseFloat(container.querySelector('.ai-sweep-step')?.value || 1);
                    const summary = container.querySelector('.ai-sweep-summary');
                    if (summary && st > 0) {
                        const n = Math.floor((e - s) / st) + 1;
                        summary.textContent = `${Math.max(0, n)} predictions will be generated`;
                    }
                };
                container.querySelectorAll('.ai-sweep-start,.ai-sweep-end,.ai-sweep-step').forEach(inp => {
                    inp.addEventListener('input', updateSweepSummary);
                });

                // Focus first input
                const firstInput = container.querySelector('input, textarea');
                if (firstInput) setTimeout(() => firstInput.focus(), 50);

                // Run
                container.querySelector('.ai-infer-run').addEventListener('click', async () => {
                    const resultDiv = container.querySelector(`#ai-infer-result-${jobId}`);
                    const runBtn = container.querySelector('.ai-infer-run');

                    if (activeTab === 'sweep') {
                        // --- SWEEP MODE ---
                        const paramName = container.querySelector('.ai-sweep-param')?.value;
                        const start = parseFloat(container.querySelector('.ai-sweep-start')?.value);
                        const end = parseFloat(container.querySelector('.ai-sweep-end')?.value);
                        const step = parseFloat(container.querySelector('.ai-sweep-step')?.value);

                        if (!paramName || isNaN(start) || isNaN(end) || isNaN(step) || step <= 0) {
                            resultDiv.style.display = '';
                            resultDiv.style.background = 'rgba(239,68,68,0.1)';
                            resultDiv.style.color = '#f87171';
                            resultDiv.textContent = 'Enter valid start, end, and step values.';
                            return;
                        }

                        const n = Math.floor((end - start) / step) + 1;
                        runBtn.disabled = true;
                        runBtn.innerHTML = '<span class="spinner" style="width:14px;height:14px;"></span> Sweeping...';
                        resultDiv.style.display = '';
                        resultDiv.style.background = 'rgba(99,102,241,0.1)';
                        resultDiv.style.color = '#818cf8';
                        resultDiv.textContent = `Initializing sweep (${n} predictions)...`;

                        // Poll for progress while sweep runs
                        let progressPollTimer = null;
                        const formatTime = (s) => {
                            if (s < 60) return `${Math.round(s)}s`;
                            const m = Math.floor(s / 60);
                            const sec = Math.round(s % 60);
                            return `${m}m ${sec}s`;
                        };
                        const pollProgress = async () => {
                            try {
                                const prog = await aiApi.get(`/ai/training-jobs/${jobId}/inference-progress`);
                                if (prog && prog.progress) {
                                    const p = prog.progress;
                                    const pct = p.percent || 0;
                                    const cur = p.current || 0;
                                    const tot = p.total || n;
                                    const elapsed = p.elapsed_seconds || 0;
                                    const eta = p.eta_seconds || 0;
                                    const phase = p.phase === 'loading_model' ? 'Loading model...' : 'Predicting';
                                    const valInfo = p.current_value !== undefined ? ` · ${p.param_name || ''} = ${p.current_value}` : '';

                                    // Progress bar
                                    resultDiv.innerHTML = `
                                        <div style="margin-bottom:6px;font-weight:600;">${phase} ${cur}/${tot} (${pct}%)${valInfo}</div>
                                        <div style="width:100%;background:rgba(99,102,241,0.15);border-radius:4px;height:6px;overflow:hidden;margin-bottom:4px;">
                                            <div style="width:${pct}%;background:linear-gradient(90deg,#6366f1,#818cf8);height:100%;border-radius:4px;transition:width 0.3s ease;"></div>
                                        </div>
                                        <div style="font-size:10px;color:var(--text-muted);">
                                            Elapsed: ${formatTime(elapsed)} · ETA: ~${formatTime(eta)}
                                        </div>
                                    `;
                                    runBtn.innerHTML = `<span class="spinner" style="width:14px;height:14px;"></span> ${cur}/${tot}`;
                                }
                            } catch (_) {}
                        };
                        // Start polling immediately and every 1.5s
                        progressPollTimer = setInterval(pollProgress, 1500);
                        setTimeout(pollProgress, 500);

                        try {
                            const res = await aiApi.post(`/ai/training-jobs/${jobId}/infer-sweep`, {
                                param_name: paramName, start, end, step
                            });
                            clearInterval(progressPollTimer);
                            if (res && res.status === 'ok') {
                                const sw = res.sweep || {};
                                const outDir = res.output_dir || sw.output_dir || '';
                                resultDiv.style.background = 'rgba(16,185,129,0.1)';
                                resultDiv.style.color = '#34d399';
                                resultDiv.innerHTML = `
                                    <div style="margin-bottom:6px;">✓ Sweep complete! <strong>${sw.count || n}</strong> predictions generated.</div>
                                    ${outDir ? `<div style="font-size:10px;color:var(--text-muted);word-break:break-all;">📁 ${escHtml(outDir)}</div>` : ''}
                                `;

                                if (sw.pvd_path && window._pvdViewer && window._pvdViewer.openAiPvdViewer) {
                                    const viewBtn = document.createElement('button');
                                    viewBtn.className = 'btn btn-sm';
                                    viewBtn.style.cssText = 'margin-top:8px;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:white;font-weight:600;padding:6px 16px;width:100%;';
                                    viewBtn.innerHTML = '▶ Play in Viewer';
                                    viewBtn.addEventListener('click', () => {
                                        // Close the parent modal if it exists
                                        const parentModal = document.getElementById('ai-job-detail-modal');
                                        if (parentModal) parentModal.remove();
                                        if (onClose) onClose();
                                        window._pvdViewer.openAiPvdViewer(sw.pvd_path);
                                    });
                                    resultDiv.appendChild(viewBtn);
                                }
                                showToast(`Sweep complete: ${sw.count || n} predictions`, 'success');
                            } else {
                                resultDiv.style.background = 'rgba(239,68,68,0.1)';
                                resultDiv.style.color = '#f87171';
                                resultDiv.textContent = 'Error: ' + (res?.error || res?.message || 'Unknown error');
                            }
                        } catch (e) {
                            clearInterval(progressPollTimer);
                            resultDiv.style.background = 'rgba(239,68,68,0.1)';
                            resultDiv.style.color = '#f87171';
                            resultDiv.textContent = 'Network error: ' + e.message;
                        }
                        runBtn.disabled = false;
                        runBtn.innerHTML = 'Predict';
                        return;
                    }

                    // --- SINGLE MODE ---
                    let inputParams = {};

                    if (paramNames.length > 0) {
                        container.querySelectorAll('.ai-infer-param').forEach(inp => {
                            const val = parseFloat(inp.value);
                            if (!isNaN(val)) inputParams[inp.dataset.paramName] = val;
                        });
                        if (Object.keys(inputParams).length === 0) {
                            resultDiv.style.display = '';
                            resultDiv.style.background = 'rgba(239,68,68,0.1)';
                            resultDiv.style.color = '#f87171';
                            resultDiv.textContent = 'Enter at least one parameter value.';
                            return;
                        }
                    } else {
                        const raw = container.querySelector('.ai-infer-raw-json');
                        try { inputParams = JSON.parse(raw.value); } catch {
                            resultDiv.style.display = '';
                            resultDiv.style.background = 'rgba(239,68,68,0.1)';
                            resultDiv.style.color = '#f87171';
                            resultDiv.textContent = 'Invalid JSON.';
                            return;
                        }
                    }

                    runBtn.disabled = true;
                    runBtn.innerHTML = '<span class="spinner" style="width:14px;height:14px;"></span> Running...';

                    resultDiv.style.display = '';
                    resultDiv.style.background = 'rgba(99,102,241,0.1)';
                    resultDiv.style.color = '#818cf8';
                    resultDiv.textContent = 'Running inference...';

                    try {
                        const res = await aiApi.post(`/ai/training-jobs/${jobId}/infer`, { input_params: inputParams });
                        if (res && res.status === 'ok') {
                            const inf = res.inference || {};
                            const outDir = res.output_dir || inf.output_dir || '';
                            resultDiv.style.background = 'rgba(16,185,129,0.1)';
                            resultDiv.style.color = '#34d399';
                            let msg = '<div style="margin-bottom:6px;">✓ Prediction complete!';
                            if (inf.prediction_shape) msg += ` Shape: [${inf.prediction_shape.join('×')}]`;
                            msg += '</div>';
                            if (outDir) msg += `<div style="font-size:10px;color:var(--text-muted);word-break:break-all;">📁 ${escHtml(outDir)}</div>`;
                            resultDiv.innerHTML = msg;

                            // Add "Open in Viewer" button if PVD is available
                            if (inf.pvd_path && window._pvdViewer && window._pvdViewer.openAiPvdViewer) {
                                const viewBtn = document.createElement('button');
                                viewBtn.className = 'btn btn-sm';
                                viewBtn.style.cssText = 'margin-top:8px;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:white;font-weight:600;padding:6px 16px;width:100%;';
                                viewBtn.innerHTML = '▶ Open in Viewer';
                                viewBtn.addEventListener('click', () => {
                                    const parentModal = document.getElementById('ai-job-detail-modal');
                                    if (parentModal) parentModal.remove();
                                    if (onClose) onClose();
                                    window._pvdViewer.openAiPvdViewer(inf.pvd_path);
                                });
                                resultDiv.appendChild(viewBtn);
                            }
                            showToast('Inference complete!', 'success');
                        } else {
                            resultDiv.style.background = 'rgba(239,68,68,0.1)';
                            resultDiv.style.color = '#f87171';
                            resultDiv.textContent = 'Error: ' + (res?.error || res?.message || 'Unknown error');
                        }
                    } catch (e) {
                        resultDiv.style.background = 'rgba(239,68,68,0.1)';
                        resultDiv.style.color = '#f87171';
                        resultDiv.textContent = 'Network error: ' + e.message;
                    }

                    runBtn.disabled = false;
                    runBtn.innerHTML = 'Predict';
                });
    }

    // Wrapper for opening training modal from job detail
    function _openTrainModal(datasetId, modelFamily, runName, sourceJobId, mode) {
        showView('new-training', {
            mode: mode,
            sourceJobId: sourceJobId,
            modelFamily: modelFamily,
            runName: runName,
            datasetId: datasetId,
        });
    }

    function formatGpuList(gpuIdsStr) {
        try {
            const ids = JSON.parse(gpuIdsStr);
            if (Array.isArray(ids) && ids.length > 0) return ids.join(', ');
        } catch { /* fall through */ }
        return 'auto';
    }

    // ============================================================
    // VIEW 2: CREATE DATASET (full page with file browser)
    // ============================================================
    function renderCreateDataset() {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }

        container.innerHTML = '';
        container.appendChild(styleEl);

        let selectedSweepRoot = '';

        const wrapper = document.createElement('div');
        wrapper.className = 'page-enter';
        wrapper.innerHTML = `
            <div class="ai-back-btn" id="ai-ds-back">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"></polyline></svg>
                Back to AI Training
            </div>
            <div class="page-header">
                <h1>Create AI Dataset</h1>
                <p>Configure a training dataset from M-Star simulation sweep results</p>
            </div>

            <div class="ai-submit-layout">
                <div>
                    <!-- Sweep Data Source -->
                    <div class="card" style="margin-bottom:16px;">
                        <div class="card-header"><span class="card-title">Sweep Data Source</span></div>
                        <div style="display:flex;gap:0;margin-bottom:12px;">
                            <button class="btn btn-sm msb-tab active" id="ai-ds-tab-browse" style="flex:1;border-radius:8px 0 0 8px;justify-content:center;">Browse Server</button>
                            <button class="btn btn-sm msb-tab" id="ai-ds-tab-manual" style="flex:1;border-radius:0 8px 8px 0;justify-content:center;">Manual Path</button>
                        </div>
                        <div id="ai-ds-browse-panel">
                            <div id="ai-ds-browse-bar" class="ai-browse-bar"></div>
                            <div id="ai-ds-browse-list" style="max-height:320px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;"></div>
                        </div>
                        <div id="ai-ds-manual-panel" style="display:none;">
                            <div class="form-group" style="margin-bottom:0;">
                                <input type="text" class="form-input" id="ai-ds-manual-path" placeholder="/simulations/MyProject/sweep_results">
                                <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">Full path to the folder containing sweep case subdirectories</div>
                            </div>
                        </div>
                        <div id="ai-ds-selected" style="margin-top:10px;display:none;">
                            <div class="file-info" style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:rgba(59,130,246,0.08);border:1px solid rgba(59,130,246,0.2);border-radius:8px;">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent-green)" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>
                                <span id="ai-ds-selected-path" style="font-size:13px;font-family:var(--font-mono);color:var(--text-primary);"></span>
                                <button class="btn-icon" id="ai-ds-clear-path" style="margin-left:auto;" title="Clear selection">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                                </button>
                            </div>
                        </div>
                    </div>

                    <!-- Dataset Configuration -->
                    <div class="card" style="margin-bottom:16px;">
                        <div class="card-header"><span class="card-title">Dataset Configuration</span></div>
                        <div style="padding:0 16px 16px;">
                            <div class="form-group">
                                <label class="form-label">Dataset Name</label>
                                <input type="text" class="form-input" id="ai-ds-name" placeholder="e.g. Agitator RPM Sweep">
                            </div>
                            <div style="font-size:12px;color:var(--text-secondary);padding:8px 12px;background:var(--bg-tertiary);border-radius:8px;line-height:1.6;margin-top:4px;">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px;opacity:0.6;"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
                                After creation, the system automatically scans the sweep directory to discover all available <strong>stats files</strong>, <strong>2D slice fields</strong>, and <strong>3D volume data</strong>.
                            </div>
                        </div>
                    </div>
                </div>

                <div>
                    <!-- Preview / Info card -->
                    <div class="card" style="margin-bottom:16px;">
                        <div class="card-header"><span class="card-title">About Datasets</span></div>
                        <div style="padding:0 16px 16px;font-size:13px;color:var(--text-secondary);line-height:1.6;">
                            <p style="margin:0 0 12px;">A dataset catalogs all available output data from a completed M-Star parameter sweep. Point it at the sweep directory and the system will discover everything automatically.</p>
                            <p style="margin:0 0 8px;"><strong>What gets scanned:</strong></p>
                            <ul style="margin:0;padding-left:20px;">
                                <li><strong>Stats files</strong> — <code>out/Stats/*.txt</code> (scalar time series)</li>
                                <li><strong>2D Slices</strong> — <code>out/Output/Slice*.pvd</code> (velocity, pressure, etc.)</li>
                                <li><strong>3D Volumes</strong> — <code>out/Output/Volume*.pvd</code> (full field data)</li>
                            </ul>
                        </div>
                    </div>

                    <!-- Submit button -->
                    <button class="btn btn-primary" id="ai-ds-submit" style="width:100%;justify-content:center;padding:14px;font-size:15px;" disabled>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"></path><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"></path></svg>
                        Create Dataset
                    </button>
                </div>
            </div>
        `;
        container.appendChild(wrapper);

        // ---- Back button ----
        document.getElementById('ai-ds-back').addEventListener('click', () => showView('dashboard', { tab: 'datasets' }));

        // ---- Tab switching ----
        const tabBrowse = document.getElementById('ai-ds-tab-browse');
        const tabManual = document.getElementById('ai-ds-tab-manual');
        const browsePanel = document.getElementById('ai-ds-browse-panel');
        const manualPanel = document.getElementById('ai-ds-manual-panel');

        tabBrowse.addEventListener('click', () => {
            tabBrowse.classList.add('active');
            tabManual.classList.remove('active');
            browsePanel.style.display = '';
            manualPanel.style.display = 'none';
        });
        tabManual.addEventListener('click', () => {
            tabManual.classList.add('active');
            tabBrowse.classList.remove('active');
            manualPanel.style.display = '';
            browsePanel.style.display = 'none';
        });

        // ---- File browser ----
        async function loadDsBrowse(path) {
            const data = await aiApi.get(`/browse?path=${encodeURIComponent(path)}&mode=all`);
            if (!data || data.error) { showToast(data?.error || 'Browse failed', 'error'); return; }

            // Check if this directory contains sweep_manifest.json
            const hasManifest = data.entries.some(e => !e.is_dir && e.name === 'sweep_manifest.json');

            // Breadcrumbs
            const bar = document.getElementById('ai-ds-browse-bar');
            const parts = data.path.split('/').filter(Boolean);
            let crumbs = '<span data-path="/simulations">simulations</span>';
            let accumulated = '';
            for (const part of parts) {
                accumulated += '/' + part;
                if (accumulated === '/simulations') continue;
                crumbs += ' <span style="color:var(--text-muted);">/</span> ';
                crumbs += `<span data-path="${accumulated}">${part}</span>`;
            }
            bar.innerHTML = crumbs;
            bar.querySelectorAll('[data-path]').forEach(el => {
                el.addEventListener('click', () => loadDsBrowse(el.dataset.path));
            });

            // If manifest found, show auto-detect banner and auto-select this directory
            const list = document.getElementById('ai-ds-browse-list');
            let html = '';

            if (hasManifest) {
                const numSubdirs = data.entries.filter(e => e.is_dir).length;
                html += `<div style="padding:12px 14px;background:rgba(16,185,129,0.08);border:1px solid rgba(16,185,129,0.25);border-radius:8px;margin-bottom:8px;display:flex;align-items:center;gap:10px;">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--accent-green)" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>
                    <div>
                        <div style="font-weight:600;font-size:13px;color:var(--accent-green);">M-Star Sweep Detected</div>
                        <div style="font-size:12px;color:var(--text-secondary);">${numSubdirs} case directories · sweep_manifest.json found</div>
                    </div>
                    <button class="btn btn-sm btn-primary" id="ai-ds-auto-select" style="margin-left:auto;">Use This Directory</button>
                </div>`;
            }

            if (data.parent) {
                html += `<div class="ai-browse-entry" data-browse-dir="${data.parent}">
                    <span style="font-size:18px;">⬆️</span><span style="color:var(--text-secondary);">..</span></div>`;
            }
            for (const entry of data.entries) {
                if (entry.is_dir) {
                    const isSelected = selectedSweepRoot === entry.path;
                    html += `<div class="ai-browse-entry ${isSelected ? 'selected' : ''}" data-browse-dir="${entry.path}" data-selectable="true">
                        
                        <span style="flex:1;">${escHtml(entry.name)}</span>
                        <button class="btn btn-sm btn-secondary" data-select-dir="${entry.path}" style="padding:4px 10px;font-size:11px;" title="Use this folder as the sweep root">
                            Select
                        </button>
                    </div>`;
                }
                // Skip non-directory files in the listing (they're only used for manifest detection)
            }
            if (!data.entries.filter(e => e.is_dir).length && !data.parent && !hasManifest) {
                html = '<div style="padding:20px;text-align:center;color:var(--text-muted);">No subdirectories found</div>';
            }
            list.innerHTML = html;

            // Click handlers
            list.querySelectorAll('[data-browse-dir]').forEach(el => {
                el.addEventListener('click', (e) => {
                    // Don't navigate if the "Select" button was clicked
                    if (e.target.closest('[data-select-dir]')) return;
                    loadDsBrowse(el.dataset.browseDir);
                });
            });

            // Select buttons
            list.querySelectorAll('[data-select-dir]').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    selectSweepRoot(btn.dataset.selectDir);
                });
            });

            // Auto-select (sweep manifest detected) button
            const autoSelectBtn = document.getElementById('ai-ds-auto-select');
            if (autoSelectBtn) {
                autoSelectBtn.addEventListener('click', () => {
                    selectSweepRoot(data.path);
                    // Try to read sweep_manifest.json for auto-fill
                    aiApi.get(`/browse?path=${encodeURIComponent(data.path + '/sweep_manifest.json')}&mode=all`)
                        .catch(() => {});
                });
            }
        }

        function selectSweepRoot(path) {
            selectedSweepRoot = path;
            const selectedEl = document.getElementById('ai-ds-selected');
            const pathEl = document.getElementById('ai-ds-selected-path');
            selectedEl.style.display = '';
            pathEl.textContent = path;

            // Auto-fill name from folder name if empty
            const nameInput = document.getElementById('ai-ds-name');
            if (!nameInput.value) {
                nameInput.value = path.split('/').pop();
            }

            updateDsSubmitBtn();

            // Refresh the browse list to show selection highlight
            const currentPath = document.getElementById('ai-ds-browse-bar')
                .querySelector('[data-path]:last-child')?.dataset.path;
            if (currentPath) loadDsBrowse(currentPath);
        }

        // Clear selection
        document.getElementById('ai-ds-clear-path').addEventListener('click', () => {
            selectedSweepRoot = '';
            document.getElementById('ai-ds-selected').style.display = 'none';
            document.getElementById('ai-ds-selected-path').textContent = '';
            updateDsSubmitBtn();
        });

        // Manual path → enable submit
        document.getElementById('ai-ds-manual-path').addEventListener('input', () => updateDsSubmitBtn());

        function updateDsSubmitBtn() {
            const name = document.getElementById('ai-ds-name').value.trim();
            const manualPath = document.getElementById('ai-ds-manual-path').value.trim();
            const hasPath = selectedSweepRoot || manualPath;
            document.getElementById('ai-ds-submit').disabled = !(name && hasPath);
        }
        document.getElementById('ai-ds-name').addEventListener('input', () => updateDsSubmitBtn());

        // ---- Submit ----
        document.getElementById('ai-ds-submit').addEventListener('click', async () => {
            const name = document.getElementById('ai-ds-name').value.trim();
            const manualPath = document.getElementById('ai-ds-manual-path').value.trim();
            const sweepRoot = selectedSweepRoot || manualPath;

            if (!name || !sweepRoot) {
                showToast('Name and Sweep Root are required.', 'error');
                return;
            }

            const btn = document.getElementById('ai-ds-submit');
            btn.disabled = true;
            const origHtml = btn.innerHTML;
            btn.innerHTML = '<span class="spinner" style="width:14px;height:14px;"></span> Scanning...';

            const body = { name, sweep_root: sweepRoot };

            try {
                const res = await aiApi.post('/ai/datasets', body);
                if (res && res.id) {
                    showToast(`Dataset "${name}" created — scanning output data`, 'success');
                    showView('dashboard', { tab: 'datasets' });
                } else {
                    showToast(res?.error || 'Failed to create dataset', 'error');
                    btn.disabled = false;
                    btn.innerHTML = origHtml;
                }
            } catch {
                showToast('Network error', 'error');
                btn.disabled = false;
                btn.innerHTML = origHtml;
            }
        });

        // ---- Start browsing at /simulations ----
        loadDsBrowse('/simulations');
    }

    // ============================================================
    // VIEW 3: NEW TRAINING JOB (full page)
    // ============================================================
    async function renderNewTraining(resumeOpts) {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        selectedGpus.clear();

        container.innerHTML = '';
        container.appendChild(styleEl);

        // Determine resume mode
        const isResume = resumeOpts && resumeOpts.sourceJobId;
        const isContinue = isResume && resumeOpts.mode === 'continue';
        const isTransfer = isResume && resumeOpts.mode === 'transfer';
        const isRestart = isResume && resumeOpts.mode === 'restart';

        // If resuming, fetch the source job's config to pre-fill
        let sourceConfig = {};
        if (isResume) {
            try {
                const jobData = await aiApi.get(`/ai/training-jobs/${resumeOpts.sourceJobId}`);
                if (jobData && jobData.config_json) {
                    sourceConfig = typeof jobData.config_json === 'string'
                        ? JSON.parse(jobData.config_json)
                        : jobData.config_json;
                }
                // Also grab dataset_id from the job data
                if (jobData && jobData.dataset_id) {
                    resumeOpts.datasetId = resumeOpts.datasetId || jobData.dataset_id;
                }
            } catch (e) {
                console.warn('[AI] Failed to fetch source job config:', e);
            }
        }

        // Pre-load datasets
        const dsData = await aiApi.get('/ai/datasets');
        const datasets = dsData?.datasets || [];

        // Page title based on mode
        const pageTitle = isContinue ? 'Continue Training' : isTransfer ? 'Transfer Learning' : isRestart ? 'Restart Training' : 'New Training Job';
        const pageDesc = isContinue
            ? `Resuming from Job #${resumeOpts.sourceJobId} — model weights will be loaded from the best checkpoint`
            : isTransfer
            ? `Using pretrained weights from Job #${resumeOpts.sourceJobId} — same model architecture, new training`
            : isRestart
            ? `Fresh start using settings from Job #${resumeOpts.sourceJobId} — all parameters are editable`
            : 'Train a PhysicsNeMo surrogate model from simulation data';

        const wrapper = document.createElement('div');
        wrapper.className = 'page-enter';
        wrapper.innerHTML = `
            <div class="ai-back-btn" id="ai-tj-back">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"></polyline></svg>
                Back to AI Training
            </div>
            <div class="page-header">
                <h1>${pageTitle}</h1>
                <p>${pageDesc}</p>
            </div>

            ${isResume ? `
            <div style="display:flex;align-items:center;gap:10px;padding:12px 16px;margin-bottom:16px;border-radius:10px;background:${isContinue ? 'rgba(59,130,246,0.08)' : isRestart ? 'rgba(245,158,11,0.08)' : 'rgba(139,92,246,0.08)'};border:1px solid ${isContinue ? 'rgba(59,130,246,0.2)' : isRestart ? 'rgba(245,158,11,0.2)' : 'rgba(139,92,246,0.2)'};">
                <span style="font-size:18px;"></span>
                <div>
                    <div style="font-size:13px;font-weight:600;color:var(--text-primary);">
                        ${isContinue ? 'Continuing from' : isRestart ? 'Restarting from' : 'Pretrained from'} Job #${resumeOpts.sourceJobId}
                    </div>
                    <div style="font-size:11px;color:var(--text-muted);">
                        ${escHtml(resumeOpts.runName || '')} · ${escHtml(resumeOpts.modelFamily || '')}
                        ${isContinue ? ' · Same dataset & I/O, modify training parameters below' : isRestart ? ' · Fresh start — all settings editable' : ' · Same model architecture, select new dataset & I/O below'}
                    </div>
                </div>
            </div>
            ` : ''}

            <div class="ai-submit-layout">
                <div>
                    <!-- Dataset & Model -->
                    <div class="card" style="margin-bottom:16px;">
                        <div class="card-header"><span class="card-title">Dataset & Model</span></div>
                        <div style="padding:0 16px 16px;">
                            <div class="ai-form-grid">
                                <div class="form-group">
                                    <label class="form-label">Dataset</label>
                                    <select class="form-select" id="ai-tj-dataset">
                                        ${datasets.length
                                            ? datasets.map(ds => `<option value="${ds.id}">${escHtml(ds.name)} (${ds.num_cases_with_output || 0} cases)</option>`).join('')
                                            : '<option disabled>No datasets — create one first</option>'
                                        }
                                    </select>
                                </div>
                                <div class="form-group">
                                    <label class="form-label">Model Family</label>
                                    <select class="form-select" id="ai-tj-model">
                                        <option value="unet" selected>U-Net (Encoder-Decoder)</option>
                                        <option value="transolver">Transolver (Physics-Attention Transformer)</option>
                                        <option value="gnn">GNN (Graph Neural Network)</option>
                                        <option value="mlp">MLP (Multi-Layer Perceptron)</option>
                                    </select>
                                    <div id="ai-tj-model-note" style="font-size:11px;color:var(--text-muted);margin-top:4px;">2D/3D structured CFD fields, slices, voxel grids, image-like field prediction</div>
                                </div>
                                <div class="form-group">
                                    <label class="form-label">Data Mode</label>
                                    <select class="form-select" id="ai-tj-data-mode">
                                        <option value="time_averaged_2d" selected>2D Slice (e.g., SliceX, SliceY)</option>
                                        <option value="time_averaged_3d">3D Volume (full domain)</option>
                                        <option value="stats_table">Stats Table (scalar outputs only)</option>
                                    </select>
                                    <div id="ai-tj-mode-note" style="font-size:11px;color:var(--text-muted);margin-top:4px;">Determines spatial dimensions and model architecture (2D vs 3D convolutions)</div>
                                </div>
                            </div>
                            <div class="form-group" style="margin-bottom:0;">
                                <label class="form-label">Run Name <span style="color:var(--text-muted);font-weight:400;">(optional — auto-generated if blank)</span></label>
                                <input type="text" class="form-input" id="ai-tj-name" placeholder="e.g. unet_agitator_v2">
                            </div>
                        </div>
                    </div>

                    <!-- Inputs & Outputs -->
                    <div class="card" style="margin-bottom:16px;" id="ai-io-card">
                        <div class="card-header" style="display:flex;align-items:center;">
                            <span class="card-title">Inputs & Outputs</span>
                            <button class="btn btn-xs" id="ai-io-view-data-btn" style="display:none;margin-left:auto;font-size:11px;padding:4px 10px;border-radius:4px;background:var(--surface-2,#1e293b);border:1px solid var(--border-color,#333);color:var(--text-secondary);cursor:pointer;" title="View all dataset contents">
                                View Data
                            </button>
                        </div>
                        <div style="padding:0 16px 16px;" id="ai-io-body">
                            <div id="ai-io-placeholder" style="color:var(--text-muted);font-size:13px;padding:12px 0;">
                                Select a dataset above to see available parameters and fields.
                            </div>
                            <!-- Mode Toggle Bar -->
                            <div id="ai-io-mode-bar" style="display:none;margin-bottom:12px;">
                                <div style="display:flex;gap:4px;padding:3px;border-radius:8px;background:var(--bg-tertiary,#0f1423);border:1px solid var(--border-color,#333);">
                                    <button id="ai-io-mode-input" class="ai-io-mode-btn active" style="flex:1;padding:8px 12px;border-radius:6px;border:none;cursor:pointer;font-size:12px;font-weight:600;font-family:inherit;transition:all 0.2s;background:var(--accent-blue,#3b82f6);color:white;">
                                        Inputs <span id="ai-io-input-count" style="font-weight:400;opacity:0.8;"></span>
                                    </button>
                                    <button id="ai-io-mode-output" class="ai-io-mode-btn" style="flex:1;padding:8px 12px;border-radius:6px;border:none;cursor:pointer;font-size:12px;font-weight:600;font-family:inherit;transition:all 0.2s;background:transparent;color:var(--text-muted);">
                                        Outputs <span id="ai-io-output-count" style="font-weight:400;opacity:0.8;"></span>
                                    </button>
                                </div>
                                <div id="ai-io-mode-hint" style="font-size:11px;color:var(--text-muted);margin-top:6px;padding:0 2px;">Click fields below to add them as <strong style="color:var(--accent-blue,#3b82f6);">inputs</strong> to the neural network.</div>
                            </div>
                            <!-- Unified Field List -->
                            <div id="ai-io-field-list" style="display:none;display:flex;flex-direction:column;gap:4px;"></div>
                            <div id="ai-io-fields-empty" style="display:none;font-size:12px;color:var(--text-muted);padding:8px 0;">No fields detected.</div>
                            <!-- Tensor Summary -->
                            <div id="ai-tensor-summary-section" style="display:none;margin-top:12px;"></div>
                            <!-- Dataset info -->
                            <div id="ai-io-ds-info" style="display:none;font-size:11px;color:var(--text-muted);margin-top:12px;padding-top:8px;border-top:1px solid var(--border-color,#333);"></div>
                        </div>
                    </div>

                    <!-- Training Configuration -->
                    <div class="card" style="margin-bottom:16px;">
                        <div class="card-header" style="cursor:pointer;" id="ai-advanced-toggle">
                            <span class="card-title">Training Configuration</span>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-left:auto;transition:transform 0.2s;" id="ai-advanced-chevron"><polyline points="6 9 12 15 18 9"></polyline></svg>
                        </div>
                        <div id="ai-advanced-body" style="padding:0 16px 16px;">
                            <!-- Auto-suggest banner -->
                            <div id="ai-autosuggest-bar" style="display:flex;align-items:center;gap:8px;margin-bottom:12px;padding:8px 12px;border-radius:8px;background:rgba(139,92,246,0.06);border:1px solid rgba(139,92,246,0.15);">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" stroke-width="2"><path d="M12 2a7 7 0 017 7c0 2.38-1.19 4.47-3 5.74V17a2 2 0 01-2 2h-4a2 2 0 01-2-2v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 017-7z"></path><line x1="9" y1="21" x2="15" y2="21"></line></svg>
                                <span style="flex:1;font-size:11px;color:#a78bfa;">Set optimal hyperparameters based on your GPU and dataset</span>
                                <button class="btn" id="ai-autosuggest-btn" style="padding:4px 12px;font-size:11px;background:rgba(139,92,246,0.12);color:#a78bfa;border:1px solid rgba(139,92,246,0.25);border-radius:6px;cursor:pointer;white-space:nowrap;">
                                    ✨ Auto-Suggest
                                </button>
                            </div>
                            <div id="ai-autosuggest-msg" style="display:none;margin-bottom:10px;padding:8px 12px;border-radius:6px;background:rgba(16,185,129,0.06);border:1px solid rgba(16,185,129,0.15);font-size:11px;color:#10b981;"></div>

                            <div class="ai-form-grid">
                                <!-- Core Training -->
                                <div class="form-group" title="Number of full passes through the training data. More epochs = longer training but potentially better convergence. 3D training may need fewer epochs due to richer spatial information.">
                                    <label class="form-label">Epochs <span class="ai-tooltip-icon" data-tip="Total training iterations over the full dataset. Typical: 200–500 for U-Net, 500–1000 for GNN.">ⓘ</span></label>
                                    <input type="number" class="form-input" id="ai-tj-epochs" value="500" min="1" max="10000">
                                </div>
                                <div class="form-group" title="Samples processed per optimizer step. Larger batches = smoother gradients but more VRAM. For 3D data, use batch_size=1 with gradient accumulation.">
                                    <label class="form-label">Batch Size <span class="ai-tooltip-icon" data-tip="Samples per GPU per step. 3D volumes may require batch=1 due to VRAM. Use gradient accumulation to simulate larger batches.">ⓘ</span></label>
                                    <input type="number" class="form-input" id="ai-tj-batch" value="4" min="1" max="65536">
                                </div>
                                <div class="form-group" title="Step size for weight updates. Too high = unstable training, too low = slow convergence. Typical: 1e-4 to 3e-4 for AdamW.">
                                    <label class="form-label">Learning Rate <span class="ai-tooltip-icon" data-tip="Controls how aggressively weights are updated. Lower values are safer but slower. 3e-4 is a good starting point for AdamW.">ⓘ</span></label>
                                    <input type="number" class="form-input" id="ai-tj-lr" value="0.0003" step="0.0001" min="0.000001" max="1">
                                </div>
                                <div class="form-group" title="Gradient descent algorithm. AdamW is the best general-purpose choice with decoupled weight decay.">
                                    <label class="form-label">Optimizer <span class="ai-tooltip-icon" data-tip="AdamW (recommended): adaptive learning rate + weight decay. Adam: no weight decay. SGD: simple, may need tuning.">ⓘ</span></label>
                                    <select class="form-select" id="ai-tj-optimizer">
                                        <option value="adamw" selected>AdamW</option>
                                        <option value="adam">Adam</option>
                                        <option value="sgd">SGD</option>
                                        <option value="rmsprop">RMSProp</option>
                                    </select>
                                </div>
                                <div class="form-group" title="Learning rate schedule over training. Cosine annealing smoothly decays LR; OneCycle ramps up then down.">
                                    <label class="form-label">LR Scheduler <span class="ai-tooltip-icon" data-tip="Cosine: smooth decay to near-zero. OneCycle: warmup → peak → decay (best with known epoch count). Plateau: reduce when loss stalls.">ⓘ</span></label>
                                    <select class="form-select" id="ai-tj-scheduler">
                                        <option value="cosine" selected>Cosine Annealing</option>
                                        <option value="reduce_on_plateau">Reduce on Plateau</option>
                                        <option value="onecycle">OneCycle</option>
                                        <option value="step">Step LR</option>
                                        <option value="">None</option>
                                    </select>
                                </div>
                                <div class="form-group" title="Save a model checkpoint every N epochs. Lower = more checkpoints (more disk space) but easier to resume from a good state.">
                                    <label class="form-label">Checkpoint Interval <span class="ai-tooltip-icon" data-tip="How often to save model weights (in epochs). 10 is a good default; set lower (e.g. 5) if training is unstable.">ⓘ</span></label>
                                    <input type="number" class="form-input" id="ai-tj-ckpt" value="10" min="1" max="1000">
                                </div>

                                <!-- Memory & Performance -->
                                <div class="form-group" title="Mixed precision (FP16) training halves VRAM usage for activations with minimal accuracy impact. Essential for 3D models.">
                                    <label class="form-label">Mixed Precision (AMP) <span class="ai-tooltip-icon" data-tip="Uses float16 for forward/backward pass, float32 for weight updates. Halves VRAM for activations. Strongly recommended for 3D.">ⓘ</span></label>
                                    <select class="form-select" id="ai-tj-amp">
                                        <option value="auto" selected>Auto (on for 3D)</option>
                                        <option value="true">Enabled</option>
                                        <option value="false">Disabled</option>
                                    </select>
                                </div>
                                <div class="form-group" title="Accumulate gradients over N mini-batches before updating weights. Effectively multiplies your batch size without using more VRAM. E.g., batch=1 × accum=4 = effective batch of 4.">
                                    <label class="form-label">Gradient Accumulation <span class="ai-tooltip-icon" data-tip="Simulates larger batch sizes by accumulating gradients. Effective batch = batch_size × accum_steps. Essential for 3D where batch=1 is the max.">ⓘ</span></label>
                                    <input type="number" class="form-input" id="ai-tj-grad-accum" value="1" min="1" max="64">
                                </div>

                                <!-- Regularization -->
                                <div class="form-group" title="L2 regularization strength. Prevents overfitting by penalizing large weights. 0 = no regularization.">
                                    <label class="form-label">Weight Decay <span class="ai-tooltip-icon" data-tip="L2 regularization. Higher = more regularization. Typical range: 0.01–0.1 for AdamW, 0 for Adam.">ⓘ</span></label>
                                    <input type="number" class="form-input" id="ai-tj-weight-decay" value="0.01" step="0.01" min="0" max="1">
                                </div>

                                <!-- Data Processing -->
                                <div class="form-group" title="Downsample the spatial grid before training. 'Auto' only downsamples if the grid exceeds PyTorch's 2^31 element indexing limit. Explicit factors (1.5×, 2×, etc.) always downsample — useful for faster iteration on large 3D datasets.">
                                    <label class="form-label">Spatial Downsampling <span class="ai-tooltip-icon" data-tip="Reduces spatial resolution of training data. 'Auto': only if grid too large for PyTorch's int32 indexing (>2B elements). Explicit: always downsample by this factor. Trades spatial detail for speed and VRAM.">ⓘ</span></label>
                                    <select class="form-select" id="ai-tj-downsample">
                                        <option value="auto" selected>Auto (only if needed)</option>
                                        <option value="1">None (full resolution)</option>
                                        <option value="1.5">1.5× (moderate)</option>
                                        <option value="2">2× (recommended for 3D)</option>
                                        <option value="3">3× (fast iteration)</option>
                                        <option value="4">4× (very coarse)</option>
                                    </select>
                                </div>
                            </div>

                            <!-- VRAM estimate -->
                            <div id="ai-vram-estimate" style="display:none;margin-top:10px;padding:8px 12px;border-radius:6px;border:1px solid var(--border-color,#333);font-size:11px;color:var(--text-muted);"></div>
                        </div>
                    </div>
                </div>

                <div>
                    <!-- GPU Selection -->
                    <div class="card" style="margin-bottom:16px;">
                        <div class="card-header"><span class="card-title">GPU Selection</span></div>
                        <div id="ai-gpu-select-grid" class="gpu-select-grid">
                            <div class="skeleton" style="height:60px"></div>
                            <div class="skeleton" style="height:60px"></div>
                        </div>
                        <div style="font-size:11px;color:var(--text-muted);padding:6px 16px 12px;">Click GPUs to select. Leave empty for automatic assignment.</div>
                    </div>

                    <!-- Training Summary -->
                    <div class="card" style="margin-bottom:16px;" id="ai-training-summary-card">
                        <div class="card-header"><span class="card-title">Training Summary</span></div>
                        <div id="ai-training-summary" style="padding:8px 16px 12px;font-size:12px;color:var(--text-muted);">Select inputs and outputs above to see a summary.</div>
                    </div>

                    <!-- Submit button -->
                    <button class="btn btn-primary" id="ai-tj-submit" style="width:100%;justify-content:center;padding:14px;font-size:15px;" ${!datasets.length ? 'disabled' : ''}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                        ${isContinue ? 'Continue Training' : isTransfer ? 'Start Transfer Training' : isRestart ? 'Restart Training' : 'Start Training'}
                    </button>
                </div>
            </div>
        `;
        container.appendChild(wrapper);

        // ---- Back button ----
        document.getElementById('ai-tj-back').addEventListener('click', () => showView('dashboard', { tab: 'training-jobs' }));

        // ---- Advanced toggle ----
        const advancedToggle = document.getElementById('ai-advanced-toggle');
        const advancedBody = document.getElementById('ai-advanced-body');
        const advancedChevron = document.getElementById('ai-advanced-chevron');
        let advancedOpen = true;

        advancedToggle.addEventListener('click', () => {
            advancedOpen = !advancedOpen;
            advancedBody.style.display = advancedOpen ? 'block' : 'none';
            advancedChevron.style.transform = advancedOpen ? 'rotate(0deg)' : 'rotate(-90deg)';
        });

        // ---- Model family defaults & note ----
        const modelSelect = document.getElementById('ai-tj-model');
        const modelNote = document.getElementById('ai-tj-model-note');
        const MODEL_DEFAULTS = {
            unet: {
                note: '2D/3D structured CFD fields, slices, voxel grids, image-like field prediction',
                epochs: 500, batch_size: 4, learning_rate: 0.0003,
                optimizer: 'adamw', scheduler: 'cosine', checkpoint_interval: 10,
                amp: 'auto', gradient_accumulation_steps: 1, weight_decay: 0.01,
                spatial_downsample: 'auto',
            },
            transolver: {
                note: 'Physics-Attention transformer for structured CFD grids (voxels/slices) — not for unstructured body meshes (STL)',
                epochs: 500, batch_size: 4, learning_rate: 0.0003,
                optimizer: 'adamw', scheduler: 'cosine', checkpoint_interval: 10,
                amp: 'true', gradient_accumulation_steps: 1, weight_decay: 0.01,
                spatial_downsample: 'auto',
            },
            gnn: {
                note: 'Unstructured meshes, particle neighborhoods, irregular geometry, graph-based flow fields',
                epochs: 800, batch_size: 2, learning_rate: 0.0003,
                optimizer: 'adamw', scheduler: 'reduce_on_plateau', checkpoint_interval: 15,
                amp: 'false', gradient_accumulation_steps: 1, weight_decay: 0.01,
                spatial_downsample: '1',
            },
            mlp: {
                note: 'Low-dimensional surrogate, pointwise regression, coordinates/RPM/time → field values',
                epochs: 500, batch_size: 8192, learning_rate: 0.001,
                optimizer: 'adamw', scheduler: 'onecycle', checkpoint_interval: 10,
                amp: 'false', gradient_accumulation_steps: 1, weight_decay: 0,
                spatial_downsample: '1',
            },
        };
        function applyModelDefaults(family) {
            const d = MODEL_DEFAULTS[family];
            if (!d) return;
            modelNote.textContent = d.note || '';
            document.getElementById('ai-tj-epochs').value = d.epochs;
            document.getElementById('ai-tj-batch').value = d.batch_size;
            document.getElementById('ai-tj-lr').value = d.learning_rate;
            document.getElementById('ai-tj-optimizer').value = d.optimizer;
            document.getElementById('ai-tj-scheduler').value = d.scheduler;
            document.getElementById('ai-tj-ckpt').value = d.checkpoint_interval;
            document.getElementById('ai-tj-amp').value = d.amp;
            document.getElementById('ai-tj-grad-accum').value = d.gradient_accumulation_steps;
            document.getElementById('ai-tj-weight-decay').value = d.weight_decay;
            document.getElementById('ai-tj-downsample').value = d.spatial_downsample || 'auto';
        }
        modelSelect.addEventListener('change', () => {
            applyModelDefaults(modelSelect.value);
            _updateVramEstimate();
        });

        // ---- Resume / Transfer / Restart pre-fill ----
        if (isResume) {
            // Lock model family for continue/transfer (must match checkpoint),
            // but leave editable for restart (fresh start)
            modelSelect.value = resumeOpts.modelFamily || 'unet';
            if (!isRestart) {
                modelSelect.disabled = true;
                modelSelect.style.opacity = '0.7';
                modelSelect.title = 'Model architecture must match the source job';
            }

            // Pre-fill training config from source job
            if (sourceConfig.epochs) document.getElementById('ai-tj-epochs').value = sourceConfig.epochs;
            if (sourceConfig.batch_size) document.getElementById('ai-tj-batch').value = sourceConfig.batch_size;
            if (sourceConfig.learning_rate) document.getElementById('ai-tj-lr').value = sourceConfig.learning_rate;
            if (sourceConfig.optimizer) document.getElementById('ai-tj-optimizer').value = sourceConfig.optimizer;
            if (sourceConfig.scheduler) document.getElementById('ai-tj-scheduler').value = sourceConfig.scheduler;
            if (sourceConfig.checkpoint_interval) document.getElementById('ai-tj-ckpt').value = sourceConfig.checkpoint_interval;
            if (sourceConfig.dataset_mode) document.getElementById('ai-tj-data-mode').value = sourceConfig.dataset_mode;
            if (sourceConfig.amp != null) document.getElementById('ai-tj-amp').value = String(sourceConfig.amp);
            if (sourceConfig.gradient_accumulation_steps) document.getElementById('ai-tj-grad-accum').value = sourceConfig.gradient_accumulation_steps;
            if (sourceConfig.weight_decay != null) document.getElementById('ai-tj-weight-decay').value = sourceConfig.weight_decay;
            if (sourceConfig.spatial_downsample) document.getElementById('ai-tj-downsample').value = sourceConfig.spatial_downsample;

            // Auto-generate a run name
            const suffix = isContinue ? '_cont' : isRestart ? '_restart' : '_transfer';
            const baseName = resumeOpts.runName || `run_${resumeOpts.modelFamily}`;
            document.getElementById('ai-tj-name').value = baseName + suffix;

            // For continue and restart modes, pre-select the same dataset
            if ((isContinue || isRestart) && resumeOpts.datasetId) {
                const dsSelect = document.getElementById('ai-tj-dataset');
                dsSelect.value = String(resumeOpts.datasetId);
                // Trigger dataset load to populate I/O
                dsSelect.dispatchEvent(new Event('change'));
            }
        }

        // ---- I/O panel population ----
        const datasetSelect = document.getElementById('ai-tj-dataset');

        function _safeParse(jsonStr) {
            if (!jsonStr) return null;
            try { return JSON.parse(jsonStr); } catch { return null; }
        }

        function _isNumeric(v) {
            if (typeof v === 'number') return true;
            if (typeof v === 'string') return v !== '' && !isNaN(Number(v));
            return false;
        }

        // Keywords for auto-selecting output fields
        const _TARGET_KW = ['velocity', 'pressure', 'temperature', 'concentration',
            'vorticity', 'tke', 'magnitude', 'torque', 'force', 'power', 'energy'];

        // Store current dataset reference for View Data modal
        let _currentDs = null;

        function populateIOPanels(ds) {
            const placeholder = document.getElementById('ai-io-placeholder');
            const modeBar = document.getElementById('ai-io-mode-bar');
            const fieldList = document.getElementById('ai-io-field-list');
            const fieldsEmpty = document.getElementById('ai-io-fields-empty');
            const dsInfo = document.getElementById('ai-io-ds-info');
            const viewBtn = document.getElementById('ai-io-view-data-btn');

            _currentDs = ds;
            // Reset selections
            window._ioInputs = new Set();
            window._ioOutputs = new Set();
            window._ioMode = 'input';

            if (!ds) {
                placeholder.style.display = '';
                modeBar.style.display = 'none';
                fieldList.style.display = 'none';
                fieldsEmpty.style.display = 'none';
                dsInfo.style.display = 'none';
                viewBtn.style.display = 'none';
                const tensorSec = document.getElementById('ai-tensor-summary-section');
                if (tensorSec) tensorSec.style.display = 'none';
                return;
            }

            placeholder.style.display = 'none';
            viewBtn.style.display = '';
            modeBar.style.display = '';
            fieldList.style.display = '';

            // Reset mode toggle UI
            _setIOMode('input');

            // --- Collect ALL available fields ---
            const sweepParams = _safeParse(ds.sweep_parameters_json) || [];
            const casesData = _safeParse(ds.cases_json) || [];
            const pvdInv = _safeParse(ds.pvd_inventory_json) || {};
            const statsInv = _safeParse(ds.stats_inventory_json) || {};
            const dsMode = ds.dataset_mode || '';
            const isStatsMode = dsMode === 'stats_table';
            const isSpatialMode = !isStatsMode;

            let html = '';
            let hasAny = false;

            // === 1. Sweep Parameters ===
            const paramInfos = [];
            if (Array.isArray(sweepParams) && sweepParams.length > 0) {
                for (const sp of sweepParams) {
                    const pname = typeof sp === 'string' ? sp : (sp.name || sp);
                    const values = [];
                    for (const c of casesData) {
                        const params = c.parameters || {};
                        if (params[pname] !== undefined) values.push(params[pname]);
                    }
                    const uniqueVals = [...new Set(values.map(v => String(v)))];
                    const allNumeric = values.length > 0 && values.every(v => _isNumeric(v));
                    const varies = uniqueVals.length > 1;
                    paramInfos.push({ name: pname, values, uniqueVals, allNumeric, varies });
                }
            } else {
                const allParamKeys = new Set();
                for (const c of casesData) {
                    for (const k of Object.keys(c.parameters || {})) allParamKeys.add(k);
                }
                for (const pname of allParamKeys) {
                    const values = casesData.map(c => (c.parameters || {})[pname]).filter(v => v !== undefined);
                    const uniqueVals = [...new Set(values.map(v => String(v)))];
                    const allNumeric = values.length > 0 && values.every(v => _isNumeric(v));
                    const varies = uniqueVals.length > 1;
                    paramInfos.push({ name: pname, values, uniqueVals, allNumeric, varies });
                }
            }

            if (paramInfos.length > 0) {
                hasAny = true;
                html += `
                    <div class="stats-category-card">
                        <div class="stats-category-header" onclick="this.parentNode.classList.toggle('collapsed')">
                            <div class="stats-category-info">
                                <span class="stats-category-title">Sweep Parameters</span>
                                <span class="stats-category-meta">${paramInfos.length} parameter${paramInfos.length !== 1 ? 's' : ''} · ${casesData.length} cases</span>
                            </div>
                            <svg class="stats-section-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
                        </div>
                        <div class="stats-category-body">
                            ${paramInfos.map(p => {
                                const rangeStr = p.allNumeric && p.uniqueVals.length > 0
                                    ? p.uniqueVals.sort((a,b) => Number(a)-Number(b)).join(' → ')
                                    : '';
                                let badge = '';
                                if (!p.allNumeric) badge = ' ⚠';
                                else if (!p.varies) badge = ' ≡';
                                let title = `${p.name}`;
                                if (rangeStr) title += `\n${rangeStr}`;
                                if (!p.allNumeric) title += '\n⚠ Non-numeric values';
                                else if (!p.varies) title += '\n≡ Constant across all cases';
                                const fkey = 'param:' + p.name;
                                return `
                                    <button class="stats-col-btn" data-field-key="${escHtml(fkey)}" data-field-type="param" data-field-value="${escHtml(p.name)}" title="${escHtml(title)}"
                                        onclick="_toggleIOField(this)">
                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M4.93 4.93l4.24 4.24m5.66 5.66l4.24 4.24M19.07 4.93l-4.24 4.24m-5.66 5.66l-4.24 4.24M1 12h4m14 0h4M12 1v4m0 14v4"/></svg>
                                        ${escHtml(p.name)}${badge}
                                    </button>`;
                            }).join('')}
                        </div>
                    </div>`;
            }

            // === 2. VTK Fields (ImageData) — for spatial mode ===
            if (isSpatialMode) {
                const discoveredFields = [];
                const seenFields = new Set();
                for (const [catKey, catList] of Object.entries(pvdInv)) {
                    for (const entry of catList) {
                        const pvdName = entry.pvd_name || catKey;
                        const gridType = (entry.grid || {}).type || '';
                        const isStatic = entry.is_static || false;
                        const fields = entry.fields || [];
                        if (gridType !== 'ImageData') continue;
                        for (const f of fields) {
                            const fieldName = f.name || f.display_name || '';
                            const components = f.components || 1;
                            const dedupeKey = `${pvdName}:${fieldName}`;
                            if (seenFields.has(dedupeKey)) continue;
                            seenFields.add(dedupeKey);
                            discoveredFields.push({ fieldName, pvdName, components, isStatic, category: catKey });
                        }
                    }
                }

                const pvdColors = { boundary_conditions: 'amber', slices_2d: 'green', volumes_3d: 'purple' };
                const fieldsByPvd = {};
                for (const f of discoveredFields) {
                    if (!fieldsByPvd[f.pvdName]) fieldsByPvd[f.pvdName] = [];
                    fieldsByPvd[f.pvdName].push(f);
                }
                for (const [pvdName, fields] of Object.entries(fieldsByPvd)) {
                    hasAny = true;
                    const cat = fields[0].category;
                    const isAux = cat === 'boundary_conditions';
                    const label = isAux ? `${pvdName} (auxiliary volume)` : pvdName;
                    html += `
                        <div class="stats-category-card" style="margin-top:8px;">
                            <div class="stats-category-header" onclick="this.parentNode.classList.toggle('collapsed')">
                                <div class="stats-category-info">
                                    <span class="stats-category-title">${escHtml(label)}</span>
                                    <span class="stats-category-meta">${fields.length} field${fields.length !== 1 ? 's' : ''} · ${isAux ? 'static geometry' : 'time-varying'}</span>
                                </div>
                                <svg class="stats-section-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
                            </div>
                            <div class="stats-category-body">
                                ${fields.map(f => {
                                    const compLabel = f.components > 1 ? ` (${f.components}C)` : '';
                                    const descriptor = JSON.stringify({
                                        field_name: f.fieldName,
                                        pvd_source: isAux ? pvdName : 'self',
                                        transform: 'raw',
                                        channel_name: f.fieldName,
                                    });
                                    const fkey = 'vtk:' + f.pvdName + ':' + f.fieldName;
                                    return `
                                        <button class="stats-col-btn" data-field-key="${escHtml(fkey)}" data-field-type="vtk" data-field-value='${escHtml(descriptor)}' data-components="${f.components}" title="${escHtml(f.fieldName + compLabel + '\nFrom: ' + pvdName)}"
                                            onclick="_toggleIOField(this)">
                                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="12" x2="21" y2="12"/></svg>
                                            ${escHtml(f.fieldName)}${compLabel}
                                        </button>`;
                                }).join('')}
                            </div>
                        </div>`;
                }

                // === 3. Geometry Channels ===
                let computedChannels = [
                    { name: 'x_norm', label: 'X Coordinate', desc: 'Normalized X position [-1, 1]', icon: '\u2194', defaultOn: true },
                    { name: 'y_norm', label: 'Y Coordinate', desc: 'Normalized Y position [-1, 1]', icon: '\u2195', defaultOn: true },
                    { name: 'z_norm', label: 'Z Coordinate', desc: 'Normalized Z position [-1, 1] (3D only)', icon: '\u2197', defaultOn: false },
                ];

                hasAny = true;
                html += `
                    <div class="stats-category-card" style="margin-top:8px;" data-channel-group="geometry">
                        <div class="stats-category-header" onclick="this.parentNode.classList.toggle('collapsed')">
                            <div class="stats-category-info">
                                <span class="stats-category-title">Geometry Channels</span>
                                <span class="stats-category-meta">${computedChannels.length} channels · coordinates</span>
                            </div>
                            <svg class="stats-section-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
                        </div>
                        <div class="stats-category-body">
                            ${computedChannels.map(ch => {
                                const fkey = 'spatial:' + ch.name;
                                return `
                                <button class="stats-col-btn" data-field-key="${escHtml(fkey)}" data-field-type="spatial" data-field-value="${ch.name}" title="${escHtml(ch.desc)}"
                                    onclick="_toggleIOField(this)">
                                    <span style="margin-right:4px;">${ch.icon}</span>
                                    ${escHtml(ch.label)}
                                </button>`;
                            }).join('')}
                        </div>
                    </div>`;

                // Upgrade with full channel registry from API (non-blocking)
                aiApi.get('/ai/config').then(cfgRes => {
                    if (cfgRes && cfgRes.channel_registry && cfgRes.channel_registry.length > 0) {
                        const fullRegistry = cfgRes.channel_registry
                            .filter(ch => !ch.is_template && ch.category === 'geometry')
                            .map(ch => ({
                                name: ch.name,
                                label: ch.display_name,
                                desc: ch.description,
                                icon: ch.icon || '',
                                defaultOn: ch.default_on || false,
                            }));
                        if (fullRegistry.length > 0) {
                            const geoCard = fieldList.querySelector('[data-channel-group="geometry"] .stats-category-body');
                            if (geoCard) {
                                geoCard.innerHTML = fullRegistry.map(ch => {
                                    const fkey = 'spatial:' + ch.name;
                                    return `
                                    <button class="stats-col-btn" data-field-key="${escHtml(fkey)}" data-field-type="spatial" data-field-value="${ch.name}" title="${escHtml(ch.desc)}"
                                        onclick="_toggleIOField(this)">
                                        <span style="margin-right:4px;">${ch.icon}</span>
                                        ${escHtml(ch.label)}
                                    </button>`;
                                }).join('');
                                _refreshFieldStyles();
                            }
                        }

                        // Upgrade body geometry section from API registry
                        const bodyRegistry = cfgRes.channel_registry
                            .filter(ch => !ch.is_template && ch.category === 'body_geometry')
                            .map(ch => ({
                                name: ch.name,
                                label: ch.display_name,
                                desc: ch.description,
                                icon: ch.icon || '',
                                defaultOn: ch.default_on || false,
                            }));
                        if (bodyRegistry.length > 0) {
                            const bodyCard = fieldList.querySelector('[data-channel-group="body_geometry"] .stats-category-body');
                            if (bodyCard) {
                                bodyCard.innerHTML = bodyRegistry.map(ch => {
                                    const fkey = 'spatial:' + ch.name;
                                    return `
                                    <button class="stats-col-btn" data-field-key="${escHtml(fkey)}" data-field-type="spatial" data-field-value="${ch.name}" title="${escHtml(ch.desc)}"
                                        onclick="_toggleIOField(this)">
                                        <span style="margin-right:4px;">${ch.icon}</span>
                                        ${escHtml(ch.label)}
                                    </button>`;
                                }).join('');
                                _refreshFieldStyles();
                            }
                        }
                    }
                }).catch(() => {});

                // === 3b. Body Geometry Channels ===
                if (!isStatsMode) {
                    const bodyChannels = [
                        { name: 'static_body_mask', label: 'Static Body Mask', desc: 'Binary mask at static walls, baffles, fixed geometry (BC==0)', icon: '\uD83E\uDDF1', defaultOn: false },
                        { name: 'moving_body_mask', label: 'Moving Body / Rotating Zone', desc: 'Binary mask in rotating zones and moving body regions (BC==1) — critical for impeller-driven flows', icon: '\u2699\uFE0F', defaultOn: true },
                        { name: 'all_body_mask', label: 'All Bodies Combined', desc: 'Binary mask wherever any solid body exists (static OR moving)', icon: '\u25A3', defaultOn: false },
                        { name: 'body_sdf', label: 'Body SDF', desc: 'Signed distance to nearest body surface. Positive in fluid, negative inside bodies.', icon: '\uD83D\uDCCF', defaultOn: false },
                    ];

                    html += `
                        <div class="stats-category-card" style="margin-top:8px;" data-channel-group="body_geometry">
                            <div class="stats-category-header" onclick="this.parentNode.classList.toggle('collapsed')">
                                <div class="stats-category-info">
                                    <span class="stats-category-title">Body Geometry</span>
                                    <span class="stats-category-meta">${bodyChannels.length} channels · from BoundaryConditions.pvd</span>
                                </div>
                                <svg class="stats-section-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
                            </div>
                            <div class="stats-category-body">
                                ${bodyChannels.map(ch => {
                                    const fkey = 'spatial:' + ch.name;
                                    return `
                                    <button class="stats-col-btn" data-field-key="${escHtml(fkey)}" data-field-type="spatial" data-field-value="${ch.name}" title="${escHtml(ch.desc)}"
                                        onclick="_toggleIOField(this)">
                                        <span style="margin-right:4px;">${ch.icon}</span>
                                        ${escHtml(ch.label)}
                                    </button>`;
                                }).join('')}
                            </div>
                        </div>`;
                }
            }

            // === 4. Stats table columns (for stats mode) ===
            if (isStatsMode) {
                const catColors = ['cyan', 'green', 'amber', 'purple', 'red', 'blue'];
                const physicsStats = (statsInv.physics || []);
                physicsStats.forEach((sf, fi) => {
                    const cols = (sf.columns || []).filter(c => {
                        const n = (c.raw || c.name || '').toLowerCase();
                        return n !== 'time' && n !== 'timestep' && n !== 'step' && n !== 'iteration';
                    });
                    if (cols.length === 0) return;
                    hasAny = true;
                    const color = catColors[fi % catColors.length];
                    html += `
                        <div class="stats-category-card" style="margin-top:8px;">
                            <div class="stats-category-header" onclick="this.parentNode.classList.toggle('collapsed')">
                                <div class="stats-category-info">
                                    <span class="stats-category-title">${escHtml(sf.filename.replace('.txt','').replace('.csv',''))}</span>
                                    <span class="stats-category-meta">${cols.length} variables · ${sf.num_rows || '?'} rows</span>
                                </div>
                                <svg class="stats-section-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
                            </div>
                            <div class="stats-category-body">
                                ${cols.map(col => {
                                    const cname = col.raw || col.name || col;
                                    const displayName = col.name || cname;
                                    const unit = col.unit ? ` [${col.unit}]` : '';
                                    const fkey = 'stats:' + sf.filename + ':' + cname;
                                    return `
                                        <button class="stats-col-btn" data-field-key="${escHtml(fkey)}" data-field-type="stats" data-field-value="${escHtml(cname)}" data-source="${escHtml(sf.filename)}" title="${escHtml(displayName + unit)}"
                                            onclick="_toggleIOField(this)">
                                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
                                            ${escHtml(displayName)}${escHtml(unit)}
                                        </button>`;
                                }).join('')}
                            </div>
                        </div>`;
                });
            }

            // === 5. VTK output fields (for spatial mode — all PVD sources including non-ImageData) ===
            if (isSpatialMode) {
                const categoryLabels = { slices_2d: '2D Slices', volumes_3d: '3D Volumes', slices_body: 'Body Slices', other: 'Other' };
                const categoryOrder = ['slices_2d', 'volumes_3d', 'slices_body', 'other'];
                const catColors = ['cyan', 'green', 'amber', 'purple', 'red', 'blue'];
                let colorIdx = 0;
                for (const cat of categoryOrder) {
                    const pvdList = pvdInv[cat] || [];
                    if (pvdList.length === 0) continue;
                    for (const pvd of pvdList) {
                        const fields = pvd.fields || [];
                        if (fields.length === 0) continue;
                        const gridType = (pvd.grid || {}).type || '';
                        // Skip ImageData PVDs already shown in VTK Fields section above
                        if (gridType === 'ImageData') { colorIdx++; continue; }
                        hasAny = true;
                        const pvdLabel = pvd.pvd_name || pvd.pvd_file || '?';
                        const planeInfo = pvd.plane ? ` (${pvd.plane})` : '';
                        const catLabel = categoryLabels[cat] || cat;
                        const color = catColors[colorIdx % catColors.length];
                        colorIdx++;
                        html += `
                            <div class="stats-category-card" style="margin-top:8px;">
                                <div class="stats-category-header" onclick="this.parentNode.classList.toggle('collapsed')">
                                    <div class="stats-category-info">
                                        <span class="stats-category-title">${escHtml(pvdLabel + planeInfo)}</span>
                                        <span class="stats-category-meta">${catLabel} · ${fields.length} fields · ${gridType || 'PolyData'}</span>
                                    </div>
                                    <svg class="stats-section-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
                                </div>
                                <div class="stats-category-body">
                                    ${fields.map(f => {
                                        const fname = f.name || f.display_name || '';
                                        const fkey = 'output_vtk:' + pvdLabel + ':' + fname;
                                        const tags = f.is_solver_averaged ? ' ✓avg' : (f.is_rms ? ' ~RMS' : '');
                                        return `
                                            <button class="stats-col-btn" data-field-key="${escHtml(fkey)}" data-field-type="output_vtk" data-field-value="${escHtml(fname)}" data-source="${escHtml(pvdLabel)}" data-components="${f.components || 1}" title="${escHtml(f.display_name || fname)}"
                                                onclick="_toggleIOField(this)">
                                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
                                                ${escHtml(f.display_name || fname)}${tags}
                                            </button>`;
                                    }).join('')}
                                </div>
                            </div>`;
                    }
                }
            }

            // Set field list content
            if (hasAny) {
                fieldList.innerHTML = html;
                fieldsEmpty.style.display = 'none';

                // Auto-select defaultOn channels into inputs (for new jobs only)
                // Uses a static set of known defaults since the channel arrays
                // may be scoped inside isSpatialMode blocks.
                if (!isResume && isSpatialMode) {
                    const defaultOnNames = new Set([
                        'x_norm', 'y_norm',        // coordinates
                        'moving_body_mask',         // body geometry
                    ]);
                    fieldList.querySelectorAll('.stats-col-btn[data-field-type="spatial"]').forEach(btn => {
                        if (defaultOnNames.has(btn.dataset.fieldValue)) {
                            window._ioInputs.add(btn.dataset.fieldKey);
                        }
                    });
                    _refreshFieldStyles();
                }
            } else {
                fieldList.innerHTML = '';
                fieldsEmpty.style.display = '';
            }

            // === 6. Tensor Summary (spatial mode) ===
            const tensorSec = document.getElementById('ai-tensor-summary-section');
            if (isSpatialMode && tensorSec) {
                tensorSec.style.display = '';
                tensorSec.innerHTML = `
                    <div class="stats-category-card" style="border:1px solid var(--accent-green);">
                        <div class="stats-category-header" style="cursor:default;">
                            <div class="stats-category-info">
                                <span class="stats-category-title" style="color:var(--accent-green);">\ud83e\udde0 Tensor Summary</span>
                                <span class="stats-category-meta" id="ai-tensor-summary-meta">select channels above</span>
                            </div>
                        </div>
                        <div class="stats-category-body" style="padding:0;">
                            <div id="ai-tensor-summary" style="font-family:monospace;font-size:12px;padding:8px 12px;color:var(--text-secondary);max-height:200px;overflow-y:auto;"></div>
                        </div>
                    </div>`;
            } else if (tensorSec) {
                tensorSec.style.display = 'none';
            }

            // === 7. Fetch derived/prepared fields (async, spatial mode) ===
            // Instead of a separate "Prepared Fields" block, insert each derived
            // field under the PVD card it originated from (matching by pvd_name
            // from the recipe). Falls back to an "Other Prepared" section.
            if (isSpatialMode) {
                aiApi.get(`/ai/datasets/${ds.id}/derived-fields`).then(derivedRes => {
                    const derivedFields = (derivedRes && derivedRes.fields) || [];
                    if (derivedFields.length === 0) return;

                    const METHODS = {
                        time_average: { label: 'Time Average', icon: '\u23f1' },
                        solver_average: { label: 'Solver Average', icon: '\ud83d\udcca' },
                        coordinates: { label: 'Coordinates', icon: '\ud83d\udcd0' },
                        edt: { label: 'Distance Field', icon: '\ud83d\udd32' },
                        sdf: { label: 'Signed Distance', icon: '\u00b1' },
                        vorticity: { label: 'Vorticity', icon: '\ud83c\udf00' },
                        q_criterion: { label: 'Q-Criterion', icon: 'Q' },
                    };

                    const preparedFields = derivedFields.filter(f => {
                        const method = (f.recipe || {}).method || '';
                        if (method === 'coordinates') return false;
                        if (f.field_name && f.field_name.startsWith('target_')) return false;
                        return true;
                    });
                    if (preparedFields.length === 0) return;

                    // Group by source PVD name
                    const orphaned = [];
                    for (const f of preparedFields) {
                        const recipe = f.recipe || {};
                        const method = recipe.method || '?';
                        const methodInfo = METHODS[method] || { label: method, icon: '\u2699' };
                        const displayName = recipe.display_name || f.field_name;
                        // Recipe keys: source.source_field, source.source_pvd, source.field_name (legacy)
                        const src = recipe.source || {};
                        const sourceField = src.source_field || src.field_name || f.field_name;
                        const sourcePvd = src.source_pvd || src.pvd_name || '';
                        const descriptor = JSON.stringify({
                            field_name: f.field_name,
                            source_field_name: sourceField,
                            pvd_source: 'derived',
                            transform: method,
                            channel_name: f.field_name,
                        });
                        const fkey = 'derived:' + f.field_name;
                        const pvdInfo = sourcePvd ? `\nSource PVD: ${sourcePvd}` : '';
                        const title = `${displayName}\nMethod: ${methodInfo.label}\nDerived from: ${sourceField}${pvdInfo}\nCases: ${f.case_count}`;
                        const btnHtml = `
                            <button class="stats-col-btn" style="border-left:2px solid var(--accent-green);" data-field-key="${escHtml(fkey)}" data-field-type="derived" data-field-value='${escHtml(descriptor)}' title="${escHtml(title)}"
                                onclick="_toggleIOField(this)">
                                <span style="margin-right:3px;">${methodInfo.icon}</span>
                                ${escHtml(displayName)}
                                <span style="font-size:9px;color:var(--text-muted);margin-left:4px;">(prepared)</span>
                            </button>`;

                        // Find the PVD card this field belongs to.
                        // Strategy: find the card that already contains the SOURCE field
                        // (e.g. "Velocity Vector (m/s)") by checking data-field-key attrs.
                        // Falls back to PVD name title match, then orphaned.
                        let placed = false;
                        const pvdCards = fieldList.querySelectorAll('.stats-category-card');

                        // 1) Best match: card with a button matching BOTH the source PVD and field name
                        if (sourceField && sourcePvd) {
                            const pvdBase = sourcePvd.replace('.pvd', '');
                            for (const card of pvdCards) {
                                const btns = card.querySelectorAll('.stats-col-btn[data-field-key]');
                                for (const btn of btns) {
                                    const fk = btn.getAttribute('data-field-key') || '';
                                    // vtk field keys: "vtk:<pvd_name>:<field_name>"
                                    if (fk === 'vtk:' + sourcePvd + ':' + sourceField ||
                                        fk === 'vtk:' + pvdBase + ':' + sourceField) {
                                        const body = card.querySelector('.stats-category-body');
                                        if (body) {
                                            body.insertAdjacentHTML('beforeend', btnHtml);
                                            placed = true;
                                        }
                                        break;
                                    }
                                }
                                if (placed) break;
                            }
                        }

                        // 2) Fallback: match by source field name only (any PVD card)
                        if (!placed && sourceField) {
                            for (const card of pvdCards) {
                                const btns = card.querySelectorAll('.stats-col-btn[data-field-key]');
                                for (const btn of btns) {
                                    const fk = btn.getAttribute('data-field-key') || '';
                                    if (fk.startsWith('vtk:') && fk.endsWith(':' + sourceField)) {
                                        const body = card.querySelector('.stats-category-body');
                                        if (body) {
                                            body.insertAdjacentHTML('beforeend', btnHtml);
                                            placed = true;
                                        }
                                        break;
                                    }
                                }
                                if (placed) break;
                            }
                        }

                        // 2) Fallback: match by PVD name in card title
                        if (!placed && sourcePvd && sourcePvd !== 'auto' && sourcePvd !== 'unknown') {
                            for (const card of pvdCards) {
                                const titleEl = card.querySelector('.stats-category-title');
                                if (titleEl && titleEl.textContent.trim().includes(sourcePvd.replace('.pvd', ''))) {
                                    const body = card.querySelector('.stats-category-body');
                                    if (body) {
                                        body.insertAdjacentHTML('beforeend', btnHtml);
                                        placed = true;
                                        break;
                                    }
                                }
                            }
                        }

                        if (!placed) orphaned.push(btnHtml);
                    }

                    // Any fields that couldn't match a PVD card go into a fallback section
                    if (orphaned.length > 0) {
                        const fallbackHtml = `
                            <div class="stats-category-card" style="margin-top:8px;" data-derived-fields>
                                <div class="stats-category-header" onclick="this.parentNode.classList.toggle('collapsed')">
                                    <div class="stats-category-info">
                                        <span class="stats-category-title" style="color:var(--accent-green);">\ud83d\udce6 Prepared Fields</span>
                                        <span class="stats-category-meta">${orphaned.length} field${orphaned.length !== 1 ? 's' : ''} \u00b7 computed in preparation</span>
                                    </div>
                                    <svg class="stats-section-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
                                </div>
                                <div class="stats-category-body">
                                    ${orphaned.join('')}
                                </div>
                            </div>`;
                        fieldList.insertAdjacentHTML('beforeend', fallbackHtml);
                    }

                    _updateIOCounts();
                }).catch(e => console.warn('[AI] Failed to load derived fields:', e));
            }

            // --- Dataset info line ---
            const nCases = ds.num_cases_with_output || ds.num_cases || 0;
            const totalInv = (statsInv.total_data_human || _safeParse(ds.stats_inventory_json)?.total_data_human || '');
            const modeLabel = dsMode || 'auto';
            dsInfo.style.display = '';
            dsInfo.textContent = `${nCases} case${nCases !== 1 ? 's' : ''} · ${modeLabel}${totalInv ? ' · ' + totalInv : ''}`;

            // --- Update counts ---
            _updateIOCounts();
            setTimeout(() => updateTensorSummary(), 50);
        }






        // ---- I/O Mode Toggle Logic ----
        window._ioMode = 'input';
        window._ioInputs = new Set();
        window._ioOutputs = new Set();

        function _setIOMode(mode) {
            window._ioMode = mode;
            const inputBtn = document.getElementById('ai-io-mode-input');
            const outputBtn = document.getElementById('ai-io-mode-output');
            const hint = document.getElementById('ai-io-mode-hint');
            if (!inputBtn || !outputBtn) return;

            if (mode === 'input') {
                inputBtn.style.background = 'var(--accent-blue,#3b82f6)';
                inputBtn.style.color = 'white';
                outputBtn.style.background = 'transparent';
                outputBtn.style.color = 'var(--text-muted)';
                if (hint) hint.innerHTML = 'Click fields below to add them as <strong style="color:var(--accent-blue,#3b82f6);">inputs</strong> to the neural network.';
            } else {
                outputBtn.style.background = 'var(--accent-cyan,#06b6d4)';
                outputBtn.style.color = 'white';
                inputBtn.style.background = 'transparent';
                inputBtn.style.color = 'var(--text-muted)';
                if (hint) hint.innerHTML = 'Click fields below to select <strong style="color:var(--accent-cyan,#06b6d4);">outputs</strong> — what the model should predict.';
            }
        }
        window._setIOMode = _setIOMode;

        function _toggleIOField(btn) {
            const key = btn.dataset.fieldKey;
            if (!key) return;
            const mode = window._ioMode;
            const inputs = window._ioInputs;
            const outputs = window._ioOutputs;

            if (mode === 'input') {
                if (inputs.has(key)) inputs.delete(key);
                else inputs.add(key);
            } else {
                if (outputs.has(key)) outputs.delete(key);
                else outputs.add(key);
            }
            _applyFieldStyle(btn);
            _updateIOCounts();
            if (window.updateTensorSummary) updateTensorSummary();
        }
        window._toggleIOField = _toggleIOField;

        function _applyFieldStyle(btn) {
            const key = btn.dataset.fieldKey;
            const isInput = window._ioInputs.has(key);
            const isOutput = window._ioOutputs.has(key);

            // Remove any previous role classes
            btn.classList.remove('active', 'io-input', 'io-output', 'io-both', 'blue', 'cyan', 'green', 'amber', 'purple');

            if (isInput && isOutput) {
                btn.classList.add('active', 'io-both');
                btn.style.borderLeft = '3px solid';
                btn.style.borderImage = 'linear-gradient(to bottom, var(--accent-blue,#3b82f6) 50%, var(--accent-cyan,#06b6d4) 50%) 1';
                btn.style.background = 'linear-gradient(135deg, rgba(59,130,246,0.12), rgba(6,182,212,0.12))';
            } else if (isInput) {
                btn.classList.add('active', 'io-input', 'blue');
                btn.style.borderLeft = '3px solid var(--accent-blue,#3b82f6)';
                btn.style.borderImage = '';
                btn.style.background = 'rgba(59,130,246,0.12)';
            } else if (isOutput) {
                btn.classList.add('active', 'io-output', 'cyan');
                btn.style.borderLeft = '3px solid var(--accent-cyan,#06b6d4)';
                btn.style.borderImage = '';
                btn.style.background = 'rgba(6,182,212,0.12)';
            } else {
                btn.style.borderLeft = '';
                btn.style.borderImage = '';
                btn.style.background = '';
            }

            // Role indicator badges
            let badgeHtml = '';
            if (isInput) badgeHtml += '<span style="position:absolute;top:2px;right:2px;font-size:8px;color:var(--accent-blue,#3b82f6);font-weight:700;background:rgba(59,130,246,0.15);padding:0 3px;border-radius:3px;">IN</span>';
            if (isOutput) badgeHtml += '<span style="position:absolute;top:' + (isInput ? '14px' : '2px') + ';right:2px;font-size:8px;color:var(--accent-cyan,#06b6d4);font-weight:700;background:rgba(6,182,212,0.15);padding:0 3px;border-radius:3px;">OUT</span>';

            // Ensure position:relative
            btn.style.position = 'relative';
            // Remove old badges
            btn.querySelectorAll('.io-role-badge').forEach(b => b.remove());
            if (badgeHtml) {
                const wrapper = document.createElement('span');
                wrapper.className = 'io-role-badge';
                wrapper.innerHTML = badgeHtml;
                btn.appendChild(wrapper);
            }
        }

        function _refreshFieldStyles() {
            document.querySelectorAll('#ai-io-field-list [data-field-key]').forEach(btn => {
                _applyFieldStyle(btn);
            });
        }

        // Update selection counts in mode toggle buttons
        function _updateIOCounts() {
            const inputs = window._ioInputs;
            const outputs = window._ioOutputs;

            const inputCountEl = document.getElementById('ai-io-input-count');
            const outputCountEl = document.getElementById('ai-io-output-count');
            if (inputCountEl) inputCountEl.textContent = inputs.size > 0 ? `(${inputs.size})` : '';
            if (outputCountEl) outputCountEl.textContent = outputs.size > 0 ? `(${outputs.size})` : '';

            // Build training summary
            const summaryEl = document.getElementById('ai-training-summary');
            if (!summaryEl) return;

            if (inputs.size === 0 && outputs.size === 0) {
                summaryEl.innerHTML = '<span style="color:var(--text-muted);">Select inputs and outputs above to see a summary.</span>';
                return;
            }

            // Classify inputs by type
            const paramInputs = [], vtkInputs = [], spatialInputs = [], derivedInputs = [], otherInputs = [];
            for (const key of inputs) {
                const btn = document.querySelector(`[data-field-key="${CSS.escape(key)}"]`);
                const type = btn ? btn.dataset.fieldType : '';
                const val = btn ? btn.textContent.trim() : key;
                if (type === 'param') paramInputs.push(val);
                else if (type === 'vtk') vtkInputs.push(val);
                else if (type === 'spatial') spatialInputs.push(val);
                else if (type === 'derived') derivedInputs.push(val);
                else otherInputs.push(val);
            }

            // Classify outputs — sum components for total channel count
            const outputNames = [];
            let totalOutputChannels = 0;
            for (const key of outputs) {
                const btn = document.querySelector(`[data-field-key="${CSS.escape(key)}"]`);
                const nComp = btn ? parseInt(btn.dataset.components || '1', 10) : 1;
                totalOutputChannels += nComp;
                const label = btn ? btn.textContent.trim() : key;
                if (nComp > 1) {
                    outputNames.push(`${label} (${nComp}ch)`);
                } else {
                    outputNames.push(label);
                }
            }

            const totalInputs = inputs.size;
            const modelEl = document.getElementById('ai-tj-model');
            const modelName = modelEl ? modelEl.value.toUpperCase() : 'UNET';

            // Build channel groups for input display
            const channelGroups = [];
            if (vtkInputs.length > 0)
                channelGroups.push({ label: 'VTK Fields', channels: vtkInputs, color: '#f59e0b', bg: 'rgba(245,158,11,0.12)' });
            if (spatialInputs.length > 0)
                channelGroups.push({ label: 'Computed', channels: spatialInputs, color: '#3b82f6', bg: 'rgba(59,130,246,0.12)' });
            if (paramInputs.length > 0)
                channelGroups.push({ label: 'Params', channels: paramInputs, color: '#06b6d4', bg: 'rgba(6,182,212,0.12)' });
            if (derivedInputs.length > 0)
                channelGroups.push({ label: 'Prepared', channels: derivedInputs, color: '#10b981', bg: 'rgba(16,185,129,0.12)' });
            if (otherInputs.length > 0)
                channelGroups.push({ label: 'Other', channels: otherInputs, color: '#8b5cf6', bg: 'rgba(139,92,246,0.12)' });

            let inputHtml = '';
            if (channelGroups.length > 0) {
                const groupsHtml = channelGroups.map(g => {
                    const pills = g.channels.map(n =>
                        `<span style="display:inline-block;padding:1px 6px;border-radius:3px;background:${g.bg};color:${g.color};font-size:10px;font-weight:500;margin:1px;white-space:nowrap;">${escHtml(n)}</span>`
                    ).join('');
                    return `<div style="margin-bottom:4px;">
                        <span style="font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;">${g.label}</span>
                        <div style="margin-top:2px;display:flex;flex-wrap:wrap;gap:1px;">${pills}</div>
                    </div>`;
                }).join('');

                inputHtml = `
                    <div style="flex:1;min-width:120px;border:1px solid var(--border);border-radius:8px;padding:8px 10px;background:var(--bg-secondary);">
                        <div style="font-size:11px;font-weight:600;color:var(--text-primary);margin-bottom:6px;">
                            Input Tensor
                            <span style="font-weight:400;color:var(--text-muted);margin-left:4px;">(${totalInputs}, H, W)</span>
                        </div>
                        ${groupsHtml}
                    </div>`;
            }

            const networkHtml = `
                <div style="display:flex;flex-direction:column;align-items:center;flex-shrink:0;gap:2px;">
                    <svg width="20" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="1.5"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
                    <div style="padding:6px 14px;border-radius:8px;background:linear-gradient(135deg, rgba(139,92,246,0.2), rgba(59,130,246,0.2));border:1px solid rgba(139,92,246,0.3);text-align:center;">
                        <div style="font-size:13px;font-weight:700;color:var(--accent-purple,#8b5cf6);">${escHtml(modelName)}</div>
                        <div style="font-size:10px;color:var(--text-muted);">${totalInputs}ch → ${totalOutputChannels}ch</div>
                    </div>
                    <svg width="20" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="1.5"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
                </div>`;

            let outputHtml = '';
            if (outputs.size > 0) {
                const outPills = outputNames.map(n =>
                    `<span style="display:inline-block;padding:1px 6px;border-radius:3px;background:rgba(6,182,212,0.12);color:#06b6d4;font-size:10px;font-weight:500;margin:1px;white-space:nowrap;">${escHtml(n)}</span>`
                ).join('');
                outputHtml = `
                    <div style="flex:1;min-width:100px;border:1px solid var(--border);border-radius:8px;padding:8px 10px;background:var(--bg-secondary);">
                        <div style="font-size:11px;font-weight:600;color:var(--text-primary);margin-bottom:6px;">
                            Output Tensor
                            <span style="font-weight:400;color:var(--text-muted);margin-left:4px;">(${totalOutputChannels}, H, W)</span>
                        </div>
                        <div style="display:flex;flex-wrap:wrap;gap:1px;">${outPills}</div>
                    </div>`;
            }

            summaryEl.innerHTML = `
                <div style="display:flex;align-items:center;gap:8px;">
                    ${inputHtml}
                    ${networkHtml}
                    ${outputHtml}
                </div>`;
        }


        // ---- View Data Modal ----
        document.getElementById('ai-io-view-data-btn').addEventListener('click', () => {
            if (!_currentDs) return;
            const ds = _currentDs;
            const casesData = _safeParse(ds.cases_json) || [];
            const pvdInv = _safeParse(ds.pvd_inventory_json) || {};
            const statsInv = _safeParse(ds.stats_inventory_json) || {};

            // Build modal content
            let html = '';

            // --- Cases & Parameters ---
            html += '<div style="margin-bottom:20px;"><div style="font-size:14px;font-weight:600;color:var(--text-primary);margin-bottom:8px;">Cases & Parameters</div>';
            if (casesData.length > 0) {
                // Collect all param keys
                const allKeys = new Set();
                for (const c of casesData) for (const k of Object.keys(c.parameters || {})) allKeys.add(k);
                const paramKeys = [...allKeys];
                html += '<div style="overflow-x:auto;"><table style="width:100%;font-size:12px;border-collapse:collapse;">';
                html += '<thead><tr style="border-bottom:1px solid var(--border-color,#333);">';
                html += '<th style="text-align:left;padding:6px 8px;color:var(--text-secondary);font-weight:600;">Case</th>';
                for (const k of paramKeys) html += `<th style="text-align:right;padding:6px 8px;color:var(--text-secondary);font-weight:600;">${escHtml(k)}</th>`;
                html += '<th style="text-align:center;padding:6px 8px;color:var(--text-secondary);font-weight:600;">Output</th>';
                html += '</tr></thead><tbody>';
                for (const c of casesData) {
                    const hasOut = c.has_output !== false && c.status !== 'no_output';
                    html += '<tr style="border-bottom:1px solid var(--border-color,#222);">';
                    html += `<td style="padding:5px 8px;color:var(--text-primary);font-weight:500;">${escHtml(c.name)}</td>`;
                    for (const k of paramKeys) {
                        const v = (c.parameters || {})[k];
                        const display = v !== undefined ? String(v) : '—';
                        html += `<td style="padding:5px 8px;text-align:right;color:var(--text-muted);font-family:monospace;font-size:11px;">${escHtml(display)}</td>`;
                    }
                    html += `<td style="padding:5px 8px;text-align:center;">${hasOut ? '✓' : '✗'}</td>`;
                    html += '</tr>';
                }
                html += '</tbody></table></div>';
            } else {
                html += '<div style="color:var(--text-muted);font-size:12px;">No case data available.</div>';
            }
            html += '</div>';

            // --- PVD Sources ---
            const categoryLabels2 = { slices_2d: '2D Slices', volumes_3d: '3D Volumes', slices_body: 'Body Slices', boundary_conditions: 'Boundary Conditions', other: 'Other' };
            let hasPvd = false;
            for (const [cat, items] of Object.entries(pvdInv)) {
                if (!Array.isArray(items) || items.length === 0) continue;
                if (!hasPvd) {
                    html += '<div style="margin-bottom:20px;"><div style="font-size:14px;font-weight:600;color:var(--text-primary);margin-bottom:8px;">PVD Sources</div>';
                    hasPvd = true;
                }
                html += `<div style="font-size:12px;font-weight:600;color:var(--text-secondary);margin:8px 0 4px;">${categoryLabels2[cat] || cat} (${items.length})</div>`;
                for (const pvd of items) {
                    const name = pvd.pvd_name || '?';
                    const plane = pvd.plane ? ` — ${pvd.plane}` : '';
                    const ts = pvd.num_timesteps || 0;
                    const fmt = pvd.format || '?';
                    const fields = pvd.fields || [];
                    const isStatic = pvd.is_static;
                    html += `<div style="padding:6px 10px;margin-bottom:4px;border-radius:6px;background:var(--bg-tertiary,#0f1423);border:1px solid var(--border-color,#333);">`;
                    html += `<div style="font-size:12px;font-weight:500;color:var(--text-primary);">${escHtml(name + plane)}${isStatic ? ' <span style="color:var(--text-muted);font-size:10px;">static geometry</span>' : ''}</div>`;
                    html += `<div style="font-size:11px;color:var(--text-muted);">${fmt.toUpperCase()} · ${ts} timesteps · ${fields.length} fields</div>`;
                    if (fields.length > 0) {
                        html += `<div style="font-size:11px;color:var(--text-muted);margin-top:2px;">Fields: ${fields.map(f => escHtml(f.display_name || f.name || '?')).join(', ')}</div>`;
                    }
                    html += '</div>';
                }
            }
            if (hasPvd) html += '</div>';

            // --- Stats Files ---
            const physStats = statsInv.physics || [];
            const sysStats = statsInv.system || [];
            if (physStats.length > 0 || sysStats.length > 0) {
                html += '<div style="margin-bottom:20px;"><div style="font-size:14px;font-weight:600;color:var(--text-primary);margin-bottom:8px;">Stats Files</div>';
                for (const sf of [...physStats, ...sysStats]) {
                    const cols = (sf.columns || []).map(c => c.raw || c.name || c).join(', ');
                    html += `<div style="padding:6px 10px;margin-bottom:4px;border-radius:6px;background:var(--bg-tertiary,#0f1423);border:1px solid var(--border-color,#333);">`;
                    html += `<div style="font-size:12px;font-weight:500;color:var(--text-primary);">${escHtml(sf.filename)}</div>`;
                    html += `<div style="font-size:11px;color:var(--text-muted);">${sf.num_rows || '?'} rows · ${(sf.columns || []).length} columns</div>`;
                    if (cols) html += `<div style="font-size:11px;color:var(--text-muted);margin-top:2px;">Columns: ${escHtml(cols)}</div>`;
                    html += '</div>';
                }
                html += '</div>';
            }

            // Create modal
            const overlay = document.createElement('div');
            overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:10000;display:flex;align-items:center;justify-content:center;';
            overlay.innerHTML = `
                <div style="background:var(--bg-secondary,#111827);border:1px solid var(--border-color,#333);border-radius:12px;width:90vw;max-width:900px;max-height:85vh;display:flex;flex-direction:column;">
                    <div style="display:flex;align-items:center;padding:16px 20px;border-bottom:1px solid var(--border-color,#333);flex-shrink:0;">
                        <span style="font-size:16px;font-weight:600;color:var(--text-primary);">Dataset: ${escHtml(ds.name)}</span>
                        <button id="ai-view-data-close" style="margin-left:auto;background:none;border:none;color:var(--text-muted);font-size:20px;cursor:pointer;padding:4px 8px;">&times;</button>
                    </div>
                    <div style="padding:20px;overflow-y:auto;flex:1;">${html}</div>
                </div>
            `;
            document.body.appendChild(overlay);
            overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
            overlay.querySelector('#ai-view-data-close').addEventListener('click', () => overlay.remove());
        });

        // Populate on initial load
        if (datasets.length > 0) {
            // For continue mode, use the source job's dataset; otherwise first
            const initialDs = ((isContinue || isRestart) && resumeOpts.datasetId)
                ? datasets.find(d => d.id === resumeOpts.datasetId) || datasets[0]
                : datasets[0];
            populateIOPanels(initialDs);

            // If resuming, apply source job's I/O selections after panels are populated
            if (isResume && (sourceConfig.selected_input_params || sourceConfig.selected_target_fields)) {
                // Restore input selections via the Set model
                const srcInputs = sourceConfig.selected_input_params || [];
                const srcSpatial = sourceConfig.selected_spatial_channels || sourceConfig.computed_channels || [];
                const srcOutputs = sourceConfig.selected_target_fields || [];

                // Map param names to field keys
                for (const pname of srcInputs) {
                    const fkey = 'param:' + pname;
                    window._ioInputs.add(fkey);
                }
                for (const ch of srcSpatial) {
                    const fkey = 'spatial:' + ch;
                    window._ioInputs.add(fkey);
                }
                for (const oname of srcOutputs) {
                    // Find the matching output field key
                    const btn = document.querySelector(`[data-field-value="${CSS.escape(oname)}"]`);
                    if (btn && btn.dataset.fieldKey) {
                        window._ioOutputs.add(btn.dataset.fieldKey);
                    }
                }
                _refreshFieldStyles();
                _updateIOCounts();
                if (window.updateTensorSummary) setTimeout(() => updateTensorSummary(), 100);
            }
        }
        datasetSelect.addEventListener('change', () => {
            const ds = datasets.find(d => d.id === parseInt(datasetSelect.value, 10));
            populateIOPanels(ds);
        });

        // Collapsible I/O sections
        function _setupCollapsible(toggleId, chevronId, collapsibleId) {
            const toggle = document.getElementById(toggleId);
            const chevron = document.getElementById(chevronId);
            const body = document.getElementById(collapsibleId);
            if (!toggle || !body) return;
            toggle.addEventListener('click', () => {
                const isOpen = body.style.display !== 'none';
                body.style.display = isOpen ? 'none' : '';
                if (chevron) chevron.style.transform = isOpen ? 'rotate(-90deg)' : '';
            });
        }
        // Mode toggle buttons
        document.getElementById('ai-io-mode-input').addEventListener('click', () => _setIOMode('input'));
        document.getElementById('ai-io-mode-output').addEventListener('click', () => _setIOMode('output'));
        // Update summary when model changes
        modelSelect.addEventListener('change', () => _updateIOCounts());

        // ---- GPU grid ----
        await loadTrainingGpuGrid();

        // ---- Submit ----
        document.getElementById('ai-tj-submit').addEventListener('click', async () => {
            const datasetId = parseInt(document.getElementById('ai-tj-dataset').value, 10);
            const modelFamily = document.getElementById('ai-tj-model').value;
            const runName = document.getElementById('ai-tj-name').value.trim();

            if (!datasetId || isNaN(datasetId)) {
                showToast('Select a dataset first.', 'error');
                return;
            }

            const body = { dataset_id: datasetId, model_family: modelFamily };
            if (runName) body.run_name = runName;

            if (selectedGpus.size > 0) {
                body.gpu_ids = [...selectedGpus].sort();
            }

            // Training config overrides
            const config = {};
            const epochs = parseInt(document.getElementById('ai-tj-epochs').value, 10);
            const batchSize = parseInt(document.getElementById('ai-tj-batch').value, 10);
            const lr = parseFloat(document.getElementById('ai-tj-lr').value);
            const optimizer = document.getElementById('ai-tj-optimizer').value;
            const scheduler = document.getElementById('ai-tj-scheduler').value;
            const ckptInterval = parseInt(document.getElementById('ai-tj-ckpt').value, 10);
            const ampVal = document.getElementById('ai-tj-amp').value;
            const gradAccum = parseInt(document.getElementById('ai-tj-grad-accum').value, 10);
            const weightDecay = parseFloat(document.getElementById('ai-tj-weight-decay').value);

            if (epochs && epochs > 0) config.epochs = epochs;
            if (batchSize && batchSize > 0) config.batch_size = batchSize;
            if (lr && lr > 0) config.learning_rate = lr;
            if (optimizer) config.optimizer = optimizer;
            if (scheduler) config.scheduler = scheduler;
            if (ckptInterval && ckptInterval > 0) config.checkpoint_interval = ckptInterval;
            // AMP: 'auto' → let backend decide, 'true'/'false' → explicit
            if (ampVal === 'true') config.amp = true;
            else if (ampVal === 'false') config.amp = false;
            // else 'auto' — don't set, let the backend auto-detect based on 3D mode
            if (gradAccum && gradAccum > 0) config.gradient_accumulation_steps = gradAccum;
            if (!isNaN(weightDecay) && weightDecay >= 0) config.weight_decay = weightDecay;
            // Spatial downsampling: 'auto' or a numeric factor
            const downsampleVal = document.getElementById('ai-tj-downsample').value;
            if (downsampleVal && downsampleVal !== 'auto') {
                const factor = parseFloat(downsampleVal);
                if (factor > 1) config.spatial_downsample = factor;
                // factor === 1 means "none" — don't send (backend default is auto)
            } else if (downsampleVal === 'auto') {
                config.spatial_downsample = 'auto';
            }

            // I/O selections from unified mode-toggle Sets
            const inputs = window._ioInputs;
            const outputs = window._ioOutputs;

            const checkedInputParams = [];
            const checkedInputFields = [];
            const checkedComputed = [];
            const checkedOutputs = [];

            for (const key of inputs) {
                const btn = document.querySelector(`[data-field-key="${CSS.escape(key)}"]`);
                if (!btn) continue;
                const type = btn.dataset.fieldType;
                const val = btn.dataset.fieldValue;
                if (type === 'param') checkedInputParams.push(val);
                else if (type === 'vtk' || type === 'derived') {
                    try { checkedInputFields.push(JSON.parse(val)); } catch { checkedInputFields.push({ field_name: val, pvd_source: 'self', transform: 'raw', channel_name: val }); }
                }
                else if (type === 'spatial') checkedComputed.push(val);
                else if (type === 'stats' || type === 'output_vtk') checkedInputParams.push(val); // stats columns as params
            }

            for (const key of outputs) {
                const btn = document.querySelector(`[data-field-key="${CSS.escape(key)}"]`);
                if (!btn) continue;
                const val = btn.dataset.fieldValue;
                const type = btn.dataset.fieldType;
                if (type === 'vtk' || type === 'derived') {
                    try {
                        const d = JSON.parse(val);
                        // For derived fields, use the source field name (original M-Star
                        // name) so the training loader can find it in VTI cell data.
                        // Falls back to field_name / channel_name if source not available.
                        if (type === 'derived' && d.source_field_name) {
                            checkedOutputs.push(d.source_field_name);
                        } else {
                            checkedOutputs.push(d.field_name || d.channel_name || val);
                        }
                    } catch { checkedOutputs.push(val); }
                } else {
                    checkedOutputs.push(val);
                }
            }

            // Custom expression channels
            const customChannelRows = document.querySelectorAll('.ai-custom-channel-row');
            const customChannels = [];
            customChannelRows.forEach(row => {
                const nameInput = row.querySelector('.ai-custom-ch-name');
                const exprInput = row.querySelector('.ai-custom-ch-expr');
                if (nameInput && exprInput && nameInput.value.trim() && exprInput.value.trim()) {
                    customChannels.push({
                        channel_name: nameInput.value.trim(),
                        expression: exprInput.value.trim(),
                        method: 'expression',
                    });
                }
            });

            if (checkedInputParams.length > 0) config.selected_input_params = checkedInputParams;
            if (checkedInputFields.length > 0) config.input_fields = checkedInputFields;
            if (checkedComputed.length > 0) config.computed_channels = checkedComputed;
            if (checkedOutputs.length > 0) config.selected_target_fields = checkedOutputs;
            if (customChannels.length > 0) config.custom_channels = customChannels;
            // Dataset mode — read from the user's explicit selection
            config.dataset_mode = document.getElementById('ai-tj-data-mode').value;

            // --- Validate mode ↔ field compatibility ---
            // Check that selected I/O fields come from PVDs matching the chosen mode
            if (config.dataset_mode !== 'stats_table') {
                const selectedDs = (dsData?.datasets || []).find(d => d.id === datasetId);
                const pvdInv = _safeParse(selectedDs?.pvd_inventory_json) || {};

                // Build sets of PVD names per category
                const slicePvdNames = new Set(
                    (pvdInv.slices_2d || []).map(e => e.pvd_name || e)
                );
                const volumePvdNames = new Set(
                    (pvdInv.volumes_3d || []).map(e => e.pvd_name || e)
                );

                // Collect all selected VTK field PVD sources
                const allFieldKeys = [...(window._ioInputs || []), ...(window._ioOutputs || [])];
                const fieldPvdSources = new Set();
                for (const key of allFieldKeys) {
                    const btn = document.querySelector(`[data-field-key="${CSS.escape(key)}"]`);
                    if (!btn) continue;
                    const type = btn.dataset.fieldType;
                    if (type === 'vtk' || type === 'derived') {
                        try {
                            const desc = JSON.parse(btn.dataset.fieldValue || '{}');
                            const pvdSrc = desc.pvd_source || desc.source_pvd || '';
                            if (pvdSrc && pvdSrc !== 'self') fieldPvdSources.add(pvdSrc);
                        } catch {}
                    }
                }

                // Check for mismatch
                if (config.dataset_mode === 'time_averaged_3d' && fieldPvdSources.size > 0) {
                    const hasSliceFields = [...fieldPvdSources].some(s => slicePvdNames.has(s));
                    const hasVolumeFields = [...fieldPvdSources].some(s => volumePvdNames.has(s));
                    if (hasSliceFields && !hasVolumeFields) {
                        showToast(
                            '⚠ Mode mismatch: You selected "3D Volume" mode but all your I/O fields come from 2D Slice PVDs. ' +
                            'Either switch to "2D Slice" mode, or choose fields from a Volume PVD.',
                            'error'
                        );
                        return;
                    }
                }
                if (config.dataset_mode === 'time_averaged_2d' && fieldPvdSources.size > 0) {
                    const hasSliceFields = [...fieldPvdSources].some(s => slicePvdNames.has(s));
                    const hasVolumeFields = [...fieldPvdSources].some(s => volumePvdNames.has(s));
                    if (hasVolumeFields && !hasSliceFields) {
                        showToast(
                            '⚠ Mode mismatch: You selected "2D Slice" mode but your I/O fields come from 3D Volume PVDs. ' +
                            'Either switch to "3D Volume" mode, or choose fields from a Slice PVD.',
                            'error'
                        );
                        return;
                    }
                }
            }

            if (Object.keys(config).length > 0) body.config = config;

            // Include resume_from_job for continue/transfer learning
            // Restart mode does NOT set this — it's a fresh start with no checkpoint
            if (isResume && !isRestart && resumeOpts.sourceJobId) {
                body.resume_from_job = resumeOpts.sourceJobId;
            }

            const btn = document.getElementById('ai-tj-submit');
            btn.disabled = true;
            const origHtml = btn.innerHTML;
            btn.innerHTML = '<span class="spinner" style="width:14px;height:14px;"></span> Submitting...';

            try {
                const res = await aiApi.post('/ai/training-jobs', body);
                if (res && res.id) {
                    showToast(`Training job "${res.run_name}" queued`, 'success');
                    showView('dashboard', { tab: 'training-jobs' });
                } else {
                    showToast(res?.error || 'Failed to create training job', 'error');
                    btn.disabled = false;
                    btn.innerHTML = origHtml;
                }
            } catch {
                showToast('Network error', 'error');
                btn.disabled = false;
                btn.innerHTML = origHtml;
            }
        });
    }

    // ---- Helper: Update Input Tensor Summary ----
    function updateTensorSummary() {
        const summaryEl = document.getElementById('ai-tensor-summary');
        const metaEl = document.getElementById('ai-tensor-summary-meta');
        if (!summaryEl) return;

        const channels = [];
        let idx = 0;
        const inputs = window._ioInputs || new Set();
        const outputs = window._ioOutputs || new Set();

        // Build input channels from the Set
        for (const key of inputs) {
            const btn = document.querySelector(`[data-field-key="${CSS.escape(key)}"]`);
            if (!btn) continue;
            const type = btn.dataset.fieldType;
            const val = btn.dataset.fieldValue;
            if (type === 'vtk' || type === 'derived') {
                try {
                    const desc = JSON.parse(val);
                    channels.push({ idx: idx++, name: desc.channel_name || desc.field_name, type: desc.transform || 'raw', source: type === 'derived' ? 'derived' : 'vtk_field' });
                } catch { channels.push({ idx: idx++, name: val, type: 'raw', source: 'vtk_field' }); }
            } else if (type === 'spatial') {
                channels.push({ idx: idx++, name: val, type: 'computed', source: 'registry' });
            } else if (type === 'param') {
                channels.push({ idx: idx++, name: 'param_' + val.toLowerCase().replace(/\s+/g, '_'), type: 'broadcast', source: 'sweep_param' });
            } else {
                channels.push({ idx: idx++, name: val || btn.textContent.trim(), type: 'input', source: type || 'unknown' });
            }
        }

        // Custom channels
        document.querySelectorAll('.ai-custom-channel-row').forEach(row => {
            const n = row.querySelector('.ai-custom-ch-name');
            if (n && n.value.trim()) {
                channels.push({ idx: idx++, name: n.value.trim(), type: 'expression', source: 'custom' });
            }
        });

        if (channels.length === 0 && outputs.size === 0) {
            summaryEl.innerHTML = '<span style="color:var(--text-muted);">No channels selected</span>';
            metaEl.textContent = 'select channels above';
            return;
        }

        if (metaEl) {
            let totalOutputCh = 0;
            for (const key of outputs) {
                const btn = document.querySelector(`[data-field-key="${CSS.escape(key)}"]`);
                totalOutputCh += btn ? parseInt(btn.dataset.components || '1', 10) : 1;
            }
            metaEl.textContent = `${channels.length} input${channels.length !== 1 ? 's' : ''} · ${totalOutputCh} output${totalOutputCh !== 1 ? 's' : ''}`;
        }

        const typeColors = {
            vtk_field: 'var(--accent-amber)',
            computed: 'var(--accent-blue)',
            broadcast: 'var(--accent-cyan)',
            expression: 'var(--accent-green)',
        };

        const lines = channels.map(ch => {
            const color = typeColors[ch.source] || 'var(--text-secondary)';
            return `<div style="display:flex;gap:8px;padding:2px 0;">`
                + `<span style="color:var(--text-muted);min-width:24px;text-align:right;">${ch.idx}:</span>`
                + `<span style="color:${color};min-width:200px;">${escHtml(ch.name)}</span>`
                + `<span style="color:var(--text-muted);font-size:11px;">(${ch.type})</span>`
                + `</div>`;
        });

        summaryEl.innerHTML = lines.join('');
        metaEl.textContent = `${channels.length} channels · shape: (${channels.length}, H, W)`;

        // Also update the change event
        const ioBody = document.getElementById('ai-io-body');
        if (ioBody) ioBody.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // ---- Helper: Add Custom Channel Row ----
    function addCustomChannelRow() {
        const list = document.getElementById('ai-custom-channels-list');
        if (!list) return;
        const rowId = 'custom-ch-' + Date.now();
        const row = document.createElement('div');
        row.className = 'ai-custom-channel-row';
        row.id = rowId;
        row.style.cssText = 'display:flex;gap:6px;align-items:center;margin-bottom:6px;';
        row.innerHTML = `
            <input class="ai-custom-ch-name" type="text" placeholder="channel_name"
                style="width:120px;padding:4px 8px;border-radius:4px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);font-size:12px;"
                oninput="updateTensorSummary()">
            <input class="ai-custom-ch-expr" type="text" placeholder="np.sqrt(field_vx**2 + field_vy**2)"
                style="flex:1;padding:4px 8px;border-radius:4px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);font-size:12px;font-family:monospace;"
                oninput="updateTensorSummary()">
            <button style="background:none;border:none;color:var(--text-muted);cursor:pointer;padding:4px;"
                onclick="this.parentNode.remove(); updateTensorSummary();" title="Remove">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
        `;
        list.appendChild(row);
        row.querySelector('.ai-custom-ch-name').focus();
    }

    // ---- Helper: Render channel cards from a registry array ----
    function _renderChannelCards(channels, containerEl) {
        const categoryMeta = {
            geometry: { title: 'Geometry Channels', meta: 'coordinates · always available', color: 'blue' },
        };
        const grouped = {};
        for (const ch of channels) {
            const cat = ch.category || 'geometry';
            if (!grouped[cat]) grouped[cat] = [];
            grouped[cat].push(ch);
        }
        let html = '';
        for (const [cat, chList] of Object.entries(grouped)) {
            const meta = categoryMeta[cat] || { title: cat, meta: '', color: 'blue' };
            html += `
                <div class="stats-category-card" style="margin-top: 8px;" data-channel-group="${cat}">
                    <div class="stats-category-header" onclick="this.parentNode.classList.toggle('collapsed')">
                        <div class="stats-category-info">
                            <span class="stats-category-title">${escHtml(meta.title)}</span>
                            <span class="stats-category-meta">${chList.length} channel${chList.length !== 1 ? 's' : ''} · ${escHtml(meta.meta)}</span>
                        </div>
                        <svg class="stats-section-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
                    </div>
                    <div class="stats-category-body">
                        ${chList.map(ch => {
                            const fkey = 'spatial:' + ch.name;
                            return `
                            <button class="stats-col-btn" data-field-key="${escHtml(fkey)}" data-field-type="spatial" data-field-value="${ch.name}" title="${escHtml(ch.desc || '')}"
                                onclick="_toggleIOField(this)">
                                <span style="margin-right:4px;">${ch.icon}</span>
                                ${escHtml(ch.label)}
                            </button>`;
                        }).join('')}
                    </div>
                </div>`;
        }
        // Insert before the custom expression card (or at end)
        const customCard = containerEl.querySelector('[data-channel-group="custom-expr"]');
        if (customCard) {
            customCard.insertAdjacentHTML('beforebegin', html);
        } else {
            containerEl.insertAdjacentHTML('beforeend', html);
        }
        _refreshFieldStyles();
    }

    // Make helpers available in onclick handlers
    window.updateTensorSummary = updateTensorSummary;
    window.addCustomChannelRow = addCustomChannelRow;

    async function loadTrainingGpuGrid() {
        const grid = document.getElementById('ai-gpu-select-grid');
        try {
            const gpus = await aiApi.get('/gpus');
            if (!Array.isArray(gpus) || gpus.length === 0) {
                grid.innerHTML = '<div style="padding:12px;font-size:12px;color:var(--text-muted);">No GPUs detected</div>';
                return;
            }

            grid.innerHTML = gpus.map(gpu => {
                const reserved = !!gpu.running_job || gpu.externally_busy;
                let statusLabel = 'Available';
                let statusColor = 'var(--accent-green)';
                if (gpu.running_job) {
                    statusLabel = `In use: ${gpu.running_job.job_name || 'Job #' + gpu.running_job.job_id}`;
                    statusColor = 'var(--accent-amber)';
                } else if (gpu.externally_busy) {
                    statusLabel = 'External process';
                    statusColor = 'var(--accent-red)';
                }
                return `
                    <div class="gpu-select-card ${reserved ? 'reserved' : ''}" data-gpu-id="${gpu.index}">
                        <div class="gpu-select-name">GPU ${gpu.index}: ${(gpu.name || '').split(' ').pop()}</div>
                        <div class="gpu-select-meta">${formatMemory(gpu.memory_total)} VRAM</div>
                        <div class="gpu-select-meta" style="color:${statusColor}">${statusLabel}</div>
                    </div>`;
            }).join('');

            grid.querySelectorAll('.gpu-select-card:not(.reserved)').forEach(card => {
                card.addEventListener('click', () => {
                    const gpuId = parseInt(card.dataset.gpuId);
                    if (selectedGpus.has(gpuId)) {
                        selectedGpus.delete(gpuId);
                        card.classList.remove('selected');
                    } else {
                        selectedGpus.add(gpuId);
                        card.classList.add('selected');
                    }
                });
            });
        } catch {
            grid.innerHTML = '<div style="padding:12px;font-size:12px;color:var(--text-muted);">Failed to load GPU status</div>';
        }
    }

    // ---- Auto-Suggest & VRAM Estimation ----
    let _cachedGpuInfo = null;

    async function _getGpuInfo() {
        if (_cachedGpuInfo) return _cachedGpuInfo;
        try {
            const gpus = await aiApi.get('/gpus');
            if (Array.isArray(gpus) && gpus.length > 0) {
                _cachedGpuInfo = gpus;
            }
        } catch { /* ignore */ }
        return _cachedGpuInfo || [];
    }

    function _getDataMode() {
        const el = document.getElementById('ai-tj-data-mode');
        return el ? el.value : 'time_averaged_2d';
    }

    function _is3D() {
        return _getDataMode().includes('3d');
    }

    /**
     * Estimate VRAM needed for a single training step.
     * Based on the U-Net Pix2Pix architecture:
     *   - Input:  (B, C_in, D, H, W) or (B, C_in, H, W)
     *   - Feature maps at each level: channels double, spatial halves
     *   - Backward pass stores ~2x the forward activations
     */
    function _estimateVramGB(batchSize, is3d, useAmp) {
        const modelFamily = document.getElementById('ai-tj-model').value;
        const bytesPerEl = useAmp ? 2 : 4; // fp16 vs fp32

        if (modelFamily === 'mlp') {
            return 0.5; // MLP is tiny
        }

        if (modelFamily === 'gnn') {
            return batchSize * 2.0; // rough estimate
        }

        // UNet estimation
        const inCh = 5;  // typical: volume_fraction + x/y/z_norm + param
        const outCh = 3; // velocity vector components
        const convBase = 32;
        const depth = 4;

        let totalBytes = 0;

        // Spatial dims (typical for this dataset)
        let dims;
        if (is3d) {
            dims = [301, 476, 300]; // 3D volume
        } else {
            dims = [476, 300]; // 2D slice
        }

        // Input + target tensors
        const spatialSize = dims.reduce((a, b) => a * b, 1);
        totalBytes += batchSize * inCh * spatialSize * bytesPerEl;   // input
        totalBytes += batchSize * outCh * spatialSize * bytesPerEl;  // target

        // Feature maps at each encoder level (forward + backward ≈ 3x)
        for (let d = 0; d <= depth; d++) {
            const ch = convBase * Math.pow(2, d);
            const levelSize = dims.map(s => Math.floor(s / Math.pow(2, d)));
            const levelSpatial = levelSize.reduce((a, b) => a * b, 1);
            // Encoder + decoder + skip connections ≈ 3x feature maps
            totalBytes += batchSize * ch * levelSpatial * bytesPerEl * 3;
        }

        // Model params + optimizer state (~2x for AdamW)
        const paramCount = 37_800_000; // typical for conv_size=32, depth=4
        totalBytes += paramCount * 4 * 3; // params (fp32) + momentum + variance

        // Gradient buffers
        totalBytes += paramCount * bytesPerEl;

        return totalBytes / (1024 ** 3);
    }

    function _updateVramEstimate() {
        const el = document.getElementById('ai-vram-estimate');
        if (!el) return;

        const batchSize = parseInt(document.getElementById('ai-tj-batch').value, 10) || 1;
        const ampVal = document.getElementById('ai-tj-amp').value;
        const is3d = _is3D();
        const useAmp = ampVal === 'true' || (ampVal === 'auto' && is3d);
        const gradAccum = parseInt(document.getElementById('ai-tj-grad-accum').value, 10) || 1;

        const vramGB = _estimateVramGB(batchSize, is3d, useAmp);
        const effectiveBatch = batchSize * gradAccum;

        // Get downsample factor
        const dsVal = document.getElementById('ai-tj-downsample').value;
        let dsFactor = 1;
        if (dsVal === 'auto' && is3d) {
            // Auto: estimate if downsampling would trigger (301×476×300 × 64 > 2^31)
            const testElements = 64 * 301 * 476 * 300; // conv_base=32, decoder concat=64
            if (testElements > 2**31) dsFactor = 1.5;
        } else if (dsVal !== 'auto' && dsVal !== '1') {
            dsFactor = parseFloat(dsVal) || 1;
        }

        const adjustedVram = dsFactor > 1 ? vramGB / Math.pow(dsFactor, is3d ? 3 : 2) : vramGB;

        let html = `<div style="display:flex;align-items:center;gap:8px;">`;
        html += `<span style="font-weight:600;">Estimated VRAM:</span> `;
        html += `<span style="font-family:var(--font-mono);font-weight:600;color:${adjustedVram > 80 ? '#ef4444' : adjustedVram > 40 ? '#f59e0b' : '#10b981'};">${adjustedVram.toFixed(1)} GB</span>`;
        html += `<span style="color:var(--text-muted);">per GPU</span>`;
        if (effectiveBatch > 1 && gradAccum > 1) {
            html += `<span style="margin-left:auto;color:var(--text-muted);">Effective batch: ${effectiveBatch} (${batchSize} × ${gradAccum} accum)</span>`;
        }
        html += `</div>`;

        if (dsFactor > 1) {
            const origDims = is3d ? '301×476×300' : '476×300';
            const newDims = is3d
                ? `${Math.round(301/dsFactor)}×${Math.round(476/dsFactor)}×${Math.round(300/dsFactor)}`
                : `${Math.round(476/dsFactor)}×${Math.round(300/dsFactor)}`;
            html += `<div style="color:#a78bfa;margin-top:4px;">📐 Spatial grid: ${origDims} → ${newDims} (${dsFactor}× downsample)</div>`;
        }

        if (adjustedVram > 80) {
            html += `<div style="color:#ef4444;margin-top:4px;">⚠️ Likely to OOM on most GPUs. Reduce batch size or enable AMP.</div>`;
        } else if (adjustedVram > 40) {
            html += `<div style="color:#f59e0b;margin-top:4px;">⚠ Tight fit — ensure your GPU has ≥${Math.ceil(adjustedVram + 10)} GB VRAM.</div>`;
        }

        el.style.display = 'block';
        el.innerHTML = html;
    }

    async function _autoSuggest() {
        const gpus = await _getGpuInfo();
        const is3d = _is3D();
        const modelFamily = document.getElementById('ai-tj-model').value;
        const msgEl = document.getElementById('ai-autosuggest-msg');

        // Find minimum VRAM across available GPUs
        let minVram = 96; // fallback
        if (gpus.length > 0) {
            const memoryValues = gpus
                .filter(g => !g.running_job && !g.externally_busy)
                .map(g => (g.memory_total || 0) / (1024 * 1024)); // bytes → MB → GB... depends on API
            if (memoryValues.length > 0) {
                // memory_total is typically in bytes
                minVram = Math.min(...gpus.map(g => (g.memory_total || 0) / (1024 * 1024 * 1024)));
                if (minVram < 1) {
                    // Might be in MB already
                    minVram = Math.min(...gpus.map(g => (g.memory_total || 0) / 1024));
                }
                if (minVram < 1) minVram = 96; // fallback
            }
        }

        const changes = [];

        if (modelFamily === 'unet') {
            if (is3d) {
                // 3D UNet — aggressive memory optimization
                document.getElementById('ai-tj-batch').value = 1;
                document.getElementById('ai-tj-amp').value = 'true';
                document.getElementById('ai-tj-grad-accum').value = 4;
                document.getElementById('ai-tj-lr').value = 0.0003;
                document.getElementById('ai-tj-epochs').value = 300;
                document.getElementById('ai-tj-weight-decay').value = 0.01;
                document.getElementById('ai-tj-optimizer').value = 'adamw';
                document.getElementById('ai-tj-scheduler').value = 'cosine';
                document.getElementById('ai-tj-downsample').value = 'auto';
                changes.push('batch_size=1 (3D volumes use ~5 GB/sample)');
                changes.push('AMP enabled (halves activation memory)');
                changes.push('gradient accumulation=4 (effective batch=4)');
                changes.push('spatial downsample=auto (only if grid > 2B elements)');
                changes.push('300 epochs (3D converges faster)');
            } else {
                // 2D UNet — can be more generous
                let suggestedBatch = 4;
                if (minVram >= 40) suggestedBatch = 8;
                if (minVram >= 80) suggestedBatch = 16;

                document.getElementById('ai-tj-batch').value = suggestedBatch;
                document.getElementById('ai-tj-amp').value = 'false';
                document.getElementById('ai-tj-grad-accum').value = 1;
                document.getElementById('ai-tj-lr').value = 0.0003;
                document.getElementById('ai-tj-epochs').value = 500;
                document.getElementById('ai-tj-weight-decay').value = 0.01;
                changes.push(`batch_size=${suggestedBatch} (based on ${minVram.toFixed(0)} GB VRAM)`);
                changes.push('AMP disabled (2D fits easily)');
            }
        } else if (modelFamily === 'transolver') {
            if (is3d) {
                // 3D Transolver — similar to 3D U-Net memory profile
                document.getElementById('ai-tj-batch').value = 1;
                document.getElementById('ai-tj-amp').value = 'true';
                document.getElementById('ai-tj-grad-accum').value = 4;
                document.getElementById('ai-tj-lr').value = 0.0003;
                document.getElementById('ai-tj-epochs').value = 300;
                document.getElementById('ai-tj-weight-decay').value = 0.01;
                document.getElementById('ai-tj-optimizer').value = 'adamw';
                document.getElementById('ai-tj-scheduler').value = 'cosine';
                document.getElementById('ai-tj-downsample').value = 'auto';
                changes.push('batch_size=1 (3D attention is memory-intensive)');
                changes.push('AMP enabled (halves activation memory)');
                changes.push('gradient accumulation=4 (effective batch=4)');
                changes.push('300 epochs (3D converges faster)');
            } else {
                let suggestedBatch = 4;
                if (minVram >= 40) suggestedBatch = 8;
                document.getElementById('ai-tj-batch').value = suggestedBatch;
                document.getElementById('ai-tj-amp').value = 'true';
                document.getElementById('ai-tj-grad-accum').value = 1;
                document.getElementById('ai-tj-lr').value = 0.0003;
                document.getElementById('ai-tj-epochs').value = 500;
                document.getElementById('ai-tj-weight-decay').value = 0.01;
                changes.push(`batch_size=${suggestedBatch} (based on ${minVram.toFixed(0)} GB VRAM)`);
                changes.push('AMP enabled (Transolver benefits from mixed precision)');
            }
        } else if (modelFamily === 'gnn') {
            document.getElementById('ai-tj-batch').value = 2;
            document.getElementById('ai-tj-amp').value = is3d ? 'true' : 'false';
            document.getElementById('ai-tj-grad-accum').value = is3d ? 2 : 1;
            changes.push('GNN defaults applied');
        } else if (modelFamily === 'mlp') {
            document.getElementById('ai-tj-batch').value = 8192;
            document.getElementById('ai-tj-amp').value = 'false';
            document.getElementById('ai-tj-grad-accum').value = 1;
            changes.push('MLP: large batch (fits in RAM)');
        }

        // Show feedback
        if (msgEl && changes.length > 0) {
            const gpuLabel = gpus.length > 0
                ? `${gpus.length}× ${(gpus[0].name || 'GPU').split(' ').pop()} (${minVram.toFixed(0)} GB each)`
                : 'GPU info unavailable';
            msgEl.innerHTML = `
                <div style="font-weight:600;margin-bottom:4px;">✨ Auto-configured for ${is3d ? '3D' : '2D'} ${modelFamily.toUpperCase()} — ${gpuLabel}</div>
                <ul style="margin:0;padding-left:16px;line-height:1.6;">
                    ${changes.map(c => `<li>${c}</li>`).join('')}
                </ul>
            `;
            msgEl.style.display = 'block';
            // Auto-hide after 15s
            setTimeout(() => { if (msgEl) msgEl.style.display = 'none'; }, 15000);
        }

        _updateVramEstimate();
    }

    // Wire up auto-suggest button
    const autoSuggestBtn = document.getElementById('ai-autosuggest-btn');
    if (autoSuggestBtn) {
        autoSuggestBtn.addEventListener('click', _autoSuggest);
    }

    // Update VRAM estimate whenever relevant fields change
    ['ai-tj-batch', 'ai-tj-amp', 'ai-tj-grad-accum', 'ai-tj-downsample'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('change', _updateVramEstimate);
        if (el) el.addEventListener('input', _updateVramEstimate);
    });

    // Update VRAM estimate when data mode changes
    const dataModeEl = document.getElementById('ai-tj-data-mode');
    if (dataModeEl) {
        dataModeEl.addEventListener('change', () => {
            _updateVramEstimate();
            // Also update the autosuggest bar hint
            const msgEl = document.getElementById('ai-autosuggest-msg');
            if (msgEl) msgEl.style.display = 'none'; // hide old suggestions
        });
    }

    // Initial VRAM estimate
    _updateVramEstimate();

    // ---- Cleanup on page navigation ----
    container._aiTrainingCleanup = () => {
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
        // Also close any open metrics modal
        if (window._aiTrainingMetrics) {
            window._aiTrainingMetrics.closeTrainingMetrics();
        }
    };

    // ============================================================
    // VIEW: PREPARE DATASET — Compute derived fields & export VTK
    // ============================================================
    async function renderPrepareDataset(opts) {
        if (!opts || !opts.datasetId) {
            showToast('No dataset selected', 'error');
            return showView('dashboard', { tab: 'datasets' });
        }

        const dsId = opts.datasetId;
        const dsName = opts.datasetName || `Dataset #${dsId}`;
        const sweepRoot = opts.sweepRoot || '';

        container.innerHTML = '';
        container.appendChild(styleEl);

        const wrapper = document.createElement('div');
        wrapper.className = 'page-enter';
        wrapper.style.maxWidth = '1400px';
        wrapper.innerHTML = `
            <div class="page-header" style="display:flex;justify-content:space-between;align-items:flex-start;">
                <div>
                    <button class="btn btn-secondary" id="ai-prep-back" style="margin-bottom:8px;">← Back to Dashboard</button>
                    <h1>Prepare Dataset</h1>
                    <p style="color:var(--text-muted);margin-top:4px;">${escHtml(dsName)}</p>
                    <p style="color:var(--text-muted);font-size:12px;margin-top:2px;font-family:monospace;">${escHtml(sweepRoot)}</p>
                </div>
            </div>

            <!-- Sweep/DoE Parameters Summary -->
            <div id="ai-prep-sweep-params" style="margin-top:12px;display:none;"></div>

            <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:16px;">
                <!-- Left: Available M-Star Fields -->
                <div class="card" style="padding:20px;">
                    <h3 style="margin-bottom:4px;">Available Fields</h3>
                    <p style="color:var(--text-muted);font-size:12px;margin-bottom:14px;">
                        Discovered from M-Star output. Click <strong>Add</strong> to include in the preparation recipe.
                    </p>
                    <div id="ai-probe-results" style="display:flex;flex-direction:column;gap:6px;">
                        <div style="text-align:center;padding:30px;color:var(--text-muted);">
                            <div class="spinner" style="width:20px;height:20px;margin:0 auto 8px;"></div>
                            Scanning output files…
                        </div>
                    </div>

                    <!-- Synthetic fields section -->
                    <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--border-color);">
                        <h4 style="margin-bottom:8px;font-size:12px;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.5px;">Synthetic Fields</h4>
                        <p style="color:var(--text-muted);font-size:11px;margin-bottom:8px;">Generated grids, not from simulation data.</p>
                        <div style="display:flex;flex-wrap:wrap;gap:6px;" id="ai-prep-synthetic-btns">
                            <button class="btn btn-secondary" data-synth="coordinates_x" style="font-size:12px;padding:4px 10px;">+ X Coordinate</button>
                            <button class="btn btn-secondary" data-synth="coordinates_y" style="font-size:12px;padding:4px 10px;">+ Y Coordinate</button>
                            <button class="btn btn-secondary" data-synth="coordinates_z" style="font-size:12px;padding:4px 10px;">+ Z Coordinate</button>
                        </div>
                    </div>
                </div>

                <!-- Right: Recipe + Computed -->
                <div class="card" style="padding:20px;">
                    <h3 style="margin-bottom:4px;">Preparation Recipe</h3>
                    <p style="color:var(--text-muted);font-size:12px;margin-bottom:14px;">
                        Fields that will be extracted and processed. Change the method or output name before computing.
                    </p>
                    <div id="ai-prep-recipe-list" style="display:flex;flex-direction:column;gap:6px;">
                        <p style="color:var(--text-muted);font-size:13px;font-style:italic;">No fields added yet.</p>
                    </div>

                    <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--border-color);display:flex;gap:8px;flex-wrap:wrap;">
                        <button class="btn btn-primary" id="ai-prep-compute" disabled>
                            Compute
                        </button>
                    </div>
                    <div id="ai-prep-status" style="margin-top:10px;display:none;"></div>

                    <div style="margin-top:20px;padding-top:14px;border-top:1px solid var(--border-color);">
                        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
                            <h4 style="margin:0;font-size:12px;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.5px;">
                                Already Computed
                            </h4>
                            <button class="btn btn-sm" id="ai-prep-delete-selected" style="display:none;font-size:11px;padding:3px 10px;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);color:#ef4444;border-radius:6px;cursor:pointer;">
                                Delete Selected (<span id="ai-prep-delete-count">0</span>)
                            </button>
                        </div>
                        <div id="ai-prep-computed">
                            <p style="color:var(--text-muted);font-size:12px;">Loading…</p>
                        </div>
                    </div>

                    <!-- Password Confirmation Modal -->
                    <div id="ai-prep-delete-modal" style="display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);z-index:9999;align-items:center;justify-content:center;">
                        <div style="background:var(--bg-secondary, #1e293b);border:1px solid var(--border-color);border-radius:12px;padding:24px;width:380px;max-width:90vw;box-shadow:0 20px 60px rgba(0,0,0,0.4);">
                            <h3 style="margin:0 0 8px 0;font-size:16px;color:var(--text-primary);">Confirm Deletion</h3>
                            <p id="ai-prep-delete-modal-msg" style="margin:0 0 16px 0;font-size:13px;color:var(--text-secondary);"></p>
                            <div style="margin-bottom:16px;">
                                <label style="font-size:12px;color:var(--text-muted);display:block;margin-bottom:4px;">Enter your password to confirm</label>
                                <input type="password" id="ai-prep-delete-password" placeholder="Password"
                                    style="width:100%;padding:8px 12px;font-size:13px;background:var(--bg-tertiary, #0f172a);border:1px solid var(--border-color);border-radius:6px;color:var(--text-primary);box-sizing:border-box;">
                                <p id="ai-prep-delete-error" style="color:#ef4444;font-size:12px;margin:6px 0 0 0;display:none;"></p>
                            </div>
                            <div style="display:flex;gap:8px;justify-content:flex-end;">
                                <button id="ai-prep-delete-cancel" style="font-size:12px;padding:6px 14px;background:var(--bg-tertiary, #0f172a);border:1px solid var(--border-color);color:var(--text-primary);border-radius:6px;cursor:pointer;">Cancel</button>
                                <button id="ai-prep-delete-confirm" style="font-size:12px;padding:6px 14px;background:#ef4444;border:1px solid #dc2626;color:white;border-radius:6px;cursor:pointer;">Delete</button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;
        container.appendChild(wrapper);

        // Back button
        document.getElementById('ai-prep-back').addEventListener('click', () => showView('dashboard', { tab: 'datasets' }));

        // ---- State ----
        let probeData = null;
        let recipe = [];
        let sweepParamInfos = [];  // Sweep/DoE parameters for the summary bar

        // ---- Fetch dataset details for sweep parameters ----
        (async () => {
            try {
                const ds = await aiApi.get(`/ai/datasets/${dsId}`);
                if (!ds || ds.error) { console.warn('Sweep params: ds fetch error', ds); return; }

                const sweepParams = _safeParse(ds.sweep_parameters_json) || [];
                const casesData = _safeParse(ds.cases_json) || [];
                const numCases = casesData.length || ds.num_cases || 0;

                // Build parameter info from sweep_parameters_json
                // Format: [{"name":"Rotation Speed UDF","values":["40.0","46.7",...]}]
                if (Array.isArray(sweepParams)) {
                    for (const sp of sweepParams) {
                        const pname = typeof sp === 'string' ? sp : (sp.name || String(sp));
                        // Use pre-computed values if available, else extract from cases
                        let values = [];
                        if (sp.values && Array.isArray(sp.values)) {
                            values = sp.values;
                        } else {
                            for (const c of casesData) {
                                const pv = (c.parameters || {})[pname];
                                if (pv !== undefined) values.push(pv);
                            }
                        }
                        const uniqueVals = [...new Set(values.map(v => String(v)))];
                        const allNumeric = values.length > 0 && values.every(v => !isNaN(parseFloat(v)));
                        const varies = uniqueVals.length > 1;

                        let rangeStr = '';
                        if (allNumeric && uniqueVals.length > 0) {
                            const nums = uniqueVals.map(Number).sort((a,b) => a - b);
                            rangeStr = nums.length > 1 ? `${nums[0]} → ${nums[nums.length-1]}` : `${nums[0]}`;
                        } else if (uniqueVals.length > 0) {
                            rangeStr = uniqueVals.length <= 5 ? uniqueVals.join(', ') : `${uniqueVals.length} values`;
                        }

                        sweepParamInfos.push({ name: pname, values: uniqueVals, rangeStr, allNumeric, varies, count: uniqueVals.length });
                    }
                }

                // Render the sweep params bar
                const sweepEl = document.getElementById('ai-prep-sweep-params');
                if (!sweepEl) { console.warn('Sweep params: DOM element not found'); return; }

                if (sweepParamInfos.length > 0) {
                    sweepEl.style.display = '';
                    sweepEl.innerHTML = `
                        <div style="background:var(--bg-secondary, #1e293b);border:1px solid var(--border-color);border-radius:8px;padding:14px 16px;">
                            <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent-blue, #60a5fa)" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M4.93 4.93l4.24 4.24m5.66 5.66l4.24 4.24M19.07 4.93l-4.24 4.24m-5.66 5.66l-4.24 4.24M1 12h4m14 0h4M12 1v4m0 14v4"/></svg>
                                <span style="font-size:12px;font-weight:600;color:var(--text-primary);">
                                    Sweep / DoE Parameters
                                </span>
                                <span style="font-size:11px;color:var(--text-muted);margin-left:auto;">${numCases} cases</span>
                            </div>
                            <table style="width:100%;border-collapse:collapse;font-size:12px;">
                                <thead>
                                    <tr style="border-bottom:1px solid var(--border-color);">
                                        <th style="text-align:left;padding:4px 8px;font-weight:500;color:var(--text-secondary);font-size:11px;">Parameter</th>
                                        <th style="text-align:left;padding:4px 8px;font-weight:500;color:var(--text-secondary);font-size:11px;">Range</th>
                                        <th style="text-align:left;padding:4px 8px;font-weight:500;color:var(--text-secondary);font-size:11px;">Values</th>
                                        <th style="text-align:center;padding:4px 8px;font-weight:500;color:var(--text-secondary);font-size:11px;">Status</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${sweepParamInfos.map(p => {
                                        const statusBadge = p.varies
                                            ? '<span style="display:inline-block;padding:1px 6px;border-radius:4px;font-size:10px;background:rgba(34,197,94,0.15);color:#4ade80;">varies</span>'
                                            : '<span style="display:inline-block;padding:1px 6px;border-radius:4px;font-size:10px;background:rgba(250,204,21,0.15);color:#facc15;">constant</span>';
                                        const valuesStr = p.values.length <= 12
                                            ? p.values.join(', ')
                                            : p.values.slice(0, 10).join(', ') + ` … (+${p.values.length - 10})`;
                                        return `<tr style="border-bottom:1px solid rgba(255,255,255,0.03);">
                                            <td style="padding:5px 8px;font-weight:500;color:var(--text-primary);">${escHtml(p.name)}</td>
                                            <td style="padding:5px 8px;color:var(--accent-blue, #60a5fa);font-family:monospace;">${escHtml(p.rangeStr)}</td>
                                            <td style="padding:5px 8px;color:var(--text-muted);font-family:monospace;font-size:11px;">${escHtml(valuesStr)}</td>
                                            <td style="padding:5px 8px;text-align:center;">${statusBadge}</td>
                                        </tr>`;
                                    }).join('')}
                                </tbody>
                            </table>
                        </div>`;
                } else {
                    sweepEl.style.display = 'none';
                }
            } catch (e) {
                console.warn('Failed to load sweep params:', e);
            }
        })();

        // All available computation methods — must match prepare.py's _compute_field dispatch
        const METHODS = {
            time_average:       { label: 'Time Average',       desc: 'Arithmetic mean of field values across output files. "Last N" uses the tail end; "All Files" uses every output for a cumulative mean. Vectors are averaged component-wise.',  for: 'source' },
            solver_average:     { label: 'Solver Average',     desc: 'M-Star solver-computed running mean (Mean Trim). Averages over every solver substep, more accurate than time average.', for: 'source' },
            identity:           { label: 'Last Timestep',      desc: 'Raw field value from the final output file. No averaging.',                                      for: 'source' },
            binary_mask:        { label: 'Binary Mask',        desc: 'Applies a threshold to a scalar field to produce a 0/1 mask (e.g., Volume Fraction > 0.01 → fluid mask).', for: 'source_scalar' },
            edt:                { label: 'Distance (EDT)',     desc: 'Euclidean distance transform from a binary mask boundary. Computes how far each cell is from the nearest wall. Requires a mask field as input.', for: 'source_scalar' },
            sdf:                { label: 'Signed Distance (SDF)', desc: 'Signed distance function: positive in fluid, negative in solid. Smoother than binary masks. Uses EDT internally with sign flip at the boundary.', for: 'source_scalar' },
            vorticity:          { label: 'Vorticity',          desc: 'Curl of velocity (|∂v/∂x − ∂u/∂y|). Measures local rotation rate. Requires a vector velocity source field.', for: 'source_vector' },
            coordinates:        { label: 'Normalize [-1, 1]',  desc: 'Generates a coordinate grid with values normalized from -1 to 1 across the grid dimension. Based on pixel index, not physical position.', for: 'synthetic' },
            custom_expression:  { label: 'Custom Expression',  desc: 'User-defined numpy expression. Variables: field_<name> (loaded fields), x/y/z (coordinate grids), mask, np. Example: np.sqrt(field_vx**2 + field_vy**2)', for: 'source' },
        };

        // ---- Probe the dataset ----
        async function runProbe() {
            try {
                const res = await aiApi.post(`/ai/datasets/${dsId}/probe`, {});
                probeData = res?.probe || null;
                renderProbeResults();
            } catch (e) {
                const el = document.getElementById('ai-probe-results');
                if (el) el.innerHTML = `<div style="padding:12px;color:var(--accent-red);font-size:13px;">Probe failed: ${escHtml(e.message || 'Unknown error')}</div>`;
            }
        }

        // ---- Render discovered fields (deduplicated across PVDs) ----
        function renderProbeResults() {
            const el = document.getElementById('ai-probe-results');
            if (!el || !probeData) return;

            const sources = probeData.pvd_sources || [];
            const fluidSources = sources.filter(s => s.type === 'fluid_slice' || s.type === 'fluid_volume');

            if (fluidSources.length === 0) {
                el.innerHTML = '<p style="color:var(--text-muted);font-size:13px;">No fluid fields found in the output.</p>';
                return;
            }

            // Deduplicate fields across PVDs — same field name appears in multiple PVDs
            // Build a unique field list with which PVDs contain them
            const fieldMap = new Map(); // fieldName -> { field, pvds: [{name, type, timesteps, hasSolverAvg}] }
            for (const src of fluidSources) {
                const hasSolverAvg = src.solver_averages?.has_solver_averages || false;
                for (const field of (src.fields || [])) {
                    if (!fieldMap.has(field.name)) {
                        fieldMap.set(field.name, { field, pvds: [] });
                    }
                    fieldMap.get(field.name).pvds.push({
                        name: src.pvd_name,
                        type: src.type,
                        timesteps: src.timesteps,
                        hasSolverAvg,
                        solverMapping: src.solver_averages?.field_mapping || {},
                    });
                }
            }

            let html = '';

            // Show PVD summary at top
            html += `<div style="margin-bottom:12px;padding:8px 10px;border-radius:6px;background:var(--bg-tertiary);font-size:11px;color:var(--text-muted);">
                <strong style="color:var(--text-secondary);">Sources:</strong> `;
            html += fluidSources.map(s => {
                const label = s.type === 'fluid_volume' ? 'Volume' : s.pvd_name.replace('.pvd','');
                return `<code style="padding:0 4px;">${escHtml(label)}</code> (${s.timesteps} ts)`;
            }).join(' · ');
            html += `</div>`;

            // Render each unique field
            for (const [fieldName, entry] of fieldMap) {
                const { field, pvds } = entry;
                const compLabel = field.components > 1 ? `${field.components}-component` : 'scalar';
                const anySolverAvg = pvds.some(p => p.hasSolverAvg && p.solverMapping[fieldName]);

                // Check if already added to recipe (any PVD)
                const alreadyAdded = recipe.some(r => r.source_field === fieldName);

                // Default PVD: pick the first slice (more common for 2D training)
                const defaultPvd = pvds.find(p => p.type === 'fluid_slice') || pvds[0];
                const defaultMethod = (anySolverAvg && defaultPvd.solverMapping?.[fieldName]) ? 'solver_average' : 'time_average';

                html += `<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:6px;border:1px solid var(--border-color);margin-bottom:4px;background:var(--bg-secondary);${alreadyAdded ? 'opacity:0.4;' : ''}">
                    <button class="btn btn-secondary ai-add-field-btn" data-field="${escHtml(fieldName)}" data-pvd="${escHtml(defaultPvd.name)}" data-method="${defaultMethod}" data-components="${field.components}" data-pvd-options='${escHtml(JSON.stringify(pvds.map(p => p.name)))}'
                        ${alreadyAdded ? 'disabled' : ''} style="font-size:11px;padding:3px 10px;min-width:42px;${alreadyAdded ? 'cursor:default;' : ''}">
                        ${alreadyAdded ? 'Added' : 'Add'}
                    </button>
                    <div style="flex:1;min-width:0;">
                        <div style="font-size:13px;font-weight:500;">${escHtml(fieldName)}</div>
                        <div style="font-size:10px;color:var(--text-muted);">${compLabel}${anySolverAvg ? ' · solver averages available' : ''}</div>
                    </div>
                </div>`;
            }

            // Other PVDs (collapsed)
            const otherSources = sources.filter(s => s.type !== 'fluid_slice' && s.type !== 'fluid_volume');
            if (otherSources.length > 0) {
                html += `<details style="margin-top:10px;"><summary style="cursor:pointer;font-size:12px;color:var(--text-muted);user-select:none;">Other PVDs (${otherSources.length})</summary>
                <div style="margin-top:6px;">`;
                for (const src of otherSources) {
                    html += `<div style="display:flex;align-items:center;gap:6px;padding:3px 0;">
                        <code style="font-size:11px;background:var(--bg-tertiary);padding:1px 6px;border-radius:4px;">${escHtml(src.pvd_name)}</code>
                        <span style="font-size:10px;color:var(--text-muted);">${src.type} · ${src.timesteps} ts · ${(src.fields||[]).length} fields</span>
                    </div>`;
                }
                html += `</div></details>`;
            }

            el.innerHTML = html;

            // Wire "Add" buttons
            el.querySelectorAll('.ai-add-field-btn:not([disabled])').forEach(btn => {
                btn.addEventListener('click', () => {
                    const fieldName = btn.dataset.field;
                    const pvdName = btn.dataset.pvd;
                    const defaultMethod = btn.dataset.method;
                    const components = parseInt(btn.dataset.components, 10) || 1;
                    let pvdOptions = [];
                    try { pvdOptions = JSON.parse(btn.dataset.pvdOptions || '[]'); } catch {}

                    let shortName = fieldName
                        .replace(/\s*\([^)]*\)\s*/g, '')
                        .replace(/\s+/g, '_')
                        .toLowerCase();

                    recipe.push({
                        name: shortName,
                        display_name: fieldName,
                        method: defaultMethod,
                        source_field: fieldName,
                        source_pvd: pvdName,
                        pvd_options: pvdOptions,
                        components: components,
                        is_synthetic: false,
                        params: defaultMethod === 'binary_mask'
                            ? { operator: 'gt', threshold: 0.5 }
                            : defaultMethod === 'time_average'
                            ? { n_files: 10, averaging_mode: 'last_n' }
                            : {},
                    });

                    renderRecipe();
                    renderProbeResults();
                });
            });
        }

        // ---- Render the recipe list (right panel) ----
        function renderRecipe() {
            const el = document.getElementById('ai-prep-recipe-list');
            if (!el) return;

            if (recipe.length === 0) {
                el.innerHTML = '<p style="color:var(--text-muted);font-size:13px;font-style:italic;">No fields added yet.</p>';
                document.getElementById('ai-prep-compute').disabled = true;
                return;
            }

            document.getElementById('ai-prep-compute').disabled = false;

            el.innerHTML = recipe.map((entry, idx) => {
                // Build method dropdown — filter based on entry type and method.for tag
                const isSource = !!entry.source_field;
                const isScalar = entry.components <= 1;
                const isVector = entry.components > 1;

                const methodOptions = Object.entries(METHODS).map(([key, m]) => {
                    const mFor = m.for || 'source';

                    // Synthetic methods only for non-source entries
                    if (mFor === 'synthetic' && isSource) return '';
                    if (mFor !== 'synthetic' && !isSource) return '';

                    // Scalar-only methods
                    if (mFor === 'source_scalar' && isVector) return '';
                    // Vector-only methods
                    if (mFor === 'source_vector' && isScalar) return '';

                    // solver_average only if PVD has solver averages
                    if (key === 'solver_average') {
                        const src = (probeData?.pvd_sources || []).find(s => s.pvd_name === entry.source_pvd);
                        if (!src?.solver_averages?.has_solver_averages) return '';
                    }

                    const selected = key === entry.method ? 'selected' : '';
                    return `<option value="${key}" ${selected}>${escHtml(m.label)}</option>`;
                }).filter(Boolean).join('');

                const methodInfo = METHODS[entry.method] || {};

                // Source line — only for fields that have a source
                let sourceLine = '';
                if (entry.source_field) {
                    let pvdSelector = '';
                    if (entry.pvd_options && entry.pvd_options.length > 1) {
                        const pvdOpts = entry.pvd_options.map(p => {
                            const sel = p === entry.source_pvd ? 'selected' : '';
                            const label = p.replace('.pvd', '');
                            return `<option value="${escHtml(p)}" ${sel}>${escHtml(label)}</option>`;
                        }).join('');
                        pvdSelector = `<select data-idx="${idx}" data-role="pvd" style="font-size:10px;padding:1px 4px;background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:4px;color:var(--text-primary);">${pvdOpts}</select>`;
                    } else {
                        const pvdLabel = (entry.source_pvd || '').replace('.pvd', '');
                        pvdSelector = `<code style="background:var(--bg-tertiary);padding:0 4px;border-radius:3px;font-size:10px;">${escHtml(pvdLabel)}</code>`;
                    }
                    sourceLine = `<div style="font-size:10px;color:var(--text-muted);margin-bottom:4px;display:flex;align-items:center;gap:4px;">
                        Input: <code style="background:var(--bg-tertiary);padding:0 4px;border-radius:3px;">${escHtml(entry.source_field)}</code>
                        from ${pvdSelector}
                    </div>`;
                }

                // Binary mask params
                let extraParams = '';
                if (entry.method === 'binary_mask') {
                    const thresh = entry.params?.threshold ?? 0.5;
                    const op = entry.params?.operator ?? 'gt';
                    extraParams = `
                        <div style="display:flex;gap:4px;align-items:center;margin-top:4px;">
                            <span style="font-size:10px;color:var(--text-muted);">Threshold:</span>
                            <select data-idx="${idx}" data-param="operator" style="font-size:11px;padding:1px 4px;background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:4px;color:var(--text-primary);">
                                <option value="gt" ${op==='gt'?'selected':''}>&gt;</option>
                                <option value="lt" ${op==='lt'?'selected':''}>&lt;</option>
                                <option value="gte" ${op==='gte'?'selected':''}>≥</option>
                                <option value="lte" ${op==='lte'?'selected':''}>≤</option>
                            </select>
                            <input type="number" step="any" value="${thresh}" data-idx="${idx}" data-param="threshold"
                                style="width:60px;font-size:11px;padding:1px 4px;background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:4px;color:var(--text-primary);">
                        </div>`;
                }

                // Custom expression params
                if (entry.method === 'custom_expression') {
                    const expr = entry.params?.expression || '';
                    extraParams += `
                        <div style="margin-top:4px;display:flex;align-items:center;gap:6px;">
                            <span style="font-size:10px;color:var(--text-muted);">Expr:</span>
                            <input type="text" value="${escHtml(expr)}" data-idx="${idx}" data-param="expression"
                                placeholder="np.sqrt(field_vx**2 + field_vy**2)"
                                style="flex:1;font-size:11px;padding:2px 6px;background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:4px;color:var(--text-primary);font-family:monospace;">
                        </div>`;
                }

                // Time average params
                if (entry.method === 'time_average') {
                    const avgMode = entry.params?.averaging_mode ?? 'last_n';
                    const nFiles = entry.params?.n_files ?? 10;
                    extraParams += `
                        <div style="display:flex;gap:6px;align-items:center;margin-top:4px;">
                            <span style="font-size:10px;color:var(--text-muted);">Mode</span>
                            <select data-idx="${idx}" data-param="averaging_mode"
                                style="font-size:11px;padding:1px 4px;background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:4px;color:var(--text-primary);">
                                <option value="last_n" ${avgMode === 'last_n' ? 'selected' : ''}>Last N files</option>
                                <option value="all" ${avgMode === 'all' ? 'selected' : ''}>All files (cumulative)</option>
                            </select>
                        </div>`;
                    if (avgMode === 'last_n') {
                        extraParams += `
                        <div style="display:flex;gap:6px;align-items:center;margin-top:4px;">
                            <span style="font-size:10px;color:var(--text-muted);">Average last</span>
                            <input type="number" min="1" step="1" value="${nFiles}" data-idx="${idx}" data-param="n_files"
                                style="width:50px;font-size:11px;padding:1px 4px;background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:4px;color:var(--text-primary);">
                            <span style="font-size:10px;color:var(--text-muted);">output files</span>
                        </div>`;
                    }
                }

                // EDT / SDF params — need to know which mask to compute distance from
                if (entry.method === 'edt' || entry.method === 'sdf') {
                    const srcMask = entry.params?.source_mask || 'fluid_mask';
                    // Find candidate mask fields from the recipe
                    const maskCandidates = recipe
                        .filter(r => r.method === 'binary_mask')
                        .map(r => r.name);
                    let maskSelector;
                    if (maskCandidates.length > 0) {
                        const opts = maskCandidates.map(m => {
                            const sel = m === srcMask ? 'selected' : '';
                            return `<option value="${escHtml(m)}" ${sel}>${escHtml(m)}</option>`;
                        }).join('');
                        maskSelector = `<select data-idx="${idx}" data-param="source_mask" style="font-size:11px;padding:1px 4px;background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:4px;color:var(--text-primary);">${opts}</select>`;
                    } else {
                        maskSelector = `<input type="text" value="${escHtml(srcMask)}" data-idx="${idx}" data-param="source_mask" placeholder="fluid_mask"
                            style="width:100px;font-size:11px;padding:1px 4px;background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:4px;color:var(--text-primary);">`;
                    }
                    extraParams += `
                        <div style="display:flex;gap:6px;align-items:center;margin-top:4px;">
                            <span style="font-size:10px;color:var(--text-muted);">From mask:</span>
                            ${maskSelector}
                        </div>`;
                }

                return `
                <div style="display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border-radius:8px;border:1px solid var(--border-color);background:var(--bg-secondary);">
                    <div style="flex:1;min-width:0;">
                        <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px;">
                            <input type="text" value="${escHtml(entry.name)}" data-idx="${idx}" data-role="name"
                                style="font-size:12px;font-weight:600;background:transparent;border:1px solid transparent;border-radius:4px;padding:1px 4px;color:var(--text-primary);width:100%;max-width:220px;"
                                title="Output field name">
                        </div>
                        ${sourceLine}
                        <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px;">
                            <span style="font-size:10px;color:var(--text-muted);">Method:</span>
                            <select data-idx="${idx}" data-role="method"
                                style="font-size:11px;padding:2px 6px;background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:4px;color:var(--text-primary);">
                                ${methodOptions}
                            </select>
                        </div>
                        <div style="font-size:10px;color:var(--text-muted);padding:3px 6px;background:var(--bg-tertiary);border-radius:4px;line-height:1.4;">
                            ${escHtml(methodInfo.desc || '')}
                        </div>
                        ${extraParams}
                    </div>
                    <button class="btn-icon ai-recipe-remove" data-idx="${idx}" title="Remove" style="color:var(--accent-red);font-size:14px;padding:2px 6px;cursor:pointer;background:none;border:none;">✕</button>
                </div>`;
            }).join('');

            // Wire name editing
            el.querySelectorAll('input[data-role="name"]').forEach(input => {
                input.addEventListener('change', e => {
                    const idx = parseInt(e.target.dataset.idx, 10);
                    if (recipe[idx]) recipe[idx].name = e.target.value.trim().replace(/[^a-zA-Z0-9_-]/g, '_');
                    renderRecipe();
                });
            });

            // Wire method changes
            el.querySelectorAll('select[data-role="method"]').forEach(sel => {
                sel.addEventListener('change', e => {
                    const idx = parseInt(e.target.dataset.idx, 10);
                    if (!recipe[idx]) return;
                    const newMethod = e.target.value;
                    recipe[idx].method = newMethod;
                    // Initialize default params for each method
                    if (newMethod === 'binary_mask') {
                        recipe[idx].params = { operator: 'gt', threshold: 0.5 };
                    } else if (newMethod === 'time_average') {
                        recipe[idx].params = { n_files: 10, averaging_mode: 'last_n' };
                    } else if (newMethod === 'custom_expression') {
                        recipe[idx].params = { expression: '' };
                    } else if (newMethod === 'edt' || newMethod === 'sdf') {
                        recipe[idx].params = { source_mask: 'fluid_mask' };
                    } else {
                        recipe[idx].params = {};
                    }
                    renderRecipe();
                });
            });

            // Wire PVD source changes
            el.querySelectorAll('select[data-role="pvd"]').forEach(sel => {
                sel.addEventListener('change', e => {
                    const idx = parseInt(e.target.dataset.idx, 10);
                    if (recipe[idx]) recipe[idx].source_pvd = e.target.value;
                });
            });

            // Wire param changes
            el.querySelectorAll('select[data-param], input[data-param]').forEach(ctrl => {
                ctrl.addEventListener('change', e => {
                    const idx = parseInt(e.target.dataset.idx, 10);
                    const param = e.target.dataset.param;
                    if (!recipe[idx]) return;
                    if (!recipe[idx].params) recipe[idx].params = {};
                    const numericParams = ['threshold', 'n_files'];
                    if (numericParams.includes(param)) {
                        recipe[idx].params[param] = param === 'n_files' ? parseInt(e.target.value, 10) : parseFloat(e.target.value);
                    } else {
                        recipe[idx].params[param] = e.target.value;
                    }
                    // Re-render if averaging_mode changed (controls n_files visibility)
                    if (param === 'averaging_mode') renderRecipe();
                });
            });

            // Wire remove buttons
            el.querySelectorAll('.ai-recipe-remove').forEach(btn => {
                btn.addEventListener('click', () => {
                    const idx = parseInt(btn.dataset.idx, 10);
                    recipe.splice(idx, 1);
                    renderRecipe();
                    renderProbeResults();
                });
            });
        }

        // ---- Synthetic field buttons ----
        document.getElementById('ai-prep-synthetic-btns').querySelectorAll('button').forEach(btn => {
            btn.addEventListener('click', () => {
                const synth = btn.dataset.synth;
                if (!synth) return;

                if (synth.startsWith('coordinates_')) {
                    const axis = synth.split('_')[1];
                    if (recipe.some(r => r.name === `coord_${axis}`)) {
                        showToast(`${axis.toUpperCase()} coordinate already in recipe`, 'info');
                        return;
                    }
                    recipe.push({
                        name: `coord_${axis}`,
                        display_name: `${axis.toUpperCase()} Coordinate Grid [-1, 1]`,
                        method: 'coordinates',
                        source_field: null,
                        source_pvd: null,
                        components: 1,
                        is_synthetic: true,
                        params: { axis },
                    });
                }
                renderRecipe();
            });
        });

        // ---- Load existing computed fields ----
        let selectedForDelete = new Set();

        function updateDeleteButton() {
            const btn = document.getElementById('ai-prep-delete-selected');
            const countEl = document.getElementById('ai-prep-delete-count');
            if (!btn) return;
            if (selectedForDelete.size > 0) {
                btn.style.display = 'inline-block';
                countEl.textContent = selectedForDelete.size;
            } else {
                btn.style.display = 'none';
            }
        }

        async function loadComputedFields() {
            try {
                const res = await aiApi.get(`/ai/datasets/${dsId}/derived-fields`);
                const computedEl = document.getElementById('ai-prep-computed');
                if (!computedEl) return;

                const fields = res?.fields || [];
                selectedForDelete.clear();
                updateDeleteButton();

                if (fields.length === 0) {
                    computedEl.innerHTML = '<p style="color:var(--text-muted);font-size:12px;">No fields computed yet.</p>';
                    return;
                }

                computedEl.innerHTML = fields.map(f => {
                    const r = f.recipe || {};
                    const displayName = r.display_name || f.field_name;
                    const method = r.method || '?';
                    const methodLabel = METHODS[method]?.label || method;
                    const fieldId = f.field_name;
                    // Provenance: show which source field & PVD this was derived from
                    const source = r.source || {};
                    const sourceField = source.source_field || source.field_name || '';
                    const sourcePvd = source.source_pvd || source.pvd_name || '';
                    let provenanceParts = [];
                    provenanceParts.push(`${f.case_count} cases`);
                    provenanceParts.push(escHtml(methodLabel));
                    if (sourceField) provenanceParts.push(`of ${escHtml(sourceField)}`);
                    if (sourcePvd && sourcePvd !== 'auto' && sourcePvd !== 'unknown') provenanceParts.push(`from ${escHtml(sourcePvd)}`);
                    const provenanceStr = provenanceParts.join(' · ');
                    return `
                        <div style="display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:6px;background:rgba(16,185,129,0.06);border:1px solid rgba(16,185,129,0.12);margin-bottom:4px;cursor:pointer;" data-delete-field="${escHtml(fieldId)}">
                            <input type="checkbox" class="ai-delete-check" data-field="${escHtml(fieldId)}"
                                style="accent-color:#ef4444;cursor:pointer;flex-shrink:0;">
                            <span style="color:#10b981;font-size:12px;">●</span>
                            <div style="flex:1;min-width:0;">
                                <div style="font-size:12px;font-weight:500;">${escHtml(displayName)}</div>
                                <div style="font-size:10px;color:var(--text-muted);">${provenanceStr}</div>
                            </div>
                        </div>`;
                }).join('');

                // Wire checkboxes
                computedEl.querySelectorAll('.ai-delete-check').forEach(cb => {
                    cb.addEventListener('change', e => {
                        e.stopPropagation();
                        const field = cb.dataset.field;
                        if (cb.checked) {
                            selectedForDelete.add(field);
                        } else {
                            selectedForDelete.delete(field);
                        }
                        updateDeleteButton();
                    });
                });

                // Click row to toggle checkbox
                computedEl.querySelectorAll('[data-delete-field]').forEach(row => {
                    row.addEventListener('click', e => {
                        if (e.target.tagName === 'INPUT') return;
                        const cb = row.querySelector('.ai-delete-check');
                        if (cb) {
                            cb.checked = !cb.checked;
                            cb.dispatchEvent(new Event('change'));
                        }
                    });
                });
            } catch (e) {
                console.warn('[Prepare] Failed to load derived fields:', e);
            }
        }
        // ---- Delete modal wiring ----
        document.getElementById('ai-prep-delete-selected').addEventListener('click', () => {
            if (selectedForDelete.size === 0) return;
            const modal = document.getElementById('ai-prep-delete-modal');
            const msg = document.getElementById('ai-prep-delete-modal-msg');
            const errEl = document.getElementById('ai-prep-delete-error');
            const pwdInput = document.getElementById('ai-prep-delete-password');

            msg.textContent = `This will permanently delete ${selectedForDelete.size} computed field${selectedForDelete.size > 1 ? 's' : ''} and all cached data for every case. This cannot be undone.`;
            errEl.style.display = 'none';
            pwdInput.value = '';
            modal.style.display = 'flex';
            setTimeout(() => pwdInput.focus(), 100);
        });

        document.getElementById('ai-prep-delete-cancel').addEventListener('click', () => {
            document.getElementById('ai-prep-delete-modal').style.display = 'none';
        });

        // Click outside modal to close
        document.getElementById('ai-prep-delete-modal').addEventListener('click', e => {
            if (e.target === e.currentTarget) {
                e.currentTarget.style.display = 'none';
            }
        });

        // Enter key in password field triggers confirm
        document.getElementById('ai-prep-delete-password').addEventListener('keydown', e => {
            if (e.key === 'Enter') {
                document.getElementById('ai-prep-delete-confirm').click();
            }
        });

        document.getElementById('ai-prep-delete-confirm').addEventListener('click', async () => {
            const password = document.getElementById('ai-prep-delete-password').value;
            const errEl = document.getElementById('ai-prep-delete-error');
            const confirmBtn = document.getElementById('ai-prep-delete-confirm');

            if (!password) {
                errEl.textContent = 'Password is required';
                errEl.style.display = 'block';
                return;
            }

            confirmBtn.disabled = true;
            confirmBtn.textContent = 'Deleting…';
            errEl.style.display = 'none';

            try {
                const res = await aiApi.post(`/ai/field-ops/delete/${dsId}`, {
                    field_names: Array.from(selectedForDelete),
                    password: password,
                });

                if (res?.error) {
                    errEl.textContent = res.error;
                    errEl.style.display = 'block';
                    return;
                }

                // Success — close modal and refresh
                document.getElementById('ai-prep-delete-modal').style.display = 'none';
                selectedForDelete.clear();
                updateDeleteButton();
                loadComputedFields();

                if (res?.deleted_count > 0) {
                    console.log(`[Prepare] Deleted ${res.deleted_count} field(s)`);
                }
                if (res?.errors?.length > 0) {
                    console.warn('[Prepare] Some deletions failed:', res.errors);
                }
            } catch (e) {
                errEl.textContent = e.message || 'Delete failed';
                errEl.style.display = 'block';
            } finally {
                confirmBtn.disabled = false;
                confirmBtn.textContent = 'Delete';
            }
        });

        // ---- Compute button ----
        document.getElementById('ai-prep-compute').addEventListener('click', async () => {
            if (recipe.length === 0) return;

            const payload = {
                fields: recipe.map(entry => {
                    const f = {
                        name: entry.name,
                        display_name: entry.display_name,
                        method: entry.method,
                    };
                    if (entry.source_field) f.source_field = entry.source_field;
                    if (entry.source_pvd) f.source_pvd = entry.source_pvd;
                    if (entry.params && Object.keys(entry.params).length > 0) f.params = entry.params;
                    return f;
                }),
            };

            const statusEl = document.getElementById('ai-prep-status');
            statusEl.style.display = 'block';
            statusEl.innerHTML = `
                <div style="display:flex;align-items:center;gap:8px;padding:10px;border-radius:8px;background:rgba(6,182,212,0.08);border:1px solid rgba(6,182,212,0.2);">
                    <div class="spinner" style="width:14px;height:14px;"></div>
                    <span style="color:var(--accent-cyan);font-size:12px;">Starting preparation…</span>
                </div>`;

            const computeBtn = document.getElementById('ai-prep-compute');
            computeBtn.disabled = true;
            computeBtn.textContent = 'Computing…';

            // Helper to format seconds as human-readable
            const fmtTime = (s) => {
                if (s < 60) return `${Math.round(s)}s`;
                const m = Math.floor(s / 60);
                const sec = Math.round(s % 60);
                return sec > 0 ? `${m}m ${sec}s` : `${m}m`;
            };

            try {
                const res = await aiApi.post(`/ai/datasets/${dsId}/prepare`, payload);
                if (res?.error) {
                    statusEl.innerHTML = `<div style="padding:10px;border-radius:8px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);color:var(--accent-red);font-size:12px;">Error: ${escHtml(res.error)}</div>`;
                    computeBtn.disabled = false;
                    computeBtn.textContent = 'Compute';
                    return;
                }

                const pollPrepare = setInterval(async () => {
                    try {
                        // Poll both dataset status AND progress
                        const [dsRes, dfRes] = await Promise.all([
                            aiApi.get(`/ai/datasets/${dsId}`),
                            aiApi.get(`/ai/datasets/${dsId}/derived-fields`),
                        ]);
                        const ds = dsRes?.dataset || dsRes;
                        const progress = dfRes?.progress;

                        // Update progress display
                        if (progress && progress.status !== 'complete') {
                            const pct = progress.percent || 0;
                            const cur = progress.current || 0;
                            const tot = progress.total || 1;
                            const fieldName = progress.field_name || '';
                            const caseName = progress.case_name || '';
                            const elapsed = progress.elapsed_seconds || 0;
                            const eta = progress.eta_seconds || 0;
                            const perCase = progress.per_case_seconds || 0;
                            const computed = progress.computed || 0;
                            const cached = progress.cached || 0;
                            const failed = progress.failed || 0;
                            const statusText = progress.status === 'computing'
                                ? `Computing <b>${escHtml(caseName)}</b>…`
                                : `Case ${cur}/${tot}`;

                            statusEl.innerHTML = `
                                <div style="padding:12px;border-radius:8px;background:rgba(6,182,212,0.08);border:1px solid rgba(6,182,212,0.2);">
                                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                                        <span style="color:var(--accent-cyan);font-size:12px;font-weight:600;">
                                            Computing: ${escHtml(fieldName)}
                                        </span>
                                        <span style="color:var(--text-muted);font-size:11px;">
                                            ${fmtTime(elapsed)} elapsed · ~${fmtTime(eta)} remaining
                                        </span>
                                    </div>
                                    <div style="background:rgba(255,255,255,0.06);border-radius:4px;height:6px;overflow:hidden;margin-bottom:6px;">
                                        <div style="background:var(--accent-cyan);height:100%;width:${pct}%;border-radius:4px;transition:width 0.3s ease;"></div>
                                    </div>
                                    <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-muted);">
                                        <span>${statusText}</span>
                                        <span>${cur}/${tot} cases · ${fmtTime(perCase)}/case</span>
                                    </div>
                                    ${failed > 0 ? `<div style="margin-top:4px;font-size:11px;color:var(--accent-red);">⚠ ${failed} case(s) failed</div>` : ''}
                                </div>`;
                            computeBtn.textContent = `Computing… ${Math.round(pct)}%`;
                        }

                        if (!ds) return;
                        if (ds.status === 'prepared') {
                            clearInterval(pollPrepare);
                            statusEl.innerHTML = `
                                <div style="padding:10px;border-radius:8px;background:rgba(16,185,129,0.08);border:1px solid rgba(16,185,129,0.2);color:#10b981;font-size:12px;">
                                    Done. Fields are ready and viewable in the PVD Viewer.
                                </div>`;
                            computeBtn.disabled = false;
                            computeBtn.textContent = 'Compute';
                            loadComputedFields();
                        } else if (ds.status === 'error') {
                            clearInterval(pollPrepare);
                            statusEl.innerHTML = `<div style="padding:10px;border-radius:8px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);color:var(--accent-red);font-size:12px;">Preparation failed.</div>`;
                            computeBtn.disabled = false;
                            computeBtn.textContent = 'Compute';
                        }
                    } catch { /* ignore poll errors */ }
                }, 3000);
            } catch (e) {
                statusEl.innerHTML = `<div style="padding:10px;border-radius:8px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);color:var(--accent-red);font-size:12px;">Error: ${escHtml(e.message || 'Unknown')}</div>`;
                computeBtn.disabled = false;
                computeBtn.textContent = 'Compute';
            }
        });

        // ---- Initialize ----
        runProbe();
        loadComputedFields();
    }

    // ---- Initial render ----
    showView('dashboard');
}
