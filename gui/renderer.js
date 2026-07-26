// ============ Web Local GUI - Frontend ============
// Uses fetch API to communicate with Express server

// ============ State ============
let files = [];
let isCompressing = false;
let availableEncoders = { nvenc: false, qsv: false, cpu: true };
let eventSource = null;
let presets = [];
let performanceInterval = null;
const isElectronMode = typeof window.electronAPI !== 'undefined';

// ============ DOM Elements ============
const $ = (id) => document.getElementById(id);

// ============ Initialize ============
async function init() {
    console.log('Initializing GUI...');

    // Folder selection
    $('btn-input-browse').onclick = async () => await promptForPath('input');
    $('btn-output-browse').onclick = async () => await promptForPath('output');

    // Scan button
    $('btn-scan').onclick = scanFolder;

    // Sliders
    $('quality-slider').oninput = () => $('quality-value').textContent = $('quality-slider').value;
    $('crf-slider').oninput = () => $('crf-value').textContent = $('crf-slider').value;

    // Action buttons
    $('btn-start').onclick = startCompression;
    $('btn-cancel').onclick = cancelCompression;

    // Make folder inputs editable
    $('input-folder').removeAttribute('readonly');
    $('output-folder').removeAttribute('readonly');
    $('input-folder').placeholder = 'Paste folder path here, e.g. D:\\Photos';
    $('output-folder').placeholder = 'Paste output path here, e.g. D:\\Photos\\compressed';

    // Detect encoders
    await detectEncoders();

    // Initialize Theme
    initTheme();

    // Connect SSE for real-time updates
    connectSSE();

    // Modal Interaction
    $('btn-close-modal').onclick = closeModal;
    $('btn-modal-ok').onclick = closeModal;
    $('btn-view-failed').onclick = () => { closeModal(); showFailedFiles(); };

    // Click outside to close
    $('summary-modal').addEventListener('click', (e) => {
        if (e.target.id === 'summary-modal') closeModal();
    });

    // Retry failed
    $('btn-retry-failed').onclick = retryFailedFiles;

    // Presets
    $('btn-save-preset').onclick = savePreset;
    $('btn-update-preset').onclick = updatePreset;
    $('btn-copy-preset').onclick = copyPreset;
    $('btn-delete-preset').onclick = deletePreset;
    $('btn-toggle-metrics').onclick = toggleMetricsPanel;
    $('preset-select').onchange = loadPreset;

    // Drag and drop
    setupDragAndDrop();

    // Load presets
    await loadPresetsFromServer();

    // Check for resumable job
    await checkResumableJob();

    // Start performance metrics
    startPerformanceMetrics();

    console.log('GUI initialized');
}

// ============ Drag and Drop ============
function setupDragAndDrop() {
    const dropZone = $('drop-zone');
    const overlay = $('drop-overlay');

    if (!dropZone) return;

    let dragDepth = 0;

    const showOverlay = () => {
        overlay.style.display = 'flex';
        dropZone.style.borderColor = 'var(--accent-purple)';
    };

    const hideOverlay = () => {
        dragDepth = 0;
        overlay.style.display = 'none';
        dropZone.style.borderColor = '';
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

        // Fallback: try to get path from data
        const text = e.dataTransfer.getData('text/plain') || e.dataTransfer.getData('text/uri-list');
        if (text) {
            const textPaths = getPathsFromDropText(text);
            if (textPaths.length > 0) {
                await handleDroppedPaths(textPaths);
                return;
            }
        }

        if (e.dataTransfer.files?.length && !window.electronAPI?.getPathForFile) {
            alert('Dropping individual files requires the desktop app. Browsers do not expose local file paths to the server.');
        }
    });
}

function getDroppedPaths(dataTransfer) {
    if (!dataTransfer?.files?.length) return [];

    return Array.from(dataTransfer.files)
        .map(file => {
            if (window.electronAPI?.getPathForFile) {
                return window.electronAPI.getPathForFile(file);
            }

            return file.path || '';
        })
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
        alert('Error reading dropped files: ' + (error.error || 'Unknown error'));
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
        updateStartButton();
        return;
    }

    if (paths.length === 1) {
        $('input-folder').value = paths[0];
        if (!$('output-folder').value) {
            $('output-folder').value = paths[0] + '\\compressed';
        }
        files = [];
        renderFileList();
        updateStartButton();
        return;
    }

    alert('No supported image or video files were dropped.');
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

