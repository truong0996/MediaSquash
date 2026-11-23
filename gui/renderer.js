// ============ Tactile Studio Workbench - Frontend ============

let files = [];
let isCompressing = false;
let availableEncoders = { nvenc: false, amf: false, qsv: false, x264: true, x265: true };
let eventSource = null;
let presets = [];
let performanceInterval = null;
let jobStartedAt = 0;

// Cached DOM references for rendered queue rows (avoids querySelector per SSE tick)
const rowElements = new Map();
const pendingRowUpdates = new Map();
let rowUpdateFrame = null;

const MAX_RENDERED_ROWS = 2000;
const SCROLL_THROTTLE_MS = 450;
let lastScrollAt = 0;

const $ = (id) => document.getElementById(id);

const ICONS = {
    image: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
    video: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>',
    system: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
    dark: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>',
    light: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>'
};

// ============ Initialization ============
async function init() {
    $('btn-input-browse').onclick = () => promptForPath('input');
    $('btn-output-browse').onclick = () => promptForPath('output');
    $('btn-scan').onclick = scanFolder;

    $('input-folder').addEventListener('input', () => {
        updateStartButton();
        updatePathPreview();
    });
    $('input-folder').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && $('input-folder').value.trim()) {
            scanFolder();
        }
    });
    $('output-folder').addEventListener('input', () => {
        updateStartButton();
        updatePathPreview();
    });

    $('quality-slider').oninput = updateQualityLabel;
    $('crf-slider').oninput = updateCrfLabel;
    updateQualityLabel();
    updateCrfLabel();

    $('btn-start').onclick = startCompression;
    $('btn-cancel').onclick = cancelCompression;

    // Segmented controls & filter radios
    setupRadioControls();

    // Summary modal
    $('btn-close-modal').onclick = closeModal;
    $('btn-modal-ok').onclick = closeModal;
    $('btn-view-failed').onclick = () => {
        closeModal();
        showFailedFiles();
    };
    $('summary-modal').addEventListener('click', (e) => {
        if (e.target.id === 'summary-modal') closeModal();
    });

    // Failed files
    $('btn-retry-failed').onclick = retryFailedFiles;
    $('btn-hide-failed').onclick = () => {
        $('failed-files-section').style.display = 'none';
    };

    // Presets
    $('btn-save-preset').onclick = savePreset;
    $('btn-update-preset').onclick = updatePreset;
    $('btn-copy-preset').onclick = copyPreset;
    $('btn-delete-preset').onclick = deletePreset;
    $('preset-select').onchange = loadPreset;
    updatePresetActionState();

    // Metrics
    $('btn-toggle-metrics').onclick = toggleMetricsPanel;

    // Theme & SSE & Drag/Drop
    initTheme();
    connectSSE();
    setupDragAndDrop();

    await detectEncoders();
    await loadPresetsFromServer();
    await checkResumableJob();

    updatePathPreview();
    updateStartButton();
}

// ============ Radio & Output Structure Sync ============
function setupRadioControls() {
    // Output structure segmented control
    document.querySelectorAll('input[name="output-structure"]').forEach(radio => {
        radio.addEventListener('change', () => {
            syncOutputStructureFromRadio(radio.value);
            updatePathPreview();
        });
    });

    $('category-by-year').addEventListener('change', () => {
        if (!$('category-by-year').checked && !$('category-by-month').checked) {
            $('category-by-year').checked = true;
        }
        updatePathPreview();
    });
    $('category-by-month').addEventListener('change', () => {
        if (!$('category-by-year').checked && !$('category-by-month').checked) {
            $('category-by-month').checked = true;
        }
        updatePathPreview();
    });
    $('rename-only').addEventListener('change', updatePathPreview);

    // Image format segmented control
    document.querySelectorAll('input[name="image-format"]').forEach(radio => {
        radio.addEventListener('change', () => {
            syncSegmentedActive('image-format');
            updatePathPreview();
        });
    });

    // Video encoder grid
    document.querySelectorAll('input[name="encoder"]').forEach(radio => {
        radio.addEventListener('change', () => {
            syncEncoderActive();
        });
    });

    // Media type filter pills
    document.querySelectorAll('input[name="file-type"]').forEach(radio => {
        radio.addEventListener('change', () => {
            syncFilterPills();
            syncCardDimming();
            if (files.length > 0 && $('input-folder').value.trim()) {
                scanFolder();
            }
        });
    });

    syncSegmentedActive('image-format');
    syncFilterPills();
    syncCardDimming();
}

function syncOutputStructureFromRadio(mode) {
    document.querySelectorAll('[data-structure]').forEach(el => {
        el.classList.toggle('active', el.dataset.structure === mode);
    });

    const dateRow = $('date-options-row');
    if (mode === 'flatten') {
        $('flatten-output').checked = true;
        $('category-by-year').checked = false;
        $('category-by-month').checked = false;
        dateRow.style.display = 'none';
    } else if (mode === 'date') {
        $('flatten-output').checked = false;
        if (!$('category-by-year').checked && !$('category-by-month').checked) {
            $('category-by-year').checked = true;
        }
        dateRow.style.display = 'flex';
    } else {
        $('flatten-output').checked = false;
        $('category-by-year').checked = false;
        $('category-by-month').checked = false;
        dateRow.style.display = 'none';
    }
}

