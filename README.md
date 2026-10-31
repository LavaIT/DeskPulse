# DeskPulse

> A minimal always-on-top system monitor widget for the Windows desktop.
> Built with Electron · Transparent window · Frameless · System tray · Light / dark themes · English & 简体中文.

**English** | [简体中文](README.zh-CN.md)

---

## Features

- **Stays on top**: above the Start menu, notifications, fullscreen apps and UWP flyouts.
- **Transparent and frameless**: no window decorations, blends into the desktop.
- **Click-through**: clicks pass to the desktop by default; the drag strip and control areas temporarily disable click-through on hover, so the widget is movable without blocking your work.
- **Light / dark themes**: follows the system theme, and can be switched manually from the widget menu or the tray menu.
- **System tray**: show/hide, switch theme, reset position, settings, about and quit. Closing the window hides it to the tray instead of quitting the app.
- **Launch at login**: toggle in Settings, backed by Electron `app.setLoginItemSettings` (Windows registry).
- **Position memory**: the window position is debounced and saved after dragging, and restored on the next start; falls back to the top-right corner if it would be off-screen.
- **Compact mode**: a single-line mini panel (CPU / GPU / MEM / network) for gaming or fullscreen video. Toggle with the global shortcut `Ctrl+Alt+M`; the preference is saved automatically.
- **Color presets**: 5 built-in presets (Teal Blue / Ocean Blue / Emerald / Purple Gold / Minimal Gray) plus a custom color picker for the accent color.
- **Glass effects**: Off / Frosted / Liquid (Apple WWDC 2025 style with a cursor-following highlight and slight 3D tilt).
- **Panel opacity**: a slider for the background alpha (0–100%); automatically disabled in Liquid mode to protect the refraction effect.
- **Display mode**: memory and disks can be shown as percentages or exact values.
- **Threshold alerts**: CPU / MEM / GPU values turn red above the configured threshold (default 80%, adjustable).
- **Clock options**: 12/24-hour time, optional seconds, and 4 date formats (localized / ISO / US / dotted).
- **Font selection**: scans installed system fonts (localized names first) and renders every dropdown entry in its own typeface.
- **Show/hide metrics**: toggle each row in Settings; double-click a row to hide it quickly, with a toast explaining how to restore it.
- **Corner positioning**: move the widget to the top-left / top-right / bottom-left / bottom-right corner from the context or tray menu.
- **Quick launch**: open Task Manager or Resource Monitor directly from the tray menu.
- **Interface language**: English and Simplified Chinese, following the system language by default.

### Monitored metrics

| Metric | Details |
|---|---|
| Date & time | Local date, weekday and a live clock (12/24h, optional seconds, multiple formats) |
| System info | Windows version + kernel platform |
| Battery | Charge percentage + charging state (the row is hidden on desktops) |
| CPU | Live usage % + CPU model + optional per-core load bars |
| Memory | Used / total GB + optional memory type and speed |
| Storage | Used / total GB per drive + optional per-second read/write speed ↓↑ |
| Network | Live upload / download rate (the active physical adapter is selected automatically) |
| GPU | Vendor, model, total VRAM + optional live VRAM usage / total |
| Uptime | Time since boot (optional, off by default) |
| WiFi signal | Signal strength of the current WiFi connection (optional, off by default) |

---

## Screenshots

> _Screenshots coming soon._ When running, a 320 px wide card sits in the top-right corner of the primary display.

---

## Version history

| Version | Highlights |
|---|---|
| v1.0.0 | First release: 8 metrics, light/dark themes, system tray, position memory |
| v1.0.1 | 5 metrics collected in parallel (`Promise.all`), 3 s per-metric timeout, NET row ellipsis fix |
| v1.0.2 | Network speed accuracy fix, GPU query hang fix, settings window + about dialog, preference persistence, hardware cache |
| v1.0.3 | Layered refresh rates (disks/battery every 10 s), CPU model display, dynamic version in Settings, theme sync |
| v1.0.4 | Compact mode (single-line mini panel), live GPU usage, default menu bar removed from Settings |
| v1.0.5 | Sectioned settings (General / Appearance / Visible Items / Advanced), Frosted + Liquid glass, 5 color presets |
| v1.0.6 | Missing drives auto-hidden, battery row hidden on desktops, percent/value switch, optional WiFi + uptime, `Ctrl+Alt+M` shortcut, per-row visibility |
| v1.0.7 | Data depth: per-core CPU bars, disk read/write speed, live VRAM usage, memory spec (type and speed) — all optional |
| v1.0.8 | Clock options (12/24h, seconds, 4 date formats), threshold alerts, double-click to hide a row, corner positioning, custom accent color, tray shortcuts to Task Manager / Resource Monitor, panel opacity slider, system font picker |
| v1.1.0 | Full English localization (UI, tray/menus, settings, about, installer), language preference with system-language detection, bilingual README, `about.html` and `locales/` added to the package |

