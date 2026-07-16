/**
 * AI Paper Reader — Frontend Application
 * 论文 AI 阅读助手前端逻辑
 *
 * 主要功能：
 * - 上传 PDF + AI 分析（速览/总结/思维导图/实验/全文翻译）
 * - 独立划词翻译工作台（不依赖 PDF）
 * - Web UI 动态配置 API 模型（主力/辅助各自独立）
 * - ADMIN_TOKEN 鉴权支持
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
    actionBar: $('#actionBar'),
    tabs: $('#tabs'),
    btnRun: $('#btnRun'),
    btnStop: $('#btnStop'),
    statusText: $('#statusText'),
    resultArea: $('#resultArea'),
    resultPlaceholder: $('#resultPlaceholder'),
    resultContent: $('#resultContent'),
    mindmapContainer: $('#mindmapContainer'),
    mindmapSvg: $('#mindmapSvg'),
    translatePopup: $('#translatePopup'),
    translatePopupBody: $('#translatePopupBody'),
    modelBadge: $('#modelBadge'),
    recentPapersList: $('#recentPapersList'),
    // 划词翻译工作台
    snippetWorkspace: $('#snippetTranslateWorkspace'),
    snippetInput: $('#snippetInput'),
    snippetCharCount: $('#snippetCharCount'),
    snippetHistoryList: $('#snippetHistoryList'),
    btnSnippetTranslate: $('#btnSnippetTranslate'),
};

const SNIPPET_HISTORY_KEY = 'ai_read_snippet_history';
const AUTH_TOKEN_KEY = 'ai_read_token';
const MAX_SNIPPET_HISTORY = 50;

// ─── 鉴权 Token 管理 ───

function getAuthToken() {
    return localStorage.getItem(AUTH_TOKEN_KEY) || '';
}

function setAuthToken(token) {
    localStorage.setItem(AUTH_TOKEN_KEY, token);
}

function clearAuthToken() {
    localStorage.removeItem(AUTH_TOKEN_KEY);
}

function authHeaders(extra) {
    const h = Object.assign({}, extra || {});
    const t = getAuthToken();
    if (t) h['Authorization'] = 'Bearer ' + t;
    return h;
}

/** 统一的 fetch 包装：自动注入 Authorization 头 */
function apiFetch(url, options) {
    options = options || {};
    options.headers = authHeaders(options.headers);
    return fetch(url, options);
}

/** 给 iframe / EventSource 等无法设置请求头的场景用：在 URL 上拼 ?token= */
function withTokenQuery(url) {
    const t = getAuthToken();
    if (!t) return url;
    const sep = url.indexOf('?') >= 0 ? '&' : '?';
    return url + sep + 'token=' + encodeURIComponent(t);
}

function showAuthModal() {
    document.getElementById('authOverlay').classList.remove('hidden');
    document.getElementById('authPanel').classList.remove('hidden');
    setTimeout(() => {
        const input = document.getElementById('authTokenInput');
        if (input) input.focus();
    }, 50);
}

function hideAuthModal() {
    document.getElementById('authOverlay').classList.add('hidden');
    document.getElementById('authPanel').classList.add('hidden');
}

async function submitAuthToken() {
    const input = document.getElementById('authTokenInput');
    const statusEl = document.getElementById('authStatus');
    const token = (input.value || '').trim();
    if (!token) {
        statusEl.textContent = '请输入令牌';
        return;
    }
    // 先暂存，再用一个鉴权接口验证
    setAuthToken(token);
    try {
        const resp = await apiFetch('api/papers');
        if (resp.status === 401) {
            clearAuthToken();
            statusEl.textContent = '令牌无效，请重试';
            return;
        }
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        hideAuthModal();
        // 验证通过后刷新数据
        loadModelConfig();
        loadRecentPapers();
        renderTabView();
    } catch (e) {
        clearAuthToken();
        statusEl.textContent = '验证失败：' + e.message;
    }
}

// 按 Enter 提交令牌
document.addEventListener('DOMContentLoaded', () => {
    const inp = document.getElementById('authTokenInput');
    if (inp) {
        inp.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); submitAuthToken(); }
        });
    }
});

