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
        };
        const c = colors[status] || 'var(--text-muted)';
        const isAnimated = status === 'running' || status === 'preflight' || status === 'launching' || status === 'scanning';
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
    function showView(view) {
        currentView = view;
        if (view === 'dashboard') renderDashboard();
        else if (view === 'create-dataset') renderCreateDataset();
        else if (view === 'new-training') renderNewTraining();
    }

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
                <div class="ai-tab active" data-panel="datasets">Datasets</div>
                <div class="ai-tab" data-panel="training-jobs">Training Jobs</div>
            </div>

            <div class="ai-panel active" id="panel-datasets">
                <div class="card"><div id="ai-datasets-table"></div></div>
            </div>

            <div class="ai-panel" id="panel-training-jobs">
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
                                <td>
                                    <button class="btn btn-secondary" style="padding:4px 10px;font-size:11px;" onclick="event.stopPropagation(); window._aiShowDatasetDetail && window._aiShowDatasetDetail(${ds.id})">
                                        View
                                    </button>
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
                    <button class="ai-ds-tab active" data-tab="stats" style="padding:10px 16px;background:none;border:none;color:var(--text-primary);cursor:pointer;border-bottom:2px solid transparent;font-size:13px;font-weight:500;">
                        📊 Stats (${physicsStats.length})
                    </button>
                    <button class="ai-ds-tab" data-tab="slices2d" style="padding:10px 16px;background:none;border:none;color:var(--text-muted);cursor:pointer;border-bottom:2px solid transparent;font-size:13px;font-weight:500;">
                        🔲 2D Slices (${slices2d.length})
                    </button>
                    <button class="ai-ds-tab" data-tab="volumes3d" style="padding:10px 16px;background:none;border:none;color:var(--text-muted);cursor:pointer;border-bottom:2px solid transparent;font-size:13px;font-weight:500;">
                        📦 3D / Bodies (${volumes3d.length + slicesBody.length})
                    </button>
                    <button class="ai-ds-tab" data-tab="cases" style="padding:10px 16px;background:none;border:none;color:var(--text-muted);cursor:pointer;border-bottom:2px solid transparent;font-size:13px;font-weight:500;">
                        📁 Cases (${cases.length})
                    </button>
                    <button class="ai-ds-tab" data-tab="matrix" style="padding:10px 16px;background:none;border:none;color:var(--text-muted);cursor:pointer;border-bottom:2px solid transparent;font-size:13px;font-weight:500;">
                        🔀 Consistency
                    </button>
                </div>

                <div id="ai-ds-tab-content" style="padding:16px;">
                    ${renderStatsTab(physicsStats, numCases, casesWithOutput)}
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
                    case 'stats': content.innerHTML = renderStatsTab(physicsStats, numCases, casesWithOutput); break;
                    case 'slices2d': content.innerHTML = renderSlices2dTab(slices2d, numCases, casesWithOutput); break;
                    case 'volumes3d': content.innerHTML = renderVolumes3dTab(volumes3d, slicesBody, numCases, casesWithOutput); break;
                    case 'cases': content.innerHTML = renderCasesTab(cases, physicsStats, pvd); break;
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
        el.querySelector('#ai-ds-back').addEventListener('click', () => showView('dashboard'));

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

    function renderCasesTab(cases, physicsStats, pvd) {
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

        return `
            <div class="table-container">
                <table class="data-table" style="font-size:12px;">
                    <thead><tr>
                        <th>Case Name</th><th>Status</th><th>Time Range</th><th>Stats</th><th>2D</th><th>3D</th><th>Completeness</th><th>Directory</th>
                    </tr></thead>
                    <tbody>
                        ${cases.map(c => {
                            const timeStr = fmtTimeRange(c.time_range);
                            const statsCount = (c.stats_files || []).length;
                            const pvdCats = c.pvd_categories || {};
                            const sliceCount = (pvdCats.slices_2d || 0) + (pvdCats.other || 0);
                            const volCount = (pvdCats.volumes_3d || 0) + (pvdCats.slices_body || 0);

                            // Completeness: does this case have all common stats and PVDs?
                            const hasAllStats = statsCount >= totalStats;
                            const hasAllPvds = sliceCount + volCount >= totalPvds;
                            let completeness = '—';
                            if (c.status === 'scanned') {
                                if (hasAllStats && hasAllPvds) completeness = '<span style="color:#22c55e;" title="All data present">✓ Complete</span>';
                                else completeness = `<span style="color:#f59e0b;" title="Some data missing">⚠ Partial</span>`;
                            }

                            return `
                            <tr>
                                <td style="font-weight:500;">${escHtml(c.name)}</td>
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
                        <th>ID</th><th>Run Name</th><th>Model</th><th>Dataset</th><th>GPUs</th><th>Status</th><th>Submitted</th><th>Actions</th>
                    </tr></thead>
                    <tbody>
                        ${jobs.map(j => {
                            const gpuDisplay = j.gpu_ids ? formatGpuList(j.gpu_ids) : 'auto';
                            const isActive = ['queued', 'running', 'preflight', 'launching'].includes(j.status);
                            const elapsed = j.started_at && !j.completed_at
                                ? formatDuration((Date.now() - new Date(j.started_at + 'Z').getTime()) / 1000)
                                : (j.started_at && j.completed_at
                                    ? formatDuration((new Date(j.completed_at + 'Z') - new Date(j.started_at + 'Z')) / 1000)
                                    : '');
                            return `
                            <tr>
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
                                <td>
                                    ${isActive ? `<button class="btn btn-danger btn-sm" data-cancel-job="${j.id}">Cancel</button>` : ''}
                                    <button class="btn btn-sm" style="margin-left:4px;background:var(--surface-2);color:var(--text-secondary);" data-view-log="${j.id}" title="View training log">Log</button>
                                    ${j.status === 'completed' ? `<button class="btn btn-secondary btn-sm" style="margin-left:4px;" data-infer-job="${j.id}" title="Run inference with this model">Infer</button>` : ''}
                                    ${j.failure_reason ? `<div class="ai-job-detail ai-job-error" title="${escHtml(j.failure_reason)}">${escHtml(truncate(j.failure_reason, 80))}</div>` : ''}
                                </td>
                            </tr>`;
                        }).join('')}
                    </tbody>
                </table>
            </div>`;

        // Cancel buttons
        el.querySelectorAll('[data-cancel-job]').forEach(btn => {
            btn.addEventListener('click', async () => {
                const jobId = btn.dataset.cancelJob;
                if (!confirm(`Cancel training job #${jobId}?`)) return;
                btn.disabled = true;
                btn.textContent = 'Cancelling...';
                try {
                    const res = await aiApi.post(`/ai/training-jobs/${jobId}/cancel`, {});
                    if (res && !res.error) {
                        showToast(`Training job #${jobId} cancelled`, 'success');
                        loadAllData();
                    } else {
                        showToast(res?.error || 'Failed to cancel', 'error');
                        btn.disabled = false;
                        btn.textContent = 'Cancel';
                    }
                } catch {
                    btn.disabled = false;
                    btn.textContent = 'Cancel';
                }
            });
        });

        // Inference buttons
        el.querySelectorAll('[data-infer-job]').forEach(btn => {
            btn.addEventListener('click', async () => {
                const jobId = btn.dataset.inferJob;
                const paramsStr = prompt(
                    'Enter input parameters as JSON (e.g. {"RPM": 75.0}):',
                    '{}'
                );
                if (paramsStr === null) return;

                btn.disabled = true;
                btn.textContent = 'Running...';
                try {
                    const res = await aiApi.post(`/ai/training-jobs/${jobId}/infer`, {
                        input_params: JSON.parse(paramsStr),
                    });
                    if (res && !res.error) {
                        showToast(`Inference complete — output: ${res.output_dir || 'saved'}`, 'success');
                    } else {
                        showToast(res?.error || 'Inference failed', 'error');
                    }
                } catch (e) {
                    showToast('Invalid JSON or network error', 'error');
                }
                btn.disabled = false;
                btn.textContent = 'Infer';
            });
        });

        // View Log buttons
        el.querySelectorAll('[data-view-log]').forEach(btn => {
            btn.addEventListener('click', async () => {
                const jobId = btn.dataset.viewLog;
                btn.disabled = true;
                btn.textContent = '...';
                try {
                    const res = await aiApi.get(`/ai/training-jobs/${jobId}/log`);
                    const logText = res?.log || res?.message || 'No log available';

                    // Create modal overlay
                    const overlay = document.createElement('div');
                    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;padding:24px;';
                    overlay.innerHTML = `
                        <div style="background:var(--surface-1);border-radius:12px;width:100%;max-width:900px;max-height:85vh;display:flex;flex-direction:column;border:1px solid var(--border);">
                            <div style="display:flex;justify-content:space-between;align-items:center;padding:16px 20px;border-bottom:1px solid var(--border);">
                                <h3 style="margin:0;font-size:16px;">Training Log — Job #${jobId}</h3>
                                <button id="ai-log-close" style="background:none;border:none;color:var(--text-secondary);font-size:22px;cursor:pointer;padding:4px 8px;">✕</button>
                            </div>
                            <pre style="flex:1;overflow:auto;padding:16px 20px;margin:0;font-family:'JetBrains Mono',Consolas,monospace;font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-all;color:var(--text-primary);background:var(--surface-0);">${escHtml(logText)}</pre>
                        </div>`;
                    document.body.appendChild(overlay);

                    // Close handlers
                    overlay.querySelector('#ai-log-close').addEventListener('click', () => overlay.remove());
                    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
                    document.addEventListener('keydown', function esc(e) {
                        if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', esc); }
                    });
                } catch (e) {
                    showToast('Failed to fetch log', 'error');
                }
                btn.disabled = false;
                btn.textContent = 'Log';
            });
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
        document.getElementById('ai-ds-back').addEventListener('click', () => showView('dashboard'));

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
                        <span style="font-size:18px;">📁</span>
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
                    showView('dashboard');
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
    async function renderNewTraining() {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        selectedGpus.clear();

        container.innerHTML = '';
        container.appendChild(styleEl);

        // Pre-load datasets
        const dsData = await aiApi.get('/ai/datasets');
        const datasets = dsData?.datasets || [];

        const wrapper = document.createElement('div');
        wrapper.className = 'page-enter';
        wrapper.innerHTML = `
            <div class="ai-back-btn" id="ai-tj-back">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"></polyline></svg>
                Back to AI Training
            </div>
            <div class="page-header">
                <h1>New Training Job</h1>
                <p>Train a PhysicsNeMo surrogate model from simulation data</p>
            </div>

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
                                        <option value="fno">FNO (Fourier Neural Operator)</option>
                                        <option value="unet">U-Net (Encoder-Decoder)</option>
                                        <option value="mlp">MLP (Multi-Layer Perceptron)</option>
                                    </select>
                                    <div id="ai-tj-model-note" style="font-size:11px;color:var(--text-muted);margin-top:4px;"></div>
                                </div>
                            </div>
                            <div class="form-group" style="margin-bottom:0;">
                                <label class="form-label">Run Name <span style="color:var(--text-muted);font-weight:400;">(optional — auto-generated if blank)</span></label>
                                <input type="text" class="form-input" id="ai-tj-name" placeholder="e.g. fno_agitator_v2">
                            </div>
                        </div>
                    </div>

                    <!-- Training Configuration -->
                    <div class="card" style="margin-bottom:16px;">
                        <div class="card-header" style="cursor:pointer;" id="ai-advanced-toggle">
                            <span class="card-title">Training Configuration</span>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-left:auto;transition:transform 0.2s;" id="ai-advanced-chevron"><polyline points="6 9 12 15 18 9"></polyline></svg>
                        </div>
                        <div id="ai-advanced-body" style="padding:0 16px 16px;">
                            <div class="ai-form-grid">
                                <div class="form-group">
                                    <label class="form-label">Epochs</label>
                                    <input type="number" class="form-input" id="ai-tj-epochs" value="100" min="1" max="10000">
                                </div>
                                <div class="form-group">
                                    <label class="form-label">Batch Size</label>
                                    <input type="number" class="form-input" id="ai-tj-batch" value="8" min="1" max="4096">
                                </div>
                                <div class="form-group">
                                    <label class="form-label">Learning Rate</label>
                                    <input type="number" class="form-input" id="ai-tj-lr" value="0.001" step="0.0001" min="0.000001" max="1">
                                </div>
                                <div class="form-group">
                                    <label class="form-label">Optimizer</label>
                                    <select class="form-select" id="ai-tj-optimizer">
                                        <option value="adam">Adam</option>
                                        <option value="adamw">AdamW</option>
                                        <option value="sgd">SGD</option>
                                        <option value="rmsprop">RMSProp</option>
                                    </select>
                                </div>
                                <div class="form-group">
                                    <label class="form-label">LR Scheduler <span style="color:var(--text-muted);font-weight:400;">(optional)</span></label>
                                    <select class="form-select" id="ai-tj-scheduler">
                                        <option value="">None</option>
                                        <option value="reduce_on_plateau">Reduce on Plateau</option>
                                        <option value="cosine">Cosine Annealing</option>
                                        <option value="step">Step LR</option>
                                    </select>
                                </div>
                                <div class="form-group">
                                    <label class="form-label">Checkpoint Interval</label>
                                    <input type="number" class="form-input" id="ai-tj-ckpt" value="10" min="1" max="1000">
                                </div>
                            </div>
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

                    <!-- Submit button -->
                    <button class="btn btn-primary" id="ai-tj-submit" style="width:100%;justify-content:center;padding:14px;font-size:15px;" ${!datasets.length ? 'disabled' : ''}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                        Start Training
                    </button>
                </div>
            </div>
        `;
        container.appendChild(wrapper);

        // ---- Back button ----
        document.getElementById('ai-tj-back').addEventListener('click', () => showView('dashboard'));

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

        // ---- Model family note ----
        const modelSelect = document.getElementById('ai-tj-model');
        const modelNote = document.getElementById('ai-tj-model-note');
        const modelNotes = {
            fno: '',
            unet: 'Best for 2D/3D spatial field prediction. Uses PhysicsNeMo Pix2Pix when available.',
            mlp: 'For scalar-to-scalar regression (stats_table datasets only).',
        };
        modelSelect.addEventListener('change', () => {
            modelNote.textContent = modelNotes[modelSelect.value] || '';
        });

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

            if (epochs && epochs > 0) config.epochs = epochs;
            if (batchSize && batchSize > 0) config.batch_size = batchSize;
            if (lr && lr > 0) config.learning_rate = lr;
            if (optimizer) config.optimizer = optimizer;
            if (scheduler) config.scheduler = scheduler;
            if (ckptInterval && ckptInterval > 0) config.checkpoint_interval = ckptInterval;

            if (Object.keys(config).length > 0) body.config = config;

            const btn = document.getElementById('ai-tj-submit');
            btn.disabled = true;
            const origHtml = btn.innerHTML;
            btn.innerHTML = '<span class="spinner" style="width:14px;height:14px;"></span> Submitting...';

            try {
                const res = await aiApi.post('/ai/training-jobs', body);
                if (res && res.id) {
                    showToast(`Training job "${res.run_name}" queued`, 'success');
                    showView('dashboard');
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

    // ---- Cleanup on page navigation ----
    container._aiTrainingCleanup = () => {
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
    };

    // ---- Initial render ----
    showView('dashboard');
}