function applyStructureFromCheckboxes(flatten, byYear, byMonth) {
    let mode = 'preserve';
    if (flatten) {
        mode = 'flatten';
    } else if (byYear || byMonth) {
        mode = 'date';
    }

    const radio = document.querySelector(`input[name="output-structure"][value="${mode}"]`);
    if (radio) radio.checked = true;

    document.querySelectorAll('[data-structure]').forEach(el => {
        el.classList.toggle('active', el.dataset.structure === mode);
    });

    $('flatten-output').checked = Boolean(flatten);
    $('category-by-year').checked = Boolean(byYear);
    $('category-by-month').checked = Boolean(byMonth);
    $('date-options-row').style.display = mode === 'date' ? 'flex' : 'none';
    updatePathPreview();
}

function syncSegmentedActive(name) {
    document.querySelectorAll(`input[name="${name}"]`).forEach(r => {
        r.closest('.seg-item')?.classList.toggle('active', r.checked);
    });
}

function syncEncoderActive() {
    document.querySelectorAll('input[name="encoder"]').forEach(r => {
        r.closest('.encoder-option')?.classList.toggle('active', r.checked);
    });
}

function syncFilterPills() {
    document.querySelectorAll('input[name="file-type"]').forEach(r => {
        r.closest('.type-radio')?.classList.toggle('active', r.checked);
    });
}

function syncCardDimming() {
    const type = document.querySelector('input[name="file-type"]:checked')?.value || 'all';
    const imgPanel = $('image-settings-panel');
    const vidPanel = $('video-settings-panel');
    const imgStatus = $('image-card-status');
    const vidStatus = $('video-card-status');

    imgPanel.classList.toggle('dimmed', type === 'video');
    vidPanel.classList.toggle('dimmed', type === 'image');
    imgStatus.textContent = type === 'video' ? 'Skipped' : 'Active';
    vidStatus.textContent = type === 'image' ? 'Skipped' : 'Active';
}

// ============ Human-Friendly Slider Labels & Path Preview ============
function updateQualityLabel() {
    const slider = $('quality-slider');
    const val = parseInt(slider.value, 10);
    const pct = ((val - 1) / 99) * 100;
    slider.style.setProperty('--slider-fill', `${pct}%`);

    let tier = 'Balanced';
    if (val >= 92) tier = 'Archival';
    else if (val >= 82) tier = 'High';
    else if (val >= 65) tier = 'Compact';
    else tier = 'Tiny';

    $('quality-badge').innerHTML = `<strong id="quality-value">${val}</strong> · ${tier}`;
}

function updateCrfLabel() {
    const slider = $('crf-slider');
    const val = parseInt(slider.value, 10);
    const pct = (val / 51) * 100;
    slider.style.setProperty('--slider-fill', `${pct}%`);

    let tier = 'Balanced';
    if (val <= 17) tier = 'Visually Lossless';
    else if (val <= 21) tier = 'High Quality';
    else if (val <= 25) tier = 'Balanced';
    else if (val <= 30) tier = 'Compact';
    else tier = 'Small';

    $('crf-badge').innerHTML = `<strong id="crf-value">${val}</strong> · ${tier}`;
}

function updatePathPreview() {
    const outDir = ($('output-folder').value || 'D:\\Photos\\compressed').trim().replace(/[\\/]+$/, '');
    const structure = document.querySelector('input[name="output-structure"]:checked')?.value || 'preserve';
    const format = document.querySelector('input[name="image-format"]:checked')?.value || 'webp';
    const renameOnly = $('rename-only').checked;
    const ext = renameOnly ? 'jpg' : format;
    const sampleName = `20260412-183012.${ext}`;

    const parts = [outDir];
    if (structure === 'preserve') {
        parts.push('Album', sampleName);
    } else if (structure === 'date') {
        if ($('category-by-year').checked) parts.push('2026');
        if ($('category-by-month').checked) parts.push('202604__');
        parts.push(sampleName);
    } else {
        parts.push(sampleName);
    }

    $('path-preview-code').textContent = parts.join('\\');
}

// ============ Toasts & Dialogs (Replacing alert/prompt/confirm) ============
function showToast(message, type = 'info') {
    const container = $('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transition = 'opacity 0.2s ease';
        setTimeout(() => toast.remove(), 220);
    }, 3400);
}

function openDialog({ title, message, inputDefault = null, confirmText = 'Confirm', danger = false }) {
    return new Promise((resolve) => {
        const modal = $('dialog-modal');
        const input = $('dialog-input');
        const confirmBtn = $('dialog-confirm');

        $('dialog-title').textContent = title;
        $('dialog-message').textContent = message;
        confirmBtn.textContent = confirmText;
        confirmBtn.className = danger ? 'btn-danger' : 'btn-primary';
        confirmBtn.style.height = '36px';
        confirmBtn.style.padding = '0 18px';

        if (inputDefault !== null) {
            input.style.display = 'block';
            input.value = inputDefault;
        } else {
            input.style.display = 'none';
            input.value = '';
        }

        const close = (result) => {
            modal.classList.remove('show');
            setTimeout(() => { modal.style.display = 'none'; }, 180);
            document.removeEventListener('keydown', onKey);
            resolve(result);
        };

        const onConfirm = () => {
            close(inputDefault !== null ? input.value : true);
        };

        const onKey = (e) => {
            if (e.key === 'Escape') close(null);
            if (e.key === 'Enter' && inputDefault !== null) onConfirm();
        };

        $('dialog-cancel').onclick = () => close(null);
        confirmBtn.onclick = onConfirm;
        modal.onclick = (e) => {
            if (e.target === modal) close(null);
        };
        document.addEventListener('keydown', onKey);

        modal.style.display = 'flex';
        modal.offsetHeight;
        modal.classList.add('show');

        if (inputDefault !== null) {
            setTimeout(() => {
                input.focus();
                input.select();
            }, 20);
        }
    });
}

