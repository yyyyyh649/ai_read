/**
 * AI Paper Reader — Frontend Application
 * 论文 AI 阅读助手前端逻辑
 * 支持 Web UI 动态配置 API 模型（主力/辅助各自独立）
 */

// ─── Global State ───
const state = {
    fileId: null,
    currentTab: 'quick-scan',
    paperMeta: null,
    tasks: {},   // 每个 tab 独立的任务状态：{ running, controller, text, done, error }
};

function getTask(tab) {
    if (!state.tasks[tab]) {
        state.tasks[tab] = { running: false, controller: null, text: '', done: false, error: null, canRetry: false };
    }
    return state.tasks[tab];
}

// ─── DOM Elements ───
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const dom = {
    uploadZone: $('#uploadZone'),
    fileInput: $('#fileInput'),
    pdfPreview: $('#pdfPreview'),
    pdfFrame: $('#pdfFrame'),
    pdfTitle: $('#pdfTitle'),
    emptyState: $('#emptyState'),
    workspace: $('#workspace'),
    tabs: $('#tabs'),
    btnRun: $('#btnRun'),
    btnStop: $('#btnStop'),
    statusText: $('#statusText'),
    resultPlaceholder: $('#resultPlaceholder'),
    resultContent: $('#resultContent'),
    mindmapContainer: $('#mindmapContainer'),
    mindmapSvg: $('#mindmapSvg'),
    translatePopup: $('#translatePopup'),
    translatePopupBody: $('#translatePopupBody'),
    modelBadge: $('#modelBadge'),
};

// ─── Initialization ───
document.addEventListener('DOMContentLoaded', () => {
    setupUpload();
    setupTabs();
    setupTextSelection();
    loadModelConfig();
});

// ─── Model Config Management ───
function toggleModelSettings() {
    const panel = document.getElementById('settingsPanel');
    const overlay = document.getElementById('settingsOverlay');
    if (!panel.classList.contains('hidden')) {
        panel.classList.add('hidden');
        overlay.classList.add('hidden');
    } else {
        loadConfigIntoForm();
        panel.classList.remove('hidden');
        overlay.classList.remove('hidden');
    }
}

function closeModelSettings() {
    document.getElementById('settingsPanel').classList.add('hidden');
    document.getElementById('settingsOverlay').classList.add('hidden');
}

async function loadModelConfig() {
    try {
        const resp = await fetch('api/config');
        if (!resp.ok) return;
        const cfg = await resp.json();
        updateModelBadge(cfg.model || '--');
        localStorage.setItem('ai_read_config', JSON.stringify(cfg));
    } catch (e) {
        setTimeout(loadModelConfig, 2000);
    }
}

function loadConfigIntoForm() {
    const cached = localStorage.getItem('ai_read_config');
    let cfg = {};
    if (cached) { try { cfg = JSON.parse(cached); } catch (e) {} }
    document.getElementById('cfgBaseUrl').value = cfg.base_url || '';
    // 打码的 key（含 ***）不回填，避免覆盖真实密钥
    const ak = cfg.api_key || '';
    document.getElementById('cfgApiKey').value = ak.includes('***') ? '' : ak;
    document.getElementById('cfgModel').value = cfg.model || '';
    document.getElementById('cfgFastBaseUrl').value = cfg.fast_base_url || '';
    const fak = cfg.fast_api_key || '';
    document.getElementById('cfgFastApiKey').value = fak.includes('***') ? '' : fak;
    document.getElementById('cfgFastModel').value = cfg.fast_model || '';
}

