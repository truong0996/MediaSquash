# Media Compressor

A powerful Node.js tool for compressing images and videos with **GPU acceleration** and a modern **Web GUI**. Features automatic hardware encoder detection, smart file renaming, and parallel processing optimized for your system.

## ✨ Key Features

- **🎮 GPU Acceleration**: NVIDIA NVENC, AMD AMF, Intel QuickSync support
- **🖥️ Web GUI**: Modern dark-themed interface with real-time progress
- **⚡ Worker Pool Processing**: True parallel processing - slots never idle waiting
- **📁 Consistent Output**: All images → `.jpeg`, all videos → `.mp4`
- **📅 Smart Renaming**: Rename files by capture date (EXIF/metadata)
- **📁 Flexible Output**: Flatten folders, organize by year, preserve structure
- **🔒 Metadata Preservation**: Keeps GPS location, dates, and EXIF data
- **📊 Detailed Reports**: Compression stats with time and size savings

## 🎯 Supported Hardware Encoders

| Encoder | Brand | Codec | Speed |
|---------|-------|-------|-------|
| **NVENC** | NVIDIA GPU | h264_nvenc | ⚡⚡⚡ Fastest |
| **AMF** | AMD GPU/APU | h264_amf | ⚡⚡⚡ Fast |
| **QuickSync** | Intel CPU | h264_qsv | ⚡⚡⚡ Fast |
| **x264** | CPU (Software) | libx264 | ⚡ Slow |

> Auto-detection finds the best encoder for your system!

## 📦 Installation

```bash
npm install
```

## 🖥️ Web GUI (Recommended)

Launch the modern web interface:

```bash
npm run gui
```

This opens a browser at `http://localhost:3847` with:
- Folder selection with recursive scanning
- Encoder selection with availability badges
- Quality and CRF sliders
- Real-time progress updates
- Options: flatten output, rename only, organize by year

### GUI Options

| Option | Description |
|--------|-------------|
| **Include subfolders** | Scan directories recursively |
| **Flatten output** | All files in one folder (no subfolders) |
| **Rename only** | Copy files with date-based names (no compression) |
| **Category by year** | Organize output into year folders (2023, 2024...) |
| **File type filter** | Process images only, videos only, or all |

## 💻 CLI Usage

### Batch Compress (Recommended)

```bash
node src/index.js all ./input -o ./output --recursive --encoder auto
```

**Options:**
| Flag | Description |
|------|-------------|
| `-r, --recursive` | Search directories recursively |
| `-o, --output <dir>` | Output directory |
| `-e, --encoder <type>` | Encoder: `auto`, `nvenc`, `amf`, `qsv`, `cpu` |
| `--rename` | Rename files to capture date |
| `--rename-only` | Rename without compression |
| `-q, --quality <1-100>` | Image quality (default: 75) |
| `-c, --crf <0-51>` | Video quality (default: 23, lower = better) |
| `-p, --preset <preset>` | x264 preset: `ultrafast`, `veryfast`, etc. |

### Single File Compression

```bash
# Image
node src/index.js image input.jpg -o output.jpg -q 80

# Video with NVENC
node src/index.js video input.mp4 -o output.mp4 -e nvenc -c 23
```

## 📁 Consistent Output Format

All files are normalized to standard formats for consistency:

| Input Format | Output Format | Notes |
|--------------|---------------|-------|
| `.jpg`, `.png`, `.webp`, `.heic`, `.heif`, etc. | `.jpeg` | Universal compatibility |
| `.mov`, `.avi`, `.mkv`, `.mp4`, etc. | `.mp4` | Best streaming support |

### HEIC/HEIF Handling

iPhone HEIC photos are automatically converted to JPEG:
- Primary: `heic-convert` library for native HEIC decoding
- Fallback: Sharp for mislabeled or variant HEIC files
- Corrupted files are copied as-is (no failure)

## 📅 Smart Renaming

Files are renamed based on capture date: `YYYYMMDD-HHMMSS.jpeg`

| Source | Priority |
|--------|----------|
| **Images** | EXIF DateTimeOriginal → File Modified Date |
| **Videos** | Metadata creation_time → File Modified Date |

- **Duplicate handling (CLI)**: `20210313-143211(1).jpeg`, `20210313-143211(2).jpeg`
- **Duplicate handling (GUI)**: `20210313-143211_1.jpeg`, `20210313-143211_2.jpeg`
- **No metadata**: Falls back to file modified date

## ⚡ Performance Optimization

### Worker Pool Pattern

Unlike batch processing, our worker pool **immediately picks up the next item** when any slot finishes:

```
❌ Old: [Video1: 30min] [Video2: done, waiting...] [Video3: done, waiting...]
✅ New: [Video1: 30min] [Video2→Video5→Video8→...] [Video3→Video6→Video9→...]
```

**Result**: 2-3x faster for mixed file sizes!

### Dynamic Concurrency (GPU Encoding)

Automatically scales based on your CPU for GPU encoding (NVENC/QSV):

| CPU Threads | Image Workers | Video Workers | Threads/Video |
|-------------|---------------|---------------|---------------|
| 8 threads | 8 parallel | 4 parallel | 2 |
| 12 threads | 12 parallel | 6 parallel | 2 |
| 16 threads | 12 parallel | 6 parallel | 2 |

### GPU Encoding Benefits

- **10-20x faster** than CPU encoding
- **Near-zero CPU usage** (GPU handles encoding)
- **Same quality** as CPU at equivalent settings

## 📁 Supported Formats

### Images (Input)
JPEG, JPG, PNG, WebP, AVIF, TIFF, GIF, HEIC, HEIF

### Videos (Input)
MP4, MKV, AVI, MOV, WMV, FLV, WebM, 3GP, M4V, MPEG, MPG

### Output
- All images → `.jpeg`
- All videos → `.mp4`

## 📊 Example Output

```
🗜️  Media Compressor GUI
   Server running at: http://localhost:3847

🔍 Detecting available hardware encoders...
  ✓ NVIDIA NVENC: Available
  ✓ Intel QuickSync: Available
  ✓ Software x264: Always available

⚡ Dynamic concurrency: 12 images, 6 videos (16 CPU cores detected)
   Video threads per worker: 2 (GPU encoding, threads for decoding)

Processing 5569 images and 645 videos...

📊 Summary Report
   Files processed:  6214/6214
   Time taken:       18m 45s
   Total original:   25.2 GB
   Total compressed: 10.8 GB
   Total saved:      14.4 GB (57% reduction)
```

## 🛠️ CLI Examples

```bash
# GPU-accelerated compression with NVENC (NVIDIA)
node src/index.js all "./Photos" -o "./Compressed" -r -e nvenc

# AMD GPU compression with AMF
node src/index.js all "./Photos" -o "./Compressed" -r -e amf

# Organize by year with Intel QuickSync
node src/index.js all "./Memory" -o "./Sorted" -r -e qsv --rename

# Rename only (no compression)
node src/index.js all "./Backup" -o "./Renamed" -r --rename-only

# High quality encoding (lower CRF = better quality)
node src/index.js all "./Videos" -o "./Output" -r -e auto -c 18
```

## 📜 License

MIT