// ============ Drag and Drop ============
function setupDragAndDrop() {
    const dropZone = $('drop-zone');
    const overlay = $('drop-overlay');
    if (!dropZone) return;

    let dragDepth = 0;

    const showOverlay = () => {
        overlay.style.display = 'flex';
    };

    const hideOverlay = () => {
        dragDepth = 0;
        overlay.style.display = 'none';
    };

    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.dataTransfer) {
                e.dataTransfer.dropEffect = 'copy';
            }
        });
    });

    dropZone.addEventListener('dragenter', (e) => {
        if (dropZone.contains(e.relatedTarget)) return;
        dragDepth++;
        showOverlay();
    });

    dropZone.addEventListener('dragover', showOverlay);

    dropZone.addEventListener('dragleave', (e) => {
        if (dropZone.contains(e.relatedTarget)) return;
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) hideOverlay();
    });

    dropZone.addEventListener('drop', async (e) => {
        hideOverlay();

        const droppedPaths = getDroppedPaths(e.dataTransfer);
        if (droppedPaths.length > 0) {
            await handleDroppedPaths(droppedPaths);
            return;
        }

        const text = e.dataTransfer.getData('text/plain') || e.dataTransfer.getData('text/uri-list');
        if (text) {
            const textPaths = getPathsFromDropText(text);
            if (textPaths.length > 0) {
                await handleDroppedPaths(textPaths);
                return;
            }
        }

        if (e.dataTransfer.files?.length && !window.electronAPI?.getPathForFile) {
            showToast('Dropping individual files requires the Desktop App. Paste a folder path in browser mode.', 'warning');
        }
    });
}

function getDroppedPaths(dataTransfer) {
    if (!dataTransfer?.files?.length) return [];
    return Array.from(dataTransfer.files)
        .map(file => (window.electronAPI?.getPathForFile ? window.electronAPI.getPathForFile(file) : (file.path || '')))
        .filter(Boolean);
}

async function handleDroppedPaths(paths) {
    const fileType = document.querySelector('input[name="file-type"]:checked').value;
    const response = await fetch('/api/scan-files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            filePaths: paths,
            recursive: $('recursive-scan').checked,
            fileType
        })
    });

    if (!response.ok) {
        const error = await response.json();
        showToast('Error reading dropped files: ' + (error.error || 'Unknown error'), 'error');
        return;
    }

    const droppedFiles = await response.json();
    if (droppedFiles.length > 0) {
        files = droppedFiles.map(file => ({ ...file, status: 'pending' }));

        const commonFolder = getCommonFolder(files.map(file => file.path));
        if (commonFolder) {
            $('input-folder').value = commonFolder;
            if (!$('output-folder').value) {
                $('output-folder').value = commonFolder + '\\compressed';
            }
        }

        renderFileList();
        updatePathPreview();
        updateStartButton();
        showToast(`Loaded ${files.length} file(s)`, 'success');
        return;
    }

    if (paths.length === 1) {
        $('input-folder').value = paths[0];
        if (!$('output-folder').value) {
            $('output-folder').value = paths[0] + '\\compressed';
        }
        files = [];
        renderFileList();
        updatePathPreview();
        updateStartButton();
        return;
    }

    showToast('No supported image or video files found in drop.', 'warning');
}

function getPathsFromDropText(text) {
    return text
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .filter(line => !line.startsWith('#'))
        .map(line => {
            const withoutScheme = line.replace(/^file:\/\/\/?/i, '');
            try {
                return decodeURIComponent(withoutScheme);
            } catch {
                return withoutScheme;
            }
        });
}

function getCommonFolder(filePaths) {
    if (filePaths.length === 0) return '';
    const separators = /[\\/]/;
    const folders = filePaths.map(filePath => filePath.split(separators).slice(0, -1));
    const first = folders[0];
    let length = first.length;

    for (const folder of folders.slice(1)) {
        length = Math.min(length, folder.length);
        for (let i = 0; i < length; i++) {
            if (folder[i].toLowerCase() !== first[i].toLowerCase()) {
                length = i;
                break;
            }
        }
    }

    return first.slice(0, length).join('\\');
}

// ============ SSE Connection & Batched Row Rendering ============
function queueRowUpdate(index, status, extras = {}) {
    const prev = pendingRowUpdates.get(index);
    // Do not overwrite a final state in the same frame with an earlier progress tick
    if (prev && (prev.status === 'completed' || prev.status === 'failed' || prev.status === 'skipped') && status === 'processing') {
        return;
    }
    pendingRowUpdates.set(index, { status, extras });

    if (rowUpdateFrame !== null) return;
    rowUpdateFrame = requestAnimationFrame(() => {
        rowUpdateFrame = null;
        for (const [idx, update] of pendingRowUpdates.entries()) {
            updateFileStatus(idx, update.status, update.extras);
        }
        pendingRowUpdates.clear();
    });
}