---

## Quick start

### Requirements

- Node.js **≥ 18** (LTS recommended)
- npm **≥ 9**

### Run in development

```bash
# 1. Install dependencies
npm install

# 2. Start the widget
npm start
```

The widget appears in the top-right corner of the primary display. Drag it by the top strip, or click `⋮` for the action menu.

---

## Building

The build produces an **NSIS installer** and a **portable single-file exe**, plus an unpacked directory for quick debugging. Everything is written to `build-output/`.

```bash
# Unpacked directory only (fastest, good for smoke testing)
npm run build:dir

# Full build: installer + portable
npm run build
```

Build artifacts:

```
build-output/
├── DeskPulse Setup 1.1.0.exe    # NSIS installer (custom install path, Start-menu shortcut)
├── DeskPulse 1.1.0.exe          # Portable single-file exe
└── win-unpacked/DeskPulse.exe   # Unpacked debug build
```

The installer ships English and Simplified Chinese UI and picks the system language automatically.

> Building reads `assets/icon.ico` (app / installer / shortcut icon) and `assets/tray.png` (transparent tray icon). If `tray.png` is missing, the main process falls back to a resized `icon.ico`.

### Mainland China network note

`.npmrc` pins the npm registry to `registry.npmmirror.com`. Before building, set these environment variables to speed up downloads of the Electron prebuilt binary and electron-builder helper binaries:

```powershell
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
$env:ELECTRON_CACHE = "$PWD\.cache\electron"
$env:ELECTRON_BUILDER_CACHE = "$PWD\.cache\electron-builder"
npm run build
```

---

## Tray menu

| Item | Action |
|---|---|
| Show / Hide widget | Toggle widget visibility |
| Toggle theme | Switch between light and dark |
| Compact mode | Switch between the full panel and the single-line mini panel |
| Move to → Top-left / Top-right / Bottom-left / Bottom-right | Move the window to a corner |
| Task Manager | Launch Windows Task Manager |
| Resource Monitor | Launch Windows Resource Monitor |
| Reset to top right | Move the window back to the default position |
| Settings... | Open the settings window |
| About | Version and copyright information |
| Quit DeskPulse | Close the window and exit the process |

**Left-clicking** the tray icon toggles the widget. Menu labels follow the selected interface language.

---

## Project structure

```
desk-pulse/
├── main.js            # Electron main process: windows, tray, IPC, position memory
├── renderer.js        # Renderer: systeminformation collection, themes, UI updates
├── i18n.js            # Shared localization module (main + renderers)
├── locales/
│   ├── zh-CN.json     # Simplified Chinese strings
│   └── en-US.json     # English strings
├── index.html         # Widget DOM
├── style.css          # Theme variables and layout (light/dark via CSS variables)
├── settings.html      # Settings window (General / Appearance / Visible Items / Advanced)
├── about.html         # About window
├── assets/
│   ├── icon.ico       # App / installer / shortcut icon (multi-size ICO, ≥ 256×256)
│   └── tray.png       # Transparent tray icon (≥ 64×64 recommended)
├── README.md          # English documentation
├── README.zh-CN.md    # Chinese documentation
├── .gitignore         # Ignores node_modules / .cache / build-output / userData
├── .npmrc             # Registry and mirror notes
├── package.json       # Metadata + build configuration
└── userData/          # Runtime data (window position, preferences, hardware cache; not in git)
```

---

## FAQ

### Why is there no CPU temperature?

Reading CPU DTS registers on Windows requires a kernel driver or administrator privileges (e.g. LibreHardwareMonitor). To keep the app lightweight, dependency-free and runnable as a regular user, CPU temperature was intentionally left out.

### Why doesn't the app exit when I close the window?

Closing the widget hides it to the system tray instead of quitting — the standard behavior for desktop widgets. **Left-click the tray icon** to show it again. To really exit, use the tray item “Quit DeskPulse”.

### How do I change the language?

Open Settings → General → Language and choose **System**, **中文** or **English**. Changes apply immediately to the widget, tray menu, Settings and About windows.

### How do I replace the icons?

- Replace `assets/icon.ico` with a multi-size `.ico` (16/32/48/64/128/256). It is used for the exe, shortcuts, installer and uninstaller.
- Replace `assets/tray.png` with a PNG that has an alpha channel; the main process scales it to 16×16 at the highest quality.

---

## License

MIT © Lava