// ============ SSE Connection ============
function connectSSE() {
    eventSource = new EventSource('/api/events');

    eventSource.addEventListener('file-start', (e) => {
        const data = JSON.parse(e.data);
        updateFileStatus(data.index, 'processing');
        scrollToFile(data.index);
    });

    eventSource.addEventListener('file-progress', (e) => {
        const data = JSON.parse(e.data);
        updateFileStatus(data.index, 'processing', { progress: data.percent });
    });

    eventSource.addEventListener('file-complete', (e) => {
        const data = JSON.parse(e.data);
        updateFileStatus(data.index, 'completed', { savings: data.savings });
    });

    eventSource.addEventListener('file-skipped', (e) => {
        const data = JSON.parse(e.data);
        updateFileStatus(data.index, 'skipped', { savings: data.sizeSaved });
    });

    eventSource.addEventListener('file-error', (e) => {
        const data = JSON.parse(e.data);
        updateFileStatus(data.index, 'failed', { error: data.error });
    });

    // Overall progress fires once per completed file. On a large library that is
    // thousands of events, so the DOM write is coalesced to one per frame.
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
        });
    });

    eventSource.addEventListener('complete', (e) => {
        const data = JSON.parse(e.data);
        showSummary(data);
        finishCompression();
        updateMetrics();
    });

    eventSource.addEventListener('cancelled', (e) => {
        const data = JSON.parse(e.data);
        $('progress-text').textContent = 'Cancelled';
        $('progress-bar').style.width = '0%';
        finishCompression();
    });
}

// ============ Encoder Detection ============
async function detectEncoders() {
    try {
        const response = await fetch('/api/encoders');
        availableEncoders = await response.json();

        $('nvenc-badge').textContent = availableEncoders.nvenc ? 'GPU' : 'N/A';
        $('nvenc-badge').className = 'badge ' + (availableEncoders.nvenc ? 'available' : 'unavailable');

        $('amf-badge').textContent = availableEncoders.amf ? 'GPU' : 'N/A';
        $('amf-badge').className = 'badge ' + (availableEncoders.amf ? 'available' : 'unavailable');

        $('qsv-badge').textContent = availableEncoders.qsv ? 'iGPU' : 'N/A';
        $('qsv-badge').className = 'badge ' + (availableEncoders.qsv ? 'available' : 'unavailable');

        const disableOption = (id, inputVal, available) => {
            const input = document.querySelector(`input[value="${inputVal}"]`);
            const label = $(id);
            if (input && label) {
                input.disabled = !available;
                label.style.opacity = available ? '1' : '0.5';
                label.style.cursor = available ? 'pointer' : 'not-allowed';
            }
        };

        disableOption('encoder-nvenc-label', 'nvenc', availableEncoders.nvenc);
        disableOption('encoder-amf-label', 'amf', availableEncoders.amf);
        disableOption('encoder-qsv-label', 'qsv', availableEncoders.qsv);

        let bestEncoder = 'x264';
        if (availableEncoders.nvenc) bestEncoder = 'nvenc';
        else if (availableEncoders.amf) bestEncoder = 'amf';
        else if (availableEncoders.qsv) bestEncoder = 'qsv';

        const radioToSelect = document.querySelector(`input[value="${bestEncoder}"]`);
        if (radioToSelect) radioToSelect.checked = true;
    } catch (error) {
        console.error('Failed to detect encoders:', error);
    }
}

// ============ Folder Selection ============
async function promptForPath(type) {
    let newPath = null;

    if (window.electronAPI) {
        newPath = await window.electronAPI.selectFolder();
    } else {
        const currentValue = type === 'input' ? $('input-folder').value : $('output-folder').value;
        newPath = prompt(
            type === 'input' ? 'Enter input folder path (e.g. D:\\Photos):' : 'Enter output folder path:',
            currentValue
        );
    }

    if (newPath) {
        if (type === 'input') {
            $('input-folder').value = newPath;
            if (!$('output-folder').value) {
                $('output-folder').value = newPath + '\\compressed';
            }
        } else {
            $('output-folder').value = newPath;
        }
        updateStartButton();
    }
}

// ============ File Scanning ============
async function scanFolder() {
    const folderPath = $('input-folder').value.trim();

    if (!folderPath) {
        alert('Please enter an input folder path first');
        return;
    }

    $('btn-scan').disabled = true;
    $('btn-scan').textContent = 'Scanning...';

    try {
        const fileType = document.querySelector('input[name="file-type"]:checked').value;

        const response = await fetch('/api/scan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                folderPath: folderPath,
                recursive: $('recursive-scan').checked,
                fileType: fileType
            })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Scan failed');
        }

        files = await response.json();
        files.forEach(f => f.status = 'pending');

        renderFileList();
        updateStartButton();
    } catch (error) {
        alert('Error scanning folder: ' + error.message);
    } finally {
        $('btn-scan').disabled = false;
        $('btn-scan').textContent = 'Scan Folder';
    }
}