function connectSSE() {
    eventSource = new EventSource('/api/events');

    eventSource.addEventListener('file-start', (e) => {
        const data = JSON.parse(e.data);
        queueRowUpdate(data.index, 'processing');
        scrollToFile(data.index);
    });

    eventSource.addEventListener('file-progress', (e) => {
        const data = JSON.parse(e.data);
        queueRowUpdate(data.index, 'processing', { progress: data.percent });
    });

    eventSource.addEventListener('file-complete', (e) => {
        const data = JSON.parse(e.data);
        queueRowUpdate(data.index, 'completed', { savings: data.savings });
    });

    eventSource.addEventListener('file-skipped', (e) => {
        const data = JSON.parse(e.data);
        queueRowUpdate(data.index, 'skipped', { savings: data.sizeSaved });
    });

    eventSource.addEventListener('file-error', (e) => {
        const data = JSON.parse(e.data);
        queueRowUpdate(data.index, 'failed', { error: data.error });
    });

    let pendingOverall = null;
    let overallFrame = null;

    eventSource.addEventListener('overall-progress', (e) => {
        pendingOverall = JSON.parse(e.data);
        if (overallFrame !== null) return;

        overallFrame = requestAnimationFrame(() => {
            overallFrame = null;
            const data = pendingOverall;
            if (!data) return;

            $('progress-bar').style.width = `${data.percent}%`;
            $('progress-text').textContent = `${data.percent.toFixed(0)}%`;
            $('progress-count').textContent = `${data.processed}/${data.total}`;
            $('metric-processed').textContent = data.processed;

            let etaText = '';
            if (data.processed >= 2 && data.processed < data.total && jobStartedAt > 0) {
                const elapsedSec = (Date.now() - jobStartedAt) / 1000;
                const rate = data.processed / elapsedSec;
                if (rate > 0) {
                    const remainingSec = (data.total - data.processed) / rate;
                    etaText = ` · ~${formatDuration(remainingSec)} left`;
                }
            }
            $('action-status-text').textContent = `Compressing ${data.processed} of ${data.total}${etaText}`;
        });
    });

    eventSource.addEventListener('complete', (e) => {
        if (overallFrame !== null) {
            cancelAnimationFrame(overallFrame);
            overallFrame = null;
        }
        pendingOverall = null;
        const data = JSON.parse(e.data);
        finishCompression();
        showSummary(data);
        if (isMetricsOpen()) updateMetrics();
        updateRetryButtonState();
    });

    eventSource.addEventListener('cancelled', () => {
        if (overallFrame !== null) {
            cancelAnimationFrame(overallFrame);
            overallFrame = null;
        }
        pendingOverall = null;
        finishCompression();
        $('action-status-text').textContent = 'Compression stopped. Remaining files saved for resume.';
        showToast('Compression stopped', 'warning');
        checkResumableJob();
        updateRetryButtonState();
    });
}

// ============ Encoder Detection ============
async function detectEncoders() {
    try {
        const response = await fetch('/api/encoders');
        availableEncoders = await response.json();

        const setBadge = (id, available, textOn, textOff) => {
            const el = $(id);
            if (!el) return;
            el.textContent = available ? textOn : textOff;
            el.className = 'enc-badge ' + (available ? 'available' : 'unavailable');
        };

        setBadge('nvenc-badge', availableEncoders.nvenc, 'GPU', 'N/A');
        setBadge('amf-badge', availableEncoders.amf, 'GPU', 'N/A');
        setBadge('qsv-badge', availableEncoders.qsv, 'iGPU', 'N/A');

        const toggleEncoderOption = (labelId, value, available) => {
            const input = document.querySelector(`input[name="encoder"][value="${value}"]`);
            const label = $(labelId);
            if (input && label) {
                input.disabled = !available;
                label.classList.toggle('disabled', !available);
            }
        };

        toggleEncoderOption('encoder-nvenc-label', 'nvenc', availableEncoders.nvenc);
        toggleEncoderOption('encoder-amf-label', 'amf', availableEncoders.amf);
        toggleEncoderOption('encoder-qsv-label', 'qsv', availableEncoders.qsv);

        let bestEncoder = 'x264';
        if (availableEncoders.nvenc) bestEncoder = 'nvenc';
        else if (availableEncoders.amf) bestEncoder = 'amf';
        else if (availableEncoders.qsv) bestEncoder = 'qsv';

        const radioToSelect = document.querySelector(`input[name="encoder"][value="${bestEncoder}"]`);
        if (radioToSelect) radioToSelect.checked = true;
        syncEncoderActive();
    } catch (error) {
        console.error('Failed to detect encoders:', error);
    }
}

// ============ Folder Selection & Auto-Scan ============
async function promptForPath(type) {
    let newPath = null;

    if (window.electronAPI) {
        newPath = await window.electronAPI.selectFolder();
    } else {
        const currentValue = type === 'input' ? $('input-folder').value : $('output-folder').value;
        newPath = await openDialog({
            title: type === 'input' ? 'Source Folder Path' : 'Destination Folder Path',
            message: 'Enter a local folder path:',
            inputDefault: currentValue || 'D:\\Photos',
            confirmText: 'Select'
        });
    }

    if (newPath) {
        if (type === 'input') {
            $('input-folder').value = newPath;
            if (!$('output-folder').value) {
                $('output-folder').value = newPath + '\\compressed';
            }
            updatePathPreview();
            updateStartButton();
            await scanFolder();
        } else {
            $('output-folder').value = newPath;
            updatePathPreview();
            updateStartButton();
        }
    }
}

// ============ File Scanning ============
async function scanFolder() {
    const folderPath = $('input-folder').value.trim();
    if (!folderPath) {
        showToast('Enter or select a Source Folder first.', 'warning');
        return;
    }

    if (!$('output-folder').value.trim()) {
        $('output-folder').value = folderPath.replace(/[\\/]+$/, '') + '\\compressed';
        updatePathPreview();
    }

    $('btn-scan').disabled = true;
    $('action-status-text').textContent = 'Scanning folder...';

    try {
        const fileType = document.querySelector('input[name="file-type"]:checked').value;
        const response = await fetch('/api/scan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                folderPath,
                recursive: $('recursive-scan').checked,
                fileType
            })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Scan failed');
        }

        files = await response.json();
        files.forEach(f => { f.status = 'pending'; });

        renderFileList();
        updateStartButton();
    } catch (error) {
        showToast('Scan failed: ' + error.message, 'error');
        $('action-status-text').textContent = 'Scan failed';
    } finally {
        $('btn-scan').disabled = false;
    }
}