async function saveModelConfig() {
    const base_url = document.getElementById('cfgBaseUrl').value.trim();
    const api_key = document.getElementById('cfgApiKey').value.trim();
    const model = document.getElementById('cfgModel').value.trim();
    const fast_base_url = document.getElementById('cfgFastBaseUrl').value.trim();
    const fast_api_key = document.getElementById('cfgFastApiKey').value.trim();
    const fast_model = document.getElementById('cfgFastModel').value.trim();
    const statusEl = document.getElementById('settingsStatus');

    try {
        // 跳过打码 key（含 ***），保留服务器已有值
        const body = { base_url, model, fast_base_url, fast_model };
        if (!api_key.includes('***')) body.api_key = api_key;
        if (!fast_api_key.includes('***')) body.fast_api_key = fast_api_key;
        const resp = await fetch('api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!resp.ok) throw new Error(await resp.text());
        const cfg = await resp.json();
        localStorage.setItem('ai_read_config', JSON.stringify(cfg));
        updateModelBadge(cfg.model || '--');
        statusEl.textContent = '✓ 配置已保存';
        statusEl.style.color = '#16a34a';
        setTimeout(() => { statusEl.textContent = ''; }, 2000);
    } catch (e) {
        statusEl.textContent = '✗ 保存失败：' + e.message;
        statusEl.style.color = '#dc2626';
    }
}

async function detectModels(type) {
    const prefix = type === 'fast' ? 'cfgFast' : 'cfg';
    const baseUrl = document.getElementById(prefix + 'BaseUrl').value.trim();
    const apiKey = document.getElementById(prefix + 'ApiKey').value.trim();
    const btn = document.getElementById(type === 'fast' ? 'btnDetectFast' : 'btnDetectMain');
    const dropdown = document.getElementById(type === 'fast' ? 'modelsDropdownFast' : 'modelsDropdownMain');

    if (!baseUrl) { showDetectError(dropdown, '请先填写 API Base URL'); return; }
    if (!apiKey) { showDetectError(dropdown, '请先填写 API Key'); return; }

    btn.disabled = true;
    btn.textContent = '⏳ 检测中...';
    dropdown.classList.add('hidden');

    try {
        const resp = await fetch('api/models', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ base_url: baseUrl, api_key: apiKey }),
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.detail || '请求失败');
        
        // Show warning if API doesn't support /models
        if (data.warning) {
            showDetectError(dropdown, data.warning);
            return;
        }
        
        if (data.models.length === 0) {
            showDetectError(dropdown, '未找到可用模型，请确认 Base URL 正确');
            return;
        }
        
        dropdown.innerHTML = data.models.map(function(m) {
            return '<div class="model-item" onclick="selectModel(\'' + type + '\', \'' + m.id.replace(/'/g, "\\'") + '\')">' +
                '<span class="model-id">' + m.id + '</span>' +
                '<span class="model-owner">' + (m.owned_by || '') + '</span>' +
                '</div>';
        }).join('');
        dropdown.classList.remove('hidden');
    } catch (e) {
        showDetectError(dropdown, e.message);
    } finally {
        btn.disabled = false;
        btn.textContent = '🔍 检测';
    }
}

function showDetectError(dropdown, msg) {
    dropdown.innerHTML = '<div class="models-error">⚠ ' + msg + '</div>';
    dropdown.classList.remove('hidden');
    setTimeout(function() { dropdown.classList.add('hidden'); }, 5000);
}

function selectModel(type, modelId) {
    const inputId = type === 'fast' ? 'cfgFastModel' : 'cfgModel';
    const dropdownId = type === 'fast' ? 'modelsDropdownFast' : 'modelsDropdownMain';
    document.getElementById(inputId).value = modelId;
    document.getElementById(dropdownId).classList.add('hidden');
}

document.addEventListener('click', function(e) {
    if (!e.target.closest('.input-with-btn')) {
        document.querySelectorAll('.models-dropdown').forEach(function(d) { d.classList.add('hidden'); });
    }
});

function updateModelBadge(modelName) {
    if (dom.modelBadge) {
        dom.modelBadge.textContent = '⚙ Model: ' + modelName;
    }
}

// ─── Upload ───
function setupUpload() {
    const zone = dom.uploadZone;
    zone.addEventListener('click', (e) => {
        if (e.target === dom.fileInput) return;
        dom.fileInput.click();
    });
    dom.fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) uploadFile(e.target.files[0]);
    });
    zone.addEventListener('dragover', (e) => {
        e.preventDefault();
        zone.classList.add('drag-over');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', (e) => {
        e.preventDefault();
        zone.classList.remove('drag-over');
        const file = e.dataTransfer.files[0];
        if (file) uploadFile(file);
    });
    document.addEventListener('paste', (e) => {
        if (state.fileId) return;
        const items = e.clipboardData?.items;
        if (!items) return;
        for (const item of items) {
            if (item.type === 'application/pdf' || (item.kind === 'file' && item.type === '')) {
                const file = item.getAsFile();
                if (file) { e.preventDefault(); uploadFile(file); return; }
            }
        }
    });
}