// ─── Initialization ───
document.addEventListener('DOMContentLoaded', () => {
    setupUpload();
    setupTabs();
    setupTextSelection();
    setupSnippetInput();
    loadModelConfig();
    loadRecentPapers();
    renderSnippetHistory();
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
    const cached = localStorage.getItem('ai_read_config');
    let cfg = {};
    if (cached) { try { cfg = JSON.parse(cached); } catch (e) {} }

    // 先从服务器拉一次配置，顺便判断是否启用鉴权
    let serverCfg = null;
    try {
        const resp = await fetch('api/config');  // 公开接口，不需要 token
        if (resp.ok) serverCfg = await resp.json();
    } catch (e) {
        setTimeout(loadModelConfig, 2000);
        return;
    }
    if (!serverCfg) return;

    updateModelBadge(serverCfg.model || '--');

    // 鉴权检查：若服务端启用了 ADMIN_TOKEN，且本地没有 token，弹窗要求输入
    if (serverCfg.auth_required && !getAuthToken()) {
        showAuthModal();
        return;  // 等待用户输入令牌后再继续
    }

    // 如果本地缓存了真实密钥（未打码），先把它们同步到服务器运行态。
    // 注意：只同步非空的、真实的 key，避免把空字符串覆盖到服务器。
    const hasRealMainKey = cfg.api_key && !cfg.api_key.includes('***') && cfg.api_key.length > 0;
    const hasRealFastKey = cfg.fast_api_key && !cfg.fast_api_key.includes('***') && cfg.fast_api_key.length > 0;
    if (hasRealMainKey || hasRealFastKey) {
        try {
            const body = { base_url: cfg.base_url || '', model: cfg.model || '', fast_base_url: cfg.fast_base_url || '', fast_model: cfg.fast_model || '' };
            if (hasRealMainKey) body.api_key = cfg.api_key;
            if (hasRealFastKey) body.fast_api_key = cfg.fast_api_key;
            const resp = await apiFetch('api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (resp.ok) {
                const sc = await resp.json();
                updateModelBadge(sc.model || '--');
                return;
            } else if (resp.status === 401) {
                clearAuthToken();
                showAuthModal();
                return;
            }
        } catch (e) {}
    }

    // 本地没有真实密钥时，把服务端配置写入本地缓存
    if (!cached) {
        localStorage.setItem('ai_read_config', JSON.stringify(serverCfg));
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
        // 关键：只在用户实际输入了新 key 时才提交 api_key 字段。
        // 输入框为空（打码 key 没回填）或仍是打码占位符时，跳过该字段，保留服务器已有值。
        // 否则会把真实 key 覆盖成空字符串，导致所有 AI 调用 401。
        const body = { base_url, model, fast_base_url, fast_model };
        if (api_key && !api_key.includes('***')) body.api_key = api_key;
        if (fast_api_key && !fast_api_key.includes('***')) body.fast_api_key = fast_api_key;
        const resp = await apiFetch('api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (resp.status === 401) {
            clearAuthToken();
            closeModelSettings();
            showAuthModal();
            return;
        }
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
        const resp = await apiFetch('api/models', {
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
                '<span class="model-id">' + escapeHtml(m.id) + '</span>' +
                '<span class="model-owner">' + escapeHtml(m.owned_by || '') + '</span>' +
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
    dropdown.innerHTML = '<div class="models-error">⚠ ' + escapeHtml(msg) + '</div>';
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
        const resp = await apiFetch('api/upload', { method: 'POST', body: formData });
        if (resp.status === 401) { clearAuthToken(); showAuthModal(); return; }
        if (!resp.ok) throw new Error(await resp.text());
        const data = await resp.json();
        state.fileId = data.file_id;
        state.paperMeta = data.meta;
        state.tasks = {};   // 新论文，清空所有旧任务/结果
        dom.uploadZone.classList.add('hidden');
        dom.pdfPreview.classList.remove('hidden');
        // PDF 在 iframe 里，无法设置请求头，通过 ?token= 传
        dom.pdfFrame.src = withTokenQuery('api/paper/' + state.fileId + '/pdf');
        dom.pdfTitle.textContent = state.paperMeta.title || file.name;
        dom.emptyState.classList.add('hidden');
        dom.workspace.classList.remove('hidden');
        dom.btnRun.disabled = false;
        dom.statusText.textContent = '已加载：' + data.meta.page_count + ' 页，' + (data.text_length / 1000).toFixed(1) + 'K 字符';
        renderTabView();
        loadRecentPapers();
    } catch (err) {
        alert('上传失败：' + err.message);
        dom.btnRun.disabled = false;
        dom.statusText.textContent = '';
    }
}

// ─── Recent Papers ───
async function loadRecentPapers() {
    if (!dom.recentPapersList) return;
    try {
        const resp = await apiFetch('api/papers');
        if (resp.status === 401) { clearAuthToken(); showAuthModal(); return; }
        if (!resp.ok) throw new Error(await resp.text());
        const data = await resp.json();
        renderRecentPapers(data.papers || []);
    } catch (e) {
        dom.recentPapersList.innerHTML = '<p class="recent-empty">加载历史文献失败</p>';
    }
}

function renderRecentPapers(papers) {
    if (!dom.recentPapersList) return;
    if (papers.length === 0) {
        dom.recentPapersList.innerHTML = '<p class="recent-empty">暂无历史文献</p>';
        return;
    }
    const currentId = state.fileId;
    dom.recentPapersList.innerHTML = papers.map(p => {
        const title = p.title || '未命名论文';
        const activeClass = p.file_id === currentId ? 'active' : '';
        return '<div class="recent-item ' + activeClass + '" onclick="loadPaperFromHistory(\'' + p.file_id + '\')">' +
            '<div class="recent-item-title" title="' + escapeHtml(title) + '">' + escapeHtml(title) + '</div>' +
            '<div class="recent-item-meta">' +
                '<span>' + (p.page_count || 0) + ' 页</span>' +
                '<span>·</span>' +
                '<span>' + ((p.text_length || 0) / 1000).toFixed(1) + 'K 字符</span>' +
            '</div>' +
            '</div>';
    }).join('');
}

async function loadPaperFromHistory(fileId) {
    if (!fileId) return;
    // 中止上一篇论文所有后台任务
    Object.values(state.tasks).forEach(t => { if (t.controller) t.controller.abort(); });
    state.fileId = fileId;
    state.paperMeta = null;
    state.tasks = {};

    try {
        // 拉取论文元数据
        const metaResp = await apiFetch('api/paper/' + fileId + '/meta');
        if (metaResp.status === 401) { clearAuthToken(); showAuthModal(); return; }
        if (!metaResp.ok) throw new Error(await metaResp.text());
        state.paperMeta = await metaResp.json();

        // 拉取已保存的 AI 结果
        const resultsResp = await apiFetch('api/paper/' + fileId + '/results');
        if (resultsResp.ok) {
            const data = await resultsResp.json();
            for (const [tab, text] of Object.entries(data.results || {})) {
                state.tasks[tab] = { running: false, controller: null, text: text, done: true, error: null, canRetry: false };
            }
        }

        // 切换到 PDF 预览工作区
        dom.uploadZone.classList.add('hidden');
        dom.pdfPreview.classList.remove('hidden');
        dom.pdfFrame.src = withTokenQuery('api/paper/' + fileId + '/pdf');
        dom.pdfTitle.textContent = state.paperMeta.title || '历史文献';
        dom.emptyState.classList.add('hidden');
        dom.workspace.classList.remove('hidden');
        dom.statusText.textContent = '已加载：' + (state.paperMeta.page_count || 0) + ' 页';

        // 高亮当前文献
        loadRecentPapers();

        renderTabView();
    } catch (err) {
        alert('加载历史文献失败：' + err.message);
    }
}

// ─── 直接进入划词翻译工作台（不需要上传 PDF） ───
function openSnippetTranslateOnly() {
    state.fileId = null;
    state.paperMeta = null;
    Object.values(state.tasks).forEach(t => { if (t.controller) t.controller.abort(); });
    state.tasks = {};
    dom.uploadZone.classList.add('hidden');
    dom.pdfPreview.classList.add('hidden');
    dom.pdfFrame.src = '';
    dom.emptyState.classList.add('hidden');
    dom.workspace.classList.remove('hidden');
    // 切到 snippet-translate tab
    $$('.tab').forEach(t => t.classList.remove('active'));
    const target = document.querySelector('.tab[data-tab="snippet-translate"]');
    if (target) target.classList.add('active');
    state.currentTab = 'snippet-translate';
    renderTabView();
    setTimeout(() => { if (dom.snippetInput) dom.snippetInput.focus(); }, 50);
}

// ─── Tabs ───
function setupTabs() {
    dom.tabs.addEventListener('click', (e) => {
        const tab = e.target.closest('.tab');
        if (!tab) return;
        // 切到非 snippet-translate 的 tab 但没有上传论文时，提示用户
        if (tab.dataset.tab !== 'snippet-translate' && !state.fileId) {
            alert('请先上传论文 PDF，或点击「直接进入划词翻译」');
            return;
        }
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
    // 划词翻译工作台独立显示，不走 result-area
    if (state.currentTab === 'snippet-translate') {
        dom.actionBar.classList.add('hidden');
        dom.resultArea.classList.add('hidden');
        dom.snippetWorkspace.classList.remove('hidden');
        updateTabIndicators();
        return;
    }
    dom.actionBar.classList.remove('hidden');
    dom.resultArea.classList.remove('hidden');
    dom.snippetWorkspace.classList.add('hidden');

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
    if (tabName === 'snippet-translate') return;  // 划词翻译有自己的按钮
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
        const resp = await apiFetch(
            'api/paper/' + state.fileId + '/' + endpoint + '?stream=true',
            { method: 'POST', signal: task.controller.signal }
        );
        if (resp.status === 401) {
            clearAuthToken();
            showAuthModal();
            task.running = false;
            task.controller = null;
            updateTabIndicators();
            return;
        }
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
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
}

// ─── 划词翻译工作台（独立 tab，不依赖 PDF） ───

function setupSnippetInput() {
    if (!dom.snippetInput) return;
    dom.snippetInput.addEventListener('input', updateSnippetCharCount);
    // Ctrl+Enter 翻译
    dom.snippetInput.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            translateSnippetText();
        }
    });
}

function updateSnippetCharCount() {
    const n = (dom.snippetInput.value || '').length;
    dom.snippetCharCount.textContent = n + ' 字符';
}

function clearSnippetInput() {
    if (dom.snippetInput) {
        dom.snippetInput.value = '';
        updateSnippetCharCount();
        dom.snippetInput.focus();
    }
}

async function translateSnippetText() {
    const text = (dom.snippetInput.value || '').trim();
    if (!text) { dom.snippetInput.focus(); return; }
    if (text.length > 10000) { alert('文本过长，最多 10000 字符'); return; }

    const btn = dom.btnSnippetTranslate;
    btn.disabled = true;
    btn.textContent = '⏳ 翻译中...';

    // 在历史顶部插一条"翻译中"的占位
    const tempId = 'temp-' + Date.now();
    const history = getSnippetHistory();
    history.unshift({ id: tempId, original: text, translated: '', ts: Date.now(), loading: true });
    saveSnippetHistory(history);
    renderSnippetHistory();

    try {
        const resp = await apiFetch('api/translate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: text }),
        });
        if (resp.status === 401) {
            clearAuthToken();
            showAuthModal();
            // 移除占位
            const h = getSnippetHistory().filter(it => it.id !== tempId);
            saveSnippetHistory(h);
            renderSnippetHistory();
            return;
        }
        if (!resp.ok) {
            // 提取后端返回的具体错误信息（FastAPI 400 会返回 {"detail": "..."}）
            let errMsg = 'HTTP ' + resp.status;
            try {
                const errBody = await resp.json();
                errMsg = errBody.detail || errBody.message || JSON.stringify(errBody);
            } catch (e2) {
                try { errMsg = await resp.text(); } catch (e3) {}
            }
            throw new Error(errMsg);
        }
        const data = await resp.json();
        // 把占位替换为最终结果
        const h = getSnippetHistory();
        const idx = h.findIndex(it => it.id === tempId);
        if (idx >= 0) {
            h[idx] = { id: tempId, original: data.original || text, translated: data.result || '', ts: Date.now() };
        } else {
            h.unshift({ id: tempId, original: data.original || text, translated: data.result || '', ts: Date.now() });
        }
        // 限制条数
        while (h.length > MAX_SNIPPET_HISTORY) h.pop();
        saveSnippetHistory(h);
        renderSnippetHistory();
        // 清空输入框，方便用户继续翻译下一段
        dom.snippetInput.value = '';
        updateSnippetCharCount();
    } catch (e) {
        // 把占位改成错误状态（移除占位，弹个提示）
        const h = getSnippetHistory().filter(it => it.id !== tempId);
        saveSnippetHistory(h);
        renderSnippetHistory();
        alert('翻译失败：' + e.message);
    } finally {
        btn.disabled = false;
        btn.textContent = '🌐 翻译';
    }
}

function getSnippetHistory() {
    try {
        const raw = localStorage.getItem(SNIPPET_HISTORY_KEY);
        if (!raw) return [];
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr : [];
    } catch (e) {
        return [];
    }
}

function saveSnippetHistory(history) {
    try {
        localStorage.setItem(SNIPPET_HISTORY_KEY, JSON.stringify(history));
    } catch (e) {
        // 容量超限时，砍掉一半再试
        try {
            localStorage.setItem(SNIPPET_HISTORY_KEY, JSON.stringify(history.slice(0, Math.floor(history.length / 2))));
        } catch (e2) {}
    }
}

function renderSnippetHistory() {
    if (!dom.snippetHistoryList) return;
    const history = getSnippetHistory();
    if (history.length === 0) {
        dom.snippetHistoryList.innerHTML = '<p class="recent-empty">暂无翻译历史</p>';
        return;
    }
    dom.snippetHistoryList.innerHTML = history.map((it, idx) => {
        const ts = formatTs(it.ts);
        if (it.loading) {
            return '<div class="snippet-item" data-idx="' + idx + '">' +
                '<div class="snippet-block">' +
                    '<div class="snippet-block-header"><span class="snippet-block-label source">📄 原文</span></div>' +
                    '<div class="snippet-block-text source">' + escapeHtml(it.original) + '</div>' +
                '</div>' +
                '<div class="snippet-block">' +
                    '<div class="snippet-block-header"><span class="snippet-block-label target">🌏 译文</span></div>' +
                    '<div class="snippet-loading"><span class="spinner"></span> 翻译中...</div>' +
                '</div>' +
                '<div class="snippet-item-footer"><span>' + ts + '</span></div>' +
                '</div>';
        }
        return '<div class="snippet-item" data-idx="' + idx + '">' +
            '<div class="snippet-block">' +
                '<div class="snippet-block-header">' +
                    '<span class="snippet-block-label source">📄 原文</span>' +
                    '<button class="snippet-copy-btn" onclick="copySnippetText(this, ' + idx + ', \'original\')">📋 复制</button>' +
                '</div>' +
                '<div class="snippet-block-text source">' + escapeHtml(it.original) + '</div>' +
            '</div>' +
            '<div class="snippet-block">' +
                '<div class="snippet-block-header">' +
                    '<span class="snippet-block-label target">🌏 译文</span>' +
                    '<button class="snippet-copy-btn" onclick="copySnippetText(this, ' + idx + ', \'translated\')">📋 复制</button>' +
                '</div>' +
                '<div class="snippet-block-text">' + escapeHtml(it.translated) + '</div>' +
            '</div>' +
            '<div class="snippet-item-footer">' +
                '<span>' + ts + '</span>' +
                '<button class="snippet-delete-btn" onclick="deleteSnippetItem(' + idx + ')">🗑 删除</button>' +
            '</div>' +
        '</div>';
    }).join('');
}

function formatTs(ts) {
    if (!ts) return '';
    try {
        const d = new Date(ts);
        const pad = (n) => String(n).padStart(2, '0');
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
               pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    } catch (e) { return ''; }
}

async function copySnippetText(btn, idx, field) {
    const history = getSnippetHistory();
    const item = history[idx];
    if (!item) return;
    const text = item[field] || '';
    if (!text) return;
    try {
        await navigator.clipboard.writeText(text);
    } catch (e) {
        // fallback：用临时 textarea
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch (e2) {}
        document.body.removeChild(ta);
    }
    btn.classList.add('copied');
    btn.textContent = '✓ 已复制';
    setTimeout(() => {
        btn.classList.remove('copied');
        btn.textContent = '📋 复制';
    }, 1500);
}

function deleteSnippetItem(idx) {
    const history = getSnippetHistory();
    if (idx < 0 || idx >= history.length) return;
    history.splice(idx, 1);
    saveSnippetHistory(history);
    renderSnippetHistory();
}

function clearSnippetHistory() {
    if (!confirm('确定清空所有翻译历史？此操作不可撤销。')) return;
    saveSnippetHistory([]);
    renderSnippetHistory();
}

// ─── 右侧结果区选词翻译弹窗（保留原有快捷翻译，但改用 POST body） ───
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
            const resp = await apiFetch('api/paper/' + state.fileId + '/translate-snippet', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: text }),
            });
            if (!resp.ok) throw new Error(await resp.text());
            const data = await resp.json();
            dom.translatePopupBody.innerHTML = '<div class="translate-source">' + escapeHtml(text) + '</div><div class="translate-target">' + escapeHtml(data.result) + '</div>';
        } catch (err) {
            dom.translatePopupBody.innerHTML = '<p style="color:var(--red)">翻译失败：' + escapeHtml(err.message) + '</p>';
        }
    });
}

function closeTranslatePopup() { dom.translatePopup.classList.add('hidden'); }
document.addEventListener('mousedown', (e) => {
    if (dom.translatePopup.classList.contains('hidden')) return;
    if (!dom.translatePopup.querySelector('.translate-popup-content').contains(e.target)) closeTranslatePopup();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeTranslatePopup(); });
