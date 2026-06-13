/**
 * AI Training Metrics — M-Star Queue
 * ====================================
 * Comprehensive training diagnostics visualization module.
 * Uses Plotly.js (already loaded globally) with the app's dark theme.
 *
 * Tabs:
 *   1. Loss Curves — train/val loss over epochs
 *   2. Learning Rate — LR schedule
 *   3. Memory — GPU memory (allocated/reserved/peak) over epochs
 *   4. Per-Channel — per-channel validation MSE over epochs
 *   5. Convergence — gradient norm, overfit ratio, epoch time
 *   6. Test Results — final test metrics with quality indicators
 *   7. Error Map — spatial error percentiles + worst-case analysis
 *
 * Stat Cards (top): Epochs, Best Val Loss, R², Time, GPU Peak, Epoch Time, Overfit, Params
 *
 * Exposes: window._aiTrainingMetrics = { openTrainingMetrics, closeTrainingMetrics, refreshTrainingMetrics, renderMetricsInto }
 */
    (function () {
        'use strict';

        // ---- Helpers ----
        function escHtml(s) {
            const d = document.createElement('div');
            d.textContent = s || '';
            return d.innerHTML;
        }

        function _escAttr(s) {
            return (s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        }

        // Clickable tooltip popover
        let _activeTipEl = null;
        function _showMetricTip(text, anchorEl, evt) {
            if (evt) { evt.stopPropagation(); evt.preventDefault(); }
            if (_activeTipEl) { _activeTipEl.remove(); _activeTipEl = null; }

            const pop = document.createElement('div');
            pop.className = 'ai-metric-tip-popover';
            pop.style.cssText = 'position:fixed;z-index:100000;max-width:380px;padding:16px 18px;border-radius:10px;'
                + 'background:var(--bg-secondary,#1e293b);border:1px solid var(--accent-blue,#3b82f6);'
                + 'box-shadow:0 12px 40px rgba(0,0,0,0.5);color:var(--text-primary,#e2e8f0);font-size:12px;'
                + 'line-height:1.6;font-family:Inter,system-ui,sans-serif;';

            const formatted = text.split('\n\n').map(para => {
                const lines = para.split('\n').map(line => {
                    if (line.length < 60 && !line.includes(':') && !line.startsWith(' ') && !line.startsWith('✓') && !line.startsWith('•') && line === line.trim()) {
                        return `<div style="font-weight:600;color:var(--accent-blue,#60a5fa);font-size:13px;margin-bottom:2px;">${escHtml(line)}</div>`;
                    }
                    if (line.includes('|') && (line.includes('Excellent') || line.includes('Good') || line.includes('Fair') || line.includes('Poor'))) {
                        return `<div style="padding:4px 8px;background:rgba(59,130,246,0.08);border-radius:4px;font-family:'JetBrains Mono',monospace;font-size:11px;margin:2px 0;">${escHtml(line)}</div>`;
                    }
                    if (line.startsWith('✓') || line.startsWith('✔')) {
                        return `<div style="color:#22c55e;">${escHtml(line)}</div>`;
                    }
                    if (line.trim().startsWith('•')) {
                        return `<div style="padding-left:8px;">${escHtml(line)}</div>`;
                    }
                    if (line.startsWith('To improve:')) {
                        return `<div style="color:var(--accent-amber,#f59e0b);margin-top:4px;">${escHtml(line)}</div>`;
                    }
                    return `<div>${escHtml(line)}</div>`;
                }).join('');
                return `<div style="margin-bottom:8px;">${lines}</div>`;
            }).join('');

            pop.innerHTML = formatted;
            document.body.appendChild(pop);
            _activeTipEl = pop;

            const rect = anchorEl.getBoundingClientRect();
            const popW = pop.offsetWidth;
            const popH = pop.offsetHeight;
            let left = rect.left + rect.width / 2 - popW / 2;
            let top = rect.bottom + 8;
            if (left < 8) left = 8;
            if (left + popW > window.innerWidth - 8) left = window.innerWidth - 8 - popW;
            if (top + popH > window.innerHeight - 8) top = rect.top - popH - 8;
            pop.style.left = left + 'px';
            pop.style.top = top + 'px';

            function dismiss(e) {
                if (e.type === 'keydown' && e.key !== 'Escape') return;
                if (e.type === 'click' && pop.contains(e.target)) return;
                pop.remove();
                _activeTipEl = null;
                document.removeEventListener('click', dismiss, true);
                document.removeEventListener('keydown', dismiss);
            }
            setTimeout(() => {
                document.addEventListener('click', dismiss, true);
                document.addEventListener('keydown', dismiss);
            }, 10);
        }

        function _tipBtn(tipKey) {
            return `<button class="ai-tip-btn" data-tip-key="${tipKey}" onclick="_mstarShowTip(this)" `
                + `style="display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;`
                + `border-radius:50%;border:1px solid var(--border-color,#444);background:rgba(59,130,246,0.1);`
                + `color:var(--accent-blue,#60a5fa);font-size:9px;font-weight:700;cursor:pointer;margin-left:4px;`
                + `vertical-align:middle;padding:0;line-height:1;font-family:Inter,sans-serif;">?</button>`;
        }

        window._mstarMetricTips = {};
        window._mstarShowTip = function(btn) {
            const key = btn.dataset.tipKey;
            const text = window._mstarMetricTips[key] || '';
            if (text) _showMetricTip(text, btn, event);
        };

        function getToken() {
            return localStorage.getItem('mstar_token') || '';
        }

        async function fetchMetrics(jobId) {
            const res = await fetch(`/api/ai/training-jobs/${jobId}/metrics`, {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${getToken()}`,
                },
            });
            return res.json();
        }

        function fmtNum(n, decimals) {
            if (n == null || isNaN(n)) return '—';
            if (Math.abs(n) >= 1e6) return n.toExponential(2);
            if (Math.abs(n) < 0.001 && n !== 0) return n.toExponential(2);
            return n.toFixed(decimals != null ? decimals : 4);
        }

        function fmtDuration(seconds) {
            if (!seconds || seconds < 0) return '—';
            const h = Math.floor(seconds / 3600);
            const m = Math.floor((seconds % 3600) / 60);
            const s = Math.floor(seconds % 60);
            if (h > 0) return `${h}h ${m}m ${s}s`;
            if (m > 0) return `${m}m ${s}s`;
            return `${s}s`;
        }

        function fmtMemory(mb) {
            if (mb == null || isNaN(mb)) return '—';
            if (mb >= 1024) return (mb / 1024).toFixed(1) + ' GB';
            return mb.toFixed(0) + ' MB';
        }

        function fmtParams(n) {
            if (!n) return '—';
            if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
            if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
            if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
            return n.toString();
        }

        // ---- Plotly dark-theme layout ----
        const DARK_LAYOUT = {
            paper_bgcolor: 'transparent',
            plot_bgcolor: 'rgba(15, 20, 35, 0.6)',
            font: { family: 'Inter, sans-serif', size: 11, color: '#9ca3af' },
            margin: { l: 55, r: 20, t: 30, b: 40 },
            legend: { orientation: 'h', y: -0.18, font: { size: 10 }, bgcolor: 'transparent' },
            showlegend: true,
            xaxis: {
                gridcolor: 'rgba(99, 115, 156, 0.08)',
                zerolinecolor: 'rgba(99, 115, 156, 0.12)',
                title: { text: 'Epoch', font: { size: 11 } },
            },
            yaxis: {
                gridcolor: 'rgba(99, 115, 156, 0.08)',
                zerolinecolor: 'rgba(99, 115, 156, 0.12)',
            },
        };

        const PLOTLY_CFG = { responsive: true, displayModeBar: false };

        const COL = {
            blue: '#3b82f6',
            cyan: '#06b6d4',
            amber: '#f59e0b',
            green: '#10b981',
            red: '#ef4444',
            purple: '#8b5cf6',
            pink: '#ec4899',
            orange: '#f97316',
        };

        const CHANNEL_COLORS = [COL.blue, COL.cyan, COL.green, COL.amber, COL.purple, COL.pink, COL.red, COL.orange];

        // ---- Tab definitions ----
        const ALL_TABS = [
            { id: 'loss', label: 'Loss Curves' },
            { id: 'lr', label: 'Learning Rate' },
            { id: 'memory', label: 'GPU Memory' },
            { id: 'perchannel', label: 'Per-Channel' },
            { id: 'convergence', label: 'Convergence' },
            { id: 'test', label: 'Test Results' },
            { id: 'errormap', label: 'Error Map' },
        ];

        // ---- State ----
        let _pollTimer = null;
        let _currentJobId = null;
        let _activeTab = 'loss';

        // ---- Public API ----
        function openTrainingMetrics(jobId, jobMeta) {
            closeTrainingMetrics();
            _currentJobId = jobId;
            _activeTab = 'loss';

            const meta = jobMeta || {};
            const title = `Training Metrics — Job #${jobId}`;
            const subtitle = [meta.model_family, meta.run_name].filter(Boolean).join(' · ');

            const overlay = document.createElement('div');
            overlay.id = 'ai-metrics-overlay';
            overlay.innerHTML = `
            <div class="modal-backdrop" id="ai-metrics-backdrop"></div>
            <div class="modal-content modal-lg" style="max-width:1100px;max-height:90vh;overflow-y:auto;">
                <div class="modal-header">
                    <div>
                        <h3 style="margin:0;">${escHtml(title)}</h3>
                        ${subtitle ? `<div style="font-size:12px;color:var(--text-muted);margin-top:2px;">${escHtml(subtitle)}</div>` : ''}
                    </div>
                    <button class="btn-icon modal-close" id="ai-metrics-close">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                </div>
                <div class="modal-body" style="padding:16px;">
                    <!-- Stat cards -->
                    <div id="ai-metrics-stats" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:16px;"></div>

                    <!-- Tabs -->
                    <div id="ai-metrics-tabs" style="display:flex;gap:0;margin-bottom:12px;flex-wrap:wrap;"></div>

                    <!-- Chart container -->
                    <div style="background:var(--bg-card,#1a1a2e);border:1px solid var(--border-color,#333);border-radius:8px;padding:8px;">
                        <div id="ai-metrics-chart" style="width:100%;min-height:360px;"></div>
                    </div>

                    <!-- Status bar -->
                    <div id="ai-metrics-status" style="font-size:11px;color:var(--text-muted);margin-top:8px;text-align:right;"></div>

                    <!-- Continue / Transfer / Export buttons (only for completed jobs) -->
                    ${meta.status === 'completed' ? `
                    <div style="display:flex;gap:10px;margin-top:16px;padding-top:12px;border-top:1px solid var(--border-color,#333);">
                        <button class="btn btn-sm" id="ai-metrics-export" style="flex:1;justify-content:center;padding:10px;background:rgba(16,185,129,0.12);color:#34d399;border:1px solid rgba(16,185,129,0.25);font-weight:500;font-size:13px;cursor:pointer;border-radius:8px;transition:all 0.2s;">
                            📦 Export Model
                        </button>
                        <button class="btn btn-sm" id="ai-metrics-continue" style="flex:1;justify-content:center;padding:10px;background:rgba(59,130,246,0.12);color:#60a5fa;border:1px solid rgba(59,130,246,0.25);font-weight:500;font-size:13px;cursor:pointer;border-radius:8px;transition:all 0.2s;">
                            🔄 Continue Training
                        </button>
                        <button class="btn btn-sm" id="ai-metrics-transfer" style="flex:1;justify-content:center;padding:10px;background:rgba(139,92,246,0.12);color:#a78bfa;border:1px solid rgba(139,92,246,0.25);font-weight:500;font-size:13px;cursor:pointer;border-radius:8px;transition:all 0.2s;">
                            🚀 Use as Pretrained
                        </button>
                    </div>
                    ` : ''}
                </div>
            </div>
        `;
            overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:10000;display:flex;align-items:center;justify-content:center;';
            document.body.appendChild(overlay);

            overlay.querySelector('#ai-metrics-close').addEventListener('click', closeTrainingMetrics);
            overlay.querySelector('#ai-metrics-backdrop').addEventListener('click', closeTrainingMetrics);
            document.addEventListener('keydown', _escHandler);

            // Continue / Transfer / Export button handlers
            const continueBtn = overlay.querySelector('#ai-metrics-continue');
            if (continueBtn) {
                continueBtn.addEventListener('click', () => {
                    closeTrainingMetrics();
                    if (window._aiTrainingModule && window._aiTrainingModule.showView) {
                        window._aiTrainingModule.showView('new-training', { mode: 'continue', sourceJobId: jobId, modelFamily: meta.model_family, runName: meta.run_name, status: meta.status });
                    }
                });
            }
            const transferBtn = overlay.querySelector('#ai-metrics-transfer');
            if (transferBtn) {
                transferBtn.addEventListener('click', () => {
                    closeTrainingMetrics();
                    if (window._aiTrainingModule && window._aiTrainingModule.showView) {
                        window._aiTrainingModule.showView('new-training', { mode: 'transfer', sourceJobId: jobId, modelFamily: meta.model_family, runName: meta.run_name, status: meta.status });
                    }
                });
            }
            const exportBtn = overlay.querySelector('#ai-metrics-export');
            if (exportBtn) {
                exportBtn.addEventListener('click', async () => {
                    exportBtn.disabled = true;
                    exportBtn.innerHTML = '<span class="spinner" style="width:14px;height:14px;border-width:2px;display:inline-block;margin-right:6px;"></span> Exporting…';
                    exportBtn.style.opacity = '0.7';
                    try {
                        const res = await fetch(`/api/ai/training-jobs/${jobId}/export`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` }, body: JSON.stringify({ formats: 'onnx,torchscript' }) });
                        const data = await res.json();
                        if (data.error) {
                            exportBtn.innerHTML = '❌ Export Failed';
                            exportBtn.style.color = '#ef4444';
                            _showStatus('Export error: ' + data.error, true);
                        } else {
                            exportBtn.innerHTML = '✅ Exported';
                            exportBtn.style.color = '#22c55e';
                            _showStatus('Model exported successfully', false);
                        }
                    } catch (err) {
                        exportBtn.innerHTML = '❌ Export Failed';
                        _showStatus('Export request failed: ' + err.message, true);
                    }
                    setTimeout(() => { exportBtn.disabled = false; exportBtn.style.opacity = '1'; }, 3000);
                });
            }

            // Build tabs
            _renderTabs(overlay);

            // Load data
            _loadAndRender(jobId);

            const isActive = meta.status === 'running' || meta.status === 'preflight' || meta.status === 'launching';
            if (isActive) {
                _pollTimer = setInterval(() => _loadAndRender(jobId), 3000);
            }
        }

        function closeTrainingMetrics() {
            if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
            _currentJobId = null;
            const overlay = document.getElementById('ai-metrics-overlay');
            if (overlay) overlay.remove();
            document.removeEventListener('keydown', _escHandler);
        }

        function refreshTrainingMetrics(jobId) {
            _loadAndRender(jobId || _currentJobId);
        }

        function _escHandler(e) {
            if (e.key === 'Escape') closeTrainingMetrics();
        }

        // ---- Tab Rendering ----
        function _renderTabs(container) {
            const tabsEl = container.querySelector('#ai-metrics-tabs');
            if (!tabsEl) return;

            tabsEl.innerHTML = ALL_TABS.map((tab, i) => {
                const isFirst = i === 0;
                const isLast = i === ALL_TABS.length - 1;
                const isActive = tab.id === _activeTab;
                const radiusL = isFirst ? '8px' : '0';
                const radiusR = isLast ? '8px' : '0';
                return `<button class="ai-mtab${isActive ? ' active' : ''}" data-tab="${tab.id}" style="flex:1;min-width:0;padding:8px 4px;text-align:center;cursor:pointer;border:1px solid ${isActive ? 'var(--accent-blue,#3b82f6)' : 'var(--border-color,#333)'};background:${isActive ? 'var(--accent-blue,#3b82f6)' : 'var(--bg-card,#1a1a2e)'};color:${isActive ? '#fff' : 'var(--text-secondary,#a0a0b0)'};font-weight:500;font-size:11px;border-radius:${radiusL} ${radiusR} ${radiusR} ${radiusL};transition:all 0.2s;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${tab.label}</button>`;
            }).join('');

            tabsEl.querySelectorAll('.ai-mtab').forEach(tab => {
                tab.addEventListener('click', () => {
                    _activeTab = tab.dataset.tab;
                    tabsEl.querySelectorAll('.ai-mtab').forEach(t => {
                        const isAct = t.dataset.tab === _activeTab;
                        t.style.background = isAct ? 'var(--accent-blue,#3b82f6)' : 'var(--bg-card,#1a1a2e)';
                        t.style.color = isAct ? '#fff' : 'var(--text-secondary,#a0a0b0)';
                        t.style.borderColor = isAct ? 'var(--accent-blue,#3b82f6)' : 'var(--border-color,#333)';
                        if (isAct) t.classList.add('active'); else t.classList.remove('active');
                    });
                    _renderCurrentTab();
                });
            });
        }

        // ---- Data loading ----
        let _lastData = null;

        async function _loadAndRender(jobId) {
            if (!jobId) return;
            try {
                const data = await fetchMetrics(jobId);
                if (data.error) { _showStatus(`Error: ${data.error}`, true); return; }
                _lastData = data;
                _renderStats(data);
                _renderCurrentTab();

                const n = (data.epochs || []).length;
                const ts = new Date().toLocaleTimeString();
                const isActive = data.job_status === 'running' || data.job_status === 'preflight';
                _showStatus(`${n} epoch${n !== 1 ? 's' : ''} loaded · ${isActive ? '🔴 Live' : '✓ Complete'} · ${ts}`, false);

                if (!isActive && _pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
            } catch (err) {
                console.error('[AI Metrics] Fetch error:', err);
                _showStatus('Failed to fetch metrics', true);
            }
        }

        function _showStatus(msg, isError) {
            const el = document.getElementById('ai-metrics-status');
            if (el) {
                el.textContent = msg;
                el.style.color = isError ? 'var(--accent-red,#ef4444)' : 'var(--text-muted)';
            }
        }

        // ---- Stat Cards ----
        function _renderStats(data) {
            const el = document.getElementById('ai-metrics-stats');
            if (!el) return;

            const epochs = data.epochs || [];
            const lastEpoch = epochs.length > 0 ? epochs[epochs.length - 1] : {};
            const tm = data.test_metrics || {};
            const cfg = data.config || {};
            const ts = data.training_summary || {};

            const totalEpochs = cfg.epochs || epochs.length;
            const bestValLoss = epochs.length > 0
                ? Math.min(...epochs.map(e => e.val_loss).filter(v => v != null && !isNaN(v)))
                : null;

            // GPU peak memory from latest epoch
            const gpuPeakMb = lastEpoch.gpu_peak_memory_mb || ts.gpu_peak_memory_mb || null;
            const avgEpochTime = ts.avg_epoch_time_seconds || (lastEpoch.epoch_time_seconds || null);
            const ofRatio = lastEpoch.overfit_ratio || null;
            const totalP = ts.total_parameters || null;

            // Overfit color
            let ofColor = 'var(--text-primary)';
            if (ofRatio != null) {
                if (ofRatio > 3.0) ofColor = COL.red;
                else if (ofRatio > 2.0) ofColor = COL.amber;
                else if (ofRatio > 1.5) ofColor = COL.orange;
                else ofColor = COL.green;
            }

            const cards = [
                { label: 'Epochs', value: `${epochs.length}${totalEpochs ? ' / ' + totalEpochs : ''}`, color: 'var(--text-primary)', tipKey: 'epochs' },
                { label: 'Best Val Loss', value: fmtNum(bestValLoss, 4), color: COL.cyan, tipKey: 'val_loss' },
                { label: 'R²', value: tm.test_r2 != null ? (tm.test_r2 * 100).toFixed(2) + '%' : '—', color: COL.green, tipKey: 'r2' },
                { label: 'Time', value: fmtDuration(lastEpoch.elapsed_seconds), color: 'var(--text-primary)', tipKey: 'time' },
                { label: 'GPU Peak', value: fmtMemory(gpuPeakMb), color: COL.purple, tipKey: 'gpu_peak' },
                { label: 'Epoch Time', value: avgEpochTime != null ? avgEpochTime.toFixed(1) + 's' : '—', color: COL.blue, tipKey: 'epoch_time' },
                { label: 'Overfit', value: ofRatio != null ? ofRatio.toFixed(2) + '×' : '—', color: ofColor, tipKey: 'overfit' },
                { label: 'Params', value: fmtParams(totalP), color: COL.amber, tipKey: 'params' },
            ];

            const headerTips = {
                epochs: 'Training iterations completed out of total requested.\n\nEach epoch processes the entire dataset once. More epochs allow the model to learn better, but too many can lead to overfitting.\n\nTypical range: 200-1000 epochs for CFD surrogates.',
                val_loss: 'Lowest validation loss achieved during training.\n\nCalculation: Mean Squared Error on a held-out validation split (data the model never trained on).\n\n✓ Lower is better — approaches 0 for a perfect model.\n\nGood: < 0.01 | Fair: 0.01-0.05 | Poor: > 0.05\n\nIf this value stops decreasing while training loss keeps dropping, your model is overfitting.',
                r2: 'R² (Coefficient of Determination) on the test set.\n\nCalculation: 1 − (Σ(y − ŷ)²) / (Σ(y − ȳ)²)\n\n✓ Higher is better — 1.0 means perfect prediction.\n\nExcellent: ≥ 99.9% | Very Good: ≥ 99% | Good: ≥ 95%\nFair: ≥ 90% | Poor: < 90%',
                time: 'Total wall-clock training time.\n\nIncludes forward/backward passes, validation, and checkpointing.',
                gpu_peak: 'Peak GPU memory used during training.\n\nIncludes model weights, activations, gradients, and optimizer state.\n\nIf this is close to your GPU\'s total VRAM, you\'re at risk of OOM errors.\n\nTo reduce: lower batch_size, reduce n_hidden, increase spatial downsampling, or enable gradient checkpointing.',
                epoch_time: 'Average wall-clock time per epoch.\n\nUse to estimate remaining training time.\n\nIf this increases over training, check for memory fragmentation or GPU throttling.',
                overfit: 'Overfitting ratio: val_loss / train_loss.\n\n✓ 1.0 = perfect generalization (val and train loss are equal)\n\n1.0-1.5: Good generalization\n1.5-2.0: Mild overfitting\n2.0-3.0: Moderate overfitting — consider regularization\n> 3.0: Severe overfitting — needs more data or less model complexity\n\nTo improve: add dropout, reduce n_layers/n_hidden, add more training cases, or use data augmentation.',
                params: 'Total number of model parameters.\n\nMore parameters = more expressive model, but also more memory and risk of overfitting.\n\nTypical ranges:\n  MLP: 100K-1M\n  U-Net: 1M-10M\n  Transolver: 5M-50M',
            };

            for (const [k, v] of Object.entries(headerTips)) {
                window._mstarMetricTips['hdr_' + k] = v;
            }

            el.innerHTML = cards.map(c => `
            <div style="padding:12px 14px;border-radius:10px;background:var(--bg-card,#1a1a2e);border:1px solid var(--border-color,#333);">
                <div style="font-size:22px;font-weight:700;line-height:1;color:${c.color};font-family:'JetBrains Mono',monospace;">${c.value}</div>
                <div style="font-size:10px;color:var(--text-muted);margin-top:4px;text-transform:uppercase;letter-spacing:0.5px;">${c.label}${c.tipKey ? _tipBtn('hdr_' + c.tipKey) : ''}</div>
            </div>
        `).join('');
        }

        // ---- Chart Rendering ----
        function _renderCurrentTab() {
            if (!_lastData) return;
            const chartEl = document.getElementById('ai-metrics-chart');
            if (!chartEl) return;

            switch (_activeTab) {
                case 'loss': _renderLossChart(_lastData, chartEl); break;
                case 'lr': _renderLRChart(_lastData, chartEl); break;
                case 'memory': _renderMemoryChart(_lastData, chartEl); break;
                case 'perchannel': _renderPerChannelChart(_lastData, chartEl); break;
                case 'convergence': _renderConvergenceChart(_lastData, chartEl); break;
                case 'test': _renderTestChart(_lastData, chartEl); break;
                case 'errormap': _renderErrorMapChart(_lastData, chartEl); break;
            }
        }

        function _noData(chartEl, msg) {
            chartEl.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:320px;color:var(--text-muted);font-size:13px;">${msg || 'No data yet'}</div>`;
        }

        // ---- Tab: Loss Curves ----
        function _renderLossChart(data, chartEl) {
            const epochs = data.epochs || [];
            if (epochs.length === 0) { _noData(chartEl, 'No epoch data yet'); return; }

            const x = epochs.map(e => e.epoch);
            const trainLoss = epochs.map(e => e.train_loss);
            const valLoss = epochs.map(e => e.val_loss);

            const traces = [
                { x, y: trainLoss, type: 'scatter', mode: 'lines', name: 'Train Loss', line: { color: COL.blue, width: 2 } },
                { x, y: valLoss, type: 'scatter', mode: 'lines', name: 'Val Loss', line: { color: COL.cyan, width: 2, dash: 'dot' } },
            ];

            let bestIdx = 0, bestVal = Infinity;
            valLoss.forEach((v, i) => { if (v < bestVal) { bestVal = v; bestIdx = i; } });
            traces.push({
                x: [x[bestIdx]], y: [bestVal], type: 'scatter', mode: 'markers',
                name: `Best: ${fmtNum(bestVal, 4)}`,
                marker: { color: COL.green, size: 10, symbol: 'star', line: { color: '#fff', width: 1 } },
            });

            chartEl.innerHTML = '';
            Plotly.newPlot(chartEl, traces, {
                ...DARK_LAYOUT, height: 360,
                title: { text: 'Training & Validation Loss', font: { size: 13, color: '#d1d5db' }, x: 0.02, y: 0.97 },
                yaxis: { ...DARK_LAYOUT.yaxis, title: { text: 'Loss', font: { size: 11 } } },
            }, PLOTLY_CFG);
        }

        // ---- Tab: Learning Rate ----
        function _renderLRChart(data, chartEl) {
            const epochs = data.epochs || [];
            if (epochs.length === 0) { _noData(chartEl, 'No epoch data yet'); return; }

            const x = epochs.map(e => e.epoch);
            const lr = epochs.map(e => e.learning_rate);

            chartEl.innerHTML = '';
            Plotly.newPlot(chartEl, [{
                x, y: lr, type: 'scatter', mode: 'lines+markers', name: 'Learning Rate',
                line: { color: COL.amber, width: 2 }, marker: { color: COL.amber, size: 4 },
            }], {
                ...DARK_LAYOUT, height: 360,
                title: { text: 'Learning Rate Schedule', font: { size: 13, color: '#d1d5db' }, x: 0.02, y: 0.97 },
                yaxis: { ...DARK_LAYOUT.yaxis, title: { text: 'Learning Rate', font: { size: 11 } }, type: lr.some(v => v > 0 && v < 1e-5) ? 'log' : 'linear', exponentformat: 'e' },
            }, PLOTLY_CFG);
        }

        // ---- Tab: GPU Memory ----
        function _renderMemoryChart(data, chartEl) {
            const epochs = data.epochs || [];
            const hasMemory = epochs.some(e => e.gpu_memory_allocated_mb != null);
            if (!hasMemory) { _noData(chartEl, 'GPU memory tracking not available for this job (requires re-training with updated backend)'); return; }

            const x = epochs.map(e => e.epoch);
            const allocated = epochs.map(e => (e.gpu_memory_allocated_mb || 0) / 1024);
            const reserved = epochs.map(e => (e.gpu_memory_reserved_mb || 0) / 1024);
            const peak = epochs.map(e => (e.gpu_peak_memory_mb || 0) / 1024);

            const traces = [
                { x, y: allocated, type: 'scatter', mode: 'lines', name: 'Allocated', line: { color: COL.blue, width: 2 }, fill: 'tozeroy', fillcolor: 'rgba(59,130,246,0.1)' },
                { x, y: reserved, type: 'scatter', mode: 'lines', name: 'Reserved', line: { color: COL.cyan, width: 1.5, dash: 'dash' } },
                { x, y: peak, type: 'scatter', mode: 'lines', name: 'Peak', line: { color: COL.red, width: 2 } },
            ];

            chartEl.innerHTML = '';
            Plotly.newPlot(chartEl, traces, {
                ...DARK_LAYOUT, height: 360,
                title: { text: 'GPU Memory Usage', font: { size: 13, color: '#d1d5db' }, x: 0.02, y: 0.97 },
                yaxis: { ...DARK_LAYOUT.yaxis, title: { text: 'Memory (GB)', font: { size: 11 } } },
            }, PLOTLY_CFG);
        }

        // ---- Tab: Per-Channel ----
        function _renderPerChannelChart(data, chartEl) {
            const epochs = data.epochs || [];
            const hasPerCh = epochs.some(e => e.val_per_channel_mse && e.val_per_channel_mse.length > 0);
            if (!hasPerCh) { _noData(chartEl, 'Per-channel metrics not available for this job'); return; }

            const x = epochs.map(e => e.epoch);
            const names = epochs.find(e => e.val_per_channel_names)?.val_per_channel_names || [];
            const nCh = epochs[0].val_per_channel_mse?.length || 0;

            const traces = [];
            for (let ch = 0; ch < nCh; ch++) {
                const y = epochs.map(e => (e.val_per_channel_mse || [])[ch] || null);
                traces.push({
                    x, y, type: 'scatter', mode: 'lines',
                    name: names[ch] || `Channel ${ch}`,
                    line: { color: CHANNEL_COLORS[ch % CHANNEL_COLORS.length], width: 2 },
                });
            }

            chartEl.innerHTML = '';
            Plotly.newPlot(chartEl, traces, {
                ...DARK_LAYOUT, height: 360,
                title: { text: 'Per-Channel Validation MSE', font: { size: 13, color: '#d1d5db' }, x: 0.02, y: 0.97 },
                yaxis: { ...DARK_LAYOUT.yaxis, title: { text: 'MSE', font: { size: 11 } } },
            }, PLOTLY_CFG);
        }

        // ---- Tab: Convergence ----
        function _renderConvergenceChart(data, chartEl) {
            const epochs = data.epochs || [];
            if (epochs.length === 0) { _noData(chartEl, 'No epoch data yet'); return; }

            const x = epochs.map(e => e.epoch);
            const hasGrad = epochs.some(e => e.grad_norm != null);
            const hasOverfit = epochs.some(e => e.overfit_ratio != null);
            const hasTime = epochs.some(e => e.epoch_time_seconds != null);
            const hasSps = epochs.some(e => e.samples_per_second != null);

            // Build subplots with Plotly subplots
            const traces = [];
            const annotations = [];
            let nRows = 0;

            // Row 1: Gradient norm
            if (hasGrad) {
                nRows++;
                traces.push({
                    x, y: epochs.map(e => e.grad_norm), type: 'scatter', mode: 'lines',
                    name: 'Grad Norm', line: { color: COL.purple, width: 2 },
                    yaxis: 'y',
                });
            }

            // Row 2: Overfit ratio
            if (hasOverfit) {
                nRows++;
                traces.push({
                    x, y: epochs.map(e => e.overfit_ratio), type: 'scatter', mode: 'lines',
                    name: 'Overfit Ratio', line: { color: COL.amber, width: 2 },
                    yaxis: nRows === 1 ? 'y' : 'y2',
                });
                // Add warning line at 2.0
                traces.push({
                    x: [x[0], x[x.length - 1]], y: [2.0, 2.0], type: 'scatter', mode: 'lines',
                    name: 'Overfit Threshold', line: { color: COL.red, width: 1, dash: 'dash' },
                    yaxis: nRows === 1 ? 'y' : 'y2', showlegend: false,
                });
            }

            // Row 3: Epoch time + samples/sec
            if (hasTime) {
                nRows++;
                traces.push({
                    x, y: epochs.map(e => e.epoch_time_seconds), type: 'scatter', mode: 'lines',
                    name: 'Epoch Time (s)', line: { color: COL.green, width: 2 },
                    yaxis: nRows <= 2 ? (nRows === 1 ? 'y' : 'y2') : 'y3',
                });
            }

            if (nRows === 0) { _noData(chartEl, 'Convergence data not available for this job'); return; }

            // Use a simple combined chart (not subplots) for simplicity
            chartEl.innerHTML = '';
            const layout = {
                ...DARK_LAYOUT, height: 400,
                title: { text: 'Convergence Diagnostics', font: { size: 13, color: '#d1d5db' }, x: 0.02, y: 0.97 },
                yaxis: { ...DARK_LAYOUT.yaxis, title: { text: hasGrad ? 'Gradient Norm' : (hasOverfit ? 'Overfit Ratio' : 'Epoch Time (s)'), font: { size: 11 } } },
            };

            // If we have multiple signals, use secondary Y axis
            if (nRows >= 2) {
                layout.yaxis2 = {
                    ...DARK_LAYOUT.yaxis,
                    title: { text: hasOverfit ? 'Overfit Ratio' : 'Epoch Time (s)', font: { size: 11 } },
                    overlaying: 'y', side: 'right',
                };
            }
            if (nRows >= 3) {
                // For 3 signals, overlay all
                layout.yaxis3 = {
                    ...DARK_LAYOUT.yaxis,
                    title: { text: 'Epoch Time (s)', font: { size: 11 } },
                    overlaying: 'y', side: 'right',
                    anchor: 'free', position: 0.95,
                };
            }

            Plotly.newPlot(chartEl, traces, layout, PLOTLY_CFG);
        }

        // ---- Tab: Test Results ----
        function _renderTestChart(data, chartEl) {
            const tm = data.test_metrics;
            const ts = data.training_summary || {};
            if (!tm || Object.keys(tm).length === 0) {
                _noData(chartEl, 'Test results available after training completes');
                return;
            }

            const metricOrder = ['test_r2', 'test_relative_l2', 'test_rmse', 'test_mae', 'test_max_error', 'test_mse'];
            const labels = { test_r2: 'R²', test_relative_l2: 'Rel. L2', test_rmse: 'RMSE', test_mae: 'MAE', test_max_error: 'Max Error', test_mse: 'MSE' };
            const colors = { test_r2: COL.green, test_relative_l2: COL.purple, test_rmse: COL.blue, test_mae: COL.cyan, test_max_error: COL.red, test_mse: COL.amber };

            const tooltips = {
                test_r2: 'R² (Coefficient of Determination)\n\nFormula: 1 − Σ(y − ŷ)² / Σ(y − ȳ)²\n\n✓ Higher is better (closer to 100%)\n\nExcellent: ≥ 99.9% | Very Good: ≥ 99%\nGood: ≥ 95% | Fair: ≥ 90% | Poor: < 90%',
                test_relative_l2: 'Relative L2 Error\n\nFormula: ||y − ŷ||₂ / ||y||₂\n\n✓ Lower is better (closer to 0)\n\nExcellent: < 1% | Good: < 5% | Fair: < 10% | Poor: > 10%',
                test_rmse: 'RMSE (Root Mean Squared Error)\n\n✓ Lower is better\n\nIn same units as your target field (e.g., m/s for velocity).',
                test_mae: 'MAE (Mean Absolute Error)\n\n✓ Lower is better\n\nCompare MAE to RMSE: if RMSE >> MAE, a few predictions have very large errors.',
                test_max_error: 'Max Error (Worst-Case)\n\nThe single largest pointwise error. Critical for safety-sensitive applications.',
                test_mse: 'MSE (Mean Squared Error)\n\nThis is typically the training loss function itself.',
            };

            function _getQuality(key, val) {
                switch(key) {
                    case 'test_r2':
                        if (val >= 0.999) return { text: 'Excellent', color: '#22c55e' };
                        if (val >= 0.99)  return { text: 'Very Good', color: '#10b981' };
                        if (val >= 0.95)  return { text: 'Good', color: '#f59e0b' };
                        if (val >= 0.90)  return { text: 'Fair', color: '#f97316' };
                        return { text: 'Poor', color: '#ef4444' };
                    case 'test_relative_l2':
                        if (val <= 0.01) return { text: 'Excellent', color: '#22c55e' };
                        if (val <= 0.05) return { text: 'Good', color: '#10b981' };
                        if (val <= 0.10) return { text: 'Fair', color: '#f59e0b' };
                        return { text: 'Poor', color: '#ef4444' };
                    case 'test_rmse':
                        if (val <= 0.005) return { text: 'Excellent', color: '#22c55e' };
                        if (val <= 0.02)  return { text: 'Good', color: '#10b981' };
                        if (val <= 0.05)  return { text: 'Fair', color: '#f59e0b' };
                        return { text: 'High', color: '#ef4444' };
                    case 'test_mae':
                        if (val <= 0.003) return { text: 'Excellent', color: '#22c55e' };
                        if (val <= 0.01)  return { text: 'Good', color: '#10b981' };
                        if (val <= 0.03)  return { text: 'Fair', color: '#f59e0b' };
                        return { text: 'High', color: '#ef4444' };
                    case 'test_max_error':
                        if (val <= 0.05) return { text: 'Excellent', color: '#22c55e' };
                        if (val <= 0.15) return { text: 'Good', color: '#10b981' };
                        if (val <= 0.30) return { text: 'Fair', color: '#f59e0b' };
                        return { text: 'High', color: '#ef4444' };
                    case 'test_mse':
                        if (val <= 0.0001) return { text: 'Excellent', color: '#22c55e' };
                        if (val <= 0.001)  return { text: 'Good', color: '#10b981' };
                        if (val <= 0.005)  return { text: 'Fair', color: '#f59e0b' };
                        return { text: 'High', color: '#ef4444' };
                    default: return null;
                }
            }

            for (const [k, v] of Object.entries(tooltips)) { window._mstarMetricTips[k] = v; }

            const available = metricOrder.filter(k => tm[k] != null);

            let html = '<div style="padding:20px;">';

            // Global metrics grid
            html += '<div style="font-size:14px;font-weight:600;color:var(--text-primary);margin-bottom:12px;">Global Test Metrics</div>';
            html += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-bottom:20px;">';
            for (const key of available) {
                const val = tm[key];
                const label = labels[key] || key;
                const color = colors[key] || COL.blue;
                const isR2 = key === 'test_r2';
                const displayVal = isR2 ? (val * 100).toFixed(4) + '%' : fmtNum(val);
                const q = _getQuality(key, val);
                const qualityHtml = q ? `<span style="color:${q.color};font-size:10px;margin-left:6px;">${q.text}</span>` : '';
                html += `<div style="padding:12px 14px;background:var(--bg-tertiary,#0f1423);border-radius:8px;border:1px solid var(--border-color,#333);">
                    <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">${escHtml(label)}${_tipBtn(key)}</div>
                    <div style="font-size:18px;font-weight:700;color:${color};font-family:'JetBrains Mono',monospace;">${displayVal}${qualityHtml}</div>
                </div>`;
            }
            html += '</div>';

            // Per-channel metrics table (if available)
            const chNames = tm.test_per_channel_names || ts.target_channel_names;
            const chRmse = tm.test_per_channel_rmse;
            const chR2 = tm.test_per_channel_r2;
            const chRelL2 = tm.test_per_channel_rel_l2;

            if (chNames && chRmse) {
                html += '<div style="font-size:14px;font-weight:600;color:var(--text-primary);margin-bottom:12px;">Per-Channel Breakdown</div>';
                html += '<div style="overflow-x:auto;">';
                html += '<table style="width:100%;border-collapse:collapse;font-size:12px;">';
                html += '<thead><tr style="border-bottom:1px solid var(--border-color,#333);">';
                html += '<th style="text-align:left;padding:8px;color:var(--text-muted);">Channel</th>';
                html += '<th style="text-align:right;padding:8px;color:var(--text-muted);">RMSE</th>';
                if (chR2) html += '<th style="text-align:right;padding:8px;color:var(--text-muted);">R²</th>';
                if (chRelL2) html += '<th style="text-align:right;padding:8px;color:var(--text-muted);">Rel. L2</th>';
                html += '</tr></thead><tbody>';

                for (let i = 0; i < chNames.length; i++) {
                    const rowColor = CHANNEL_COLORS[i % CHANNEL_COLORS.length];
                    html += `<tr style="border-bottom:1px solid rgba(99,115,156,0.08);">`;
                    html += `<td style="padding:8px;color:${rowColor};font-weight:600;">${escHtml(chNames[i])}</td>`;
                    html += `<td style="padding:8px;text-align:right;font-family:'JetBrains Mono',monospace;color:var(--text-primary);">${fmtNum(chRmse[i])}</td>`;
                    if (chR2) html += `<td style="padding:8px;text-align:right;font-family:'JetBrains Mono',monospace;color:var(--text-primary);">${(chR2[i] * 100).toFixed(3)}%</td>`;
                    if (chRelL2) html += `<td style="padding:8px;text-align:right;font-family:'JetBrains Mono',monospace;color:var(--text-primary);">${(chRelL2[i] * 100).toFixed(2)}%</td>`;
                    html += '</tr>';
                }
                html += '</tbody></table></div>';
            }

            html += '</div>';
            chartEl.innerHTML = html;
        }

        // ---- Tab: Error Map ----
        function _renderErrorMapChart(data, chartEl) {
            const tm = data.test_metrics;
            if (!tm || tm.test_error_p50 == null) {
                _noData(chartEl, 'Error distribution data available after training completes (requires updated backend)');
                return;
            }

            let html = '<div style="padding:20px;">';
            html += '<div style="font-size:14px;font-weight:600;color:var(--text-primary);margin-bottom:16px;">Spatial Error Distribution</div>';

            // Error percentile bar chart
            const percentiles = [
                { label: 'Median (p50)', key: 'test_error_p50', color: COL.green },
                { label: '90th Percentile', key: 'test_error_p90', color: COL.cyan },
                { label: '95th Percentile', key: 'test_error_p95', color: COL.blue },
                { label: '99th Percentile', key: 'test_error_p99', color: COL.amber },
                { label: '99.9th Percentile', key: 'test_error_p999', color: COL.orange },
                { label: 'Max Error', key: 'test_max_error', color: COL.red },
            ];

            const pctData = percentiles.filter(p => tm[p.key] != null);
            if (pctData.length > 0) {
                // Horizontal bar chart
                html += '<div id="ai-metrics-errorbar" style="width:100%;height:220px;margin-bottom:20px;"></div>';
            }

            // Worst-case analysis cards
            html += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin-bottom:16px;">';

            if (tm.test_worst_1pct_mean_error != null) {
                html += `<div style="padding:14px;background:rgba(239,68,68,0.06);border:1px solid rgba(239,68,68,0.2);border-radius:8px;">
                    <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;margin-bottom:4px;">Worst 1% Mean Error</div>
                    <div style="font-size:20px;font-weight:700;color:${COL.red};font-family:'JetBrains Mono',monospace;">${fmtNum(tm.test_worst_1pct_mean_error)}</div>
                    <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">${tm.test_worst_1pct_count ? tm.test_worst_1pct_count.toLocaleString() + ' voxels' : ''}</div>
                </div>`;
            }

            if (tm.test_error_skewness != null) {
                const skew = tm.test_error_skewness;
                const skewLabel = skew > 3 ? 'Heavy tail (localized errors)' : skew > 1.5 ? 'Moderate tail' : 'Well-distributed';
                const skewColor = skew > 3 ? COL.amber : skew > 1.5 ? COL.cyan : COL.green;
                html += `<div style="padding:14px;background:rgba(139,92,246,0.06);border:1px solid rgba(139,92,246,0.2);border-radius:8px;">
                    <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;margin-bottom:4px;">Error Skewness</div>
                    <div style="font-size:20px;font-weight:700;color:${COL.purple};font-family:'JetBrains Mono',monospace;">${fmtNum(skew, 2)}</div>
                    <div style="font-size:11px;color:${skewColor};margin-top:4px;">${skewLabel}</div>
                </div>`;
            }

            // Error ratio: p99/p50 — tells you how concentrated the errors are
            if (tm.test_error_p99 != null && tm.test_error_p50 != null && tm.test_error_p50 > 0) {
                const ratio = tm.test_error_p99 / tm.test_error_p50;
                const ratioLabel = ratio > 20 ? 'Highly concentrated errors' : ratio > 10 ? 'Moderate concentration' : 'Evenly distributed';
                const ratioColor = ratio > 20 ? COL.red : ratio > 10 ? COL.amber : COL.green;
                html += `<div style="padding:14px;background:rgba(6,182,212,0.06);border:1px solid rgba(6,182,212,0.2);border-radius:8px;">
                    <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;margin-bottom:4px;">P99/P50 Ratio</div>
                    <div style="font-size:20px;font-weight:700;color:${COL.cyan};font-family:'JetBrains Mono',monospace;">${ratio.toFixed(1)}×</div>
                    <div style="font-size:11px;color:${ratioColor};margin-top:4px;">${ratioLabel}</div>
                </div>`;
            }

            html += '</div>';

            // Interpretation guidance
            html += `<div style="padding:12px;background:rgba(59,130,246,0.06);border:1px solid rgba(59,130,246,0.15);border-radius:8px;font-size:12px;color:var(--text-secondary);line-height:1.5;">
                <strong style="color:var(--text-primary);">How to read this:</strong> The percentile chart shows what fraction of spatial points have errors below each threshold.
                If p99 >> p50, errors are concentrated in a small number of regions (typically boundaries, wakes, or stagnation points).
                Use ParaView to visualize the error VTI files in the run directory to identify WHERE the model struggles.
            </div>`;

            html += '</div>';
            chartEl.innerHTML = html;

            // Render the Plotly bar chart after HTML is in the DOM
            if (pctData.length > 0) {
                const barEl = document.getElementById('ai-metrics-errorbar');
                if (barEl) {
                    Plotly.newPlot(barEl, [{
                        y: pctData.map(p => p.label),
                        x: pctData.map(p => tm[p.key]),
                        type: 'bar', orientation: 'h',
                        marker: { color: pctData.map(p => p.color) },
                        text: pctData.map(p => fmtNum(tm[p.key])),
                        textposition: 'outside',
                        textfont: { color: '#9ca3af', size: 11 },
                    }], {
                        ...DARK_LAYOUT, height: 220,
                        margin: { l: 140, r: 60, t: 10, b: 30 },
                        xaxis: { ...DARK_LAYOUT.xaxis, title: { text: 'Absolute Error', font: { size: 11 } } },
                        yaxis: { ...DARK_LAYOUT.yaxis, autorange: 'reversed' },
                        showlegend: false,
                    }, PLOTLY_CFG);
                }
            }
        }

        // ---- Embeddable renderer (for inline modal use) ----
        function renderMetricsInto(container, jobId, jobMeta) {
            _currentJobId = jobId;
            _activeTab = 'loss';
            const meta = jobMeta || {};

            container.innerHTML = `
                <div style="padding:16px 24px;">
                    <div id="ai-metrics-stats" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:16px;"></div>
                    <div id="ai-metrics-tabs" style="display:flex;gap:0;margin-bottom:12px;flex-wrap:wrap;"></div>
                    <div style="background:var(--bg-card,#1a1a2e);border:1px solid var(--border-color,#333);border-radius:8px;padding:8px;">
                        <div id="ai-metrics-chart" style="width:100%;min-height:360px;"></div>
                    </div>
                    <div id="ai-metrics-status" style="font-size:11px;color:var(--text-muted);margin-top:8px;text-align:right;"></div>
                </div>`;

            _renderTabs(container);
            _loadAndRender(jobId);

            const isRunning = meta.status === 'running' || meta.status === 'preflight' || meta.status === 'launching';
            let timer = null;
            if (isRunning) {
                timer = setInterval(() => _loadAndRender(jobId), 3000);
            }
            return timer;
        }

        // ---- Expose global API ----
        window._aiTrainingMetrics = {
            openTrainingMetrics,
            closeTrainingMetrics,
            refreshTrainingMetrics,
            renderMetricsInto,
        };

    })();