async function uploadFile(file) {
    if (!file.name.toLowerCase().endsWith('.pdf')) { alert('请上传 PDF 文件！'); return; }
    // 换新论文前，中止上一篇论文所有还在跑的后台任务
    Object.values(state.tasks).forEach(t => { if (t.controller) t.controller.abort(); });
    dom.statusText.textContent = '正在上传并解析...';
    dom.btnRun.disabled = true;
    const formData = new FormData();
    formData.append('file', file);
    try {
        const resp = await fetch('api/upload', { method: 'POST', body: formData });
        if (!resp.ok) throw new Error(await resp.text());
        const data = await resp.json();
        state.fileId = data.file_id;
        state.paperMeta = data.meta;
        state.tasks = {};   // 新论文，清空所有旧任务/结果
        dom.uploadZone.classList.add('hidden');
        dom.pdfPreview.classList.remove('hidden');
        dom.pdfFrame.src = 'api/paper/' + state.fileId + '/pdf';
        dom.pdfTitle.textContent = state.paperMeta.title || file.name;
        dom.emptyState.classList.add('hidden');
        dom.workspace.classList.remove('hidden');
        dom.btnRun.disabled = false;
        dom.statusText.textContent = '已加载：' + data.meta.page_count + ' 页，' + (data.text_length / 1000).toFixed(1) + 'K 字符';
        renderTabView();
    } catch (err) {
        alert('上传失败：' + err.message);
        dom.btnRun.disabled = false;
        dom.statusText.textContent = '';
    }
}

