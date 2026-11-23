# CLAUDE.md

This file provides guidance to AI coding assistants and contributors working with the **MediaSquash** repository.

## Project Overview

MediaSquash is a local-first image and video batch compressor available as:
- **Electron Desktop App** (`main.js` + `server.js` + `gui/`)
- **Local Web GUI** (`server.js` + `gui/`, default `http://127.0.0.1:3847`)
- **CLI** (`src/index.js`, binary alias `compress`)

## Common Commands

```bash
# Run Electron desktop app
npm start

# Run local Express Web GUI server
npm run gui

# Run CLI batch compression
node src/index.js all <inputDir> -o <outputDir> --recursive

# Run all automated tests
npm run test:all

# Build Windows installer / portable executable
npm run dist:win
```

## Architecture & Module Map

- **`main.js`**: Electron entry point. Sets `UV_THREADPOOL_SIZE`, starts `server.js` (expects `require('./server.js')` to return a `Promise` resolving `{ server, port, cleanupActiveProcesses }`), manages native folder picker IPC (`dialog:openDirectory`), and kills active FFmpeg processes on `before-quit`.
- **`server.js`**: Express 5 HTTP + SSE server bound strictly to `127.0.0.1`. Exposes `/api/encoders`, `/api/scan`, `/api/scan-files`, `/api/compress`, `/api/cancel`, `/api/retry-failed`, `/api/presets`, `/api/job-state*`, `/api/metrics`, `/api/status`, and `/api/events` (SSE).
- **`src/index.js`**: Commander CLI (`image`, `video`, `all` subcommands) with atomic output path reservation (`reservedOutputPaths`) and budgeted worker pools.
- **`src/imageCompressor.js`**: Sharp (`libvips`) pipeline with `sharp.cache(false)` and `configureSharpConcurrency()`. Normalizes format aliases (`jpg`→`jpeg`, `tif`→`tiff`) and keeps the smaller original if re-encoding the same format increases size.
- **`src/heicWorker.js`**: Lazy bounded `worker_threads` pool using `heic-decode` off the main event loop, transferring raw RGBA `ArrayBuffer` zero-copy to Sharp. Always call `shutdownHeicPool()` before CLI exit or after batch completion.
- **`src/videoCompressor.js`**: `fluent-ffmpeg` pipeline with:
  - Cached `ffprobe` (`probeVideo`) shared across capture date, `getAdaptiveCrf`, and `shouldCopyAudio`.
  - `-c:a copy` for compatible AAC streams (`<= 256kbps`) in `.mp4`/`.m4v`/`.mov`/`.mkv`.
  - `-hwaccel auto` for hardware encoders (`nvenc`/`amf`/`qsv`) with automatic single-retry software decode fallback.
  - `AbortSignal` + `shouldCancel` immediate `SIGKILL` cancellation and partial-file cleanup.
- **`src/hwEncoder.js`**: Single `ffmpeg -encoders` lookup + parallel 10-bit (`p010le` / `main10`) hardware probe caching (`detectAvailableEncoders` shares in-flight promises).
- **`src/utils.js`**: Shared validation, `parallelProcess` fixed-worker pool, `scanFilesAsync`, O(1) prefix-bucketed `findJsonSidecar` for Google Takeout exports, `getCaptureDate` (UTC-shifted local timestamps), `getRecommendedVideoConcurrency`, `getOptimalVideoThreads`, and `getWritableDataDir()`.
- **`src/logger.js`**: Non-blocking stream logger with 5MB startup rotation writing to `getWritableDataDir()/logs/mediasquash.log`.
- **`gui/`**: Vanilla HTML/CSS/JS ("Tactile Studio Workbench" design system). `renderer.js` batches SSE row updates with `requestAnimationFrame` and caches row DOM nodes in `rowElements`.

## Critical Invariants & Conventions

1. **`UV_THREADPOOL_SIZE` & `sharp.concurrency()`**: Set `UV_THREADPOOL_SIZE` before requiring `sharp`. Always call `configureSharpConcurrency(workerCount, coreBudget)` before running concurrent Sharp jobs so `workerCount × sharp.concurrency <= cpuCount`.
2. **Thread & GPU Budgeting**: Hardware encoders (`nvenc`/`amf`/`qsv`) cap video concurrency to `2–3` to respect consumer GPU session limits; software encoders (`x264`/`x265`) cap workers so each FFmpeg gets `>= 4` threads. Always pass `threads` to `compressVideo` for both software and hardware decode/filter stages.
3. **UTC-Shifted `captureDate` Objects**: `getCaptureDate()` stores local wall-clock time inside UTC slots (`toLocalAsUTC`). Always read components with `.getUTCFullYear()`, `.getUTCMonth()`, etc. (never `.getFullYear()` / `.getMonth()`).
4. **Electron `.asar` Paths**:
   - `ffmpeg-static` and `ffprobe-static` paths must replace `app.asar` with `app.asar.unpacked`.
   - Writable runtime files (`logs/`, `presets/`, `tmp_review/job-state.json`) must use `getWritableDataDir()` so packaged builds write to `%LOCALAPPDATA%/MediaSquash/` instead of the read-only `.asar` archive.
5. **`server.js` Export Contract**: `require('./server.js')` returns the `startServer()` `Promise` when imported by `main.js`. Keep this return shape intact.
6. **Preset JSON Schema**: Presets stored in `presets/*.json` use `{ imageFormat, quality, encoder, crf, recursive, flatten, renameOnly, categoryByYear, categoryByMonth }`. Keep this schema backward-compatible when editing UI controls.
7. **Security**: `server.js` binds to `127.0.0.1` by default because endpoints read/write local filesystem paths without auth. Never change the default bind host to `0.0.0.0`, and always escape dynamic filenames/errors with `escapeHtml()` in `gui/renderer.js`.
