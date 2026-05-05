/**
 * M-Star Queue — Single Page Application
 * ========================================
 * Hash-based SPA with auth, job management, GPU monitoring, and version selection.
 */
(function() {
    'use strict';

    // ============================================================
    // State
    // ============================================================
    const state = {
        token: localStorage.getItem('mstar_token') || null,
        user: JSON.parse(localStorage.getItem('mstar_user') || 'null'),
        refreshTimers: [],
    };

    // ============================================================
    // API Client
    // ============================================================
    const api = {
        baseUrl: '/api',

        async request(method, path, body = null) {
            const headers = { 'Content-Type': 'application/json' };
            if (state.token) headers['Authorization'] = `Bearer ${state.token}`;

            const opts = { method, headers };
            if (body && method !== 'GET') {
                opts.body = typeof body === 'string' ? body : JSON.stringify(body);
            }

            const res = await fetch(`${this.baseUrl}${path}`, opts);
            const data = await res.json();

            if (res.status === 401 && state.token) {
                logout();
                return null;
            }
            return data;
        },

        get(path) { return this.request('GET', path); },
        post(path, body) { return this.request('POST', path, body); },
        put(path, body) { return this.request('PUT', path, body); },
        del(path) { return this.request('DELETE', path); },

        async uploadJob(file, params) {
            const queryStr = new URLSearchParams(params).toString();
            const headers = {};
            if (state.token) headers['Authorization'] = `Bearer ${state.token}`;

            const res = await fetch(`${this.baseUrl}/jobs/submit?${queryStr}`, {
                method: 'POST',
                headers,
                body: file,
            });
            return res.json();
        }
    };

    // ============================================================
    // Auth
    // ============================================================
    function isLoggedIn() { return !!state.token && !!state.user; }

    function setAuth(token, user) {
        state.token = token;
        state.user = user;
        localStorage.setItem('mstar_token', token);
        localStorage.setItem('mstar_user', JSON.stringify(user));
        updateUserUI();
    }

    function logout() {
        if (state.token) api.post('/auth/logout');
        state.token = null;
        state.user = null;
        localStorage.removeItem('mstar_token');
        localStorage.removeItem('mstar_user');
        navigate('login');
    }

    function updateUserUI() {
        const userInfo = document.getElementById('user-info');
        const userAvatar = document.getElementById('user-avatar');
        const userName = document.getElementById('user-name');
        const userRole = document.getElementById('user-role');
        const adminNav = document.getElementById('nav-admin');
        const settingsNav = document.getElementById('nav-settings');

        if (state.user) {
            userInfo.style.display = 'flex';
            userAvatar.textContent = state.user.username[0].toUpperCase();
            userName.textContent = state.user.username;
            userRole.textContent = state.user.role;
            const isAdmin = state.user.role === 'admin';
            if (adminNav) adminNav.style.display = isAdmin ? 'flex' : 'none';
            if (settingsNav) settingsNav.style.display = isAdmin ? 'flex' : 'none';
        } else {
            userInfo.style.display = 'none';
            if (adminNav) adminNav.style.display = 'none';
            if (settingsNav) settingsNav.style.display = 'none';
        }
    }

    // ============================================================
    // Toast Notifications
    // ============================================================
    function toast(message, type = 'info') {
        const container = document.getElementById('toast-container');
        const el = document.createElement('div');
        el.className = `toast toast-${type}`;
        el.textContent = message;
        container.appendChild(el);
        setTimeout(() => el.remove(), 4000);
    }

    // ============================================================
    // Router
    // ============================================================
    const routes = {
        login: renderLogin,
        register: renderRegister,
        dashboard: renderDashboard,
        submit: renderSubmit,
        jobs: renderJobs,
        gpus: renderGpus,
        admin: renderAdmin,
        settings: renderSettings,
    };

    function navigate(route) {
        window.location.hash = `#/${route}`;
    }

    function handleRoute() {
        // Clear any active refresh timers
        state.refreshTimers.forEach(clearInterval);
        state.refreshTimers = [];

        const hash = window.location.hash.replace('#/', '') || 'dashboard';
        const route = hash.split('/')[0];

        if (!isLoggedIn() && route !== 'login' && route !== 'register') {
            document.body.classList.add('auth-mode');
            navigate('login');
            return;
        }

        if (isLoggedIn() && (route === 'login' || route === 'register')) {
            navigate('dashboard');
            return;
        }

        // Toggle auth mode (hide sidebar on login/register)
        if (route === 'login' || route === 'register') {
            document.body.classList.add('auth-mode');
        } else {
            document.body.classList.remove('auth-mode');
        }

        // Update nav active state
        document.querySelectorAll('.nav-item').forEach(el => {
            el.classList.toggle('active', el.dataset.route === route);
        });

        const renderFn = routes[route] || renderDashboard;
        const main = document.getElementById('main-content');
        main.innerHTML = '';
        renderFn(main);
    }

    window.addEventListener('hashchange', handleRoute);

    // ============================================================
    // Render: Login
    // ============================================================
    function renderLogin(container) {
        container.innerHTML = `
            <div class="auth-container">
                <div class="auth-card">
                    <div class="auth-brand">
                        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--accent-blue)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <polygon points="12 2 2 7 12 12 22 7 12 2"></polygon>
                            <polyline points="2 17 12 22 22 17"></polyline>
                            <polyline points="2 12 12 17 22 12"></polyline>
                        </svg>
                        <h2>M-Star Queue</h2>
                        <p>Sign in to manage your simulations</p>
                    </div>
                    <form id="login-form">
                        <div class="form-group">
                            <label class="form-label">Username</label>
                            <input type="text" class="form-input" id="login-username" placeholder="Enter username" required autocomplete="username">
                        </div>
                        <div class="form-group">
                            <label class="form-label">Password</label>
                            <input type="password" class="form-input" id="login-password" placeholder="Enter password" required autocomplete="current-password">
                        </div>
                        <button type="submit" class="btn btn-primary" style="width:100%;justify-content:center;padding:12px;">Sign In</button>
                    </form>
                    <div class="auth-footer">
                        Don't have an account? <a class="auth-link" id="go-register">Register</a>
                    </div>
                </div>
            </div>
        `;

        document.getElementById('login-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const username = document.getElementById('login-username').value;
            const password = document.getElementById('login-password').value;

            const data = await api.post('/auth/login', { username, password });
            if (data && data.token) {
                setAuth(data.token, data.user);
                toast('Welcome back!', 'success');
                navigate('dashboard');
            } else {
                toast(data?.error || 'Login failed', 'error');
            }
        });

        document.getElementById('go-register').addEventListener('click', () => navigate('register'));
    }

    // ============================================================
    // Render: Register
    // ============================================================
    function renderRegister(container) {
        container.innerHTML = `
            <div class="auth-container">
                <div class="auth-card">
                    <div class="auth-brand">
                        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--accent-blue)" stroke-width="2"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline></svg>
                        <h2>Create Account</h2>
                        <p>Registration restricted to @latticept.com emails</p>
                    </div>
                    <form id="register-form">
                        <div class="form-group">
                            <label class="form-label">Username</label>
                            <input type="text" class="form-input" id="reg-username" placeholder="Choose a username" required>
                        </div>
                        <div class="form-group">
                            <label class="form-label">Email</label>
                            <input type="email" class="form-input" id="reg-email" placeholder="you@latticept.com" required>
                        </div>
                        <div class="form-group">
                            <label class="form-label">Password</label>
                            <input type="password" class="form-input" id="reg-password" placeholder="Choose a strong password" required>
                        </div>
                        <button type="submit" class="btn btn-primary" style="width:100%;justify-content:center;padding:12px;">Create Account</button>
                    </form>
                    <div class="auth-footer">
                        Already have an account? <a class="auth-link" id="go-login">Sign In</a>
                    </div>
                </div>
            </div>
        `;

        document.getElementById('register-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const username = document.getElementById('reg-username').value;
            const email = document.getElementById('reg-email').value;
            const password = document.getElementById('reg-password').value;

            if (!email.endsWith('@latticept.com')) {
                toast('Only @latticept.com email addresses are allowed', 'error');
                return;
            }

            const data = await api.post('/auth/register', { username, email, password });
            if (data && data.token) {
                setAuth(data.token, data.user);
                toast('Account created!', 'success');
                navigate('dashboard');
            } else {
                toast(data?.error || 'Registration failed', 'error');
            }
        });

        document.getElementById('go-login').addEventListener('click', () => navigate('login'));
    }

    // ============================================================
    // Render: Dashboard
    // ============================================================
    async function renderDashboard(container) {
        container.innerHTML = `
            <div class="page-enter">
                <div class="page-header">
                    <h1>Dashboard</h1>
                    <p>Cluster overview and recent activity</p>
                </div>
                <div class="stats-grid" id="stats-grid">
                    <div class="stat-card blue"><div class="skeleton" style="height:40px;width:60px;margin-bottom:8px"></div><div class="skeleton" style="height:12px;width:80px"></div></div>
                    <div class="stat-card green"><div class="skeleton" style="height:40px;width:60px;margin-bottom:8px"></div><div class="skeleton" style="height:12px;width:80px"></div></div>
                    <div class="stat-card amber"><div class="skeleton" style="height:40px;width:60px;margin-bottom:8px"></div><div class="skeleton" style="height:12px;width:80px"></div></div>
                    <div class="stat-card purple"><div class="skeleton" style="height:40px;width:60px;margin-bottom:8px"></div><div class="skeleton" style="height:12px;width:80px"></div></div>
                </div>
                <div class="card">
                    <div class="card-header">
                        <span class="card-title">Recent Jobs</span>
                    </div>
                    <div id="recent-jobs-table"></div>
                </div>
            </div>
        `;

        await loadDashboardData();
        const timer = setInterval(() => loadDashboardData(), 10000);
        state.refreshTimers.push(timer);
    }

    async function loadDashboardData() {
        const [dashboard, jobs] = await Promise.all([
            api.get('/dashboard'),
            api.get('/jobs?limit=10'),
        ]);

        if (!dashboard || dashboard.error) return;

        const counts = dashboard.job_counts || {};
        const statsGrid = document.getElementById('stats-grid');
        if (statsGrid) {
            statsGrid.innerHTML = `
                <div class="stat-card blue">
                    <div class="stat-value">${counts.running || 0}</div>
                    <div class="stat-label">Running Jobs</div>
                </div>
                <div class="stat-card green">
                    <div class="stat-value">${counts.queued || 0}</div>
                    <div class="stat-label">Queued</div>
                </div>
                <div class="stat-card amber">
                    <div class="stat-value">${dashboard.active_gpus}/${dashboard.total_gpus}</div>
                    <div class="stat-label">Active GPUs</div>
                </div>
                <div class="stat-card purple">
                    <div class="stat-value">${dashboard.available_versions}</div>
                    <div class="stat-label">M-Star Versions</div>
                </div>
            `;
        }

        const tableEl = document.getElementById('recent-jobs-table');
        if (tableEl && Array.isArray(jobs)) {
            renderJobsTable(tableEl, jobs);
        }
    }

    // ============================================================
    // Render: Jobs
    // ============================================================
    async function renderJobs(container) {
        container.innerHTML = `
            <div class="page-enter">
                <div class="page-header flex justify-between items-center">
                    <div>
                        <h1>Jobs</h1>
                        <p>View and manage simulation jobs</p>
                    </div>
                    <a href="#/submit" class="btn btn-primary">+ Submit Job</a>
                </div>
                <div class="flex gap-2 mb-4">
                    <button class="btn btn-secondary btn-sm job-filter active" data-filter="">All</button>
                    <button class="btn btn-secondary btn-sm job-filter" data-filter="running">Running</button>
                    <button class="btn btn-secondary btn-sm job-filter" data-filter="queued">Queued</button>
                    <button class="btn btn-secondary btn-sm job-filter" data-filter="completed">Completed</button>
                    <button class="btn btn-secondary btn-sm job-filter" data-filter="failed">Failed</button>
                </div>
                <div class="card">
                    <div id="jobs-table"></div>
                </div>
            </div>
        `;

        let currentFilter = '';

        container.querySelectorAll('.job-filter').forEach(btn => {
            btn.addEventListener('click', () => {
                container.querySelectorAll('.job-filter').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                currentFilter = btn.dataset.filter;
                loadJobsFiltered(currentFilter);
            });
        });

        await loadJobsFiltered(currentFilter);
        const timer = setInterval(() => loadJobsFiltered(currentFilter), 5000);
        state.refreshTimers.push(timer);
    }

    async function loadJobsFiltered(filter) {
        const path = filter ? `/jobs?status=${filter}&limit=50` : '/jobs?limit=50';
        const jobs = await api.get(path);
        const tableEl = document.getElementById('jobs-table');
        if (tableEl && Array.isArray(jobs)) {
            renderJobsTable(tableEl, jobs);
        }
    }

    function renderJobsTable(container, jobs) {
        if (!jobs.length) {
            container.innerHTML = `
                <div class="empty-state">
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>
                    <h3>No jobs found</h3>
                    <p>Submit your first simulation to get started</p>
                </div>
            `;
            return;
        }

        container.innerHTML = `
            <div class="table-container">
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>ID</th>
                            <th>Name</th>
                            <th>User</th>
                            <th>Version</th>
                            <th>GPUs</th>
                            <th>Status</th>
                            <th>Submitted</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${jobs.map(job => `
                            <tr>
                                <td class="text-mono">#${job.id}</td>
                                <td>${escapeHtml(job.name)}</td>
                                <td>${escapeHtml(job.username)}</td>
                                <td class="text-mono text-sm">${job.resolved_version || job.mstar_version}</td>
                                <td class="text-mono text-sm">${formatGpuIds(job.gpu_ids)}</td>
                                <td>${statusBadge(job.status)}</td>
                                <td class="text-sm text-muted">${formatTime(job.submitted_at)}</td>
                                <td>
                                    <div class="flex gap-2">
                                        ${job.status !== 'queued' ? `<button class="btn btn-secondary btn-sm" onclick="window.mstarApp.viewOutput(${job.id})">View</button>` : ''}
                                        ${(job.status === 'queued' || job.status === 'running') ? `<button class="btn btn-danger btn-sm" onclick="window.mstarApp.cancelJob(${job.id})">Cancel</button>` : ''}
                                        ${(job.status === 'failed' || job.status === 'cancelled') ? `<button class="btn btn-primary btn-sm" onclick="window.mstarApp.restartJob(${job.id})">Restart</button>` : ''}
                                    </div>
                                    ${job.error_message ? `<div class="text-sm" style="color:var(--accent-red);margin-top:4px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(job.error_message)}">${escapeHtml(job.error_message)}</div>` : ''}
                                </td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        `;
    }

    // ============================================================
    // Render: Submit Job
    // ============================================================
    async function renderSubmit(container) {
        container.innerHTML = `
            <div class="page-enter">
                <div class="page-header">
                    <h1>Submit Job</h1>
                    <p>Select an MSB file and configure simulation parameters</p>
                </div>
                <div class="submit-layout">
                    <div>
                        <div class="card" style="margin-bottom:16px;">
                            <div class="card-header"><span class="card-title">MSB File</span></div>
                            <div style="display:flex;gap:0;margin-bottom:12px;">
                                <button class="btn btn-sm msb-tab active" id="tab-browse" style="flex:1;border-radius:8px 0 0 8px;justify-content:center;">Browse Server</button>
                                <button class="btn btn-sm msb-tab" id="tab-upload" style="flex:1;border-radius:0 8px 8px 0;justify-content:center;">Upload File</button>
                            </div>
                            <div id="msb-browse-panel">
                                <div id="browse-path-bar" style="display:flex;align-items:center;gap:6px;margin-bottom:8px;font-size:12px;color:var(--text-secondary);overflow-x:auto;white-space:nowrap;"></div>
                                <div id="browse-list" style="max-height:280px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;"></div>
                            </div>
                            <div id="msb-upload-panel" style="display:none;">
                                <div class="dropzone" id="dropzone">
                                    <div class="dropzone-icon">
                                        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>
                                    </div>
                                    <div class="dropzone-text">Drop your <strong>.msb</strong> file here or click to browse</div>
                                    <div class="dropzone-hint">Maximum size: 500 MB</div>
                                </div>
                                <input type="file" id="file-input" accept=".msb,.MSB" style="display:none">
                            </div>
                            <div id="file-info-container"></div>
                        </div>

                        <div class="card">
                            <div class="card-header"><span class="card-title">Job Settings</span></div>
                            <div class="form-group">
                                <label class="form-label">Job Name</label>
                                <input type="text" class="form-input" id="job-name" placeholder="Auto-detected from filename">
                            </div>
                            <div class="form-group">
                                <label class="form-label">Priority</label>
                                <select class="form-select" id="job-priority">
                                    <option value="0">Normal</option>
                                    <option value="1">High</option>
                                    <option value="2">Urgent</option>
                                </select>
                            </div>
                            <div class="form-checkbox">
                                <input type="checkbox" id="unified-memory">
                                <label for="unified-memory">Enable Unified Memory (CPU RAM spill)</label>
                            </div>
                            <div class="form-group" style="margin-top:12px;">
                                <label class="form-label">Copy Results To <span style="color:var(--text-muted);font-weight:400;">(optional)</span></label>
                                <div class="form-checkbox" style="margin-bottom:8px;">
                                    <input type="checkbox" id="copy-to-source-cb">
                                    <label for="copy-to-source-cb">Copy back to source folder</label>
                                </div>
                                <div style="display:flex;gap:8px;">
                                    <input type="text" class="form-input" id="copy-to-path" placeholder="/simulations/ProjectName/Results" style="flex:1;">
                                    <button class="btn btn-sm" id="copy-to-browse-btn" title="Browse server">📂</button>
                                </div>
                                <div class="dropzone-hint" style="margin-top:4px;">Completed job results will be automatically copied here</div>
                            </div>
                        </div>
                    </div>

                    <div>
                        <div class="card" style="margin-bottom:16px;">
                            <div class="card-header"><span class="card-title">M-Star Version</span></div>
                            <select class="form-select" id="mstar-version">
                                <option value="latest">Loading versions...</option>
                            </select>
                        </div>

                        <div class="card" style="margin-bottom:16px;">
                            <div class="card-header"><span class="card-title">GPU Selection</span></div>
                            <div id="gpu-select-grid" class="gpu-select-grid">
                                <div class="skeleton" style="height:60px"></div>
                                <div class="skeleton" style="height:60px"></div>
                            </div>
                        </div>

                        <button class="btn btn-primary" id="submit-btn" style="width:100%;justify-content:center;padding:14px;font-size:15px;" disabled>
                            Submit Job
                        </button>
                    </div>
                </div>
            </div>
        `;

        let selectedFile = null;
        let selectedServerPath = null;
        let selectedGpus = new Set();

        // --- Tab switching ---
        const tabBrowse = document.getElementById('tab-browse');
        const tabUpload = document.getElementById('tab-upload');
        const browsePanel = document.getElementById('msb-browse-panel');
        const uploadPanel = document.getElementById('msb-upload-panel');

        tabBrowse.addEventListener('click', () => {
            tabBrowse.classList.add('active'); tabUpload.classList.remove('active');
            browsePanel.style.display = ''; uploadPanel.style.display = 'none';
        });
        tabUpload.addEventListener('click', () => {
            tabUpload.classList.add('active'); tabBrowse.classList.remove('active');
            uploadPanel.style.display = ''; browsePanel.style.display = 'none';
        });

        // --- Remote file browser ---
        async function loadBrowse(path) {
            const data = await api.get(`/browse?path=${encodeURIComponent(path)}&mode=msb`);
            if (!data || data.error) { toast(data?.error || 'Browse failed', 'error'); return; }

            // Path breadcrumbs
            const bar = document.getElementById('browse-path-bar');
            const parts = data.path.split('/').filter(Boolean);
            let crumbs = '<span style="cursor:pointer;color:var(--accent-blue);" data-browse-path="/simulations">simulations</span>';
            let accumulated = '';
            for (const part of parts) {
                accumulated += '/' + part;
                if (accumulated === '/simulations') continue;
                crumbs += ' <span style="color:var(--text-muted);">/</span> ';
                crumbs += `<span style="cursor:pointer;color:var(--accent-blue);" data-browse-path="${accumulated}">${part}</span>`;
            }
            bar.innerHTML = crumbs;
            bar.querySelectorAll('[data-browse-path]').forEach(el => {
                el.addEventListener('click', () => loadBrowse(el.dataset.browsePath));
            });

            // Entries list
            const list = document.getElementById('browse-list');
            let html = '';
            if (data.parent) {
                html += `<div class="browse-entry browse-dir" data-browse-path="${data.parent}" style="padding:10px 14px;display:flex;align-items:center;gap:10px;cursor:pointer;border-bottom:1px solid var(--border);">
                    <span style="font-size:18px;">⬆️</span><span style="color:var(--text-secondary);">..</span></div>`;
            }
            for (const entry of data.entries) {
                if (entry.is_dir) {
                    html += `<div class="browse-entry browse-dir" data-browse-path="${entry.path}" style="padding:10px 14px;display:flex;align-items:center;gap:10px;cursor:pointer;border-bottom:1px solid var(--border);">
                        <span style="font-size:18px;">📁</span><span>${escapeHtml(entry.name)}</span></div>`;
                } else if (entry.is_msb) {
                    html += `<div class="browse-entry browse-msb" data-msb-path="${entry.path}" style="padding:10px 14px;display:flex;align-items:center;gap:10px;cursor:pointer;border-bottom:1px solid var(--border);${selectedServerPath === entry.path ? 'background:rgba(59,130,246,0.15);' : ''}">
                        <span style="font-size:18px;">📄</span><span style="flex:1;">${escapeHtml(entry.name)}</span><span style="font-size:12px;color:var(--text-muted);">${formatFileSize(entry.size)}</span></div>`;
                }
            }
            if (!data.entries.length && !data.parent) html = '<div style="padding:20px;text-align:center;color:var(--text-muted);">No MSB files found</div>';
            list.innerHTML = html;

            // Click handlers
            list.querySelectorAll('.browse-dir').forEach(el => {
                el.addEventListener('click', () => loadBrowse(el.dataset.browsePath));
            });
            list.querySelectorAll('.browse-msb').forEach(el => {
                el.addEventListener('click', () => {
                    selectedServerPath = el.dataset.msbPath;
                    selectedFile = null; // Clear upload selection
                    const fname = selectedServerPath.split('/').pop();
                    const nameInput = document.getElementById('job-name');
                    if (!nameInput.value) nameInput.value = fname.replace(/\.(msb|MSB)$/, '');
                    document.getElementById('file-info-container').innerHTML = `
                        <div class="file-info">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>
                            <span>Server: ${escapeHtml(selectedServerPath)}</span>
                        </div>`;
                    updateSubmitButton();
                    // Update copy-back checkbox
                    const cb = document.getElementById('copy-to-source-cb');
                    if (cb.checked) {
                        document.getElementById('copy-to-path').value = selectedServerPath.substring(0, selectedServerPath.lastIndexOf('/'));
                    }
                    loadBrowse(selectedServerPath.substring(0, selectedServerPath.lastIndexOf('/')));
                });
            });
        }
        loadBrowse('/simulations');

        // --- Copy-back-to-source checkbox ---
        document.getElementById('copy-to-source-cb').addEventListener('change', (e) => {
            const copyToInput = document.getElementById('copy-to-path');
            if (e.target.checked && selectedServerPath) {
                copyToInput.value = selectedServerPath.substring(0, selectedServerPath.lastIndexOf('/'));
                copyToInput.readOnly = true;
                copyToInput.style.opacity = '0.6';
            } else {
                if (e.target.checked && !selectedServerPath) {
                    toast('Select a server file first to use this option', 'error');
                    e.target.checked = false;
                    return;
                }
                copyToInput.readOnly = false;
                copyToInput.style.opacity = '1';
                if (!e.target.checked) copyToInput.value = '';
            }
        });

        // --- Copy-to browse modal ---
        document.getElementById('copy-to-browse-btn').addEventListener('click', async () => {
            const input = document.getElementById('copy-to-path');
            const startPath = input.value || '/simulations';

            // Create modal overlay
            const overlay = document.createElement('div');
            overlay.className = 'dir-picker-overlay';
            overlay.innerHTML = `
                <div class="dir-picker-modal">
                    <div class="dir-picker-header">
                        <span class="card-title" style="font-size:16px;">Select Destination Folder</span>
                        <button class="dir-picker-close" id="dir-picker-close">&times;</button>
                    </div>
                    <div id="dir-picker-breadcrumbs" class="dir-picker-breadcrumbs"></div>
                    <div id="dir-picker-list" class="dir-picker-list"></div>
                    <div class="dir-picker-footer">
                        <div class="dir-picker-new-folder">
                            <input type="text" class="form-input" id="dir-picker-new-name" placeholder="New folder name..." style="flex:1;font-size:13px;padding:8px 10px;">
                            <button class="btn btn-sm" id="dir-picker-create-btn" style="white-space:nowrap;">+ New Folder</button>
                        </div>
                        <div class="dir-picker-current">
                            <span style="color:var(--text-muted);font-size:12px;">Selected:</span>
                            <span id="dir-picker-selected-path" style="font-size:13px;color:var(--text-primary);font-family:'JetBrains Mono',monospace;"></span>
                        </div>
                        <button class="btn btn-primary" id="dir-picker-select-btn" style="width:100%;justify-content:center;padding:10px;font-size:14px;">Select This Folder</button>
                    </div>
                </div>
            `;
            document.body.appendChild(overlay);
            requestAnimationFrame(() => overlay.classList.add('open'));

            let currentDirPath = startPath;

            async function loadDirBrowser(path) {
                const data = await api.get(`/browse?path=${encodeURIComponent(path)}&mode=dirs`);
                if (!data || data.error) { toast(data?.error || 'Browse failed', 'error'); return; }

                currentDirPath = data.path;
                document.getElementById('dir-picker-selected-path').textContent = currentDirPath;

                // Breadcrumbs
                const bar = document.getElementById('dir-picker-breadcrumbs');
                const parts = data.path.split('/').filter(Boolean);
                let crumbs = '<span class="dir-crumb" data-path="/simulations">simulations</span>';
                let acc = '';
                for (const part of parts) {
                    acc += '/' + part;
                    if (acc === '/simulations') continue;
                    crumbs += '<span style="color:var(--text-muted);margin:0 2px;">/</span>';
                    crumbs += `<span class="dir-crumb" data-path="${acc}">${part}</span>`;
                }
                bar.innerHTML = crumbs;
                bar.querySelectorAll('.dir-crumb').forEach(el => {
                    el.addEventListener('click', () => loadDirBrowser(el.dataset.path));
                });

                // Directory list
                const list = document.getElementById('dir-picker-list');
                let html = '';
                if (data.parent) {
                    html += `<div class="dir-picker-entry" data-path="${data.parent}">
                        <span style="font-size:18px;opacity:.7;">⬆️</span><span style="color:var(--text-secondary);">..</span></div>`;
                }
                for (const entry of data.entries) {
                    html += `<div class="dir-picker-entry" data-path="${entry.path}">
                        <span style="font-size:18px;">📁</span><span>${escapeHtml(entry.name)}</span></div>`;
                }
                if (!data.entries.length && !data.parent) {
                    html = '<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:13px;">Empty directory</div>';
                }
                list.innerHTML = html;

                list.querySelectorAll('.dir-picker-entry').forEach(el => {
                    el.addEventListener('click', () => loadDirBrowser(el.dataset.path));
                });
            }

            loadDirBrowser(startPath);

            // New Folder
            document.getElementById('dir-picker-create-btn').addEventListener('click', async () => {
                const nameInput = document.getElementById('dir-picker-new-name');
                const folderName = nameInput.value.trim();
                if (!folderName) { toast('Enter a folder name', 'error'); return; }
                if (/[\/\\]/.test(folderName)) { toast('Folder name cannot contain slashes', 'error'); return; }

                const newPath = currentDirPath + '/' + folderName;
                const result = await api.post('/browse/mkdir', { path: newPath });
                if (result && !result.error) {
                    toast(`Folder "${folderName}" created`, 'success');
                    nameInput.value = '';
                    loadDirBrowser(newPath);
                } else {
                    toast(result?.error || 'Failed to create folder', 'error');
                }
            });

            // Enter key in new folder input
            document.getElementById('dir-picker-new-name').addEventListener('keydown', (e) => {
                if (e.key === 'Enter') document.getElementById('dir-picker-create-btn').click();
            });

            // Select
            document.getElementById('dir-picker-select-btn').addEventListener('click', () => {
                input.value = currentDirPath;
                closeModal();
            });

            // Close
            function closeModal() {
                overlay.classList.remove('open');
                setTimeout(() => overlay.remove(), 200);
            }
            document.getElementById('dir-picker-close').addEventListener('click', closeModal);
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) closeModal();
            });
        });

        // --- File upload handling ---
        const dropzone = document.getElementById('dropzone');
        const fileInput = document.getElementById('file-input');

        dropzone.addEventListener('click', () => fileInput.click());
        dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
        dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
        dropzone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropzone.classList.remove('dragover');
            if (e.dataTransfer.files.length) handleFileSelect(e.dataTransfer.files[0]);
        });
        fileInput.addEventListener('change', (e) => {
            if (e.target.files.length) handleFileSelect(e.target.files[0]);
        });

        function handleFileSelect(file) {
            selectedFile = file;
            selectedServerPath = null; // Clear server selection
            const nameInput = document.getElementById('job-name');
            if (!nameInput.value) nameInput.value = file.name.replace(/\.(msb|MSB)$/, '');
            document.getElementById('file-info-container').innerHTML = `
                <div class="file-info">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>
                    <span>${escapeHtml(file.name)} (${formatFileSize(file.size)})</span>
                </div>`;
            updateSubmitButton();
        }

        function updateSubmitButton() {
            const btn = document.getElementById('submit-btn');
            btn.disabled = !((selectedFile || selectedServerPath) && selectedGpus.size > 0);
        }

        // Load versions
        const versions = await api.get('/versions');
        const versionSelect = document.getElementById('mstar-version');
        if (Array.isArray(versions)) {
            versionSelect.innerHTML = versions.map(v =>
                `<option value="${v.version}" ${v.is_latest ? 'selected' : ''}>${v.label}</option>`
            ).join('');
        }

        // Load GPU status
        const gpus = await api.get('/gpus');
        const gpuGrid = document.getElementById('gpu-select-grid');
        if (Array.isArray(gpus)) {
            gpuGrid.innerHTML = gpus.map(gpu => {
                const reserved = !!gpu.running_job || gpu.externally_busy;
                let statusLabel = '';
                let statusColor = 'var(--accent-green)';
                if (gpu.running_job) {
                    statusLabel = `In use: ${gpu.running_job.job_name}`;
                    statusColor = 'var(--accent-amber)';
                } else if (gpu.externally_busy) {
                    statusLabel = 'External Workload';
                    statusColor = 'var(--accent-red)';
                } else {
                    statusLabel = 'Available';
                }
                return `
                    <div class="gpu-select-card ${reserved ? 'reserved' : ''}" data-gpu-id="${gpu.index}">
                        <div class="gpu-select-name">GPU ${gpu.index}: ${gpu.name.split(' ').pop()}</div>
                        <div class="gpu-select-meta">${formatFileSize(gpu.memory_total * 1024 * 1024)} VRAM</div>
                        <div class="gpu-select-meta" style="color:${statusColor}">${statusLabel}</div>
                    </div>
                `;
            }).join('');

            gpuGrid.querySelectorAll('.gpu-select-card:not(.reserved)').forEach(card => {
                card.addEventListener('click', () => {
                    const gpuId = parseInt(card.dataset.gpuId);
                    if (selectedGpus.has(gpuId)) {
                        selectedGpus.delete(gpuId);
                        card.classList.remove('selected');
                    } else {
                        selectedGpus.add(gpuId);
                        card.classList.add('selected');
                    }
                    updateSubmitButton();
                });
            });
        }

        // Submit
        document.getElementById('submit-btn').addEventListener('click', async () => {
            if (!(selectedFile || selectedServerPath) || selectedGpus.size === 0) return;

            const btn = document.getElementById('submit-btn');
            btn.disabled = true;
            btn.innerHTML = '<div class="spinner"></div> Submitting...';

            const name = document.getElementById('job-name').value || (selectedServerPath ? selectedServerPath.split('/').pop().replace(/\.(msb|MSB)$/, '') : selectedFile.name.replace(/\.(msb|MSB)$/, ''));
            const version = document.getElementById('mstar-version').value;
            const priority = document.getElementById('job-priority').value;
            const unifiedMemory = document.getElementById('unified-memory').checked;
            const gpuIds = JSON.stringify([...selectedGpus].sort());
            const copyTo = document.getElementById('copy-to-path').value || '';

            const params = { name, version, priority, unified_memory: unifiedMemory, gpu_ids: gpuIds };
            if (copyTo) params.copy_to = copyTo;

            let result;
            if (selectedServerPath) {
                // Server-side file: no upload needed, just send metadata
                params.msb_source_path = selectedServerPath;
                result = await api.uploadJob(new Blob([]), params);
            } else {
                params.filename = selectedFile.name;
                result = await api.uploadJob(selectedFile, params);
            }

            if (result && result.job_id) {
                toast(`Job #${result.job_id} submitted successfully!`, 'success');
                navigate('jobs');
            } else {
                toast(result?.error || 'Submission failed', 'error');
                btn.disabled = false;
                btn.textContent = 'Submit Job';
            }
        });
    }

    // ============================================================
    // GPU Card Grid Rendering
    // ============================================================
    function updateGpuGrid(gpus) {
        const grid = document.getElementById('gpu-grid');
        if (!grid) return;

        grid.innerHTML = gpus.map(gpu => {
            const util = gpu.utilization || 0;
            const memPct = gpu.memory_percent || 0;
            const memUsed = gpu.memory_used || 0;
            const memTotal = gpu.memory_total || 1;
            const power = gpu.power_usage || 0;
            const powerLimit = gpu.power_limit || 1;
            const powerPct = Math.min(100, (power / powerLimit) * 100);
            const temp = gpu.temperature || 0;

            // Status dot: idle < 10% util, busy 10-90%, full 90%+
            const statusClass = util < 10 ? 'idle' : (util < 90 ? 'busy' : 'full');

            // Color logic for bars
            function barColor(pct) {
                return pct < 60 ? 'green' : (pct < 85 ? 'amber' : 'red');
            }
            function tempColor(t) {
                return t < 60 ? 'green' : (t < 80 ? 'amber' : 'red');
            }

            // Shorten GPU name
            const shortName = gpu.name.replace('NVIDIA ', '').replace(' Ada Generation', '').replace(' Blackwell Server Edition', '');

            // Job badge
            let jobBadge = '';
            if (gpu.running_job) {
                jobBadge = `<div class="gpu-job-badge">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
                    ${escapeHtml(gpu.running_job.job_name)} (${escapeHtml(gpu.running_job.username)})
                </div>`;
            } else if (gpu.externally_busy) {
                jobBadge = `<div class="gpu-job-badge" style="background:rgba(245,158,11,0.1);color:var(--accent-amber);">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
                    External Workload
                </div>`;
            }

            return `<div class="gpu-card">
                <div class="gpu-card-header">
                    <span class="gpu-index">${gpu.index}</span>
                    <span class="gpu-name">${escapeHtml(shortName)}</span>
                    <span class="gpu-status-dot ${statusClass}"></span>
                </div>
                <div class="gpu-metrics">
                    <div class="gpu-metric">
                        <div class="gpu-metric-header">
                            <span class="gpu-metric-label">Utilization</span>
                            <span class="gpu-metric-value">${util.toFixed(0)}%</span>
                        </div>
                        <div class="progress-bar"><div class="progress-fill ${barColor(util)}" style="width:${util}%"></div></div>
                    </div>
                    <div class="gpu-metric">
                        <div class="gpu-metric-header">
                            <span class="gpu-metric-label">Memory</span>
                            <span class="gpu-metric-value">${(memUsed/1024).toFixed(1)} / ${(memTotal/1024).toFixed(0)} GB</span>
                        </div>
                        <div class="progress-bar"><div class="progress-fill ${barColor(memPct)}" style="width:${memPct}%"></div></div>
                    </div>
                    <div class="gpu-metric">
                        <div class="gpu-metric-header">
                            <span class="gpu-metric-label">Power</span>
                            <span class="gpu-metric-value">${power.toFixed(0)} / ${powerLimit.toFixed(0)} W</span>
                        </div>
                        <div class="progress-bar"><div class="progress-fill ${barColor(powerPct)}" style="width:${powerPct}%"></div></div>
                    </div>
                    <div class="gpu-metric">
                        <div class="gpu-metric-header">
                            <span class="gpu-metric-label">Temperature</span>
                            <span class="gpu-metric-value">${temp.toFixed(0)}°C</span>
                        </div>
                        <div class="progress-bar"><div class="progress-fill ${tempColor(temp)}" style="width:${Math.min(100, (temp / 90) * 100)}%"></div></div>
                    </div>
                </div>
                ${jobBadge}
            </div>`;
        }).join('');
    }

    // ============================================================
    // Render: GPUs
    // ============================================================
    async function renderGpus(container) {
        container.innerHTML = `
            <div class="page-enter">
                <div class="page-header">
                    <h1>GPU Monitor</h1>
                    <p>Real-time GPU utilization, memory, power, and temperature</p>
                </div>
                <div id="gpu-grid" class="gpu-grid">
                    ${Array(4).fill('<div class="gpu-card"><div class="skeleton" style="height:200px"></div></div>').join('')}
                </div>
                <div class="card" style="margin-top:20px;">
                    <div class="card-header">
                        <span class="card-title">Historical Metrics</span>
                        <div class="flex gap-2">
                            <button class="btn btn-secondary btn-sm gpu-range active" data-minutes="5">5m</button>
                            <button class="btn btn-secondary btn-sm gpu-range" data-minutes="15">15m</button>
                            <button class="btn btn-secondary btn-sm gpu-range" data-minutes="60">1h</button>
                            <button class="btn btn-secondary btn-sm gpu-range" data-minutes="360">6h</button>
                            <button class="btn btn-secondary btn-sm gpu-range" data-minutes="1440">24h</button>
                        </div>
                    </div>
                    <div class="flex gap-2 mb-4">
                        <button class="btn btn-sm gpu-metric-toggle active" data-metric="utilization" style="border-color:var(--accent-blue);color:var(--accent-blue);">Utilization</button>
                        <button class="btn btn-sm gpu-metric-toggle active" data-metric="memory_percent" style="border-color:var(--accent-green);color:var(--accent-green);">Memory</button>
                        <button class="btn btn-sm gpu-metric-toggle active" data-metric="power_percent" style="border-color:var(--accent-amber);color:var(--accent-amber);">Power</button>
                        <button class="btn btn-sm gpu-metric-toggle active" data-metric="temperature" style="border-color:var(--accent-red);color:var(--accent-red);">Temperature</button>
                    </div>
                    <div id="gpu-chart-utilization" class="gpu-subchart" style="width:100%;height:220px;"></div>
                    <div id="gpu-chart-memory_percent" class="gpu-subchart" style="width:100%;height:220px;"></div>
                    <div id="gpu-chart-power_percent" class="gpu-subchart" style="width:100%;height:220px;"></div>
                    <div id="gpu-chart-temperature" class="gpu-subchart" style="width:100%;height:220px;"></div>
                </div>
            </div>
        `;

        let gpuHistoryMinutes = 5;
        let gpuActiveMetrics = new Set(['utilization', 'memory_percent', 'power_percent', 'temperature']);

        container.querySelectorAll('.gpu-range').forEach(btn => {
            btn.addEventListener('click', () => {
                container.querySelectorAll('.gpu-range').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                gpuHistoryMinutes = parseInt(btn.dataset.minutes);
                loadGpuHistory(gpuHistoryMinutes, gpuActiveMetrics);
            });
        });

        container.querySelectorAll('.gpu-metric-toggle').forEach(btn => {
            btn.addEventListener('click', () => {
                const metric = btn.dataset.metric;
                if (gpuActiveMetrics.has(metric)) {
                    gpuActiveMetrics.delete(metric);
                    btn.classList.remove('active');
                    btn.style.background = 'transparent';
                } else {
                    gpuActiveMetrics.add(metric);
                    btn.classList.add('active');
                    btn.style.background = '';
                }
                // Show/hide chart div
                const chartDiv = document.getElementById(`gpu-chart-${metric}`);
                if (chartDiv) chartDiv.style.display = gpuActiveMetrics.has(metric) ? 'block' : 'none';
                loadGpuHistory(gpuHistoryMinutes, gpuActiveMetrics);
            });
        });

        // GPU card refresh
        async function refreshGpuCards() {
            const gpus = await api.get('/gpus');
            if (Array.isArray(gpus)) updateGpuGrid(gpus);
        }
        refreshGpuCards();
        const gpuTimer = setInterval(refreshGpuCards, 3000);
        state.refreshTimers.push(gpuTimer);

        // Historical chart
        loadGpuHistory(gpuHistoryMinutes, gpuActiveMetrics);
        const histTimer = setInterval(() => loadGpuHistory(gpuHistoryMinutes, gpuActiveMetrics), 15000);
        state.refreshTimers.push(histTimer);
    }

    const GPU_METRIC_COLORS = { utilization: '#3b82f6', memory_percent: '#10b981', power_percent: '#f59e0b', temperature: '#ef4444' };
    const GPU_METRIC_LABELS = { utilization: 'Utilization (%)', memory_percent: 'Memory (%)', power_percent: 'Power (%)', temperature: 'Temperature (°C)' };
    const GPU_LINE_STYLES = ['solid', 'dash', 'dot', 'dashdot'];

    // Per-metric Y-axis ranges
    const GPU_METRIC_RANGES = {
        utilization: [0, 100],
        memory_percent: [0, 100],
        power_percent: [0, 100],
        temperature: [20, 90],
    };

    async function loadGpuHistory(minutes, activeMetrics) {
        const data = await api.get(`/gpus/history?minutes=${minutes}`);
        if (!data || !data.gpus) return;

        const gpuIds = Object.keys(data.gpus).sort((a, b) => parseInt(a) - parseInt(b));
        const commonLayout = {
            paper_bgcolor: 'transparent',
            plot_bgcolor: 'rgba(15, 20, 35, 0.6)',
            font: { family: 'Inter, sans-serif', size: 10, color: '#9ca3af' },
            margin: { l: 50, r: 20, t: 30, b: 30 },
            legend: { orientation: 'h', y: -0.15, font: { size: 9 } },
            showlegend: true,
        };
        const commonXaxis = {
            gridcolor: 'rgba(99, 115, 156, 0.08)',
            zerolinecolor: 'rgba(99, 115, 156, 0.12)',
        };

        for (const metric of ['utilization', 'memory_percent', 'power_percent', 'temperature']) {
            const chartEl = document.getElementById(`gpu-chart-${metric}`);
            if (!chartEl) continue;

            if (!activeMetrics.has(metric)) {
                chartEl.style.display = 'none';
                continue;
            }
            chartEl.style.display = 'block';

            const traces = [];
            for (const gpuId of gpuIds) {
                const gpuData = data.gpus[gpuId];
                if (!gpuData[metric]) continue;
                const lineStyle = GPU_LINE_STYLES[parseInt(gpuId) % GPU_LINE_STYLES.length];
                traces.push({
                    x: gpuData.timestamps,
                    y: gpuData[metric],
                    type: 'scatter',
                    mode: 'lines',
                    name: `GPU ${gpuId}`,
                    line: { color: GPU_METRIC_COLORS[metric], width: 1.5, dash: lineStyle, },
                    connectgaps: true,
                    opacity: 0.7 + (parseInt(gpuId) % 4) * 0.075,
                });
            }

            const range = GPU_METRIC_RANGES[metric];
            Plotly.react(chartEl, traces, {
                ...commonLayout,
                height: 220,
                title: { text: GPU_METRIC_LABELS[metric], font: { size: 12, color: GPU_METRIC_COLORS[metric] }, x: 0.02, y: 0.95 },
                xaxis: { ...commonXaxis },
                yaxis: {
                    title: { text: GPU_METRIC_LABELS[metric], font: { size: 10 } },
                    gridcolor: 'rgba(99, 115, 156, 0.08)',
                    zerolinecolor: 'rgba(99, 115, 156, 0.12)',
                    range: range,
                },
            }, { responsive: true, displayModeBar: false });
        }
    }

    // ============================================================
    // Render: Admin
    // ============================================================
    async function renderAdmin(container) {
        // Fetch GPU list for GPU access checkboxes
        const gpus = await api.get('/gpus') || [];
        const gpuCount = Array.isArray(gpus) ? gpus.length : 0;

        container.innerHTML = `
            <div class="page-enter">
                <div class="page-header">
                    <h1>User Management</h1>
                    <p>Create users, manage roles, and assign GPU access</p>
                </div>
                <div class="submit-layout">
                    <div class="card">
                        <div class="card-header"><span class="card-title">Create New User</span></div>
                        <form id="create-user-form">
                            <div class="form-group">
                                <label class="form-label">Username</label>
                                <input type="text" class="form-input" id="new-username" placeholder="e.g. jsmith" required>
                            </div>
                            <div class="form-group">
                                <label class="form-label">Email</label>
                                <input type="email" class="form-input" id="new-email" placeholder="user@latticept.com" required>
                            </div>
                            <div class="form-group">
                                <label class="form-label">Password</label>
                                <input type="password" class="form-input" id="new-password" placeholder="Minimum 6 characters" required minlength="6">
                            </div>
                            <div class="form-group">
                                <label class="form-label">Role</label>
                                <select class="form-select" id="new-role">
                                    <option value="user">User</option>
                                    <option value="admin">Admin</option>
                                </select>
                            </div>
                            <div class="form-group">
                                <label class="form-label">GPU Access</label>
                                <div class="gpu-select-grid" id="new-user-gpus">
                                    ${Array.from({length: gpuCount}, (_, i) => `
                                        <label class="gpu-select-card" data-gpu="${i}">
                                            <div class="form-checkbox">
                                                <input type="checkbox" name="gpu" value="${i}">
                                                <span class="gpu-select-name">GPU #${i}</span>
                                            </div>
                                            <div class="gpu-select-meta">${Array.isArray(gpus) && gpus[i] ? gpus[i].name : ''}</div>
                                        </label>
                                    `).join('')}
                                </div>
                            </div>
                            <button type="submit" class="btn btn-primary" style="width:100%;">Create User</button>
                        </form>
                    </div>
                    <div class="card">
                        <div class="card-header"><span class="card-title">Users</span></div>
                        <div id="users-table"></div>
                    </div>
                </div>
            </div>
        `;

        // Handle create user form
        document.getElementById('create-user-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const gpuCheckboxes = document.querySelectorAll('#new-user-gpus input[type="checkbox"]:checked');
            const gpuIds = Array.from(gpuCheckboxes).map(cb => parseInt(cb.value));

            const result = await api.post('/users', {
                username: document.getElementById('new-username').value,
                email: document.getElementById('new-email').value,
                password: document.getElementById('new-password').value,
                role: document.getElementById('new-role').value,
                gpu_ids: gpuIds,
            });

            if (result && result.user_id) {
                toast(`User created (ID #${result.user_id})`, 'success');
                document.getElementById('create-user-form').reset();
                await loadUsersTable(gpuCount);
            } else {
                toast(result?.error || 'Failed to create user', 'error');
            }
        });

        await loadUsersTable(gpuCount);
    }

    async function loadUsersTable(gpuCount) {
        const users = await api.get('/users');
        const tableEl = document.getElementById('users-table');
        if (!tableEl) return;
        if (!Array.isArray(users)) {
            tableEl.innerHTML = '<div class="empty-state"><p>Unable to load users. Admin access required.</p></div>';
            return;
        }

        tableEl.innerHTML = `
            <div class="table-container">
                <table class="data-table">
                    <thead>
                        <tr><th>ID</th><th>Username</th><th>Email</th><th>Role</th><th>GPU Access</th><th>Created</th><th>Actions</th></tr>
                    </thead>
                    <tbody>
                        ${users.map(u => `
                            <tr>
                                <td class="text-mono">#${u.id}</td>
                                <td>${escapeHtml(u.username)}</td>
                                <td class="text-sm">${escapeHtml(u.email)}</td>
                                <td><span class="badge ${u.role === 'admin' ? 'badge-completed' : 'badge-queued'}">${u.role}</span></td>
                                <td class="text-sm text-mono">${u.role === 'admin' ? '<span class="text-muted">All</span>' : (u.gpu_access && u.gpu_access.length > 0 ? u.gpu_access.map(g => `#${g}`).join(', ') : '<span class="text-muted">None</span>')}</td>
                                <td class="text-sm text-muted">${formatTime(u.created_at)}</td>
                                <td>
                                    <div class="flex gap-2">
                                        ${u.id !== state.user?.id ? `
                                            <button class="btn btn-secondary btn-sm" onclick="window.mstarApp.editUser(${u.id}, '${escapeHtml(u.role)}', ${JSON.stringify(u.gpu_access || [])}, ${gpuCount})">Edit</button>
                                            <button class="btn btn-danger btn-sm" onclick="window.mstarApp.deleteUser(${u.id})">Delete</button>
                                        ` : '<span class="text-muted text-sm">You</span>'}
                                    </div>
                                </td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        `;
    }

    function editUser(userId, currentRole, currentGpus, gpuCount) {
        const modal = document.getElementById('output-modal');
        const title = document.getElementById('output-modal-title');
        const modalBody = document.querySelector('.modal-body');
        const modalFooter = document.querySelector('.modal-footer');

        title.textContent = `Edit User #${userId}`;
        modal.style.display = 'flex';

        modalBody.innerHTML = `
            <div class="form-group">
                <label class="form-label">Role</label>
                <select class="form-select" id="edit-role">
                    <option value="user" ${currentRole === 'user' ? 'selected' : ''}>User</option>
                    <option value="admin" ${currentRole === 'admin' ? 'selected' : ''}>Admin</option>
                </select>
            </div>
            <div class="form-group">
                <label class="form-label">GPU Access</label>
                <div class="gpu-select-grid" id="edit-user-gpus">
                    ${Array.from({length: gpuCount}, (_, i) => `
                        <label class="gpu-select-card ${currentGpus.includes(i) ? 'selected' : ''}" data-gpu="${i}">
                            <div class="form-checkbox">
                                <input type="checkbox" name="gpu" value="${i}" ${currentGpus.includes(i) ? 'checked' : ''}>
                                <span class="gpu-select-name">GPU #${i}</span>
                            </div>
                        </label>
                    `).join('')}
                </div>
            </div>
        `;

        // Toggle selected styling on GPU cards
        modalBody.querySelectorAll('.gpu-select-card').forEach(card => {
            const cb = card.querySelector('input[type="checkbox"]');
            cb.addEventListener('change', () => card.classList.toggle('selected', cb.checked));
        });

        modalFooter.innerHTML = `<button class="btn btn-primary" id="save-user-btn">Save Changes</button>`;
        document.getElementById('save-user-btn').addEventListener('click', async () => {
            const gpuCheckboxes = document.querySelectorAll('#edit-user-gpus input[type="checkbox"]:checked');
            const gpuIds = Array.from(gpuCheckboxes).map(cb => parseInt(cb.value));
            const role = document.getElementById('edit-role').value;

            const result = await api.put(`/users/${userId}`, { role, gpu_ids: gpuIds });
            if (result && result.message) {
                toast(result.message, 'success');
                modal.style.display = 'none';
                handleRoute(); // Refresh admin page
            } else {
                toast(result?.error || 'Failed to update user', 'error');
            }
        });
    }

    // ============================================================
    // Render: Settings
    // ============================================================
    async function renderSettings(container) {
        const versions = await api.get('/versions') || [];

        container.innerHTML = `
            <div class="page-enter">
                <div class="page-header">
                    <h1>Settings</h1>
                    <p>Manage M-Star CFD solver versions and system configuration</p>
                </div>
                <div class="submit-layout">
                    <div>
                        <div class="card">
                            <div class="card-header"><span class="card-title">Solver Updates</span></div>
                            <div style="padding: 1rem 1.5rem;">
                                <p class="text-muted text-sm" style="margin-bottom: 1rem;">
                                    Download and install the latest M-Star CFD nightly build. This will fetch the latest version,
                                    copy the license file, and update all <code>*-latest</code> symlinks.
                                </p>
                                <div id="install-version-status" style="display:none; margin-bottom: 1rem;"></div>
                                <button class="btn btn-primary" id="install-version-btn" style="width: 100%;">
                                    <span id="install-version-text">\u2b07 Install Latest M-Star Version</span>
                                </button>
                            </div>
                        </div>
                    </div>
                    <div class="card">
                        <div class="card-header"><span class="card-title">Installed Versions</span></div>
                        <div class="table-container">
                            <table class="data-table">
                                <thead>
                                    <tr><th>Version</th><th>Status</th><th>Install Path</th></tr>
                                </thead>
                                <tbody>
                                    ${versions.map(v => `
                                        <tr>
                                            <td class="text-mono">${v.version}</td>
                                            <td>${v.is_latest
                                                ? '<span class="badge badge-completed">latest</span>'
                                                : '<span class="badge badge-queued">installed</span>'}</td>
                                            <td class="text-muted text-sm text-mono">mstarcfd-${v.version}/</td>
                                        </tr>
                                    `).join('')}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            </div>
        `;

        // Install button handler
        document.getElementById('install-version-btn').addEventListener('click', async function() {
            if (!confirm('Download and install the latest M-Star CFD nightly?\n\nThis will download, copy the license, and update all *-latest symlinks.')) return;

            var btn = document.getElementById('install-version-btn');
            var textEl = document.getElementById('install-version-text');
            var statusEl = document.getElementById('install-version-status');

            btn.disabled = true;
            textEl.textContent = '\u23f3 Downloading and installing...';
            statusEl.style.display = 'block';
            statusEl.innerHTML = '<div class="badge badge-running" style="display:inline-block;">Installing...</div>';

            try {
                var result = await api.post('/admin/install-version');
                if (result && result.success) {
                    var output = (result.download_output || '').trim() + '\n' + (result.symlink_output || '').trim();
                    statusEl.innerHTML =
                        '<div class="badge badge-completed" style="display:inline-block; margin-bottom: 0.5rem;">\u2713 Installed v' + result.latest_version + '</div>' +
                        '<pre style="background:var(--bg-tertiary);color:var(--text-secondary);padding:0.75rem;border-radius:6px;font-size:0.75rem;max-height:200px;overflow-y:auto;white-space:pre-wrap;margin:0">' + output.replace(/</g, '&lt;') + '</pre>';
                    toast('M-Star v' + result.latest_version + ' installed (' + result.total_versions + ' versions)', 'success');
                    setTimeout(function() { handleRoute(); }, 1500);
                } else {
                    statusEl.innerHTML = '<div class="badge badge-failed" style="display:inline-block;">Failed: ' + (result && result.error ? result.error : 'Unknown error') + '</div>';
                    toast((result && result.error) || 'Install failed', 'error');
                }
            } catch (e) {
                statusEl.innerHTML = '<div class="badge badge-failed" style="display:inline-block;">Error: ' + e.message + '</div>';
                toast('Install failed: ' + e.message, 'error');
            }

            btn.disabled = false;
            textEl.textContent = '\u2b07 Install Latest M-Star Version';
        });
    }

    // ============================================================
    // Output Viewer with Draggable Progress Panels
    // ============================================================

    // Global state for progress viewer
    let progressState = {
        jobId: null,
        data: null,
        panels: [],       // { id, varName, interval, timerId, element }
        masterTimer: null,
        panelIdCounter: 0,
        dragState: null,
    };

    // Color palette for chart lines
    const CHART_COLORS = [
        '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
        '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#14b8a6',
    ];

    // Statistics overlay colors (semi-transparent, distinct from data)
    const STAT_COLORS = {
        cumAvg: '#fbbf24',  // amber-400
        movAvg: '#34d399',  // emerald-400
    };

    // Compute cumulative (running) average
    function computeCumulativeAvg(yData) {
        const result = [];
        let sum = 0;
        for (let i = 0; i < yData.length; i++) {
            const v = parseFloat(yData[i]);
            if (isNaN(v)) { result.push(null); continue; }
            sum += v;
            result.push(sum / (i + 1));
        }
        return result;
    }

    // Compute moving average with a given window size (number of points)
    function computeMovingAvg(yData, windowSize) {
        const result = [];
        const w = Math.max(1, Math.round(windowSize));
        for (let i = 0; i < yData.length; i++) {
            const start = Math.max(0, i - w + 1);
            let sum = 0, count = 0;
            for (let j = start; j <= i; j++) {
                const v = parseFloat(yData[j]);
                if (!isNaN(v)) { sum += v; count++; }
            }
            result.push(count > 0 ? sum / count : null);
        }
        return result;
    }

    // Build Plotly traces for statistics overlays
    function buildStatTraces(xData, yData, panel) {
        const traces = [];
        if (panel.showCumAvg) {
            traces.push({
                x: xData, y: computeCumulativeAvg(yData),
                type: 'scatter', mode: 'lines',
                name: 'Cumulative Avg',
                line: { color: STAT_COLORS.cumAvg, width: 2, dash: 'dash' },
                hovertemplate: 'Cum. Avg: %{y:.4g}<extra></extra>',
            });
        }
        if (panel.showMovAvg) {
            traces.push({
                x: xData, y: computeMovingAvg(yData, panel.movAvgWindow || 20),
                type: 'scatter', mode: 'lines',
                name: `Moving Avg (${panel.movAvgWindow || 20})`,
                line: { color: STAT_COLORS.movAvg, width: 2, dash: 'dot' },
                hovertemplate: 'Mov. Avg: %{y:.4g}<extra></extra>',
            });
        }
        return traces;
    }

    async function viewOutput(jobId) {
        progressState.jobId = jobId;
        progressState.panels = [];
        progressState.panelIdCounter = 0;

        // Stop old master timer
        if (progressState.masterTimer) clearInterval(progressState.masterTimer);

        const modal = document.getElementById('output-modal');
        const title = document.getElementById('output-modal-title');
        const modalBody = document.querySelector('.modal-body');
        const modalFooter = document.querySelector('.modal-footer');

        title.textContent = `Job #${jobId}`;
        modal.style.display = 'flex';

        // Build the full progress dashboard
        modalBody.innerHTML = `
            <div class="progress-tabs">
                <button class="btn btn-secondary btn-sm active" id="tab-progress" onclick="window.mstarApp.switchTab('progress')">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
                    Dashboard
                </button>
                <button class="btn btn-secondary btn-sm" id="tab-panels" onclick="window.mstarApp.switchTab('panels')">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
                    Charts
                </button>
                <button class="btn btn-secondary btn-sm" id="tab-files" onclick="window.mstarApp.switchTab('files')">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                    File Browser
                </button>
                <button class="btn btn-secondary btn-sm" id="tab-log" onclick="window.mstarApp.switchTab('log')">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                    Raw Log
                </button>
                <span style="flex:1;"></span>
                <button class="btn btn-secondary btn-sm report-generate-btn" id="btn-generate-report" onclick="window.mstarApp.generateReport()" title="Generate PDF report of selected charts" style="display:none;">
                    📄 Generate Report <span id="report-count-badge" class="report-count-badge" style="display:none;">0</span>
                </button>
            </div>
            <div id="view-progress" class="progress-dashboard">
                <div id="progress-summary-cards" class="stats-grid" style="margin-bottom:16px;"></div>
                <div id="progress-sections"></div>
            </div>
            <div id="view-panels" class="charts-split-layout" style="display:none;">
                <div class="charts-sidebar" id="charts-sidebar">
                    <div class="charts-sidebar-header">
                        <span style="font-weight:600;font-size:13px;color:var(--text-primary);">Variables</span>
                        <button class="btn-icon" id="toggle-sidebar-btn" title="Collapse sidebar">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
                        </button>
                    </div>
                    <div class="charts-sidebar-controls">
                        <select id="add-panel-var" class="form-control" style="width:100%;font-size:11px;padding:6px 8px;">
                            <option value="">Select variable...</option>
                        </select>
                        <button class="btn btn-primary btn-sm" onclick="window.mstarApp.addPanelFromSelect()" style="width:100%;justify-content:center;font-size:11px;">+ Add Chart</button>
                        <div style="display:flex;gap:4px;">
                            <button class="btn btn-secondary btn-sm" onclick="window.mstarApp.saveChartSelection()" style="flex:1;justify-content:center;font-size:10px;" title="Save chart selection">
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                                Save
                            </button>
                            <button class="btn btn-secondary btn-sm" onclick="window.mstarApp.loadChartSelection()" style="flex:1;justify-content:center;font-size:10px;" title="Load chart selection">
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                                Load
                            </button>
                            <button class="btn btn-secondary btn-sm" onclick="window.mstarApp.addDefaultPanels()" style="flex:1;justify-content:center;font-size:10px;">Auto</button>
                        </div>
                    </div>
                    <div id="stats-categories" class="charts-sidebar-categories"></div>
                </div>
                <div class="charts-main-area">
                    <div id="panels-container" class="panels-container"></div>
                    <div id="charts-empty-state" class="charts-empty-state">
                        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" style="opacity:0.3;">
                            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
                        </svg>
                        <p style="margin:12px 0 4px;font-size:14px;color:var(--text-secondary);">No charts yet</p>
                        <p style="font-size:12px;color:var(--text-muted);">Select variables from the sidebar or click "Auto" to get started</p>
                    </div>
                </div>
            </div>
            <div id="view-log" style="display:none;">
                <pre id="output-content" class="output-content" style="max-height:600px;">Loading...</pre>
            </div>
            <div id="view-files" style="display:none;">
                <div id="file-browser-breadcrumb" class="file-breadcrumb"></div>
                <div id="file-browser-content"></div>
            </div>
        `;
        modalFooter.innerHTML = '';

        // Tab switching
        window.mstarApp.switchTab = function(tab) {
            ['progress', 'panels', 'log', 'files'].forEach(t => {
                const el = document.getElementById(`view-${t}`);
                const btn = document.getElementById(`tab-${t}`);
                if (el) el.style.display = t === tab ? (t === 'panels' ? 'flex' : 'block') : 'none';
                if (btn) btn.classList.toggle('active', t === tab);
            });
            if (tab === 'log') loadRawLog(jobId);
            if (tab === 'files') loadFileBrowser(jobId, '');
            if (tab === 'panels') {
                // Load stats file categories
                loadStatsFiles(jobId);
                // Re-render all charts (they may have been created while hidden)
                setTimeout(() => {
                    progressState.panels.forEach(p => {
                        const chartEl = document.getElementById(`panel-chart-${p.id}`);
                        if (chartEl) {
                            Plotly.purge(chartEl);
                            updatePanel(p);
                        }
                    });
                }, 150);
            }
        };

        // Sidebar toggle
        document.getElementById('toggle-sidebar-btn')?.addEventListener('click', () => {
            document.getElementById('charts-sidebar')?.classList.toggle('collapsed');
        });

        // Empty state helper
        function updateChartsEmptyState() {
            const emptyEl = document.getElementById('charts-empty-state');
            if (emptyEl) emptyEl.style.display = progressState.panels.length > 0 ? 'none' : 'flex';
        }
        updateChartsEmptyState();

        // Panel management functions
        window.mstarApp.addPanelFromSelect = function() {
            const sel = document.getElementById('add-panel-var');
            if (sel.value) {
                // Value format: "filename|column"
                const [filename, column] = sel.value.split('|');
                addStatsChartPanel(jobId, filename, column);
                sel.value = '';
            }
        };

        window.mstarApp.addDefaultPanels = async function() {
            // Clear existing panels
            progressState.panels.forEach(p => {
                if (p.timerId) clearInterval(p.timerId);
            });
            progressState.panels = [];
            document.getElementById('panels-container').innerHTML = '';
            // Clear all button active states
            document.querySelectorAll('.stats-col-btn.active').forEach(b => b.classList.remove('active'));

            // Fetch stats file listing and add key variables
            const resp = await api.get(`/jobs/${jobId}/stats`);
            if (!resp || !resp.files) return;

            // Auto-pick interesting columns from each file (skip the first Time column)
            const priorities = [
                { file: 'Fluid.txt', cols: ['Kinetic Energy [J]', 'Max Velocity [m/s]'] },
                { file: 'Timing.txt', cols: ['Lattice Efficiency [MUPS]'] },
                { file: 'MemoryUsage.txt', cols: ['Used GPU Memory From System [GB]'] },
            ];

            for (const prio of priorities) {
                const f = resp.files.find(sf => sf.filename === prio.file);
                if (!f) continue;
                for (const col of prio.cols) {
                    if (f.columns.includes(col)) {
                        addStatsChartPanel(jobId, prio.file, col);
                    }
                }
            }

            // If no priority matches, add the first plottable column from each file
            if (progressState.panels.length === 0) {
                for (const f of resp.files.slice(0, 4)) {
                    if (f.columns.length > 1) {
                        addStatsChartPanel(jobId, f.filename, f.columns[1]);
                    }
                }
            }
            syncButtonStates();
        };

        window.mstarApp.removePanel = function(panelId) {
            const idx = progressState.panels.findIndex(p => p.id === panelId);
            if (idx >= 0) {
                const panel = progressState.panels[idx];
                if (panel.timerId) clearInterval(panel.timerId);
                const el = document.getElementById(`panel-${panelId}`);
                if (el) el.remove();
                // Deactivate the corresponding button
                const btn = document.querySelector(`.stats-col-btn[data-panel-key="${panel.panelKey}"]`);
                if (btn) btn.classList.remove('active');
                progressState.panels.splice(idx, 1);
                updateChartsEmptyState();
            }
        };

        window.mstarApp.setPanelInterval = function(panelId, seconds) {
            const panel = progressState.panels.find(p => p.id === panelId);
            if (!panel) return;
            panel.interval = seconds * 1000;
            if (panel.timerId) clearInterval(panel.timerId);
            panel.timerId = setInterval(() => updatePanel(panel), panel.interval);
        };

        // Toggle a stat overlay on/off for a panel
        window.mstarApp.toggleStat = function(panelId, stat) {
            const panel = progressState.panels.find(p => p.id === panelId);
            if (!panel) return;
            if (stat === 'cumAvg') {
                panel.showCumAvg = !panel.showCumAvg;
                const btn = document.getElementById(`stat-cumavg-${panelId}`);
                if (btn) btn.classList.toggle('active', panel.showCumAvg);
            } else if (stat === 'movAvg') {
                panel.showMovAvg = !panel.showMovAvg;
                const btn = document.getElementById(`stat-movavg-${panelId}`);
                if (btn) btn.classList.toggle('active', panel.showMovAvg);
                // Show/hide window input
                const windowLabel = document.getElementById(`stat-window-label-${panelId}`);
                if (windowLabel) windowLabel.style.display = panel.showMovAvg ? 'inline-flex' : 'none';
            }
            updatePanel(panel);
        };

        // Set moving average window and re-render
        window.mstarApp.setMovAvgWindow = function(panelId, windowSize) {
            const panel = progressState.panels.find(p => p.id === panelId);
            if (!panel) return;
            panel.movAvgWindow = Math.max(2, Math.min(500, windowSize || 20));
            updatePanel(panel);
        };

        // Toggle report inclusion for a panel
        window.mstarApp.toggleReport = function(panelId) {
            const panel = progressState.panels.find(p => p.id === panelId);
            if (!panel) return;
            panel.inReport = !panel.inReport;
            const btn = document.getElementById(`stat-report-${panelId}`);
            if (btn) btn.classList.toggle('active', panel.inReport);
            // Visual indicator on the panel card
            const panelEl = document.getElementById(`panel-${panelId}`);
            if (panelEl) panelEl.classList.toggle('in-report', panel.inReport);
            updateReportBadge();
        };

        // Update the report badge count on the Generate Report button
        function updateReportBadge() {
            const count = progressState.panels.filter(p => p.inReport).length;
            const btn = document.getElementById('btn-generate-report');
            const badge = document.getElementById('report-count-badge');
            if (btn) btn.style.display = count > 0 ? 'inline-flex' : 'none';
            if (badge) {
                badge.textContent = count;
                badge.style.display = count > 0 ? 'inline' : 'none';
            }
        }

        // Generate a PDF report of all panels marked for report
        window.mstarApp.generateReport = async function() {
            const reportPanels = progressState.panels.filter(p => p.inReport);
            if (reportPanels.length === 0) {
                alert('No charts selected for report. Click 📌 Report on charts to include them.');
                return;
            }

            // Check jsPDF is loaded
            if (!window.jspdf || !window.jspdf.jsPDF) {
                alert('PDF library not loaded. Please check your internet connection and refresh the page.');
                return;
            }

            const btn = document.getElementById('btn-generate-report');
            const origText = btn.innerHTML;
            btn.innerHTML = '⏳ Generating...';
            btn.disabled = true;

            try {
                const { jsPDF } = window.jspdf;
                const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
                const pageW = pdf.internal.pageSize.getWidth();
                const pageH = pdf.internal.pageSize.getHeight();
                const margin = 12;
                const chartW = pageW - margin * 2;
                const chartH = (pageH - margin * 3) / 2;  // 2 charts per page

                // Title page
                pdf.setFontSize(24);
                pdf.setTextColor(40, 40, 40);
                pdf.text('M-Star Simulation Report', pageW / 2, 40, { align: 'center' });
                pdf.setFontSize(12);
                pdf.setTextColor(100, 100, 100);
                const jobTitle = document.getElementById('output-modal-title')?.textContent || '';
                pdf.text(jobTitle, pageW / 2, 52, { align: 'center' });
                pdf.text(`Generated: ${new Date().toLocaleString()}`, pageW / 2, 60, { align: 'center' });
                pdf.text(`Charts: ${reportPanels.length}`, pageW / 2, 68, { align: 'center' });

                // Render each chart
                let chartIndex = 0;
                for (const panel of reportPanels) {
                    const chartEl = document.getElementById(`panel-chart-${panel.id}`);
                    if (!chartEl) { console.warn('Chart element not found for panel', panel.id); continue; }

                    // Temporarily update plot background for white-paper export
                    await Plotly.relayout(chartEl, {
                        'paper_bgcolor': '#ffffff',
                        'plot_bgcolor': '#f8f9fa',
                        'font.color': '#333333',
                        'xaxis.gridcolor': '#dee2e6',
                        'yaxis.gridcolor': '#dee2e6',
                    });

                    // Export chart as PNG
                    const imgData = await Plotly.toImage(chartEl, {
                        format: 'png', width: 1200, height: 480, scale: 2,
                    });

                    // Restore dark theme
                    await Plotly.relayout(chartEl, {
                        'paper_bgcolor': 'transparent',
                        'plot_bgcolor': 'rgba(15, 20, 35, 0.6)',
                        'font.color': '#9ca3af',
                        'xaxis.gridcolor': 'rgba(99, 115, 156, 0.08)',
                        'yaxis.gridcolor': 'rgba(99, 115, 156, 0.08)',
                    });

                    // Start new page at chart 0, 2, 4, ...
                    if (chartIndex % 2 === 0) {
                        pdf.addPage();
                    }

                    const yPos = chartIndex % 2 === 0 ? margin : margin + chartH + margin;

                    // Chart title
                    pdf.setFontSize(11);
                    pdf.setTextColor(40, 40, 40);
                    const title = panel.varName || `${(panel.filename || '').replace('.txt', '')} / ${panel.column || ''}`;
                    pdf.text(title, margin, yPos + 4);

                    // Chart image
                    pdf.addImage(imgData, 'PNG', margin, yPos + 6, chartW, chartH - 8);

                    chartIndex++;
                }

                if (chartIndex === 0) {
                    alert('No chart images could be exported. Make sure the charts are visible.');
                    return;
                }

                // Remove the blank first page
                pdf.deletePage(1);

                // Download
                const jobName = jobTitle.replace(/[^a-zA-Z0-9]/g, '_') || 'simulation';
                pdf.save(`${jobName}_report.pdf`);
                console.log(`Report saved: ${jobName}_report.pdf (${chartIndex} charts)`);
            } catch (err) {
                console.error('Report generation failed:', err);
                alert('Failed to generate report: ' + err.message);
            } finally {
                btn.innerHTML = origText;
                btn.disabled = false;
            }
        };

        // Sync all button active states with current panels
        function syncButtonStates() {
            document.querySelectorAll('.stats-col-btn[data-panel-key]').forEach(btn => {
                const key = btn.getAttribute('data-panel-key');
                if (progressState.panels.find(p => p.panelKey === key)) {
                    btn.classList.add('active');
                } else {
                    btn.classList.remove('active');
                }
            });
        }

        // Save current chart selections to a JSON file (includes report + stat state)
        window.mstarApp.saveChartSelection = function() {
            const selections = progressState.panels.map(p => ({
                filename: p.filename,
                column: p.column,
                varName: p.varName,
                type: p.type,
                inReport: !!p.inReport,
                showCumAvg: !!p.showCumAvg,
                showMovAvg: !!p.showMovAvg,
                movAvgWindow: p.movAvgWindow || 20,
            }));
            const json = JSON.stringify({ selections }, null, 2);
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'chart_selection.json';
            a.click();
            URL.revokeObjectURL(url);
        };

        // Load chart selections from a JSON file (restores report + stat state)
        window.mstarApp.loadChartSelection = function() {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json';
            input.onchange = async (e) => {
                const file = e.target.files[0];
                if (!file) return;
                try {
                    const text = await file.text();
                    const data = JSON.parse(text);
                    if (!data.selections || !Array.isArray(data.selections)) {
                        alert('Invalid chart selection file');
                        return;
                    }
                    // Clear existing panels
                    progressState.panels.forEach(p => {
                        if (p.timerId) clearInterval(p.timerId);
                    });
                    progressState.panels = [];
                    document.getElementById('panels-container').innerHTML = '';

                    // Add each selection
                    for (const sel of data.selections) {
                        if (sel.filename && sel.column) {
                            addStatsChartPanel(jobId, sel.filename, sel.column);
                        }
                    }

                    // Restore stat and report state after panels are created
                    setTimeout(() => {
                        for (const sel of data.selections) {
                            const panelKey = `${sel.filename}|${sel.column}`;
                            const panel = progressState.panels.find(p => p.panelKey === panelKey);
                            if (panel) {
                                if (sel.showCumAvg) window.mstarApp.toggleStat(panel.id, 'cumAvg');
                                if (sel.showMovAvg) {
                                    panel.movAvgWindow = sel.movAvgWindow || 20;
                                    const winInput = document.getElementById(`stat-window-${panel.id}`);
                                    if (winInput) winInput.value = panel.movAvgWindow;
                                    window.mstarApp.toggleStat(panel.id, 'movAvg');
                                }
                                if (sel.inReport) window.mstarApp.toggleReport(panel.id);
                            }
                        }
                        syncButtonStates();
                        updateReportBadge();
                    }, 500);
                } catch (err) {
                    alert('Failed to load chart selection: ' + err.message);
                }
            };
            input.click();
        };

        // Load initial data
        await refreshProgressData();
        buildDashboard();

        // Master refresh timer (dashboard stats) — every 5 seconds
        progressState.masterTimer = setInterval(async () => {
            if (modal.style.display === 'none') {
                clearInterval(progressState.masterTimer);
                progressState.panels.forEach(p => { if (p.timerId) clearInterval(p.timerId); });
                return;
            }
            await refreshProgressData();
            buildDashboard();
            // Update all panels (ones without their own timer)
            progressState.panels.forEach(p => {
                if (!p.timerId) updatePanel(p);
            });
        }, 5000);
    }

    async function refreshProgressData() {
        const data = await api.get(`/jobs/${progressState.jobId}/progress`);
        if (data) progressState.data = data;
    }

    function buildDashboard() {
        const d = progressState.data;
        if (!d) return;

        const cardsEl = document.getElementById('progress-summary-cards');
        const sectionsEl = document.getElementById('progress-sections');
        if (!cardsEl || !sectionsEl) return;

        // Update title
        const title = document.getElementById('output-modal-title');
        if (title) {
            title.textContent = `Job #${d.job_id} — ${d.mstar_version ? 'M-Star ' + d.mstar_version : ''} (${d.status})`;
        }

        if (!d.latest) {
            if (d.status === 'failed') {
                cardsEl.innerHTML = `
                    <div class="stat-card red">
                        <div class="stat-value" style="font-size:16px;">❌ Job Failed</div>
                        <div class="stat-label">${d.error_message || 'No error details available'}</div>
                    </div>
                `;
            } else {
                cardsEl.innerHTML = `
                    <div class="stat-card blue">
                        <div class="stat-value" style="font-size:18px;">⏳ Initializing Lattice</div>
                        <div class="stat-label">Status — waiting for first output block</div>
                    </div>
                `;
            }
            sectionsEl.innerHTML = '';
            return;
        }

        // Progress summary cards (top-level key metrics)
        const progress = d.latest['Progress'] || {};
        const perf = d.latest['Performance'] || {};
        const completion = parseFloat(progress['Completion (%)']) || 0;
        const simTime = parseFloat(progress['Time (s)']) || 0;
        const wallTime = parseFloat(progress['Elapsed Wall Time (hr)']) || 0;
        const etr = progress['Estimated Time Remaining (hr)'] || 'N/A';
        const mups = parseFloat(perf['Lattice (MUPS)']) || 0;
        const gpuUsed = parseFloat(perf['Used GPU Memory (GB)']) || 0;
        const gpuTotal = parseFloat(perf['GPU Memory Capacity (GB)']) || 0;

        cardsEl.innerHTML = `
            <div class="stat-card blue">
                <div class="stat-value">${completion.toFixed(1)}%</div>
                <div class="stat-label">Completion</div>
            </div>
            <div class="stat-card green">
                <div class="stat-value">${simTime.toFixed(3)}s</div>
                <div class="stat-label">Sim Time / ${d.total_runtime || '?'}s</div>
            </div>
            <div class="stat-card amber">
                <div class="stat-value">${mups.toFixed(1)}</div>
                <div class="stat-label">MLUPS</div>
            </div>
            <div class="stat-card purple">
                <div class="stat-value">${typeof etr === 'string' && isNaN(parseFloat(etr)) ? etr : parseFloat(etr).toFixed(2) + 'h'}</div>
                <div class="stat-label">ETR</div>
            </div>
            <div class="stat-card red">
                <div class="stat-value">${gpuUsed.toFixed(1)} GB</div>
                <div class="stat-label">GPU RAM / ${gpuTotal.toFixed(0)} GB</div>
            </div>
        `;

        // Build ALL sections as expandable bubble grids
        const sectionOrder = ['General', 'Fluid Stats', 'Inlet Stats', 'Outlet Stats', 'Particle Stats', 'Performance', 'Progress'];
        const allSections = Object.keys(d.latest).sort((a, b) => {
            const ia = sectionOrder.indexOf(a);
            const ib = sectionOrder.indexOf(b);
            if (ia >= 0 && ib >= 0) return ia - ib;
            if (ia >= 0) return -1;
            if (ib >= 0) return 1;
            return a.localeCompare(b);
        });

        const bubbleColors = ['blue', 'green', 'amber', 'purple', 'red', 'cyan', 'orange', 'pink'];
        let bubbleIdx = 0;

        sectionsEl.innerHTML = allSections.map(section => {
            const kvs = d.latest[section];
            if (!kvs || typeof kvs !== 'object') return '';
            const keys = Object.keys(kvs).sort();
            return `
                <div class="stats-section">
                    <div class="stats-section-header" onclick="this.parentNode.classList.toggle('collapsed')">
                        <span>${escapeHtml(section)}</span>
                        <span class="stats-section-count">${keys.length} vars</span>
                        <svg class="stats-section-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
                    </div>
                    <div class="stats-section-body">
                        <div class="stat-bubbles-grid">
                            ${keys.map(k => {
                                const v = kvs[k];
                                const varKey = section === 'General' ? k : `${section} / ${k}`;
                                const hasTimeSeries = d.time_series && d.time_series[varKey];
                                const color = bubbleColors[(bubbleIdx++) % bubbleColors.length];
                                return `<div class="stat-card mini ${color}">
                                    <div class="stat-value">${escapeHtml(String(v))}</div>
                                    <div class="stat-label">${escapeHtml(k)}</div>
                                    ${hasTimeSeries ? `<button class="stat-chart-btn" title="Add chart" onclick="window.mstarApp.switchTab('panels'); window.mstarApp._addPanel('${escapeHtml(varKey)}')">
                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
                                    </button>` : ''}
                                </div>`;
                            }).join('')}
                        </div>
                    </div>
                </div>
            `;
        }).join('');

        // Register the _addPanel helper (used by inline onclick)
        window.mstarApp._addPanel = function(varName) {
            addTimeSeriesPanel(varName);
        };
    }

    async function loadStatsFiles(jobId) {
        const resp = await api.get(`/jobs/${jobId}/stats`);
        if (!resp || !resp.files) return;

        const sel = document.getElementById('add-panel-var');
        const categoriesEl = document.getElementById('stats-categories');
        if (!sel || !categoriesEl) return;

        // Populate the select dropdown with all plottable columns
        let options = '<option value="">Select variable to chart...</option>';
        resp.files.forEach(f => {
            const cols = f.columns.filter(c => c !== 'Time [s]');
            if (cols.length === 0) return;
            options += `<optgroup label="${escapeHtml(f.category)}">`;
            cols.forEach(col => {
                options += `<option value="${escapeHtml(f.filename)}|${escapeHtml(col)}">${escapeHtml(col)}</option>`;
            });
            options += '</optgroup>';
        });
        sel.innerHTML = options;

        // Build stats category cards
        const catColors = ['blue', 'green', 'amber', 'purple', 'red', 'cyan', 'orange', 'pink'];
        categoriesEl.innerHTML = resp.files.map((f, fi) => {
            const cols = f.columns.filter(c => c !== 'Time [s]');
            if (cols.length === 0) return '';
            const color = catColors[fi % catColors.length];
            return `
                <div class="stats-category-card collapsed">
                    <div class="stats-category-header" onclick="this.parentNode.classList.toggle('collapsed')">
                        <div class="stats-category-info">
                            <span class="stats-category-title">${escapeHtml(f.category)}</span>
                            <span class="stats-category-meta">${cols.length} variables · ${f.row_count} timesteps</span>
                        </div>
                        <svg class="stats-section-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
                    </div>
                    <div class="stats-category-body">
                        ${cols.map(col => `
                            <button class="stats-col-btn ${color}" data-panel-key="${escapeHtml(f.filename)}|${escapeHtml(col)}" onclick="window.mstarApp._toggleStatsPanel('${escapeHtml(f.filename)}', '${escapeHtml(col)}', this)" title="Chart: ${escapeHtml(col)}">
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
                                ${escapeHtml(col)}
                            </button>
                        `).join('')}
                    </div>
                </div>
            `;
        }).join('');

        // Register toggle helper (add or remove)
        window.mstarApp._toggleStatsPanel = function(filename, column, btnEl) {
            const panelKey = `${filename}|${column}`;
            const existing = progressState.panels.find(p => p.panelKey === panelKey);
            if (existing) {
                // Remove the panel
                window.mstarApp.removePanel(existing.id);
                btnEl.classList.remove('active');
            } else {
                // Add the panel
                addStatsChartPanel(jobId, filename, column);
                btnEl.classList.add('active');
            }
        };

        // Keep legacy helper for select dropdown
        window.mstarApp._addStatsPanel = function(filename, column) {
            addStatsChartPanel(jobId, filename, column);
            syncButtonStates();
        };
    }



    function updatePanel(panel) {
        if (panel.type === 'timeseries') {
            updateTimeSeriesPanel(panel);
        } else {
            updateStatsPanel(panel);
        }
    }
    function addTimeSeriesPanel(varName, intervalMs = 5000) {
        const id = ++progressState.panelIdCounter;
        const container = document.getElementById('panels-container');
        if (!container) return;

        // Check if already exists
        if (progressState.panels.find(p => p.varName === varName)) return;

        const colorIdx = (progressState.panels.length) % CHART_COLORS.length;
        const shortName = varName.split(' / ').pop();
        const category = varName.split(' / ')[0] || 'General';

        const panelEl = document.createElement('div');
        panelEl.className = 'chart-panel';
        panelEl.id = `panel-${id}`;
        panelEl.draggable = true;

        panelEl.innerHTML = `
            <div class="chart-panel-header" data-panel-id="${id}">
                <span class="chart-panel-title" title="${escapeHtml(varName)}">${escapeHtml(shortName)}</span>
                <div class="chart-panel-controls">
                    <span class="chart-panel-source">${escapeHtml(category)}</span>
                    <select class="chart-interval-select" onchange="window.mstarApp.setPanelInterval(${id}, parseInt(this.value))">
                        <option value="2">2s</option>
                        <option value="5" selected>5s</option>
                        <option value="10">10s</option>
                        <option value="30">30s</option>
                        <option value="60">60s</option>
                    </select>
                    <button class="btn-icon" onclick="window.mstarApp.removePanel(${id})" title="Remove">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                </div>
            </div>
            <div class="chart-stats-bar">
                <button class="chart-stat-toggle" id="stat-cumavg-${id}" onclick="window.mstarApp.toggleStat(${id},'cumAvg')" title="Cumulative Average">
                    <span class="stat-swatch" style="background:${STAT_COLORS.cumAvg}"></span> Cum. Avg
                </button>
                <button class="chart-stat-toggle" id="stat-movavg-${id}" onclick="window.mstarApp.toggleStat(${id},'movAvg')" title="Moving Average">
                    <span class="stat-swatch" style="background:${STAT_COLORS.movAvg}"></span> Mov. Avg
                </button>
                <label class="chart-stat-window" id="stat-window-label-${id}" style="display:none;" title="Moving average window (number of points)">
                    Window: <input type="number" class="chart-stat-window-input" id="stat-window-${id}" value="20" min="2" max="500" onchange="window.mstarApp.setMovAvgWindow(${id}, parseInt(this.value))">
                </label>
                <span style="flex:1;"></span>
                <button class="chart-stat-toggle chart-report-toggle" id="stat-report-${id}" onclick="window.mstarApp.toggleReport(${id})" title="Add to PDF report">
                    📌 Report
                </button>
            </div>
            <div class="chart-panel-body">
                <div id="panel-chart-${id}" style="width:100%;height:280px;"></div>
            </div>
        `;

        container.appendChild(panelEl);

        // Drag handling
        panelEl.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('text/plain', id.toString());
            panelEl.classList.add('dragging');
        });
        panelEl.addEventListener('dragend', () => panelEl.classList.remove('dragging'));
        panelEl.addEventListener('dragover', (e) => {
            e.preventDefault();
            const dragging = container.querySelector('.dragging');
            if (dragging && dragging !== panelEl) {
                const rect = panelEl.getBoundingClientRect();
                const midX = rect.left + rect.width / 2;
                if (e.clientX < midX) {
                    container.insertBefore(dragging, panelEl);
                } else {
                    container.insertBefore(dragging, panelEl.nextSibling);
                }
            }
        });

        const panel = {
            id, varName, type: 'timeseries',
            jobId: progressState.jobId,
            interval: intervalMs, timerId: null,
            color: CHART_COLORS[colorIdx],
            showCumAvg: false, showMovAvg: false, movAvgWindow: 20, inReport: false,
        };
        progressState.panels.push(panel);
        updateChartsEmptyState();

        // Render from existing progress data
        requestAnimationFrame(() => {
            setTimeout(() => {
                updateTimeSeriesPanel(panel);
                panel.timerId = setInterval(() => updateTimeSeriesPanel(panel), panel.interval);
            }, 50);
        });
    }

    function updateTimeSeriesPanel(panel) {
        const chartEl = document.getElementById(`panel-chart-${panel.id}`);
        if (!chartEl) return;

        const d = progressState.data;
        if (!d || !d.time_series || !d.time_series[panel.varName]) return;

        const series = d.time_series[panel.varName];
        const wt = d.wall_times || d.sim_times || [];
        const useSim = wt.every(t => t === 0);
        const xData = useSim ? (d.sim_times || []) : wt;
        if (series.length < 1) return;

        const mainTrace = {
            x: xData, y: series, type: 'scatter', mode: 'lines+markers',
            name: panel.varName.split(' / ').pop(),
            line: { color: panel.color, width: 2 },
            marker: { size: 3, color: panel.color },
            connectgaps: true,
        };
        const statTraces = buildStatTraces(xData, series, panel);
        const hasStats = statTraces.length > 0;

        Plotly.react(chartEl, [mainTrace, ...statTraces], {
            paper_bgcolor: 'transparent',
            plot_bgcolor: 'rgba(15, 20, 35, 0.6)',
            font: { family: 'Inter, sans-serif', size: 10, color: '#9ca3af' },
            height: 280,
            margin: { l: 55, r: 12, t: 8, b: 32 },
            xaxis: {
                title: { text: useSim ? 'Sim Time (s)' : 'Wall Time (hr)', font: { size: 10 } },
                gridcolor: 'rgba(99, 115, 156, 0.08)',
                zerolinecolor: 'rgba(99, 115, 156, 0.12)',
            },
            yaxis: {
                title: { text: panel.varName.split(' / ').pop(), font: { size: 10 } },
                gridcolor: 'rgba(99, 115, 156, 0.08)',
                zerolinecolor: 'rgba(99, 115, 156, 0.12)',
            },
            showlegend: hasStats,
            legend: { x: 0, y: 1.12, orientation: 'h', font: { size: 9 } },
        }, { responsive: true, displayModeBar: false });
    }

    function addStatsChartPanel(jobId, filename, column, intervalMs = 5000) {
        const id = ++progressState.panelIdCounter;
        const container = document.getElementById('panels-container');
        if (!container) return;

        const panelKey = `${filename}|${column}`;
        // Check if already exists
        if (progressState.panels.find(p => p.panelKey === panelKey)) return;

        const colorIdx = (progressState.panels.length) % CHART_COLORS.length;
        const category = filename.replace('.txt', '');
        const shortName = column.replace(/ \[.*\]/, '');

        const panelEl = document.createElement('div');
        panelEl.className = 'chart-panel';
        panelEl.id = `panel-${id}`;
        panelEl.draggable = true;

        panelEl.innerHTML = `
            <div class="chart-panel-header" data-panel-id="${id}">
                <span class="chart-panel-title" title="${escapeHtml(category)} / ${escapeHtml(column)}">${escapeHtml(shortName)}</span>
                <div class="chart-panel-controls">
                    <span class="chart-panel-source">${escapeHtml(category)}</span>
                    <select class="chart-interval-select" onchange="window.mstarApp.setPanelInterval(${id}, parseInt(this.value))">
                        <option value="2">2s</option>
                        <option value="5" selected>5s</option>
                        <option value="10">10s</option>
                        <option value="30">30s</option>
                        <option value="60">60s</option>
                    </select>
                    <button class="btn-icon" onclick="window.mstarApp.removePanel(${id})" title="Remove">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                </div>
            </div>
            <div class="chart-stats-bar">
                <button class="chart-stat-toggle" id="stat-cumavg-${id}" onclick="window.mstarApp.toggleStat(${id},'cumAvg')" title="Cumulative Average">
                    <span class="stat-swatch" style="background:${STAT_COLORS.cumAvg}"></span> Cum. Avg
                </button>
                <button class="chart-stat-toggle" id="stat-movavg-${id}" onclick="window.mstarApp.toggleStat(${id},'movAvg')" title="Moving Average">
                    <span class="stat-swatch" style="background:${STAT_COLORS.movAvg}"></span> Mov. Avg
                </button>
                <label class="chart-stat-window" id="stat-window-label-${id}" style="display:none;" title="Moving average window (number of points)">
                    Window: <input type="number" class="chart-stat-window-input" id="stat-window-${id}" value="20" min="2" max="500" onchange="window.mstarApp.setMovAvgWindow(${id}, parseInt(this.value))">
                </label>
                <span style="flex:1;"></span>
                <button class="chart-stat-toggle chart-report-toggle" id="stat-report-${id}" onclick="window.mstarApp.toggleReport(${id})" title="Add to PDF report">
                    📌 Report
                </button>
            </div>
            <div class="chart-panel-body">
                <div id="panel-chart-${id}" style="width:100%;height:280px;"></div>
            </div>
        `;

        container.appendChild(panelEl);

        // Drag handling
        panelEl.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('text/plain', id.toString());
            panelEl.classList.add('dragging');
        });
        panelEl.addEventListener('dragend', () => panelEl.classList.remove('dragging'));
        panelEl.addEventListener('dragover', (e) => {
            e.preventDefault();
            const dragging = container.querySelector('.dragging');
            if (dragging && dragging !== panelEl) {
                const rect = panelEl.getBoundingClientRect();
                const midX = rect.left + rect.width / 2;
                if (e.clientX < midX) {
                    container.insertBefore(dragging, panelEl);
                } else {
                    container.insertBefore(dragging, panelEl.nextSibling);
                }
            }
        });

        const panel = {
            id, panelKey, jobId, filename, column,
            interval: intervalMs, timerId: null,
            color: CHART_COLORS[colorIdx],
            showCumAvg: false, showMovAvg: false, movAvgWindow: 20, inReport: false,
        };
        progressState.panels.push(panel);
        updateChartsEmptyState();

        // Defer initial render
        requestAnimationFrame(() => {
            setTimeout(() => {
                updateStatsPanel(panel);
                panel.timerId = setInterval(() => updateStatsPanel(panel), panel.interval);
            }, 50);
        });
    }

    async function updateStatsPanel(panel) {
        const chartEl = document.getElementById(`panel-chart-${panel.id}`);
        if (!chartEl) return;

        const resp = await api.get(`/jobs/${panel.jobId}/stats/${encodeURIComponent(panel.filename)}`);
        if (!resp || !resp.data) return;

        const timeCol = resp.data['Time [s]'] || resp.data[resp.columns[0]] || [];
        const yData = resp.data[panel.column] || [];
        if (yData.length < 1) return;

        const mainTrace = {
            x: timeCol, y: yData, type: 'scatter', mode: 'lines+markers',
            name: panel.column.replace(/ \[.*\]/, ''),
            line: { color: panel.color, width: 2 },
            marker: { size: 3, color: panel.color },
            connectgaps: true,
        };
        const statTraces = buildStatTraces(timeCol, yData, panel);
        const hasStats = statTraces.length > 0;

        Plotly.react(chartEl, [mainTrace, ...statTraces], {
            paper_bgcolor: 'transparent',
            plot_bgcolor: 'rgba(15, 20, 35, 0.6)',
            font: { family: 'Inter, sans-serif', size: 10, color: '#9ca3af' },
            height: 280,
            margin: { l: 55, r: 12, t: 8, b: 32 },
            xaxis: {
                title: { text: 'Time [s]', font: { size: 10 } },
                gridcolor: 'rgba(99, 115, 156, 0.08)',
                zerolinecolor: 'rgba(99, 115, 156, 0.12)',
            },
            yaxis: {
                title: { text: panel.column.replace(/ \[.*\]/, ''), font: { size: 10 } },
                gridcolor: 'rgba(99, 115, 156, 0.08)',
                zerolinecolor: 'rgba(99, 115, 156, 0.12)',
            },
            showlegend: hasStats,
            legend: { x: 0, y: 1.12, orientation: 'h', font: { size: 9 } },
        }, { responsive: true, displayModeBar: false });
    }

    // Pop-out a panel into a floating window
    function popOutPanel(panelId) {
        const panel = progressState.panels.find(p => p.id === panelId);
        if (!panel) return;

        const displayName = panel.varName || `${panel.filename || ''} / ${panel.column || ''}`;
        const isStatsPanel = panel.type !== 'timeseries' && panel.filename;

        const win = window.open('', `mstar_panel_${panelId}`,
            'width=600,height=350,menubar=no,toolbar=no,location=no,status=no');
        if (!win) { toast('Popup blocked — allow popups for this site', 'error'); return; }

        win.document.write(`<!DOCTYPE html>
<html><head>
    <title>${displayName}</title>
    <script src="https://cdn.plot.ly/plotly-2.32.0.min.js"><\/script>
    <style>
        body { margin:0; background:#0f1423; font-family:Inter,sans-serif; color:#e2e8f0; }
        .header { padding:8px 12px; background:rgba(30,40,70,0.9); border-bottom:1px solid rgba(99,115,156,0.2);
                   display:flex; align-items:center; justify-content:space-between; font-size:13px; }
        .header select { background:#1a2035; color:#e2e8f0; border:1px solid rgba(99,115,156,0.3);
                         border-radius:4px; padding:2px 6px; font-size:11px; }
        #chart { width:100%; height:calc(100vh - 40px); }
    </style>
</head><body>
    <div class="header">
        <span>${displayName}</span>
        <select id="interval" onchange="setInterval(parseInt(this.value))">
            <option value="2" ${panel.interval===2000?'selected':''}>2s</option>
            <option value="5" ${panel.interval===5000?'selected':''}>5s</option>
            <option value="10" ${panel.interval===10000?'selected':''}>10s</option>
            <option value="30" ${panel.interval===30000?'selected':''}>30s</option>
            <option value="60" ${panel.interval===60000?'selected':''}>60s</option>
        </select>
    </div>
    <div id="chart"></div>
    <script>
    let timerId = null;
    const token = '${state.token}';
    const jobId = ${progressState.jobId};
    const varName = '${displayName}';
    const color = '${panel.color}';
    const isStats = ${isStatsPanel};
    const statsFilename = '${panel.filename || ""}';
    const statsColumn = '${panel.column || ""}';

    async function refresh() {
        try {
            let xData, series;
            if (isStats) {
                const resp = await fetch('/api/jobs/' + jobId + '/stats/' + encodeURIComponent(statsFilename), { headers: { Authorization: 'Bearer ' + token } });
                const d = await resp.json();
                if (!d || !d.data) return;
                xData = d.data['Time [s]'] || d.data[d.columns[0]] || [];
                series = d.data[statsColumn] || [];
            } else {
                const resp = await fetch('/api/jobs/' + jobId + '/progress', { headers: { Authorization: 'Bearer ' + token } });
                const wrapper = await resp.json();
                const d = wrapper.data || wrapper;
                if (!d.time_series || !d.time_series[varName]) return;
                series = d.time_series[varName];
                const wt = d.wall_times || d.sim_times || [];
                const useSim = wt.every(t => t === 0);
                xData = useSim ? (d.sim_times || []) : wt;
            }
            Plotly.react('chart', [{
                x: xData, y: series, type:'scatter', mode:'lines+markers',
                line:{color:color,width:2}, marker:{size:3,color:color}, connectgaps:true
            }], {
                paper_bgcolor:'transparent', plot_bgcolor:'rgba(15,20,35,0.6)',
                font:{family:'Inter,sans-serif',size:11,color:'#9ca3af'},
                margin:{l:55,r:15,t:10,b:35},
                xaxis:{title:{text:isStats?'Time [s]':(typeof useSim!=='undefined'&&useSim)?'Sim Time (s)':'Wall Time (hr)',font:{size:11}},gridcolor:'rgba(99,115,156,0.08)'},
                yaxis:{title:{text:varName.split(' / ').pop(),font:{size:11}},gridcolor:'rgba(99,115,156,0.08)'},
                showlegend:false
            }, {responsive:true,displayModeBar:false});
        } catch(e) { console.error(e); }
    }

    function setInterval(s) {
        if (timerId) clearInterval(timerId);
        timerId = window.setInterval(refresh, s * 1000);
    }
    refresh();
    timerId = window.setInterval(refresh, ${panel.interval});
    <\/script>
</body></html>`);
        win.document.close();
    }

    async function loadFileBrowser(jobId, path) {
        const breadcrumbEl = document.getElementById('file-browser-breadcrumb');
        const contentEl = document.getElementById('file-browser-content');
        if (!breadcrumbEl || !contentEl) return;

        // Build breadcrumb
        const parts = path ? path.split('/').filter(Boolean) : [];
        let crumbHtml = `<a class="file-crumb" onclick="window.mstarApp._browseFiles('')">out/</a>`;
        let accumulated = '';
        for (const part of parts) {
            accumulated += (accumulated ? '/' : '') + part;
            const p = accumulated;
            crumbHtml += ` <span class="file-crumb-sep">/</span> <a class="file-crumb" onclick="window.mstarApp._browseFiles('${escapeHtml(p)}')">${escapeHtml(part)}</a>`;
        }
        breadcrumbEl.innerHTML = crumbHtml;

        contentEl.innerHTML = '<div class="empty-state"><div class="spinner" style="margin:0 auto;"></div><p style="margin-top:8px;">Loading...</p></div>';

        const data = await api.get(`/jobs/${jobId}/files?path=${encodeURIComponent(path)}`);
        if (!data || !data.entries) {
            contentEl.innerHTML = '<div class="empty-state"><p>Unable to load files</p></div>';
            return;
        }

        if (data.entries.length === 0) {
            contentEl.innerHTML = '<div class="empty-state"><p>Empty directory</p></div>';
            return;
        }

        contentEl.innerHTML = `
            <div class="table-container">
                <table class="data-table">
                    <thead>
                        <tr><th>Name</th><th>Size</th><th>Modified</th><th>Action</th></tr>
                    </thead>
                    <tbody>
                        ${data.entries.map(entry => {
                            const entryPath = path ? `${path}/${entry.name}` : entry.name;
                            const icon = entry.is_dir
                                ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent-amber)" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>'
                                : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
                            return `
                                <tr>
                                    <td>
                                        <span style="display:inline-flex;align-items:center;gap:6px;">
                                            ${icon}
                                            ${entry.is_dir
                                                ? `<a class="file-link" onclick="window.mstarApp._browseFiles('${escapeHtml(entryPath)}')">${escapeHtml(entry.name)}</a>`
                                                : `<span>${escapeHtml(entry.name)}</span>`}
                                        </span>
                                    </td>
                                    <td class="text-sm text-muted text-mono">${entry.is_dir ? '—' : formatFileSize(entry.size)}</td>
                                    <td class="text-sm text-muted">${entry.modified ? formatTime(entry.modified) : '—'}</td>
                                    <td>
                                        ${!entry.is_dir ? `<button class="btn btn-secondary btn-sm" onclick="window.mstarApp._downloadFile(${jobId}, '${escapeHtml(entryPath)}')">
                                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                                            Download
                                        </button>` : ''}
                                    </td>
                                </tr>
                            `;
                        }).join('')}
                    </tbody>
                </table>
            </div>
        `;

        // Register helpers
        window.mstarApp._browseFiles = function(p) {
            loadFileBrowser(jobId, p);
        };
        window.mstarApp._downloadFile = function(jid, fpath) {
            const url = `/api/jobs/${jid}/files/download?path=${encodeURIComponent(fpath)}`;
            const a = document.createElement('a');
            a.href = url;
            a.setAttribute('download', '');
            // Add auth header via fetch for download
            fetch(url, { headers: { 'Authorization': `Bearer ${state.token}` } })
                .then(r => r.blob())
                .then(blob => {
                    const blobUrl = URL.createObjectURL(blob);
                    a.href = blobUrl;
                    a.download = fpath.split('/').pop();
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    URL.revokeObjectURL(blobUrl);
                })
                .catch(() => toast('Download failed', 'error'));
        };
    }

    async function loadRawLog(jobId) {
        const content = document.getElementById('output-content');
        if (!content) return;
        const data = await api.get(`/jobs/${jobId}/output?tail=500`);
        if (data && data.output) {
            content.textContent = data.output;
            content.scrollTop = content.scrollHeight;
        } else {
            // For failed jobs with no output file, show the error from progress data
            let msg = data?.error || 'No output available';
            if (progressState.data && progressState.data.error_message) {
                msg += '\n\n--- Error Details ---\n' + progressState.data.error_message;
            }
            content.textContent = msg;
        }
    }

    // ============================================================
    // Actions
    // ============================================================
    async function cancelJob(jobId) {
        if (!confirm(`Cancel job #${jobId}?`)) return;
        const result = await api.post(`/jobs/${jobId}/cancel`);
        if (result && result.message) {
            toast(result.message, 'success');
        } else {
            toast(result?.error || 'Failed to cancel', 'error');
        }
    }

    async function deleteUser(userId) {
        if (!confirm(`Delete user #${userId}? This cannot be undone.`)) return;
        const result = await api.del(`/users/${userId}`);
        if (result && result.message) {
            toast(result.message, 'success');
            handleRoute(); // Refresh page
        } else {
            toast(result?.error || 'Failed to delete user', 'error');
        }
    }

    // ============================================================
    // Helpers
    // ============================================================
    function escapeHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function statusBadge(status) {
        const dot = status === 'running' ? '<span class="badge-dot"></span>' : '';
        return `<span class="badge badge-${status}">${dot}${status}</span>`;
    }

    function formatGpuIds(gpuIdsJson) {
        try {
            const ids = JSON.parse(gpuIdsJson);
            if (Array.isArray(ids)) {
                const count = ids.length;
                const label = ids.map(id => `#${id}`).join(', ');
                return `${count} (${label})`;
            }
            return gpuIdsJson;
        } catch { return gpuIdsJson; }
    }

    function formatTime(iso) {
        if (!iso) return '—';
        const d = new Date(iso + 'Z');
        if (isNaN(d)) return iso;
        const now = new Date();
        const diff = (now - d) / 1000;
        if (diff < 60) return 'Just now';
        if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
        if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    }

    function formatFileSize(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }

    // ============================================================
    // Expose global methods for inline onclick handlers
    // ============================================================
    async function restartJob(jobId) {
        if (!confirm(`Restart failed job #${jobId} using --load-last?`)) return;
        const result = await api.post(`/jobs/${jobId}/restart`, {});
        if (result && !result.error) {
            toast(`Restart queued: Job #${result.new_job_id}`, 'success');
            navigate('jobs');
        } else {
            toast(result?.error || 'Restart failed', 'error');
        }
    }

    window.mstarApp = Object.assign(window.mstarApp || {}, { viewOutput, cancelJob, deleteUser, editUser, popOutPanel, restartJob });

    // ============================================================
    // Modal close handlers
    // ============================================================
    document.getElementById('output-modal-close').addEventListener('click', () => {
        document.getElementById('output-modal').style.display = 'none';
    });
    document.querySelector('.modal-backdrop')?.addEventListener('click', () => {
        document.getElementById('output-modal').style.display = 'none';
    });

    // ============================================================
    // Logout button
    // ============================================================
    document.getElementById('logout-btn').addEventListener('click', logout);

    // ============================================================
    // Init
    // ============================================================
    updateUserUI();
    handleRoute();

})();