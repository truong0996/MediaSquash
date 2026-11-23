/**
 * Off-main-thread HEIC/HEIF decoder worker pool.
 * Uses heic-decode inside worker_threads and transfers raw RGBA ArrayBuffers zero-copy.
 */

const { Worker, isMainThread, parentPort } = require('worker_threads');
const fs = require('fs');
const os = require('os');

if (!isMainThread) {
    const decode = require('heic-decode');

    parentPort.on('message', async ({ id, filePath }) => {
        try {
            const inputBuffer = await fs.promises.readFile(filePath);
            const decoded = await decode({ buffer: inputBuffer });
            const raw = decoded.data instanceof Uint8Array
                ? decoded.data
                : new Uint8Array(decoded.data);

            // Ensure tightly sliced ArrayBuffer for zero-copy transfer
            const arrayBuffer = (raw.byteOffset === 0 && raw.byteLength === raw.buffer.byteLength)
                ? raw.buffer
                : raw.slice().buffer;

            parentPort.postMessage(
                { id, width: decoded.width, height: decoded.height, buffer: arrayBuffer },
                [arrayBuffer]
            );
        } catch (err) {
            parentPort.postMessage({ id, error: err?.message || 'HEIC decode failed' });
        }
    });
} else {
    const MAX_WORKERS = Math.min(4, Math.max(1, Math.floor((os.cpus().length || 4) / 2)));
    const IDLE_TIMEOUT_MS = 10000;

    const workers = [];
    const queue = [];
    let nextTaskId = 1;
    let idleTimer = null;

    function resetIdleTimer() {
        if (idleTimer) clearTimeout(idleTimer);
        if (workers.length === 0) return;
        idleTimer = setTimeout(() => {
            if (queue.length === 0 && workers.every(w => !w.busy)) {
                shutdownHeicPool();
            }
        }, IDLE_TIMEOUT_MS);
        if (idleTimer.unref) idleTimer.unref();
    }

    function createPoolWorker() {
        const worker = new Worker(__filename);
        const slot = { worker, busy: false, currentTask: null };

        worker.on('message', (msg) => {
            const task = slot.currentTask;
            slot.currentTask = null;
            slot.busy = false;

            if (task) {
                if (msg.error) {
                    task.reject(new Error(msg.error));
                } else {
                    task.resolve({
                        width: msg.width,
                        height: msg.height,
                        data: Buffer.from(msg.buffer)
                    });
                }
            }
            dispatchNext();
        });

        worker.on('error', (err) => {
            const task = slot.currentTask;
            slot.currentTask = null;
            slot.busy = false;
            const idx = workers.indexOf(slot);
            if (idx !== -1) workers.splice(idx, 1);
            if (task) task.reject(err);
            dispatchNext();
        });

        worker.on('exit', () => {
            const idx = workers.indexOf(slot);
            if (idx !== -1) workers.splice(idx, 1);
        });

        workers.push(slot);
        return slot;
    }

    function dispatchNext() {
        if (queue.length === 0) {
            resetIdleTimer();
            return;
        }

        let slot = workers.find(w => !w.busy);
        if (!slot && workers.length < MAX_WORKERS) {
            slot = createPoolWorker();
        }
        if (!slot) return;

        if (idleTimer) {
            clearTimeout(idleTimer);
            idleTimer = null;
        }

        const task = queue.shift();
        slot.busy = true;
        slot.currentTask = task;
        slot.worker.postMessage({ id: task.id, filePath: task.filePath });
    }

    /**
     * Decode a HEIC/HEIF file into raw RGBA pixels on a worker thread.
     * @param {string} filePath
     * @returns {Promise<{ width: number, height: number, data: Buffer }>}
     */
    function decodeHeicInWorker(filePath) {
        return new Promise((resolve, reject) => {
            queue.push({ id: nextTaskId++, filePath, resolve, reject });
            dispatchNext();
        });
    }

    /**
     * Terminate all idle/active HEIC worker threads.
     */
    async function shutdownHeicPool() {
        if (idleTimer) {
            clearTimeout(idleTimer);
            idleTimer = null;
        }
        while (queue.length > 0) {
            const task = queue.shift();
            task.reject(new Error('HEIC worker pool shut down'));
        }
        const active = workers.splice(0, workers.length);
        await Promise.all(active.map(slot => slot.worker.terminate().catch(() => {})));
    }

    module.exports = {
        decodeHeicInWorker,
        shutdownHeicPool
    };
}
