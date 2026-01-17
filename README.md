# Media Compressor

A powerful Node.js tool for compressing images and videos with **GPU acceleration**. Available as a standalone **Electron Desktop App** or a **Web GUI**. Features automatic hardware encoder detection, smart file renaming, and parallel processing optimized for your system.

## ✨ Key Features

- **🖥️ Desktop App**: Standalone Electron application with native file dialogs
- **🎮 GPU Acceleration**: NVIDIA NVENC, AMD AMF, Intel QuickSync support
- **🌐 Web GUI**: Modern dark-themed interface accessible via browser
- **⚡ Parallel Processing**: Smart concurrency tuned for images and videos
- **📁 Modern Formats**: Support for **WebP (default)** and **AVIF** for images, **H.265 (HEVC)** for videos
- **📅 Smart Renaming**: Rename files by capture date (EXIF/metadata)
- **📁 Flexible Output**: Flatten folders, organize by year, preserve structure
- **🔒 Metadata Preservation**: Keeps GPS location, dates, and EXIF data
- **📊 Detailed Reports**: Compression stats with time and size savings

## 🎯 Supported Hardware Encoders

| Encoder | Brand | Codec | Speed | Quality/Size |
|---------|-------|-------|-------|--------------|
| **NVENC** | NVIDIA GPU | h264_nvenc | ⚡⚡⚡ Fastest | Good |
| **AMF** | AMD GPU/APU | h264_amf | ⚡⚡⚡ Fast | Good |
| **QuickSync** | Intel CPU | h264_qsv | ⚡⚡⚡ Fast | Good |
| **x264** | CPU (Software) | libx264 | 🐢 Slow | **Better** |
| **x265** | CPU (Software) | libx265 | 🐢 Very Slow | **Best (HEVC)** |

> Smart detection automatically enables the best encoder for your hardware!

## 📦 Prerequisites

- **Node.js 18+** (required for Electron 28)
- **Windows 10/11** (for Desktop App builds)

## 📦 Installation

```bash
npm install
```

> FFmpeg and Sharp are bundled automatically - no manual installation required.

## 🚀 Usage

You can use Media Compressor either as a robust desktop application or via a web browser.

### Option 1: Desktop App (Recommended)

Run as a standalone native application with full system integration (files, GPU).

**Development:**
```bash
npm start
```

**Build for Windows:**
```bash
npm run dist
```
The executable will be in the `dist/win-unpacked` folder.

### Option 2: Web Interface

Run as a local web server and access it via your favorite browser.

```bash
npm run gui
```
Open `http://localhost:3847` in your browser.

> **Note**: Some desktop features like the native **Browse** dialog are exclusive to the Desktop App. In Web Interface mode, you will need to manually paste folder paths.

## 🎛️ Interface Features

- **Separated Settings**: Clear distinction between Image and Video settings
- **Smart Detection**: Automatically analyzes your hardware and selects the best encoder on startup
- **Format Toggle**: Choose between JPEG, WebP (default), or AVIF for images
- **Quality Sliders**: Precision control for Image Quality and Video CRF
- **Real-time Progress**: Visual file-by-file status and overall progress bar
- **Power Options**: Flatten output, rename only, organize by year folders

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
| `-e, --encoder <type>` | Encoder: `auto`, `nvenc`, `amf`, `qsv`, `x264`, `x265` |
| `--image-format <fmt>`| Target: `webp` (default), `jpeg`, `avif` |
| `--rename` | Rename files to capture date |
| `--rename-only` | Rename without compression |
| `-q, --quality <1-100>` | Image quality (default: 88, visually lossless) |
| `-c, --crf <0-51>` | Video quality (default: 22, YouTube-level) |
| `-p, --preset <preset>` | x264/x265 preset: `medium` (default), `fast`, `slow`, etc. |
| `--flatten` | Output all files to a single directory (no subfolders) |
| `--category-by-year` | Organize output into year-based folders (2023, 2024, etc.) |
| `-j, --jobs <number>` | Parallel jobs for images (default: auto-detected) |

### Single File Compression

```bash
# Image to WebP (Visually Lossless)
node src/index.js image input.jpg -o output.webp -q 88

# Video with HEVC (Smallest File)
node src/index.js video input.mp4 -o output.mp4 -e x265 -c 22
```

## 📁 Consistent Output Format

All files are normalized to standard formats for consistency:

| Input Format | Output Format | Priority |
|--------------|---------------|----------|
| `.jpg`, `.png`, `.heic`, etc. | `.webp` (default) | Better compression, universally supported |
| Any Image | `.jpeg`, `.avif` | Optional alternatives (see **Format Selection**) |
| `.mov`, `.avi`, `.mkv`, etc. | `.mp4` | Dual support for H.264 (AVC) and H.265 (HEVC) |

### 🛠️ Format Selection

- **In GUI**: Use the **Image Settings** radio buttons to switch between JPEG, WebP, and AVIF.
- **In CLI**: Use the `--image-format <format>` flag (e.g., `--image-format jpeg`).

| Format | When to use |
|--------|-------------|
| **WebP** | **Default.** Best for daily use—fast, tiny files, and works everywhere. |
| **JPEG** | Use if you need to view photos on very old TVs or legacy software. |
| **AVIF** | Use for your best photos to get the absolute smallest file size possible (slowest processing). |

### 📱 HEIC/HEIF Handling

iPhone HEIC photos are automatically converted to your **selected target format** (WebP, JPEG, or AVIF):

- **Primary**: Uses `heic-convert` library for high-quality native decoding.
- **Fallback**: Uses Sharp for variant or mislabeled HEIC files.
- **Robustness**: Corrupted or unsupported variants are copied as-is to ensure no data loss.

## 📅 Smart Renaming

Files are renamed based on capture date: `YYYYMMDD-HHMMSS.webp`

| Source | Priority |
|--------|----------|
| **Images** | EXIF DateTimeOriginal → File Modified Date |
| **Videos** | Metadata creation_time → File Modified Date |

- **Duplicate handling**: If multiple files have the same capture time, they are saved as `20210313-143211_1.webp`, `20210313-143211_2.webp`, etc.
- **No metadata**: Falls back to the file modified date for naming.

## 🎮 Hardware Acceleration Efficiency

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
- **Images**: `.webp` (default), `.jpeg`, or `.avif`
- **Videos**: `.mp4` (H.264 or H.265)

## 📊 Example Output

```
🗜️  Media Compressor GUI
   Server running at: http://localhost:3847

🔍 Detecting available hardware encoders...
  ✓ NVIDIA NVENC: Available
  ✓ AMD AMF: Available
  ✓ Intel QuickSync: Available
  ✓ Software x264: Always available
  ✓ Software x265 (HEVC): Always available

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
# GPU-accelerated H.264 with NVENC
node src/index.js all "./Photos" -o "./Compressed" -r -e nvenc

# Software H.265 (HEVC) for maximum storage savings
node src/index.js all "./Photos" -o "./Compressed" -r -e x265

# High-quality WebP images
node src/index.js all "./Memory" -o "./Sorted" -r --image-format webp -q 88

# Rename only (no compression)
node src/index.js all "./Backup" -o "./Renamed" -r --rename-only

# Ultra-high quality (visually lossless)
node src/index.js all "./Videos" -o "./Output" -r -c 18 -q 92
```

## 📜 License

MIT
