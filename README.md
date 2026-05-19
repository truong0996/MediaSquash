# MediaSquash

A powerful Node.js tool for compressing images and videos with **GPU acceleration**. Available as a standalone **Electron Desktop App** or a **Web GUI**.

## ✨ Key Features

- **🖥️ Desktop App**: Standalone Electron application with native file dialogs and drag-and-drop
- **🎮 GPU Acceleration**: Automatic NVIDIA NVENC, AMD AMF, Intel QuickSync detection
- **🌐 Web GUI**: Modern interface accessible via browser at `http://localhost:3847`
- **⚡ Parallel Processing**: Smart concurrency tuned for images and videos
- **📁 Modern Formats**: WebP (default), AVIF, JPEG for images | H.264/H.265 for videos
- **📅 Smart Renaming**: Rename files by capture date (EXIF/metadata)
- **🔒 Metadata Preservation**: Keeps GPS location, dates, and EXIF data

## 📦 Installation

```bash
npm install
```

## 🚀 Usage

### Desktop App

**Development:**
```bash
npm start
```

**Build for Windows:**
```bash
npm run dist:win
```
Artifacts are output to the `dist/` folder.

### Web Interface

```bash
npm run gui
```
Open `http://localhost:3847` in your browser.

> **Note**: Native file dialogs and drag-and-drop for individual files require the Desktop App. The web interface supports folder path input and folder drag-and-drop.

### CLI

```bash
# Batch compress
node src/index.js all ./input -o ./output --recursive

# Single image
node src/index.js image input.jpg -o output.webp -q 88

# Single video
node src/index.js video input.mp4 -o output.mp4 -e x265 -c 22
```

## 🎛️ Supported Encoders

| Encoder | Type | Speed | Quality |
|---------|------|-------|---------|
| NVENC | NVIDIA GPU | ⚡⚡⚡ | Good |
| AMF | AMD GPU | ⚡⚡⚡ | Good |
| QuickSync | Intel GPU | ⚡⚡⚡ | Good |
| x264 | CPU | 🐢 | Better |
| x265 | CPU (HEVC) | 🐢🐢 | Best |

## 📁 Supported Formats

**Images**: JPEG, PNG, WebP, AVIF, TIFF, GIF, HEIC, HEIF  
**Videos**: MP4, MKV, AVI, MOV, WMV, FLV, WebM, 3GP, M4V, MPEG, MPG

**Output**: `.webp` (default), `.jpeg`, `.avif` for images | `.mp4` for videos

## 📜 License

MIT