// A filename may legitimately contain <, > or quotes, which would otherwise
// break out of the row markup below.
function escapeHtml(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// Each row is four elements, so a full render of a very large library costs
// tens of thousands of nodes and seconds of layout. Rows past this cap are not
// built; updateFileStatus already tolerates a missing row.
const MAX_RENDERED_ROWS = 2000;

function renderFileList() {
    const fileList = $('file-list');
    const fileCount = $('file-count');

    if (files.length === 0) {
        fileList.innerHTML = '<div class="file-list-empty">No supported files found</div>';
        fileCount.textContent = '';
        return;
    }

    let imageCount = 0;
    for (const f of files) {
        if (f.type === 'image') imageCount++;
    }
    const videoCount = files.length - imageCount;
    fileCount.textContent = `${files.length} files (${imageCount} images, ${videoCount} videos)`;

    const visible = files.length > MAX_RENDERED_ROWS ? files.slice(0, MAX_RENDERED_ROWS) : files;

    let html = visible.map((file, index) => `
        <div class="file-row" id="file-${index}" data-index="${index}">
            <div class="col-name">
                <span class="file-icon">${file.type === 'image' ? '🖼️' : '🎬'}</span>
                <span class="file-name-text" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
            </div>
            <div class="col-size">${escapeHtml(file.sizeFormatted)}</div>
            <div class="col-progress">
                <div class="mini-progress-track">
                    <div class="mini-progress-bar" style="width: 0%"></div>
                </div>
            </div>
            <div class="col-actions">
            </div>
        </div>
    `).join('');

    if (files.length > MAX_RENDERED_ROWS) {
        html += `<div class="file-list-empty">Showing first ${MAX_RENDERED_ROWS} of ${files.length} files. All ${files.length} will be processed.</div>`;
    }

    fileList.innerHTML = html;
}

function getStatusText(status) {
    switch (status) {
        case 'pending': return 'Waiting';
        case 'processing': return 'Processing...';
        case 'completed': return 'Done';
        case 'failed': return 'Failed';
        default: return status;
    }
}

function updateFileStatus(index, status, extras = {}) {
    if (!files[index]) return;

    files[index].status = status;
    files[index].error = extras.error || files[index].error;
    files[index].savings = extras.savings || files[index].savings;

    const fileRow = document.getElementById(`file-${index}`);
    if (!fileRow) return;

    const colProgress = fileRow.querySelector('.col-progress');
    const ensureProgressBar = () => {
        let progressBar = fileRow.querySelector('.mini-progress-bar');
        if (!progressBar) {
            colProgress.innerHTML = `
                <div class="mini-progress-track">
                    <div class="mini-progress-bar" style="width: 0%"></div>
                </div>
            `;
            progressBar = fileRow.querySelector('.mini-progress-bar');
        }
        return progressBar;
    };

    if (status === 'pending') {
        const progressBar = ensureProgressBar();
        fileRow.classList.remove('processing-active', 'failed-active');
        progressBar.style.width = '0%';
        progressBar.style.background = '';
        return;
    }

    if (status === 'processing') {
        const progressBar = ensureProgressBar();
        fileRow.classList.add('processing-active');
        fileRow.classList.remove('failed-active');
        if (extras.progress !== undefined) {
            progressBar.style.width = `${extras.progress}%`;
        }
    } else {
        fileRow.classList.remove('processing-active');
    }

    if (status === 'completed') {
        const progressBar = ensureProgressBar();
        progressBar.style.width = '100%';
        if (extras.savings) {
            colProgress.innerHTML = `<span class="file-savings" style="color: var(--accent-success); font-weight: 600;">✓ ${extras.savings}</span>`;
        }

        // Preview button removed per user request
    } else if (status === 'skipped') {
        const savedText = typeof extras.savings === 'number' ? `${formatBytes(extras.savings)} saved` : extras.savings;
        colProgress.innerHTML = `<span class="file-savings" style="color: var(--text-secondary); font-weight: 600;">Skipped${savedText ? ` (${savedText})` : ''}</span>`;
    } else if (status === 'failed') {
        fileRow.classList.add('failed-active');
        const progressBar = ensureProgressBar();
        progressBar.style.background = 'var(--accent-danger)';
        progressBar.style.width = '100%';
        colProgress.innerHTML = `<span class="file-error-text" style="color: var(--accent-danger); font-size: 11px;" title="${extras.error || 'Unknown error'}">✗ Failed</span>`;
    }
}

// With up to a dozen workers running, every one of them requesting a smooth
// scroll turns the list into a jittery mess and keeps the compositor busy.
// Follow the most recent file at most a few times a second instead.
const SCROLL_THROTTLE_MS = 400;
let lastScrollAt = 0;
let pendingScrollIndex = null;

function scrollToFile(index) {
    pendingScrollIndex = index;

    const now = performance.now();
    const wait = SCROLL_THROTTLE_MS - (now - lastScrollAt);
    if (wait > 0) {
        return;
    }

    lastScrollAt = now;
    const target = pendingScrollIndex;
    pendingScrollIndex = null;

    const fileItem = document.getElementById(`file-${target}`);
    if (fileItem) {
        fileItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
}

// ============ Compression ============
function updateStartButton() {
    $('btn-start').disabled = !$('input-folder').value || !$('output-folder').value || files.length === 0;
}

async function cancelCompression() {
    try {
        await fetch('/api/cancel', { method: 'POST' });
    } catch (error) {
        console.error('Failed to cancel:', error);
    }
}

async function startCompression() {
    if (files.length === 0 || isCompressing) return;

    isCompressing = true;
    $('btn-start').style.display = 'none';
    $('btn-cancel').style.display = 'inline-flex';
    $('progress-section').style.display = 'block';
    $('failed-files-section').style.display = 'none';

    $('progress-bar').style.width = '0%';
    $('progress-text').textContent = '0%';
    $('progress-count').textContent = `0/${files.length}`;

    files.forEach((f, i) => {
        f.status = 'pending';
        f.error = null;
        f.savings = null;
        updateFileStatus(i, 'pending');
    });

    const encoder = document.querySelector('input[name="encoder"]:checked').value;

    try {
        const response = await fetch('/api/compress', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                files: files,
                outputFolder: $('output-folder').value,
                inputFolder: $('input-folder').value,
                encoder: encoder,
                imageFormat: document.querySelector('input[name="image-format"]:checked').value,
                quality: $('quality-slider').value,
                crf: $('crf-slider').value,
                flatten: $('flatten-output').checked,
                renameOnly: $('rename-only').checked,
                categoryByYear: $('category-by-year').checked,
                categoryByMonth: $('category-by-month').checked
            })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Compression failed');
        }
    } catch (error) {
        alert('Error starting compression: ' + error.message);
        finishCompression();
    }
}