function escapeHtml(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function renderFileList() {
    const fileList = $('file-list');
    const fileCount = $('file-count');
    rowElements.clear();

    if (files.length === 0) {
        fileList.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon" aria-hidden="true">${ICONS.image}</div>
                <div class="empty-title">No matching media files found</div>
                <div class="empty-desc">Try enabling "Include subfolders" or switching the media filter to All.</div>
            </div>
        `;
        fileCount.textContent = '0 files';
        updateRetryButtonState();
        return;
    }

    let imageCount = 0;
    let totalBytes = 0;
    for (const f of files) {
        if (f.type === 'image') imageCount++;
        totalBytes += f.size || 0;
    }
    const videoCount = files.length - imageCount;
    fileCount.textContent = `${files.length} files (${imageCount} img, ${videoCount} vid) · ${formatBytes(totalBytes)}`;

    const visible = files.length > MAX_RENDERED_ROWS ? files.slice(0, MAX_RENDERED_ROWS) : files;

    let html = visible.map((file, index) => `
        <div class="file-row" id="file-${index}" data-index="${index}">
            <div class="col-name">
                <span class="file-type-icon ${file.type === 'video' ? 'video' : ''}" aria-hidden="true">
                    ${file.type === 'image' ? ICONS.image : ICONS.video}
                </span>
                <span class="file-name-text" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
            </div>
            <div class="col-size">${escapeHtml(file.sizeFormatted || formatBytes(file.size || 0))}</div>
            <div class="col-progress">
                <div class="mini-progress-track">
                    <div class="mini-progress-bar" style="width: 0%"></div>
                </div>
            </div>
        </div>
    `).join('');

    if (files.length > MAX_RENDERED_ROWS) {
        html += `<div class="empty-desc" style="padding: 12px; text-align: center; max-width: none;">Showing first ${MAX_RENDERED_ROWS} of ${files.length} files. All ${files.length} will be processed.</div>`;
    }

    fileList.innerHTML = html;

    // Cache row element references once
    for (let i = 0; i < visible.length; i++) {
        const row = document.getElementById(`file-${i}`);
        if (row) {
            const colProgress = row.querySelector('.col-progress');
            const progressBar = row.querySelector('.mini-progress-bar');
            rowElements.set(i, { row, colProgress, progressBar });
        }
    }

    updateRetryButtonState();
}

function updateFileStatus(index, status, extras = {}) {
    if (!files[index]) return;

    files[index].status = status;
    if (extras.error !== undefined) files[index].error = extras.error;
    if (extras.savings !== undefined) files[index].savings = extras.savings;

    const cached = rowElements.get(index);
    if (!cached) return;

    const { row, colProgress } = cached;
    const ensureProgressBar = () => {
        if (!cached.progressBar || !cached.progressBar.isConnected) {
            colProgress.innerHTML = `
                <div class="mini-progress-track">
                    <div class="mini-progress-bar" style="width: 0%"></div>
                </div>
                <span class="row-pct"></span>
            `;
            cached.progressBar = colProgress.querySelector('.mini-progress-bar');
            cached.pctLabel = colProgress.querySelector('.row-pct');
        }
        return cached.progressBar;
    };

    if (status === 'pending') {
        row.classList.remove('processing-active', 'failed-active');
        const bar = ensureProgressBar();
        bar.style.width = '0%';
        bar.style.background = '';
        if (cached.pctLabel) cached.pctLabel.textContent = '';
        return;
    }

    if (status === 'processing') {
        row.classList.add('processing-active');
        row.classList.remove('failed-active');
        const bar = ensureProgressBar();
        if (extras.progress !== undefined) {
            bar.style.width = `${extras.progress}%`;
            if (cached.pctLabel) cached.pctLabel.textContent = `${extras.progress}%`;
        }
        return;
    }

    row.classList.remove('processing-active');
    cached.progressBar = null;
    cached.pctLabel = null;

    if (status === 'completed') {
        const label = escapeHtml(extras.savings || 'Done');
        colProgress.innerHTML = `<span class="row-status-pill success" title="${label}">✓ ${label}</span>`;
    } else if (status === 'skipped') {
        const savedText = typeof extras.savings === 'number'
            ? `${formatBytes(extras.savings)} saved`
            : escapeHtml(extras.savings || '');
        colProgress.innerHTML = `<span class="row-status-pill skipped">Skipped${savedText ? ` (${savedText})` : ''}</span>`;
    } else if (status === 'failed') {
        row.classList.add('failed-active');
        const errText = escapeHtml(extras.error || 'Unknown error');
        colProgress.innerHTML = `<span class="row-status-pill failed" title="${errText}">✗ Failed</span>`;
    }
}

function scrollToFile(index) {
    const now = performance.now();
    if (now - lastScrollAt < SCROLL_THROTTLE_MS) return;
    lastScrollAt = now;

    const cached = rowElements.get(index);
    if (cached?.row) {
        cached.row.scrollIntoView({ behavior: 'auto', block: 'nearest' });
    }
}

// ============ Compression ============
function updateStartButton() {
    const hasPaths = Boolean($('input-folder').value.trim() && $('output-folder').value.trim());
    const canStart = hasPaths && files.length > 0 && !isCompressing;
    $('btn-start').disabled = !canStart;

    const dot = $('status-dot');
    if (isCompressing) {
        dot.className = 'status-dot running';
    } else if (canStart) {
        dot.className = 'status-dot ready';
        $('action-status-text').textContent = `Ready · ${files.length} file(s) queued`;
    } else {
        dot.className = 'status-dot';
        if (!hasPaths) {
            $('action-status-text').textContent = 'Select a source folder to queue files';
        } else if (files.length === 0) {
            $('action-status-text').textContent = 'Scan folder or drop files to begin';
        }
    }
}

async function cancelCompression() {
    try {
        $('action-status-text').textContent = 'Stopping active encoders...';
        await fetch('/api/cancel', { method: 'POST' });
    } catch (error) {
        console.error('Failed to cancel:', error);
    }
}

function getCompressionPayload() {
    return {
        outputFolder: $('output-folder').value.trim(),
        inputFolder: $('input-folder').value.trim(),
        encoder: document.querySelector('input[name="encoder"]:checked').value,
        imageFormat: document.querySelector('input[name="image-format"]:checked').value,
        quality: $('quality-slider').value,
        crf: $('crf-slider').value,
        flatten: $('flatten-output').checked,
        renameOnly: $('rename-only').checked,
        categoryByYear: $('category-by-year').checked,
        categoryByMonth: $('category-by-month').checked
    };
}

function setRunningUI(totalCount) {
    isCompressing = true;
    jobStartedAt = Date.now();
    $('btn-start').style.display = 'none';
    $('btn-cancel').style.display = 'inline-flex';
    $('progress-section').style.display = 'flex';
    $('failed-files-section').style.display = 'none';
    $('resume-banner').style.display = 'none';

    $('progress-bar').style.width = '0%';
    $('progress-text').textContent = '0%';
    $('progress-count').textContent = `0/${totalCount}`;
    $('status-dot').className = 'status-dot running';
    $('action-status-text').textContent = `Starting 0 of ${totalCount}...`;
}

async function startCompression() {
    if (files.length === 0 || isCompressing) return;

    setRunningUI(files.length);

    // Reset all rows cleanly in one pass without forcing layout per row
    for (let i = 0; i < files.length; i++) {
        files[i].status = 'pending';
        files[i].error = null;
        files[i].savings = null;
        if (i < MAX_RENDERED_ROWS) {
            updateFileStatus(i, 'pending');
        }
    }

    try {
        const response = await fetch('/api/compress', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                files,
                ...getCompressionPayload()
            })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Compression failed');
        }
    } catch (error) {
        showToast('Error starting compression: ' + error.message, 'error');
        finishCompression();
    }
}

function finishCompression() {
    isCompressing = false;
    $('btn-start').style.display = 'inline-flex';
    $('btn-cancel').style.display = 'none';
    $('progress-section').style.display = 'none';
    updateStartButton();
}

// ============ Failed Files & Retry ============
function updateRetryButtonState() {
    const failed = files.filter(f => f.status === 'failed');
    const retryBtn = $('btn-retry-failed');
    if (failed.length > 0) {
        retryBtn.style.display = 'inline-flex';
        $('failed-count-badge').textContent = failed.length;
    } else {
        retryBtn.style.display = 'none';
    }
}

function showFailedFiles() {
    const section = $('failed-files-section');
    const list = $('failed-files-list');
    const failedFiles = files.filter(f => f.status === 'failed');

    if (failedFiles.length === 0) {
        section.style.display = 'none';
        return;
    }

    section.style.display = 'flex';
    list.innerHTML = failedFiles.map(file => `
        <div class="failed-file-row">
            <span class="failed-file-name" title="${escapeHtml(file.path)}">${escapeHtml(file.name)}</span>
            <span class="failed-file-error" title="${escapeHtml(file.error || 'Unknown error')}">${escapeHtml(file.error || 'Unknown error')}</span>
        </div>
    `).join('');
}

async function retryFailedFiles() {
    const failedWithIndices = [];
    files.forEach((f, idx) => {
        if (f.status === 'failed') {
            failedWithIndices.push({ ...f, index: idx });
            updateFileStatus(idx, 'pending');
        }
    });
    if (failedWithIndices.length === 0 || isCompressing) return;

    setRunningUI(failedWithIndices.length);

    try {
        const response = await fetch('/api/retry-failed', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                failedFiles: failedWithIndices,
                ...getCompressionPayload()
            })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Retry failed');
        }
    } catch (error) {
        showToast('Error retrying files: ' + error.message, 'error');
        finishCompression();
    }
}

// ============ Summary Modal ============
function showSummary(results) {
    const modal = $('summary-modal');
    modal.style.display = 'flex';
    modal.offsetHeight;
    modal.classList.add('show');

    const savedBytes = results.totalSaved || 0;
    const originalBytes = results.totalOriginal || 1;

    let savedText = formatBytes(savedBytes);
    if (results.totalOriginal > 0) {
        const percent = ((savedBytes / originalBytes) * 100).toFixed(1);
        savedText += ` (${percent}%)`;
    }

    $('stat-saved').textContent = savedText;
    $('stat-time').textContent = formatDuration(results.duration || 0);

    const fileType = document.querySelector('input[name="file-type"]:checked').value;
    let encoderText = 'MIXED';
    if (fileType === 'image') {
        encoderText = document.querySelector('input[name="image-format"]:checked').value.toUpperCase();
    } else if (fileType === 'video') {
        encoderText = document.querySelector('input[name="encoder"]:checked').value.toUpperCase();
    }

    $('stat-encoder-label').textContent = fileType === 'image' ? 'Format' : 'Encoder';
    $('stat-encoder').textContent = encoderText;
    $('stat-failed').textContent = results.failedCount || 0;

    const viewFailedBtn = $('btn-view-failed');
    if (results.failedCount > 0) {
        viewFailedBtn.style.display = 'inline-flex';
        showFailedFiles();
    } else {
        viewFailedBtn.style.display = 'none';
    }
}

function closeModal() {
    const modal = $('summary-modal');
    modal.classList.remove('show');
    setTimeout(() => {
        modal.style.display = 'none';
    }, 200);
}

// ============ Presets ============
function updatePresetActionState() {
    const hasSelection = Boolean($('preset-select').value);
    $('btn-update-preset').disabled = !hasSelection;
    $('btn-copy-preset').disabled = !hasSelection;
    $('btn-delete-preset').disabled = !hasSelection;
}

async function loadPresetsFromServer() {
    try {
        const response = await fetch('/api/presets');
        presets = await response.json();
        renderPresetSelector();
    } catch (error) {
        console.error('Failed to load presets:', error);
    }
}

function renderPresetSelector() {
    const select = $('preset-select');
    select.innerHTML = '<option value="">Custom</option>';
    presets.forEach(preset => {
        const option = document.createElement('option');
        option.value = preset.name;
        option.textContent = preset.name;
        select.appendChild(option);
    });
    updatePresetActionState();
}

function getCurrentSettings() {
    return {
        imageFormat: document.querySelector('input[name="image-format"]:checked').value,
        quality: $('quality-slider').value,
        encoder: document.querySelector('input[name="encoder"]:checked').value,
        crf: $('crf-slider').value,
        recursive: $('recursive-scan').checked,
        flatten: $('flatten-output').checked,
        renameOnly: $('rename-only').checked,
        categoryByYear: $('category-by-year').checked,
        categoryByMonth: $('category-by-month').checked
    };
}

async function savePreset() {
    const name = await openDialog({
        title: 'Save Preset',
        message: 'Name this compression preset:',
        inputDefault: 'My Preset',
        confirmText: 'Save'
    });
    if (!name || !name.trim()) return;
    await upsertPreset(name, getCurrentSettings(), `Saved preset "${name.trim()}"`);
}

async function upsertPreset(name, settings, successMessage) {
    const trimmed = name.trim();
    if (!trimmed) return;

    try {
        const response = await fetch('/api/presets', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: trimmed, settings })
        });

        if (response.ok) {
            await loadPresetsFromServer();
            $('preset-select').value = trimmed;
            updatePresetActionState();
            showToast(successMessage, 'success');
        } else {
            const error = await response.json();
            showToast('Failed to save preset: ' + error.error, 'error');
        }
    } catch (error) {
        showToast('Error saving preset: ' + error.message, 'error');
    }
}

async function updatePreset() {
    const name = $('preset-select').value;
    if (!name) return;

    const ok = await openDialog({
        title: 'Update Preset',
        message: `Overwrite "${name}" with your current settings?`,
        confirmText: 'Overwrite'
    });
    if (!ok) return;
    await upsertPreset(name, getCurrentSettings(), `Updated "${name}"`);
}

async function copyPreset() {
    const selected = $('preset-select').value;
    if (!selected) return;

    const newName = await openDialog({
        title: 'Duplicate Preset',
        message: `Enter a name for the copy of "${selected}":`,
        inputDefault: `${selected} Copy`,
        confirmText: 'Duplicate'
    });
    if (!newName || !newName.trim()) return;

    const source = presets.find(p => p.name === selected);
    if (!source) return;

    await upsertPreset(newName, source.settings, `Copied preset to "${newName.trim()}"`);
}

async function deletePreset() {
    const name = $('preset-select').value;
    if (!name) return;

    const ok = await openDialog({
        title: 'Delete Preset',
        message: `Delete preset "${name}"? This cannot be undone.`,
        confirmText: 'Delete',
        danger: true
    });
    if (!ok) return;

    try {
        const response = await fetch(`/api/presets/${encodeURIComponent(name)}`, { method: 'DELETE' });
        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.error || 'Delete failed');
        }

        await loadPresetsFromServer();
        $('preset-select').value = '';
        resetToCustomDefaults();
        updatePresetActionState();
        showToast(`Deleted preset "${name}"`, 'info');
    } catch (error) {
        showToast('Error deleting preset: ' + error.message, 'error');
    }
}

async function loadPreset() {
    const name = $('preset-select').value;
    updatePresetActionState();
    if (!name) {
        resetToCustomDefaults();
        return;
    }

    const preset = presets.find(p => p.name === name);
    if (!preset) return;

    const s = preset.settings;
    const formatRadio = document.querySelector(`input[name="image-format"][value="${s.imageFormat}"]`);
    if (formatRadio) formatRadio.checked = true;
    syncSegmentedActive('image-format');

    $('quality-slider').value = s.quality;
    updateQualityLabel();

    const encoderRadio = document.querySelector(`input[name="encoder"][value="${s.encoder}"]`);
    if (encoderRadio && !encoderRadio.disabled) encoderRadio.checked = true;
    syncEncoderActive();

    $('crf-slider').value = s.crf;
    updateCrfLabel();

    $('recursive-scan').checked = Boolean(s.recursive);
    $('rename-only').checked = Boolean(s.renameOnly);
    applyStructureFromCheckboxes(s.flatten, s.categoryByYear, s.categoryByMonth);
}

function resetToCustomDefaults() {
    const defaultFormat = document.querySelector('input[name="image-format"][value="webp"]');
    if (defaultFormat) defaultFormat.checked = true;
    syncSegmentedActive('image-format');

    $('quality-slider').value = '88';
    updateQualityLabel();

    let defaultEncoder = 'x264';
    if (availableEncoders.nvenc) defaultEncoder = 'nvenc';
    else if (availableEncoders.amf) defaultEncoder = 'amf';
    else if (availableEncoders.qsv) defaultEncoder = 'qsv';

    const defaultEncoderRadio = document.querySelector(`input[name="encoder"][value="${defaultEncoder}"]`);
    if (defaultEncoderRadio) defaultEncoderRadio.checked = true;
    syncEncoderActive();

    $('crf-slider').value = '22';
    updateCrfLabel();

    $('recursive-scan').checked = false;
    $('rename-only').checked = false;
    applyStructureFromCheckboxes(false, false, false);
}

// ============ Job Resume (Non-blocking Banner) ============
async function checkResumableJob() {
    try {
        const response = await fetch('/api/job-state');
        const state = await response.json();

        if (state.hasJob && state.pendingFiles?.length > 0) {
            const pending = state.pendingFiles.length;
            const total = state.files?.length || pending;
            const completed = Math.max(0, total - pending);

            $('resume-banner-text').textContent = `Interrupted job found: ${completed}/${total} processed (${pending} remaining)`;
            $('resume-banner').style.display = 'flex';

            $('btn-resume-job').onclick = () => resumeJob(state);
            $('btn-dismiss-resume').onclick = async () => {
                await fetch('/api/job-state/clear', { method: 'POST' });
                $('resume-banner').style.display = 'none';
            };
        } else {
            $('resume-banner').style.display = 'none';
        }
    } catch (error) {
        console.error('Failed to check job state:', error);
    }
}

async function resumeJob(state) {
    try {
        const response = await fetch('/api/job-state/resume', { method: 'POST' });
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Resume failed');
        }

        const data = await response.json();
        if (state?.inputFolder) $('input-folder').value = state.inputFolder;
        if (state?.outputFolder) $('output-folder').value = state.outputFolder;

        if (Array.isArray(data.files) && data.files.length > 0) {
            files = data.files.map(f => ({ ...f, status: 'pending' }));
            renderFileList();
        }

        setRunningUI(data.total || files.length);
        showToast(`Resumed ${data.total} remaining file(s)`, 'info');
    } catch (error) {
        showToast('Error resuming job: ' + error.message, 'error');
    }
}

// ============ Performance Metrics (Polls Only While Visible) ============
function isMetricsOpen() {
    const el = $('metrics-section');
    return Boolean(el && el.style.display !== 'none');
}

function toggleMetricsPanel() {
    const metrics = $('metrics-section');
    const btn = $('btn-toggle-metrics');
    if (!metrics) return;

    const show = !isMetricsOpen();
    metrics.style.display = show ? 'grid' : 'none';
    btn.classList.toggle('active', show);
    btn.setAttribute('aria-expanded', String(show));

    if (show) {
        updateMetrics();
        if (!performanceInterval) {
            performanceInterval = setInterval(updateMetrics, 4000);
        }
    } else if (performanceInterval) {
        clearInterval(performanceInterval);
        performanceInterval = null;
    }
}

async function updateMetrics() {
    try {
        const response = await fetch('/api/metrics');
        const metrics = await response.json();

        $('metric-memory').textContent = metrics.memory.heapUsed;
        $('metric-processed').textContent = metrics.compressionState.processed;
        $('metric-failed').textContent = metrics.compressionState.failed;
        $('metrics-uptime').textContent = formatDuration(metrics.uptime);
    } catch {}
}

// ============ Utilities ============
function formatBytes(bytes) {
    if (isNaN(bytes) || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(Math.abs(bytes)) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + (sizes[i] || 'B');
}

function formatDuration(seconds) {
    if (!seconds || isNaN(seconds)) return '0s';
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}m ${secs}s`;
}

// ============ Theme Management ============
let currentTheme = 'system';
const THEME_ORDER = ['system', 'dark', 'light'];

function initTheme() {
    const stored = localStorage.getItem('mediaSquashTheme');
    if (stored && THEME_ORDER.includes(stored)) currentTheme = stored;

    $('theme-toggle-btn').onclick = cycleTheme;
    setTheme(currentTheme);

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
        if (currentTheme === 'system') {
            applyTheme(e.matches ? 'dark' : 'light');
        }
    });
}

function cycleTheme() {
    const nextIndex = (THEME_ORDER.indexOf(currentTheme) + 1) % THEME_ORDER.length;
    setTheme(THEME_ORDER[nextIndex]);
}

function setTheme(mode) {
    currentTheme = mode;
    localStorage.setItem('mediaSquashTheme', mode);

    $('theme-icon').innerHTML = ICONS[mode] || ICONS.system;
    $('theme-label').textContent = mode.charAt(0).toUpperCase() + mode.slice(1);
    $('theme-toggle-btn').title = `Theme: ${mode} (click to switch)`;

    if (mode === 'system') {
        const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        applyTheme(isDark ? 'dark' : 'light');
    } else {
        applyTheme(mode);
    }
}

function applyTheme(resolvedMode) {
    if (resolvedMode === 'light') {
        document.documentElement.setAttribute('data-theme', 'light');
    } else {
        document.documentElement.removeAttribute('data-theme');
    }
}

// ============ Start ============
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
