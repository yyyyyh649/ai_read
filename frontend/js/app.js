/**
 * AI Paper Reader — Frontend Application
 * 论文 AI 阅读助手前端逻辑
 * 支持 Web UI 动态配置 API 模型
 */

// ─── Global State ───
const state = {
    fileId: null,
    currentTab: 'quick-scan',
    isStreaming: false,
    abortController: null,
    paperMeta: null,
};

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
    const isOpen = !panel.classList.contains('hidden');
    if (isOpen) {
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
        const resp = await fetch('/api/config');
        if (!resp.ok) return;
        const cfg = await resp.json();
        updateModelBadge(cfg.model || '--');
        // Store in localStorage as cache for form pre-fill
        localStorage.setItem('ai_read_config', JSON.stringify(cfg));
    } catch (e) {
        // Backend might not be ready yet
        setTimeout(loadModelConfig, 2000);
    }
}

function loadConfigIntoForm() {
    // Load from localStorage cache
    const cached = localStorage.getItem('ai_read_config');
    let cfg = {};
    if (cached) {
        try { cfg = JSON.parse(cached); } catch (e) {}
    }
    document.getElementById('cfgBaseUrl').value = cfg.base_url || '';
    document.getElementById('cfgApiKey').value = cfg.api_key || '';
    document.getElementById('cfgModel').value = cfg.model || '';
    document.getElementById('cfgModelFast').value = cfg.model_fast || '';
}

async function saveModelConfig() {
    const base_url = document.getElementById('cfgBaseUrl').value.trim();
    const api_key = document.getElementById('cfgApiKey').value.trim();
    const model = document.getElementById('cfgModel').value.trim();
    const model_fast = document.getElementById('cfgModelFast').value.trim();
    const statusEl = document.getElementById('settingsStatus');

    try {
        const resp = await fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ base_url, api_key, model, model_fast }),
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
        if (e.target.files.length > 0) {
            uploadFile(e.target.files[0]);
        }
    });
    zone.addEventListener('dragover', (e) => {
        e.preventDefault();
        zone.classList.add('drag-over');
    });
    zone.addEventListener('dragleave', () => {
        zone.classList.remove('drag-over');
    });
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
                if (file) {
                    e.preventDefault();
                    uploadFile(file);
                    return;
                }
            }
        }
    });
}

async function uploadFile(file) {
    if (!file.name.toLowerCase().endsWith('.pdf')) {
        alert('请上传 PDF 文件！');
        return;
    }
    dom.statusText.textContent = '正在上传并解析...';
    dom.btnRun.disabled = true;
    const formData = new FormData();
    formData.append('file', file);
    try {
        const resp = await fetch('/api/upload', { method: 'POST', body: formData });
        if (!resp.ok) throw new Error(await resp.text());
        const data = await resp.json();
        state.fileId = data.file_id;
        state.paperMeta = data.meta;
        dom.uploadZone.classList.add('hidden');
        dom.pdfPreview.classList.remove('hidden');
        dom.pdfFrame.src = '/api/paper/' + state.fileId + '/pdf';
        dom.pdfTitle.textContent = state.paperMeta.title || file.name;
        dom.emptyState.classList.add('hidden');
        dom.workspace.classList.remove('hidden');
        dom.btnRun.disabled = false;
        dom.statusText.textContent = '已加载：' + data.meta.page_count + ' 页，' + (data.text_length / 1000).toFixed(1) + 'K 字符';
        resetResult();
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
        const labels = {
            'quick-scan': '▶ 开始速览',
            'summary': '▶ 生成总结',
            'mindmap': '▶ 生成思维导图',
            'experiments': '▶ 汇总实验',
            'translate': '▶ 全文翻译',
        };
        dom.btnRun.textContent = labels[state.currentTab] || '▶ 开始分析';
        resetResult();
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

// ─── Analysis ───
async function runAnalysis() {
    if (!state.fileId) {
        alert('请先上传论文 PDF');
        return;
    }
    if (state.isStreaming) return;
    const endpoints = {
        'quick-scan': 'quick-scan',
        'summary': 'summary',
        'mindmap': 'mindmap',
        'experiments': 'experiments',
        'translate': 'translate-full',
    };
    const endpoint = endpoints[state.currentTab];
    if (!endpoint) return;
    state.isStreaming = true;
    state.abortController = new AbortController();
    dom.btnRun.style.display = 'none';
    dom.btnStop.style.display = 'inline-flex';
    dom.statusText.innerHTML = '<span class="spinner"></span> AI 分析中...';
    dom.resultPlaceholder.classList.add('hidden');
    dom.mindmapContainer.classList.add('hidden');
    if (state.currentTab === 'mindmap') {
        dom.resultContent.classList.add('hidden');
        dom.mindmapContainer.classList.remove('hidden');
    } else {
        dom.mindmapContainer.classList.add('hidden');
        dom.resultContent.classList.remove('hidden');
        dom.resultContent.innerHTML = '<span class="stream-cursor"></span>';
    }
    try {
        const resp = await fetch(
            '/api/paper/' + state.fileId + '/' + endpoint + '?stream=true',
            { signal: state.abortController.signal }
        );
        if (!resp.ok) throw new Error(await resp.text());
        let fullText = '';
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split('\n');
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const dataStr = line.slice(6);
                    if (dataStr === '[DONE]') continue;
                    try {
                        const data = JSON.parse(dataStr);
                        if (data.content) {
                            fullText += data.content;
                            updateResult(fullText);
                        }
                    } catch (e) {}
                }
            }
        }
        dom.statusText.textContent = '✓ 分析完成';
    } catch (err) {
        if (err.name === 'AbortError') {
            dom.statusText.textContent = '已停止';
        } else {
            dom.statusText.textContent = '⚠ ' + err.message;
            dom.resultContent.innerHTML = '<p style="color:var(--red)">错误：' + err.message + '</p>';
        }
    } finally {
        state.isStreaming = false;
        state.abortController = null;
        dom.btnRun.style.display = 'inline-flex';
        dom.btnStop.style.display = 'none';
    }
}