function finishCompression() {
    isCompressing = false;
    $('btn-start').style.display = 'inline-flex';
    $('btn-cancel').style.display = 'none';
    $('progress-section').style.display = 'none';
}

// ============ Failed Files ============
function showFailedFiles() {
    const section = $('failed-files-section');
    const list = $('failed-files-list');

    const failedFiles = files.filter(f => f.status === 'failed');
    if (failedFiles.length === 0) {
        section.style.display = 'none';
        return;
    }

    section.style.display = 'block';
    list.innerHTML = failedFiles.map((file, idx) => `
        <div class="failed-file-row">
            <span class="failed-file-icon">${file.type === 'image' ? '🖼️' : '🎬'}</span>
            <span class="failed-file-name" title="${file.path}">${file.name}</span>
            <span class="failed-file-error" title="${file.error || 'Unknown error'}">${(file.error || 'Unknown error').substring(0, 50)}${(file.error || '').length > 50 ? '...' : ''}</span>
        </div>
    `).join('');
}

async function retryFailedFiles() {
    const failedFiles = files.filter(f => f.status === 'failed');
    if (failedFiles.length === 0) return;

    isCompressing = true;
    $('btn-start').style.display = 'none';
    $('btn-cancel').style.display = 'inline-flex';
    $('progress-section').style.display = 'block';
    $('failed-files-section').style.display = 'none';

    $('progress-bar').style.width = '0%';
    $('progress-text').textContent = '0%';
    $('progress-count').textContent = `0/${failedFiles.length}`;

    const encoder = document.querySelector('input[name="encoder"]:checked').value;

    try {
        const response = await fetch('/api/retry-failed', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                failedFiles: failedFiles,
                outputFolder: $('output-folder').value,
                inputFolder: $('input-folder').value,
                encoder: encoder,
                imageFormat: document.querySelector('input[name="image-format"]:checked').value,
                quality: $('quality-slider').value,
                crf: $('crf-slider').value,
                flatten: $('flatten-output').checked,
                renameOnly: $('rename-only').checked,
                categoryByYear: $('category-by-year').checked,
                categoryByMonth: $('category-by-month').checked
            })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Retry failed');
        }
    } catch (error) {
        alert('Error retrying files: ' + error.message);
        finishCompression();
    }
}

