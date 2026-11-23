# MediaSquash

Fast, local-first image and video batch compressor with **GPU acceleration**, available as an **Electron Desktop App**, **Local Web GUI**, and **CLI**.

## Features

- **Desktop App & Web GUI**: Tactile Studio Workbench UI (`127.0.0.1:3847`) with drag-and-drop, presets, live output path preview, and light/dark themes
- **GPU Acceleration**: Automatic 10-bit HEVC detection for NVIDIA NVENC, AMD AMF, and Intel QuickSync, plus x264/x265 CPU fallbacks
- **Smart Concurrency & Optimization**:
  - Budgeted CPU/GPU worker pools with Largest-First video scheduling
  - Off-main-thread HEIC decoding (`worker_threads`) directly to WebP, AVIF, or JPEG
  - Lossless AAC audio stream copy (`-c:a copy`) when already compatible, and automatic hardware-decode fallback
- **Date Organization & Resume**: Capture-date renaming/grouping (EXIF, video metadata, and Google Takeout JSON sidecars) plus pause/resume and failed-file retry

## Installation

```bash
npm install
```

## Usage

### Desktop App

```bash
npm start
```

Build Windows portable & installer executables into `dist/`:

```bash
npm run dist:win
```

### Web GUI

```bash
npm run gui
```

Open `http://localhost:3847` in your browser. *(Native folder dialogs and individual file drag-and-drop require the Desktop App; the Web GUI supports folder paths and folder drops.)*

### CLI

```bash
# Batch compress images and videos
node src/index.js all ./input -o ./output --recursive

# Single image
node src/index.js image input.jpg -o output.webp -q 88

# Single video
node src/index.js video input.mp4 -o output.mp4 -e x265 -c 22
```

## Supported Formats & Encoders

- **Images**: JPEG, PNG, WebP, AVIF, TIFF, GIF, HEIC, HEIF → outputs `.webp` (default), `.jpeg`, or `.avif`
- **Videos**: MP4, MKV, AVI, MOV, WMV, FLV, WebM, 3GP, M4V, MPEG, MPG → outputs `.mp4`
- **Encoders**: `nvenc` (NVIDIA GPU), `amf` (AMD GPU), `qsv` (Intel iGPU), `x264` (CPU), `x265` (CPU HEVC)

## Testing & Developer Guide

```bash
npm run test:all
```

For architecture notes, concurrency invariants, and contributor conventions, see [CLAUDE.md](CLAUDE.md).

## License

MIT
