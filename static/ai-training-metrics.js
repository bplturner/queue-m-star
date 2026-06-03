/**
 * AI Training Metrics — M-Star Queue
 * ====================================
 * Standalone module for real-time training progress visualization.
 * Uses Plotly.js (already loaded globally) with the app's dark theme.
 *
 * Exposes: window._aiTrainingMetrics = { openTrainingMetrics, closeTrainingMetrics, refreshTrainingMetrics }
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
            // Close existing
            if (_activeTipEl) { _activeTipEl.remove(); _activeTipEl = null; }

            const pop = document.createElement('div');
            pop.className = 'ai-metric-tip-popover';
            pop.style.cssText = 'position:fixed;z-index:100000;max-width:380px;padding:16px 18px;border-radius:10px;'
                + 'background:var(--bg-secondary,#1e293b);border:1px solid var(--accent-blue,#3b82f6);'
                + 'box-shadow:0 12px 40px rgba(0,0,0,0.5);color:var(--text-primary,#e2e8f0);font-size:12px;'
                + 'line-height:1.6;font-family:Inter,system-ui,sans-serif;';

            // Format text: split on \n\n for paragraphs, \n for line breaks
            const formatted = text.split('\n\n').map(para => {
                const lines = para.split('\n').map(line => {
                    // Bold lines that look like headers (short, no colon at end)
                    if (line.length < 60 && !line.includes(':') && !line.startsWith(' ') && !line.startsWith('✓') && !line.startsWith('•') && line === line.trim()) {
                        return `<div style="font-weight:600;color:var(--accent-blue,#60a5fa);font-size:13px;margin-bottom:2px;">${escHtml(line)}</div>`;
                    }
                    // Threshold lines with | separators
                    if (line.includes('|') && (line.includes('Excellent') || line.includes('Good') || line.includes('Fair') || line.includes('Poor'))) {
                        return `<div style="padding:4px 8px;background:rgba(59,130,246,0.08);border-radius:4px;font-family:'JetBrains Mono',monospace;font-size:11px;margin:2px 0;">${escHtml(line)}</div>`;
                    }
                    // Checkmark lines
                    if (line.startsWith('✓') || line.startsWith('✔')) {
                        return `<div style="color:#22c55e;">${escHtml(line)}</div>`;
                    }
                    // Bullet lines
                    if (line.trim().startsWith('•')) {
                        return `<div style="padding-left:8px;">${escHtml(line)}</div>`;
                    }
                    // "To improve:" lines
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

            // Position near the anchor
            const rect = anchorEl.getBoundingClientRect();
            const popW = pop.offsetWidth;
            const popH = pop.offsetHeight;
            let left = rect.left + rect.width / 2 - popW / 2;
            let top = rect.bottom + 8;
            // Clamp to viewport
            if (left < 8) left = 8;
            if (left + popW > window.innerWidth - 8) left = window.innerWidth - 8 - popW;
            if (top + popH > window.innerHeight - 8) top = rect.top - popH - 8;
            pop.style.left = left + 'px';
            pop.style.top = top + 'px';

            // Dismiss on outside click or Escape
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

        // ? button HTML helper
        function _tipBtn(tipKey) {
            return `<button class="ai-tip-btn" data-tip-key="${tipKey}" onclick="_mstarShowTip(this)" `
                + `style="display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;`
                + `border-radius:50%;border:1px solid var(--border-color,#444);background:rgba(59,130,246,0.1);`
                + `color:var(--accent-blue,#60a5fa);font-size:9px;font-weight:700;cursor:pointer;margin-left:4px;`
                + `vertical-align:middle;padding:0;line-height:1;font-family:Inter,sans-serif;">?</button>`;
        }

        // Global handler (needed for inline onclick)
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

        // ---- Plotly dark-theme layout (matches GPU charts in scripts.js) ----
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

        // Colors
        const COL = {
            blue: '#3b82f6',
            cyan: '#06b6d4',
            amber: '#f59e0b',
            green: '#10b981',
            red: '#ef4444',
            purple: '#8b5cf6',
        };

        // ---- State ----
        let _pollTimer = null;
        let _currentJobId = null;
        let _activeTab = 'loss';

        // ---- Public API ----
        function openTrainingMetrics(jobId, jobMeta) {
            // Remove any existing overlay
            closeTrainingMetrics();

            _currentJobId = jobId;
            _activeTab = 'loss';

            const meta = jobMeta || {};
            const title = `Training Metrics — Job #${jobId}`;
            const subtitle = [meta.model_family, meta.run_name].filter(Boolean).join(' · ');

            // Create overlay
            const overlay = document.createElement('div');
            overlay.id = 'ai-metrics-overlay';
            overlay.innerHTML = `
            <div class="modal-backdrop" id="ai-metrics-backdrop"></div>
            <div class="modal-content modal-lg" style="max-width:900px;max-height:90vh;overflow-y:auto;">
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
                    <div id="ai-metrics-stats" style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px;"></div>

                    <!-- Tabs -->
                    <div id="ai-metrics-tabs" style="display:flex;gap:0;margin-bottom:12px;">
                        <button class="ai-mtab active" data-tab="loss" style="flex:1;padding:10px;text-align:center;cursor:pointer;border:1px solid var(--border-color,#333);background:var(--accent-blue,#3b82f6);color:#fff;font-weight:500;font-size:13px;border-radius:8px 0 0 8px;transition:all 0.2s;">
                            Loss Curves
                        </button>
                        <button class="ai-mtab" data-tab="lr" style="flex:1;padding:10px;text-align:center;cursor:pointer;border:1px solid var(--border-color,#333);background:var(--bg-card,#1a1a2e);color:var(--text-secondary,#a0a0b0);font-weight:500;font-size:13px;transition:all 0.2s;">
                            Learning Rate
                        </button>
                        <button class="ai-mtab" data-tab="test" style="flex:1;padding:10px;text-align:center;cursor:pointer;border:1px solid var(--border-color,#333);background:var(--bg-card,#1a1a2e);color:var(--text-secondary,#a0a0b0);font-weight:500;font-size:13px;border-radius:0 8px 8px 0;transition:all 0.2s;">
                            Test Results
                        </button>
                    </div>

                    <!-- Chart container -->
                    <div style="background:var(--bg-card,#1a1a2e);border:1px solid var(--border-color,#333);border-radius:8px;padding:8px;">
                        <div id="ai-metrics-chart" style="width:100%;height:320px;"></div>
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

            // Event listeners
            overlay.querySelector('#ai-metrics-close').addEventListener('click', closeTrainingMetrics);
            overlay.querySelector('#ai-metrics-backdrop').addEventListener('click', closeTrainingMetrics);
            document.addEventListener('keydown', _escHandler);

            // Continue / Transfer / Export button handlers
            const continueBtn = overlay.querySelector('#ai-metrics-continue');
            if (continueBtn) {
                continueBtn.addEventListener('click', () => {
                    const resumeOpts = {
                        mode: 'continue',
                        sourceJobId: jobId,
                        modelFamily: meta.model_family,
                        runName: meta.run_name,
                        status: meta.status,
                    };
                    closeTrainingMetrics();
                    // Dispatch to the AI training module
                    if (window._aiTrainingModule && window._aiTrainingModule.showView) {
                        window._aiTrainingModule.showView('new-training', resumeOpts);
                    }
                });
            }
            const transferBtn = overlay.querySelector('#ai-metrics-transfer');
            if (transferBtn) {
                transferBtn.addEventListener('click', () => {
                    const resumeOpts = {
                        mode: 'transfer',
                        sourceJobId: jobId,
                        modelFamily: meta.model_family,
                        runName: meta.run_name,
                        status: meta.status,
                    };
                    closeTrainingMetrics();
                    if (window._aiTrainingModule && window._aiTrainingModule.showView) {
                        window._aiTrainingModule.showView('new-training', resumeOpts);
                    }
                });
            }

            // Export button handler
            const exportBtn = overlay.querySelector('#ai-metrics-export');
            if (exportBtn) {
                exportBtn.addEventListener('click', async () => {
                    exportBtn.disabled = true;
                    exportBtn.innerHTML = '<span class="spinner" style="width:14px;height:14px;border-width:2px;display:inline-block;margin-right:6px;"></span> Exporting…';
                    exportBtn.style.opacity = '0.7';

                    try {
                        const res = await fetch(`/api/ai/training-jobs/${jobId}/export`, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'Authorization': `Bearer ${getToken()}`,
                            },
                            body: JSON.stringify({ formats: 'onnx,torchscript' }),
                        });
                        const data = await res.json();

                        if (data.error) {
                            exportBtn.innerHTML = '❌ Export Failed';
                            exportBtn.style.color = '#ef4444';
                            exportBtn.style.borderColor = 'rgba(239,68,68,0.3)';
                            _showStatus('Export error: ' + data.error, true);
                        } else {
                            exportBtn.innerHTML = '✅ Exported';
                            exportBtn.style.color = '#22c55e';
                            exportBtn.style.borderColor = 'rgba(34,197,94,0.3)';

                            // Show export result card
                            const exportInfo = data.export || {};
                            const files = exportInfo.exported_files || {};
                            const outputDir = data.output_dir || exportInfo.output_dir || '';
                            const params = exportInfo.total_parameters || 0;

                            let fileList = '';
                            for (const [fmt, path] of Object.entries(files)) {
                                if (fmt.endsWith('_error')) continue;
                                const basename = path.split('/').pop();
                                const icon = fmt === 'onnx' ? '🔷' : '🔶';
                                fileList += `<div style="display:flex;align-items:center;gap:8px;padding:6px 0;">
                                    <span>${icon}</span>
                                    <span style="font-family:monospace;font-size:12px;color:var(--text-primary);">${escHtml(basename)}</span>
                                    <span style="font-size:10px;color:var(--text-muted);text-transform:uppercase;">${fmt}</span>
                                </div>`;
                            }

                            const resultHtml = `
                                <div style="margin-top:12px;padding:14px;background:rgba(16,185,129,0.06);border:1px solid rgba(16,185,129,0.2);border-radius:8px;">
                                    <div style="font-size:13px;font-weight:600;color:#34d399;margin-bottom:8px;">📦 Model Exported Successfully</div>
                                    ${fileList}
                                    <div style="font-size:11px;color:var(--text-muted);margin-top:8px;padding-top:8px;border-top:1px solid rgba(16,185,129,0.1);">
                                        <div><strong>Parameters:</strong> ${params.toLocaleString()}</div>
                                        <div style="margin-top:2px;"><strong>Location:</strong> <code style="font-size:11px;">${escHtml(outputDir)}</code></div>
                                        <div style="margin-top:4px;color:var(--text-muted);">Includes <code style="font-size:11px;">export_metadata.json</code> with normalization stats and field mappings for standalone inference.</div>
                                    </div>
                                </div>`;

                            // Insert after the buttons div
                            exportBtn.closest('div').insertAdjacentHTML('afterend', resultHtml);
                            _showStatus('Model exported to ' + outputDir, false);
                        }
                    } catch (err) {
                        console.error('[AI Metrics] Export error:', err);
                        exportBtn.innerHTML = '❌ Export Failed';
                        exportBtn.style.color = '#ef4444';
                        _showStatus('Export request failed: ' + err.message, true);
                    }

                    // Re-enable after 3s
                    setTimeout(() => {
                        exportBtn.disabled = false;
                        exportBtn.style.opacity = '1';
                    }, 3000);
                });
            }

            // Tab switching
            overlay.querySelectorAll('.ai-mtab').forEach(tab => {
                tab.addEventListener('click', () => {
                    _activeTab = tab.dataset.tab;
                    overlay.querySelectorAll('.ai-mtab').forEach(t => {
                        const isActive = t.dataset.tab === _activeTab;
                        t.style.background = isActive ? 'var(--accent-blue,#3b82f6)' : 'var(--bg-card,#1a1a2e)';
                        t.style.color = isActive ? '#fff' : 'var(--text-secondary,#a0a0b0)';
                        t.style.borderColor = isActive ? 'var(--accent-blue,#3b82f6)' : 'var(--border-color,#333)';
                    });
                    _renderCurrentTab();
                });
            });

            // Load data
            _loadAndRender(jobId);

            // Poll for running jobs
            const isActive = meta.status === 'running' || meta.status === 'preflight' || meta.status === 'launching';
            if (isActive) {
                _pollTimer = setInterval(() => _loadAndRender(jobId), 3000);
            }
        }

        function closeTrainingMetrics() {
            if (_pollTimer) {
                clearInterval(_pollTimer);
                _pollTimer = null;
            }
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

        // ---- Data loading ----
        let _lastData = null;

        async function _loadAndRender(jobId) {
            if (!jobId) return;
            try {
                const data = await fetchMetrics(jobId);
                if (data.error) {
                    _showStatus(`Error: ${data.error}`, true);
                    return;
                }
                _lastData = data;
                _renderStats(data);
                _renderCurrentTab();

                // Update status bar
                const n = (data.epochs || []).length;
                const ts = new Date().toLocaleTimeString();
                const isActive = data.job_status === 'running' || data.job_status === 'preflight';
                _showStatus(
                    `${n} epoch${n !== 1 ? 's' : ''} loaded · ${isActive ? '🔴 Live' : '✓ Complete'} · ${ts}`,
                    false
                );

                // Stop polling if job is done
                if (!isActive && _pollTimer) {
                    clearInterval(_pollTimer);
                    _pollTimer = null;
                }
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

            const totalEpochs = cfg.epochs || epochs.length;
            const bestValLoss = epochs.length > 0
                ? Math.min(...epochs.map(e => e.val_loss).filter(v => v != null && !isNaN(v)))
                : null;

            const cards = [
                { label: 'Epochs', value: `${epochs.length}${totalEpochs ? ' / ' + totalEpochs : ''}`, color: 'var(--text-primary)', tipKey: 'epochs' },
                { label: 'Best Val Loss', value: fmtNum(bestValLoss, 4), color: COL.cyan, tipKey: 'val_loss' },
                { label: 'R²', value: tm.test_r2 != null ? fmtNum(tm.test_r2, 6) : '—', color: COL.green, tipKey: 'r2' },
                { label: 'Time', value: fmtDuration(lastEpoch.elapsed_seconds), color: 'var(--text-primary)', tipKey: 'time' },
            ];

            const headerTips = {
                epochs: 'Training iterations completed out of total requested.\n\nEach epoch processes the entire dataset once. More epochs allow the model to learn better, but too many can lead to overfitting (where the model memorizes training data but fails on new inputs).\n\nTypical range: 200-1000 epochs for CFD surrogates.',
                val_loss: 'Lowest validation loss achieved during training.\n\nCalculation: Mean Squared Error on a held-out validation split (data the model never trained on).\n\n✓ Lower is better — approaches 0 for a perfect model.\n\nGood: < 0.01 | Fair: 0.01-0.05 | Poor: > 0.05\n\nIf this value stops decreasing while training loss keeps dropping, your model is overfitting. Try reducing model complexity, adding dropout, or getting more training data.',
                r2: 'R² (Coefficient of Determination) on the test set.\n\nCalculation: 1 − (Σ(y − ŷ)²) / (Σ(y − ȳ)²)\nMeasures how much variance in the true data your model explains.\n\n✓ Higher is better — 1.0 means perfect prediction.\n\nExcellent: ≥ 99.9% | Very Good: ≥ 99% | Good: ≥ 95%\nFair: ≥ 90% | Poor: < 90%\n\nFor CFD surrogate models, aim for R² > 0.95. Values below 0.90 suggest the model is missing significant flow features. Check your input channels, increase model depth, or add more training cases.',
                time: 'Total wall-clock training time.\n\nIncludes forward/backward passes, validation, and checkpointing. GPU utilization and batch size significantly affect this.',
            };

            // Register tips globally for the onclick handler
            for (const [k, v] of Object.entries(headerTips)) {
                window._mstarMetricTips['hdr_' + k] = v;
            }

            el.innerHTML = cards.map(c => `
            <div style="flex:1;min-width:120px;padding:14px 18px;border-radius:10px;background:var(--bg-card,#1a1a2e);border:1px solid var(--border-color,#333);position:relative;">
                <div style="font-size:24px;font-weight:700;line-height:1;color:${c.color};">${c.value}</div>
                <div style="font-size:11px;color:var(--text-muted);margin-top:4px;text-transform:uppercase;letter-spacing:0.5px;">${c.label}${c.tipKey ? _tipBtn('hdr_' + c.tipKey) : ''}</div>
            </div>
        `).join('');
        }

        // ---- Chart Rendering ----
        function _renderCurrentTab() {
            if (!_lastData) return;
            switch (_activeTab) {
                case 'loss': _renderLossChart(_lastData); break;
                case 'lr': _renderLRChart(_lastData); break;
                case 'test': _renderTestChart(_lastData); break;
            }
        }

        function _renderLossChart(data) {
            const chartEl = document.getElementById('ai-metrics-chart');
            if (!chartEl) return;

            const epochs = data.epochs || [];
            if (epochs.length === 0) {
                chartEl.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted);font-size:13px;">No epoch data yet</div>';
                return;
            }

            const x = epochs.map(e => e.epoch);
            const trainLoss = epochs.map(e => e.train_loss);
            const valLoss = epochs.map(e => e.val_loss);

            const traces = [
                {
                    x, y: trainLoss,
                    type: 'scatter', mode: 'lines',
                    name: 'Train Loss',
                    line: { color: COL.blue, width: 2 },
                },
                {
                    x, y: valLoss,
                    type: 'scatter', mode: 'lines',
                    name: 'Val Loss',
                    line: { color: COL.cyan, width: 2, dash: 'dot' },
                },
            ];

            // Find best val loss epoch
            let bestIdx = 0;
            let bestVal = Infinity;
            valLoss.forEach((v, i) => { if (v < bestVal) { bestVal = v; bestIdx = i; } });

            // Add best-point marker
            traces.push({
                x: [x[bestIdx]], y: [bestVal],
                type: 'scatter', mode: 'markers',
                name: `Best: ${fmtNum(bestVal, 4)}`,
                marker: { color: COL.green, size: 10, symbol: 'star', line: { color: '#fff', width: 1 } },
            });

            // Clear any non-Plotly HTML (e.g. from Test Results tab) and redraw
            chartEl.innerHTML = '';
            Plotly.newPlot(chartEl, traces, {
                ...DARK_LAYOUT,
                height: 320,
                title: { text: 'Training & Validation Loss', font: { size: 13, color: '#d1d5db' }, x: 0.02, y: 0.97 },
                yaxis: { ...DARK_LAYOUT.yaxis, title: { text: 'Loss', font: { size: 11 } } },
            }, PLOTLY_CFG);
        }

        function _renderLRChart(data) {
            const chartEl = document.getElementById('ai-metrics-chart');
            if (!chartEl) return;

            const epochs = data.epochs || [];
            if (epochs.length === 0) {
                chartEl.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted);font-size:13px;">No epoch data yet</div>';
                return;
            }

            const x = epochs.map(e => e.epoch);
            const lr = epochs.map(e => e.learning_rate);

            // Clear any non-Plotly HTML (e.g. from Test Results tab) and redraw
            chartEl.innerHTML = '';
            Plotly.newPlot(chartEl, [{
                x, y: lr,
                type: 'scatter', mode: 'lines+markers',
                name: 'Learning Rate',
                line: { color: COL.amber, width: 2 },
                marker: { color: COL.amber, size: 4 },
            }], {
                ...DARK_LAYOUT,
                height: 320,
                title: { text: 'Learning Rate Schedule', font: { size: 13, color: '#d1d5db' }, x: 0.02, y: 0.97 },
                yaxis: {
                    ...DARK_LAYOUT.yaxis,
                    title: { text: 'Learning Rate', font: { size: 11 } },
                    type: lr.some(v => v > 0 && v < 1e-5) ? 'log' : 'linear',
                    exponentformat: 'e',
                },
            }, PLOTLY_CFG);
        }

        function _renderTestChart(data) {
            const chartEl = document.getElementById('ai-metrics-chart');
            if (!chartEl) return;

            const tm = data.test_metrics;
            if (!tm || Object.keys(tm).length === 0) {
                chartEl.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted);font-size:13px;">Test results available after training completes</div>';
                return;
            }

            // Separate R² (0-1 scale) from error metrics (large scale)
            const metricOrder = ['test_r2', 'test_relative_l2', 'test_rmse', 'test_mae', 'test_max_error', 'test_mse'];
            const labels = {
                test_r2: 'R²', test_relative_l2: 'Rel. L2',
                test_rmse: 'RMSE', test_mae: 'MAE',
                test_max_error: 'Max Error', test_mse: 'MSE',
            };
            const colors = {
                test_r2: COL.green, test_relative_l2: COL.purple,
                test_rmse: COL.blue, test_mae: COL.cyan,
                test_max_error: COL.red, test_mse: COL.amber,
            };

            // Render as a styled table instead of a bar chart (more readable for mixed scales)
            const available = metricOrder.filter(k => tm[k] != null);

            let html = '<div style="padding:20px;">';
            html += '<div style="font-size:14px;font-weight:600;color:var(--text-primary);margin-bottom:16px;">Test Set Evaluation</div>';
            html += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;">';

            // Detailed tooltip descriptions for each metric
            const tooltips = {
                test_r2: 'R\u00b2 (Coefficient of Determination)\n\nFormula: 1 \u2212 \u03a3(y \u2212 \u0177)\u00b2 / \u03a3(y \u2212 \u0233)\u00b2\n\nMeasures how much variance in the true data your model explains. A value of 1.0 means perfect prediction; 0.0 means the model is no better than predicting the mean.\n\n\u2714 Higher is better (closer to 100%)\n\nThresholds for CFD surrogates:\n  Excellent: \u2265 99.9% | Very Good: \u2265 99%\n  Good: \u2265 95% | Fair: \u2265 90% | Poor: < 90%\n\nYour value is evaluated on a held-out test set (unseen cases). If R\u00b2 is low but training loss is low, your model may be overfitting.\n\nTo improve: add more training cases, increase model depth, improve input normalization, or add physics-informed loss terms.',

                test_relative_l2: 'Relative L2 Error (Normalized L2 Norm)\n\nFormula: ||y \u2212 \u0177||\u2082 / ||y||\u2082\n\nThe L2 norm of the prediction error divided by the L2 norm of the true field. This is scale-invariant, making it the most reliable single metric for comparing model fidelity across different physical quantities.\n\n\u2714 Lower is better (closer to 0)\n\nThresholds for CFD surrogates:\n  Excellent: < 0.01 (1%) | Good: < 0.05 (5%)\n  Fair: < 0.10 (10%) | Poor: > 0.10 (10%)\n\nA value of 0.26 means 26% relative error \u2014 the model captures the general trend but misses significant details. State-of-the-art CFD surrogates typically achieve < 5%.\n\nTo improve: check input normalization, increase training epochs, try residual learning, or add more cases to the sweep.',

                test_rmse: 'RMSE (Root Mean Squared Error)\n\nFormula: \u221a(\u03a3(y \u2212 \u0177)\u00b2 / N)\n\nSquare root of the average squared error. Expressed in the same units as your target field (e.g., m/s for velocity). Penalizes large errors more than small ones.\n\n\u2714 Lower is better (closer to 0)\n\nInterpretation depends on the magnitude of your field:\n  If velocity range is 0-10 m/s, RMSE of 0.06 \u2248 0.6% error \u2192 excellent\n  If velocity range is 0-1 m/s, RMSE of 0.06 \u2248 6% error \u2192 fair\n\nRule of thumb: RMSE should be < 5% of the target field range for a good surrogate.\n\nTo improve: focus on high-gradient regions in your loss function, or use a weighted MSE loss.',

                test_mae: 'MAE (Mean Absolute Error)\n\nFormula: \u03a3|y \u2212 \u0177| / N\n\nAverage magnitude of errors in the same units as your target field. More robust to outliers than RMSE \u2014 gives equal weight to all errors.\n\n\u2714 Lower is better (closer to 0)\n\nCompare MAE to RMSE:\n  If RMSE >> MAE: a few predictions have very large errors (check boundary regions or wakes)\n  If RMSE \u2248 MAE: errors are uniformly distributed\n\nRule of thumb: MAE should be < 3% of the target field range for engineering use.',

                test_max_error: 'Max Error (L\u221e Norm / Worst-Case Error)\n\nFormula: max(|y \u2212 \u0177|)\n\nThe single largest pointwise error anywhere in your test set. Critical for safety-sensitive applications where one bad prediction region could be catastrophic.\n\n\u2714 Lower is better\n\nThis metric is often dominated by:\n  \u2022 Boundary layers or wall regions\n  \u2022 Stagnation points\n  \u2022 Wake/separation zones\n  \u2022 Regions of high gradients\n\nCompare to field range: Max error should be < 20% of the field range.\n\nTo improve: visualize where the max error occurs. Consider weighting the loss function to penalize errors in high-gradient regions, or add more resolution in the boundary layer.',

                test_mse: 'MSE (Mean Squared Error)\n\nFormula: \u03a3(y \u2212 \u0177)\u00b2 / N\n\nAverage of squared prediction errors. This is typically the training loss function itself \u2014 what the optimizer directly minimizes. Heavily penalizes large errors.\n\n\u2714 Lower is better (closer to 0)\n\nMSE = RMSE\u00b2 (so RMSE is the more interpretable version)\n\nUseful for comparing training loss vs test MSE:\n  If test MSE >> training MSE: model is overfitting\n  If both are similar: good generalization\n\nTo improve: same strategies as RMSE \u2014 better normalization, more data, regularization.',
            };

            // Quality indicators for ALL metrics
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

            // Register test metric tips globally
            for (const [k, v] of Object.entries(tooltips)) {
                window._mstarMetricTips[k] = v;
            }

            for (const key of available) {
                const val = tm[key];
                const label = labels[key] || key;
                const color = colors[key] || COL.blue;
                const isR2 = key === 'test_r2';
                const displayVal = isR2 ? (val * 100).toFixed(4) + '%' : fmtNum(val);
                const q = _getQuality(key, val);
                const qualityHtml = q ? `<span style="color:${q.color};font-size:10px;margin-left:6px;">${q.text}</span>` : '';

                html += `
                <div style="padding:14px 16px;background:var(--bg-tertiary,#0f1423);border-radius:8px;border:1px solid var(--border-color,#333);position:relative;">
                    <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">${escHtml(label)}${_tipBtn(key)}</div>
                    <div style="font-size:20px;font-weight:700;color:${color};font-family:'JetBrains Mono',monospace;">${displayVal}${qualityHtml}</div>
                </div>
            `;
            }

            html += '</div></div>';
            chartEl.innerHTML = html;
        }

        // ---- Embeddable renderer (for inline modal use) ----
        function renderMetricsInto(container, jobId, jobMeta) {
            _currentJobId = jobId;
            _activeTab = 'loss';

            const meta = jobMeta || {};

            container.innerHTML = `
                <div style="padding:16px 24px;">
                    <!-- Stat cards -->
                    <div id="ai-metrics-stats" style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px;"></div>

                    <!-- Tabs -->
                    <div id="ai-metrics-tabs" style="display:flex;gap:0;margin-bottom:12px;">
                        <button class="ai-mtab active" data-tab="loss" style="flex:1;padding:10px;text-align:center;cursor:pointer;border:1px solid var(--border-color,#333);background:var(--accent-blue,#3b82f6);color:#fff;font-weight:500;font-size:13px;border-radius:8px 0 0 8px;transition:all 0.2s;">
                            Loss Curves
                        </button>
                        <button class="ai-mtab" data-tab="lr" style="flex:1;padding:10px;text-align:center;cursor:pointer;border:1px solid var(--border-color,#333);background:var(--bg-card,#1a1a2e);color:var(--text-secondary,#a0a0b0);font-weight:500;font-size:13px;transition:all 0.2s;">
                            Learning Rate
                        </button>
                        <button class="ai-mtab" data-tab="test" style="flex:1;padding:10px;text-align:center;cursor:pointer;border:1px solid var(--border-color,#333);background:var(--bg-card,#1a1a2e);color:var(--text-secondary,#a0a0b0);font-weight:500;font-size:13px;border-radius:0 8px 8px 0;transition:all 0.2s;">
                            Test Results
                        </button>
                    </div>

                    <!-- Chart container -->
                    <div style="background:var(--bg-card,#1a1a2e);border:1px solid var(--border-color,#333);border-radius:8px;padding:8px;">
                        <div id="ai-metrics-chart" style="width:100%;height:320px;"></div>
                    </div>

                    <!-- Status bar -->
                    <div id="ai-metrics-status" style="font-size:11px;color:var(--text-muted);margin-top:8px;text-align:right;"></div>
                </div>`;

            // Tab switching
            container.querySelectorAll('.ai-mtab').forEach(tab => {
                tab.addEventListener('click', () => {
                    _activeTab = tab.dataset.tab;
                    container.querySelectorAll('.ai-mtab').forEach(t => {
                        const isAct = t.dataset.tab === _activeTab;
                        t.style.background = isAct ? 'var(--accent-blue,#3b82f6)' : 'var(--bg-card,#1a1a2e)';
                        t.style.color = isAct ? '#fff' : 'var(--text-secondary,#a0a0b0)';
                        t.style.borderColor = isAct ? 'var(--accent-blue,#3b82f6)' : 'var(--border-color,#333)';
                    });
                    _renderCurrentTab();
                });
            });

            // Load data
            _loadAndRender(jobId);

            // Poll for running jobs, return timer for cleanup
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