// ============ Summary ============
function showSummary(results) {
    const modal = $('summary-modal');
    modal.style.display = 'flex';
    modal.offsetHeight;
    modal.classList.add('show');

    $('progress-section').style.display = 'none';

    const savedBytes = results.totalSaved || 0;
    const originalBytes = results.totalOriginal || 1;

    let savedText = formatBytes(savedBytes);
    if (results.totalOriginal > 0) {
        const percent = ((savedBytes / originalBytes) * 100).toFixed(1);
        savedText += ` (${percent}%)`;
    }

    $('stat-saved').textContent = savedText;
    $('stat-time').textContent = formatDuration(results.duration || 0);

    // Determine what to show in "Encoder" field
    const fileType = document.querySelector('input[name="file-type"]:checked').value;
    let encoderText = '-';

    if (fileType === 'image') {
        encoderText = document.querySelector('input[name="image-format"]:checked').value.toUpperCase();
    } else if (fileType === 'video') {
        encoderText = document.querySelector('input[name="encoder"]:checked').value.toUpperCase();
    } else {
        encoderText = 'MIXED';
    }

    const encoderLabel = document.querySelector('.summary-item:last-child .summary-label');
    if (encoderLabel) {
        encoderLabel.textContent = fileType === 'image' ? 'Format' : 'Encoder';
    }

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
        $('btn-start').style.display = 'inline-flex';
    }, 300);
}

// ============ Before/After Preview ============
// ============ Presets ============
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
}

async function savePreset() {
    const name = prompt('Enter preset name:');
    if (!name) return;

    await upsertPreset(name, getCurrentSettings(), 'Preset saved!');
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
            alert(successMessage);
        } else {
            const error = await response.json();
            alert('Failed to save preset: ' + error.error);
        }
    } catch (error) {
        alert('Error saving preset: ' + error.message);
    }
}

async function updatePreset() {
    const name = $('preset-select').value;
    if (!name) {
        alert('Select a preset first to update.');
        return;
    }

    if (!confirm(`Overwrite preset "${name}" with current settings?`)) return;
    await upsertPreset(name, getCurrentSettings(), `Preset "${name}" updated.`);
}

async function copyPreset() {
    const selected = $('preset-select').value;
    if (!selected) {
        alert('Select a preset first to copy.');
        return;
    }

    const newName = prompt('Enter new name for copied preset:', `${selected} Copy`);
    if (!newName) return;

    const source = presets.find(p => p.name === selected);
    if (!source) {
        alert('Selected preset not found.');
        return;
    }

    await upsertPreset(newName, source.settings, `Preset copied to "${newName.trim()}".`);
}

async function deletePreset() {
    const name = $('preset-select').value;
    if (!name) {
        alert('Select a preset first to delete.');
        return;
    }

    if (!confirm(`Delete preset "${name}"? This cannot be undone.`)) return;

    try {
        const response = await fetch(`/api/presets/${encodeURIComponent(name)}`, { method: 'DELETE' });
        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.error || 'Delete failed');
        }

        await loadPresetsFromServer();
        $('preset-select').value = '';
        resetToCustomDefaults();
        alert(`Preset "${name}" deleted.`);
    } catch (error) {
        alert('Error deleting preset: ' + error.message);
    }
}

async function loadPreset() {
    const name = $('preset-select').value;
    if (!name) {
        resetToCustomDefaults();
        return;
    }

    const preset = presets.find(p => p.name === name);
    if (!preset) return;

    const settings = preset.settings;

    const formatRadio = document.querySelector(`input[name="image-format"][value="${settings.imageFormat}"]`);
    if (formatRadio) formatRadio.checked = true;

    $('quality-slider').value = settings.quality;
    $('quality-value').textContent = settings.quality;

    const encoderRadio = document.querySelector(`input[name="encoder"][value="${settings.encoder}"]`);
    if (encoderRadio) encoderRadio.checked = true;

    $('crf-slider').value = settings.crf;
    $('crf-value').textContent = settings.crf;

    $('recursive-scan').checked = settings.recursive;
    $('flatten-output').checked = settings.flatten;
    $('rename-only').checked = settings.renameOnly;
    $('category-by-year').checked = settings.categoryByYear;
    $('category-by-month').checked = settings.categoryByMonth;
}

