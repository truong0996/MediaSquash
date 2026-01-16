// ============ Web Local GUI - Frontend ============
// Uses fetch API to communicate with Express server

// ============ State ============
let files = [];
let isCompressing = false;
let availableEncoders = { nvenc: false, qsv: false, cpu: true };
let eventSource = null;

// ============ DOM Elements ============
const $ = (id) => document.getElementById(id);

// ============ Initialize ============
async function init() {
    console.log('Initializing GUI...');

    // Hide custom titlebar (not needed in browser)
    const titlebar = document.querySelector('.titlebar');
    if (titlebar) titlebar.style.display = 'none';

    // Folder selection - using text input for path
    $('btn-input-browse').onclick = () => promptForPath('input');
    $('btn-output-browse').onclick = () => promptForPath('output');

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

    // Connect SSE for real-time updates
    connectSSE();

    console.log('GUI initialized');
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

    eventSource.addEventListener('file-error', (e) => {
        const data = JSON.parse(e.data);
        updateFileStatus(data.index, 'failed');
    });

    eventSource.addEventListener('overall-progress', (e) => {
        const data = JSON.parse(e.data);
        $('progress-bar').style.width = `${data.percent}%`;
        $('progress-text').textContent = `${data.processed}/${data.total} files`;
        $('progress-percent').textContent = `${data.percent.toFixed(0)}%`;
    });

    eventSource.addEventListener('complete', (e) => {
        const data = JSON.parse(e.data);
        showSummary(data);
        finishCompression();
    });

    eventSource.addEventListener('cancelled', () => {
        finishCompression();
    });
}

// ============ Encoder Detection ============
async function detectEncoders() {
    try {
        const response = await fetch('/api/encoders');
        availableEncoders = await response.json();

        // Update badges
        $('nvenc-badge').textContent = availableEncoders.nvenc ? '✓' : '✗';
        $('nvenc-badge').className = 'encoder-badge ' + (availableEncoders.nvenc ? 'available' : 'unavailable');

        $('amf-badge').textContent = availableEncoders.amf ? '✓' : '✗';
        $('amf-badge').className = 'encoder-badge ' + (availableEncoders.amf ? 'available' : 'unavailable');

        $('qsv-badge').textContent = availableEncoders.qsv ? '✓' : '✗';
        $('qsv-badge').className = 'encoder-badge ' + (availableEncoders.qsv ? 'available' : 'unavailable');

        // Disable unavailable encoder options
        if (!availableEncoders.nvenc) {
            document.querySelector('input[value="nvenc"]').disabled = true;
            $('encoder-nvenc-label').style.opacity = '0.5';
        }
        if (!availableEncoders.amf) {
            document.querySelector('input[value="amf"]').disabled = true;
            $('encoder-amf-label').style.opacity = '0.5';
        }
        if (!availableEncoders.qsv) {
            document.querySelector('input[value="qsv"]').disabled = true;
            $('encoder-qsv-label').style.opacity = '0.5';
        }

        // Auto-select the best available encoder
        let bestEncoder = 'x264'; // Default fallback
        if (availableEncoders.nvenc) bestEncoder = 'nvenc';
        else if (availableEncoders.amf) bestEncoder = 'amf';
        else if (availableEncoders.qsv) bestEncoder = 'qsv';

        const radioToSelect = document.querySelector(`input[value="${bestEncoder}"]`);
        if (radioToSelect) {
            radioToSelect.checked = true;
        }
    } catch (error) {
        console.error('Failed to detect encoders:', error);
    }
}

// ============ Folder Selection ============
function promptForPath(type) {
    const currentValue = type === 'input' ? $('input-folder').value : $('output-folder').value;
    const newPath = prompt(
        type === 'input'
            ? 'Enter input folder path (e.g. D:\\Photos):'
            : 'Enter output folder path:',
        currentValue
    );

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

function renderFileList() {
    const fileList = $('file-list');
    const fileCount = $('file-count');

    if (files.length === 0) {
        fileList.innerHTML = '<div class="file-list-empty">No supported files found</div>';
        fileCount.textContent = '';
        return;
    }

    const imageCount = files.filter(f => f.type === 'image').length;
    const videoCount = files.filter(f => f.type === 'video').length;
    fileCount.textContent = `${files.length} files (${imageCount} images, ${videoCount} videos)`;

    fileList.innerHTML = files.map((file, index) => `
        <div class="file-item" id="file-${index}">
            <span class="file-icon">${file.type === 'image' ? '🖼️' : '🎬'}</span>
            <div class="file-info">
                <div class="file-name" title="${file.name}">${file.name}</div>
                <div class="file-size">${file.sizeFormatted}</div>
            </div>
            <span class="file-status status-${file.status}">${getStatusText(file.status)}</span>
        </div>
    `).join('');
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
    const fileItem = document.getElementById(`file-${index}`);
    if (!fileItem) return;

    const statusEl = fileItem.querySelector('.file-status');
    statusEl.className = `file-status status-${status}`;
    statusEl.textContent = getStatusText(status);

    if (status === 'processing') {
        fileItem.classList.add('processing');
    } else {
        fileItem.classList.remove('processing');
    }

    if (extras.progress !== undefined) {
        statusEl.textContent = `${extras.progress.toFixed(0)}%`;
    }

    if (extras.savings) {
        statusEl.innerHTML = `✓ ${extras.savings}`;
        statusEl.classList.add('file-savings');
    }
}

function scrollToFile(index) {
    const fileItem = document.getElementById(`file-${index}`);
    if (fileItem) {
        fileItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
}

// ============ Compression ============
function updateStartButton() {
    $('btn-start').disabled = !$('input-folder').value || !$('output-folder').value || files.length === 0;
}

async function startCompression() {
    if (files.length === 0 || isCompressing) return;

    isCompressing = true;
    $('btn-start').style.display = 'none';
    $('btn-cancel').style.display = 'inline-flex';
    $('progress-section').style.display = 'block';
    $('summary-section').style.display = 'none';

    // Reset progress
    $('progress-bar').style.width = '0%';
    $('progress-text').textContent = '0/0 files';
    $('progress-percent').textContent = '0%';

    // Reset all file statuses
    files.forEach((f, i) => {
        f.status = 'pending';
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
                categoryByYear: $('category-by-year').checked
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
}

async function cancelCompression() {
    try {
        await fetch('/api/cancel', { method: 'POST' });
    } catch (error) {
        console.error('Failed to cancel:', error);
    }
}

function showSummary(results) {
    $('summary-section').style.display = 'block';

    const savedBytes = results.totalSaved || 0;
    let savedText = formatBytes(savedBytes);
    if (results.totalOriginal > 0) {
        const percent = ((savedBytes / results.totalOriginal) * 100).toFixed(1);
        savedText += ` (${percent}%)`;
    }

    $('stat-saved').textContent = savedText;
    $('stat-time').textContent = formatDuration(results.duration);

    const encoder = document.querySelector('input[name="encoder"]:checked').value;
    $('stat-encoder').textContent = encoder.toUpperCase();
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatDuration(seconds) {
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