function stopAnalysis() {
    if (state.abortController) {
        state.abortController.abort();
    }
}

function updateResult(text) {
    if (state.currentTab === 'mindmap') {
        renderMindmap(text);
    } else {
        const html = marked.parse(text);
        dom.resultContent.innerHTML = html + '<span class="stream-cursor"></span>';
        dom.resultContent.scrollTop = dom.resultContent.scrollHeight;
        dom.resultContent.querySelectorAll('pre code').forEach(block => {
            if (window.hljs) {
                window.hljs.highlightElement(block);
            }
        });
    }
}

function resetResult() {
    dom.resultPlaceholder.classList.remove('hidden');
    dom.resultContent.classList.add('hidden');
    dom.mindmapContainer.classList.add('hidden');
    dom.resultContent.innerHTML = '';
    dom.mindmapSvg.innerHTML = '';
}

// ─── Mindmap ───
function renderMindmap(markdownText) {
    markdownText = markdownText.replace(/▌/g, '');
    try {
        const { Markmap } = window.markmap || {};
        if (Markmap) {
            const { transformer } = window.markmap;
            const transformer2 = new transformer.Transformer();
            const { root } = transformer2.transform(markdownText);
            dom.mindmapSvg.innerHTML = '';
            Markmap.create(dom.mindmapSvg, null, root);
        } else {
            dom.mindmapContainer.innerHTML = '<div class="markmap" style="width:100%;height:600px;">\n' + markdownText + '\n</div>';
            if (window.markmap) {
                window.markmap.autoLoader.renderAll();
            }
        }
        dom.resultContent.classList.remove('hidden');
        dom.resultContent.innerHTML = '<h3>📋 思维导图大纲</h3><pre><code class="language-markdown">' + escapeHtml(markdownText) + '</code></pre>';
    } catch (e) {
        console.error('Mindmap render error:', e);
        dom.resultContent.classList.remove('hidden');
        dom.resultContent.innerHTML = '<h3>📋 思维导图大纲</h3><pre><code class="language-markdown">' + escapeHtml(markdownText) + '</code></pre>';
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
        const top = Math.min(rect.bottom + 10, window.innerHeight - 300);
        const left = Math.max(10, Math.min(rect.left, window.innerWidth - 500));
        popup.style.position = 'fixed';
        popup.style.top = top + 'px';
        popup.style.left = left + 'px';
        popup.style.maxWidth = '480px';
        try {
            const resp = await fetch(
                '/api/paper/' + state.fileId + '/translate-snippet?text=' + encodeURIComponent(text),
                { method: 'POST' }
            );
            if (!resp.ok) throw new Error(await resp.text());
            const data = await resp.json();
            dom.translatePopupBody.innerHTML = '<div class="translate-source">' + escapeHtml(text) + '</div><div class="translate-target">' + escapeHtml(data.result) + '</div>';
        } catch (err) {
            dom.translatePopupBody.innerHTML = '<p style="color:var(--red)">翻译失败：' + err.message + '</p>';
        }
    });
}

function closeTranslatePopup() {
    dom.translatePopup.classList.add('hidden');
}

document.addEventListener('mousedown', (e) => {
    if (dom.translatePopup.classList.contains('hidden')) return;
    const popupContent = dom.translatePopup.querySelector('.translate-popup-content');
    if (popupContent && !popupContent.contains(e.target)) {
        closeTranslatePopup();
    }
});

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeTranslatePopup();
});