// ─── Tabs ───
function setupTabs() {
    dom.tabs.addEventListener('click', (e) => {
        const tab = e.target.closest('.tab');
        if (!tab) return;
        $$('.tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        state.currentTab = tab.dataset.tab;
        renderTabView();
    });
}

const TAB_LABELS = {
    'quick-scan': '▶ 开始速览', 'summary': '▶ 生成总结',
    'mindmap': '▶ 生成思维导图', 'experiments': '▶ 汇总实验', 'translate': '▶ 全文翻译',
};

// 根据当前 tab 自己的任务状态（运行中 / 已完成 / 空）刷新按钮和结果区
function renderTabView() {
    const task = getTask(state.currentTab);

    if (task.running) {
        dom.btnRun.style.display = 'none';
        dom.btnStop.style.display = 'inline-flex';
        dom.statusText.innerHTML = '<span class="spinner"></span> AI 分析中...';
    } else {
        dom.btnRun.style.display = 'inline-flex';
        dom.btnStop.style.display = 'none';
        dom.btnRun.textContent = TAB_LABELS[state.currentTab] || '▶ 开始分析';
        dom.statusText.textContent = task.done ? '✓ 分析完成' : (task.error ? ('⚠ ' + task.error) : '');
    }

    if (task.text) {
        dom.resultPlaceholder.classList.add('hidden');
        if (state.currentTab === 'mindmap') {
            dom.resultContent.classList.add('hidden');
            dom.mindmapContainer.classList.remove('hidden');
            renderMindmap(task.text);
        } else {
            dom.mindmapContainer.classList.add('hidden');
            dom.resultContent.classList.remove('hidden');
            dom.resultContent.innerHTML = marked.parse(task.text) + (task.running ? '<span class="stream-cursor"></span>' : '');
            dom.resultContent.querySelectorAll('pre code').forEach(block => {
                if (window.hljs) window.hljs.highlightElement(block);
            });
        }
    } else if (task.error && !task.running) {
        dom.resultPlaceholder.classList.add('hidden');
        dom.mindmapContainer.classList.add('hidden');
        dom.resultContent.classList.remove('hidden');
        let retryBtn = task.canRetry ? ' <button class="btn-primary" style="margin-left:8px;padding:4px 10px;font-size:13px" onclick="retryAnalysis()">重试</button>' : '';
        dom.resultContent.innerHTML = '<p style="color:var(--red)">错误：' + escapeHtml(task.error) + retryBtn + '</p>';
    } else if (task.running) {
        dom.resultPlaceholder.classList.remove('hidden');
        dom.resultContent.classList.add('hidden');
        dom.mindmapContainer.classList.add('hidden');
        dom.resultPlaceholder.innerHTML = '<p><span class="spinner"></span> AI 分析中...</p>';
    } else {
        resetResult();
    }
    updateTabIndicators();
}

function updateTabIndicators() {
    $$('.tab').forEach(tab => {
        const task = state.tasks[tab.dataset.tab];
        if (task && task.running) {
            tab.classList.add('running');
        } else {
            tab.classList.remove('running');
        }
    });
}

function switchTab(tabName) {
    if (tabName === 'upload') {
        state.fileId = null;
        dom.uploadZone.classList.remove('hidden');
        dom.pdfPreview.classList.add('hidden');
        dom.emptyState.classList.remove('hidden');
        dom.workspace.classList.add('hidden');
        dom.pdfFrame.src = '';
        return;
    }
    const tab = document.querySelector('.tab[data-tab="' + tabName + '"]');
    if (tab) tab.click();
}

// ─── Analysis（每个 tab 独立跑，互不阻塞） ───
const ENDPOINTS = {
    'quick-scan': 'quick-scan', 'summary': 'summary', 'mindmap': 'mindmap',
    'experiments': 'experiments', 'translate': 'translate-full',
};

async function runAnalysis() {
    if (!state.fileId) { alert('请先上传论文 PDF'); return; }
    const tabName = state.currentTab;   // 锁定发起时的 tab，之后切走也不影响这个任务
    const task = getTask(tabName);
    if (task.running) return;
    const endpoint = ENDPOINTS[tabName];
    if (!endpoint) return;

    task.running = true;
    task.text = '';
    task.done = false;
    task.error = null;
    task.controller = new AbortController();
    updateTabIndicators();
    if (state.currentTab === tabName) renderTabView();

    let contentReceived = false;
    let sseParseErrorCount = 0;

    try {
        const resp = await fetch(
            'api/paper/' + state.fileId + '/' + endpoint + '?stream=true',
            { method: 'POST', signal: task.controller.signal }
        );
        if (!resp.ok) throw new Error(await resp.text());
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split('\n');
            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const dataStr = line.slice(6).trim();
                if (dataStr === '[DONE]') continue;
                if (!dataStr) continue;
                try {
                    const data = JSON.parse(dataStr);
                    if (data.content) {
                        contentReceived = true;
                        task.text += data.content;
                        if (state.currentTab === tabName) updateResult(task.text);
                    }
                    if (data.error) {
                        task.error = data.error;
                        contentReceived = true; // error is also a response
                    }
                } catch (e) {
                    sseParseErrorCount++;
                    if (sseParseErrorCount <= 3) {
                        console.warn('SSE parse error:', dataStr, e);
                    }
                }
            }
        }
        task.done = true;
        if (!contentReceived && !task.error) {
            task.error = 'AI 未返回任何内容（免费模型常因限速或容量不足返回空响应，重试通常可解决）';
            task.canRetry = true;
        }
    } catch (err) {
        task.error = err.name === 'AbortError' ? '已停止' : err.message;
    } finally {
        task.running = false;
        task.controller = null;
        updateTabIndicators();
        if (state.currentTab === tabName) renderTabView();
    }
}

function stopAnalysis() {
    const task = getTask(state.currentTab);
    if (task.controller) task.controller.abort();
}

function retryAnalysis() {
    const task = getTask(state.currentTab);
    if (task.running) return;
    task.error = null;
    task.done = false;
    task.canRetry = false;
    task.text = '';
    renderTabView();
    runAnalysis();
}

// 流式过程中只更新当前可见 tab 的 DOM；后台其他 tab 的内容只写进 task.text，不动 DOM
function updateResult(text) {
    dom.resultPlaceholder.classList.add('hidden');
    if (state.currentTab === 'mindmap') {
        dom.resultContent.classList.add('hidden');
        dom.mindmapContainer.classList.remove('hidden');
        renderMindmap(text);
    } else {
        dom.mindmapContainer.classList.add('hidden');
        dom.resultContent.classList.remove('hidden');
        const html = marked.parse(text);
        dom.resultContent.innerHTML = html + '<span class="stream-cursor"></span>';
        dom.resultContent.scrollTop = dom.resultContent.scrollHeight;
        dom.resultContent.querySelectorAll('pre code').forEach(block => {
            if (window.hljs) window.hljs.highlightElement(block);
        });
    }
}

