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

    // Titlebar is now used for theme toggle, so we keep it visible
    // const titlebar = document.querySelector('.titlebar');
    // if (titlebar) titlebar.style.display = 'none';

    // Folder selection - using text input for path
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

    // Click outside to close
    $('summary-modal').addEventListener('click', (e) => {
        if (e.target.id === 'summary-modal') {
            closeModal();
        }
    });

    // Category by Year toggle logic - REMOVED (Month is now independent)
    // const yearCheckbox = $('category-by-year');
    // const monthCheckbox = $('category-by-month');

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

    eventSource.addEventListener('file-skipped', (e) => {
        const data = JSON.parse(e.data);
        updateFileStatus(data.index, 'skipped', { savings: data.sizeSaved });
    });

    eventSource.addEventListener('file-error', (e) => {
        const data = JSON.parse(e.data);
        updateFileStatus(data.index, 'failed');
    });

    eventSource.addEventListener('overall-progress', (e) => {
        const data = JSON.parse(e.data);
        $('progress-bar').style.width = `${data.percent}%`;
        $('progress-text').textContent = `${data.percent.toFixed(0)}%`;
        $('progress-count').textContent = `${data.processed}/${data.total}`;
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
        $('nvenc-badge').textContent = availableEncoders.nvenc ? 'GPU' : 'N/A';
        $('nvenc-badge').className = 'badge ' + (availableEncoders.nvenc ? 'available' : 'unavailable');

        $('amf-badge').textContent = availableEncoders.amf ? 'GPU' : 'N/A';
        $('amf-badge').className = 'badge ' + (availableEncoders.amf ? 'available' : 'unavailable');

        $('qsv-badge').textContent = availableEncoders.qsv ? 'iGPU' : 'N/A';
        $('qsv-badge').className = 'badge ' + (availableEncoders.qsv ? 'available' : 'unavailable');

        // Disable unavailable encoder options
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
async function promptForPath(type) {
    let newPath = null;

    if (window.electronAPI) {
        // Native dialog
        newPath = await window.electronAPI.selectFolder();
    } else {
        // Browser fallback
        const currentValue = type === 'input' ? $('input-folder').value : $('output-folder').value;
        newPath = prompt(
            type === 'input'
                ? 'Enter input folder path (e.g. D:\\Photos):'
                : 'Enter output folder path:',
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
        <div class="file-row" id="file-${index}">
            <div class="col-name">
                <span class="file-icon">${file.type === 'image' ? '🖼️' : '🎬'}</span>
                <span class="file-name-text" title="${file.name}">${file.name}</span>
            </div>
            <div class="col-size">${file.sizeFormatted}</div>
            <div class="col-progress">
                <div class="mini-progress-track">
                    <div class="mini-progress-bar" style="width: 0%"></div>
                </div>
            </div>
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
        fileRow.classList.remove('processing-active');
        progressBar.style.width = '0%';
        progressBar.style.background = '';
        return;
    }

    if (status === 'processing') {
        const progressBar = ensureProgressBar();
        fileRow.classList.add('processing-active');
        if (extras.progress !== undefined) {
            progressBar.style.width = `${extras.progress}%`;
        }
    } else {
        fileRow.classList.remove('processing-active');
    }

    if (status === 'completed') {
        const progressBar = ensureProgressBar();
        progressBar.style.width = '100%';
        // Replace progress bar with savings text
        if (extras.savings) {
            colProgress.innerHTML = `<span class="file-savings" style="color: var(--accent-success); font-weight: 600;">✓ ${extras.savings}</span>`;
        }
    } else if (status === 'skipped') {
        const savedText = typeof extras.savings === 'number'
            ? `${formatBytes(extras.savings)} saved`
            : extras.savings;
        colProgress.innerHTML = `<span class="file-savings" style="color: var(--text-secondary); font-weight: 600;">Skipped${savedText ? ` (${savedText})` : ''}</span>`;
    } else if (status === 'failed') {
        const progressBar = ensureProgressBar();
        progressBar.style.background = 'var(--accent-danger)';
        progressBar.style.width = '100%';
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
    // Summary is now a modal, no need to hide section manually here as it's not inline.
    // $('summary-modal').classList.remove('show'); // Optional assurance

    // Reset progress
    $('progress-bar').style.width = '0%';
    $('progress-text').textContent = '0%';
    $('progress-count').textContent = `0/${files.length}`;

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
    // Keep progress section visible if needed, or hide it. 
    // Usually better to hide it when summary shows.
    $('progress-section').style.display = 'none';
}

function showSummary(results) {
    const modal = $('summary-modal');
    // Show modal
    modal.style.display = 'flex';
    // Trigger reflow to enable transition
    modal.offsetHeight;
    modal.classList.add('show');

    // Hide progress bar on main UI
    $('progress-section').style.display = 'none';

    const savedBytes = results.totalSaved || 0;
    const originalBytes = results.totalOriginal || 1; // Prevent div by zero

    let savedText = formatBytes(savedBytes);

    // Only calculate percentage if we actually compressed something
    if (results.totalOriginal > 0) {
        const percent = ((savedBytes / originalBytes) * 100).toFixed(1);
        savedText += ` (${percent}%)`;
    }

    $('stat-saved').textContent = savedText;
    $('stat-time').textContent = formatDuration(results.duration || 0);

    $('stat-saved').textContent = savedText;
    $('stat-time').textContent = formatDuration(results.duration || 0);

    // Determine what to show in "Encoder" field
    const fileType = document.querySelector('input[name="file-type"]:checked').value;
    let encoderText = '-';

    if (fileType === 'image') {
        const fmt = document.querySelector('input[name="image-format"]:checked').value;
        encoderText = fmt.toUpperCase();
        // Update label to say "Format" instead of "Encoder"? 
        // Or just leave "Encoder" as generic term. "Format" is better contextually.
        // Let's stick to the text update for now, maybe change header dynamically if possible?
        // Changing header text requires selecting the sibling label.
        // Simple fix: Show "WEBP" / "JPEG"
    } else if (fileType === 'video') {
        const enc = document.querySelector('input[name="encoder"]:checked').value;
        encoderText = enc.toUpperCase();
    } else {
        // "ALL" mode
        encoderText = 'MIXED';
        // Or show both? "NVENC / WEBP"?
        // Let's keep it simple: "Mixed" or check what counts were.
        // Ideally we'd know count of images vs videos.
        // For now "Mixed" is safe.
    }

    // Optional: dynamically change label from "Encoder" to "Format"
    const encoderLabel = document.querySelector('.summary-item:last-child .summary-label');
    if (encoderLabel) {
        encoderLabel.textContent = fileType === 'image' ? 'Format' : 'Encoder';
    }

    $('stat-encoder').textContent = encoderText;
}

function closeModal() {
    const modal = $('summary-modal');
    modal.classList.remove('show');
    setTimeout(() => {
        modal.style.display = 'none';
        $('btn-start').style.display = 'inline-flex';
        // Reset progress bar if desired, or keep it until next scan?
        // For now, allow start button to appear again
    }, 300); // Match CSS transition duration
}

function formatBytes(bytes) {
    if (isNaN(bytes) || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(Math.abs(bytes)) / Math.log(k)); // Use Math.abs for negative savings
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
    // 1. Get stored preference
    const stored = localStorage.getItem('mediaSquashTheme');
    if (stored && THEME_ORDER.includes(stored)) currentTheme = stored;

    // 2. Bind click event to single button
    const btn = $('theme-toggle-btn');
    if (btn) {
        btn.onclick = cycleTheme;
    }

    // 3. Initial application
    setTheme(currentTheme);

    // 4. Listen for system changes
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

    // Update button icon
    const btn = $('theme-toggle-btn');
    if (btn) {
        btn.textContent = THEME_ICONS[mode];
        btn.title = `Current: ${mode.charAt(0).toUpperCase() + mode.slice(1)} (Click to switch)`;
    }

    // Apply logic
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