function resetToCustomDefaults() {
    const defaultFormat = document.querySelector('input[name="image-format"][value="webp"]');
    if (defaultFormat) defaultFormat.checked = true;

    $('quality-slider').value = '88';
    $('quality-value').textContent = '88';

    let defaultEncoder = 'x264';
    if (availableEncoders.nvenc) defaultEncoder = 'nvenc';
    else if (availableEncoders.amf) defaultEncoder = 'amf';
    else if (availableEncoders.qsv) defaultEncoder = 'qsv';

    const defaultEncoderRadio = document.querySelector(`input[name="encoder"][value="${defaultEncoder}"]`);
    if (defaultEncoderRadio) defaultEncoderRadio.checked = true;

    $('crf-slider').value = '22';
    $('crf-value').textContent = '22';

    $('recursive-scan').checked = false;
    $('flatten-output').checked = false;
    $('rename-only').checked = false;
    $('category-by-year').checked = false;
    $('category-by-month').checked = false;
}

// ============ Job Resume ============
async function checkResumableJob() {
    try {
        const response = await fetch('/api/job-state');
        const state = await response.json();

        if (state.hasJob && state.pendingFiles?.length > 0) {
            const pending = state.pendingFiles.length;
            const total = state.files?.length || pending;
            const completed = total - pending;

            const resume = confirm(`Found interrupted job: ${completed}/${total} files processed.\n\nWould you like to resume processing the remaining ${pending} files?`);
            if (resume) {
                await resumeJob();
            } else {
                await fetch('/api/job-state/clear', { method: 'POST' });
            }
        }
    } catch (error) {
        console.error('Failed to check job state:', error);
    }
}

async function resumeJob() {
    try {
        const response = await fetch('/api/job-state/resume', { method: 'POST' });
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Resume failed');
        }

        isCompressing = true;
        $('btn-start').style.display = 'none';
        $('btn-cancel').style.display = 'inline-flex';
        $('progress-section').style.display = 'block';
    } catch (error) {
        alert('Error resuming job: ' + error.message);
    }
}

// ============ Performance Metrics ============
function startPerformanceMetrics() {
    updateMetrics();
    performanceInterval = setInterval(updateMetrics, 5000);
}

function toggleMetricsPanel() {
    const metrics = $('metrics-section');
    if (!metrics) return;

    const isHidden = metrics.style.display === 'none' || metrics.style.display === '';
    metrics.style.display = isHidden ? 'block' : 'none';
}

async function updateMetrics() {
    try {
        const response = await fetch('/api/metrics');
        const metrics = await response.json();

        $('metric-memory').textContent = metrics.memory.heapUsed;
        $('metric-processed').textContent = metrics.compressionState.processed;
        $('metric-failed').textContent = metrics.compressionState.failed;
        $('metrics-uptime').textContent = `Uptime: ${formatDuration(metrics.uptime)}`;
    } catch {
    }
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

// ============ Start ============
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

// ============ Theme Management ============
let currentTheme = 'system';
const THEME_ORDER = ['system', 'dark', 'light'];
const THEME_ICONS = {
    system: '💻',
    dark: '🌙',
    light: '☀️'
};

function initTheme() {
    const stored = localStorage.getItem('mediaSquashTheme');
    if (stored && THEME_ORDER.includes(stored)) currentTheme = stored;

    const btn = $('theme-toggle-btn');
    if (btn) {
        btn.onclick = cycleTheme;
    }

    setTheme(currentTheme);

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
        if (currentTheme === 'system') {
            applyTheme(e.matches ? 'dark' : 'light');
        }
    });
}

function cycleTheme() {
    const currentIndex = THEME_ORDER.indexOf(currentTheme);
    const nextIndex = (currentIndex + 1) % THEME_ORDER.length;
    setTheme(THEME_ORDER[nextIndex]);
}

function setTheme(mode) {
    currentTheme = mode;
    localStorage.setItem('mediaSquashTheme', mode);

    const btn = $('theme-toggle-btn');
    if (btn) {
        btn.textContent = THEME_ICONS[mode];
        btn.title = `Current: ${mode.charAt(0).toUpperCase() + mode.slice(1)} (Click to switch)`;
    }

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