function resetResult() {
    dom.resultPlaceholder.classList.remove('hidden');
    dom.resultContent.classList.add('hidden');
    dom.mindmapContainer.classList.add('hidden');
    dom.resultContent.innerHTML = '';
    dom.mindmapSvg.innerHTML = '';
    dom.resultPlaceholder.innerHTML = '<p>👆 点击上方功能标签，然后点击「开始分析」</p>';
}

// ─── Mindmap ───
function renderMindmap(markdownText) {
    markdownText = markdownText.replace(/▌/g, '').trim();
    if (!markdownText) {
        resetResult();
        return;
    }

    // 先尝试用 markmap 生成真正的思维导图/流程图
    dom.mindmapContainer.classList.remove('hidden');
    dom.mindmapSvg.innerHTML = '';
    let mindmapOk = false;

    try {
        const mm = window.markmap;
        if (mm && mm.Markmap && mm.transformer) {
            const tf = new mm.transformer.Transformer();
            const { root } = tf.transform(markdownText);
            mm.Markmap.create(dom.mindmapSvg, {
                autoFit: true,
                fitRatio: 0.8,
                duration: 0,
                color: (_, i) => ['#4f6ef7', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6'][i % 5],
            }, root);
            mindmapOk = true;
            dom.resultContent.classList.add('hidden');
        }
    } catch (e) {
        console.warn('Mindmap render failed:', e);
    }

    // 如果 markmap 失败或不可用，退而求其次：把 markdown 渲染成 HTML
    if (!mindmapOk) {
        dom.mindmapContainer.classList.add('hidden');
        dom.resultContent.classList.remove('hidden');
        dom.resultContent.innerHTML = '<h3>📋 思维导图大纲</h3>' + marked.parse(markdownText);
        dom.resultContent.querySelectorAll('pre code').forEach(block => {
            if (window.hljs) window.hljs.highlightElement(block);
        });
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ─── Text Selection Translation ───
function setupTextSelection() {
    document.addEventListener('mouseup', async (e) => {
        if (!dom.resultContent.contains(e.target) && !dom.mindmapContainer.contains(e.target)) return;
        const selection = window.getSelection();
        const text = selection.toString().trim();
        if (!text || text.length < 5 || text.length > 500) return;
        if (!state.fileId) return;
        const chineseCount = (text.match(/[\u4e00-\u9fff]/g) || []).length;
        if (chineseCount / text.length > 0.5) return;
        const rect = selection.getRangeAt(0).getBoundingClientRect();
        dom.translatePopup.classList.remove('hidden');
        dom.translatePopupBody.innerHTML = '<p class="translate-loading"><span class="spinner"></span> 翻译中...</p>';
        const popup = dom.translatePopup.querySelector('.translate-popup-content');
        popup.style.position = 'fixed';
        popup.style.top = Math.min(rect.bottom + 10, window.innerHeight - 300) + 'px';
        popup.style.left = Math.max(10, Math.min(rect.left, window.innerWidth - 500)) + 'px';
        popup.style.maxWidth = '480px';
        try {
            const resp = await fetch('api/paper/' + state.fileId + '/translate-snippet?text=' + encodeURIComponent(text), { method: 'POST' });
            if (!resp.ok) throw new Error(await resp.text());
            const data = await resp.json();
            dom.translatePopupBody.innerHTML = '<div class="translate-source">' + escapeHtml(text) + '</div><div class="translate-target">' + escapeHtml(data.result) + '</div>';
        } catch (err) {
            dom.translatePopupBody.innerHTML = '<p style="color:var(--red)">翻译失败：' + err.message + '</p>';
        }
    });
}

function closeTranslatePopup() { dom.translatePopup.classList.add('hidden'); }
document.addEventListener('mousedown', (e) => {
    if (dom.translatePopup.classList.contains('hidden')) return;
    if (!dom.translatePopup.querySelector('.translate-popup-content').contains(e.target)) closeTranslatePopup();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeTranslatePopup(); });
