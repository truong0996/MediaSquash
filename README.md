# Media Compressor

A powerful Node.js tool for compressing images and videos with **GPU acceleration** and a modern **Web GUI**. Features automatic hardware encoder detection, smart file renaming, and parallel processing optimized for your system.

## ✨ Key Features

- **🎮 GPU Acceleration**: NVIDIA NVENC, AMD AMF, Intel QuickSync support
- **🖥️ Web GUI**: Modern dark-themed interface with real-time progress
- **⚡ Dynamic Parallelism**: Auto-scales based on CPU cores
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

## 📅 Smart Renaming

Files are renamed based on capture date: `YYYYMMDD-HHMMSS.ext`

| Source | Priority |
|--------|----------|
| **Images** | EXIF DateTimeOriginal → File Modified Date |
| **Videos** | Metadata creation_time → File Modified Date |

- **Duplicate handling**: `20210313-143211_1.jpg`, `20210313-143211_2.jpg`
- **No metadata**: Falls back to file modified date

## ⚡ Performance Optimization

### Dynamic Concurrency

Automatically scales based on your CPU:

| CPU Cores | Image Concurrency | Video Concurrency |
|-----------|-------------------|-------------------|
| 4 cores | 4 parallel | 1 parallel |
| 8 cores | 8 parallel | 2 parallel |
| 16 cores | 12 parallel | 4 parallel |

### GPU Encoding Benefits

- **10-20x faster** than CPU encoding
- **Near-zero CPU usage** (GPU handles encoding)
- **Same quality** as CPU at equivalent settings

## 📁 Supported Formats

### Images
JPEG, JPG, PNG, WebP, AVIF, TIFF, GIF, HEIC, HEIF

### Videos
MP4, MKV, AVI, MOV, WMV, FLV, WebM, 3GP, M4V, MPEG, MPG

## 📊 Example Output

```
🗜️  Media Compressor GUI
   Server running at: http://localhost:3847

🔍 Detecting available hardware encoders...
  ✓ NVIDIA NVENC: Available
  ✗ AMD AMF: Not available
  ✓ Intel QuickSync: Available
  ✓ Software x264: Always available

⚡ Dynamic concurrency: 8 images, 2 videos (8 CPU cores detected)
Processing 2694 images (8 concurrent) and 302 videos (2 concurrent)

📊 Summary Report
   Files processed:  2996/2996
   Time taken:       25m 30s
   Total original:   15.2 GB
   Total compressed: 6.8 GB
   Total saved:      8.4 GB (55% reduction)
```

## 🛠️ CLI Examples

```bash
# GPU-accelerated compression with NVENC
node src/index.js all "./Photos" -o "./Compressed" -r -e nvenc

# Organize by year with AMD encoder
node src/index.js all "./Memory" -o "./Sorted" -r -e amf --rename

# Rename only (no compression)
node src/index.js all "./Backup" -o "./Renamed" -r --rename-only

# High quality with Intel QuickSync
node src/index.js all "./Videos" -o "./Output" -r -e qsv -c 18
```

## 📜 License

MIT
