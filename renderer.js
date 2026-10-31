// renderer.js — renderer process
// Responsibilities: dark/light theme (follow system + manual toggle + menu trigger), date/time updates,
//       hardware data collection (CPU/temperature/GPU/memory/multi-disk storage/battery/network speed, refreshed every second),
//       adaptive window height, dynamic mouse pass-through switching, menu button.
// nodeIntegration is enabled in main.js, so Node modules can be required directly.

const { ipcRenderer, shell } = require('electron');
const os = require('os');
const fs = require('fs');
const si = require('systeminformation');

// ============================================================
// Preference read/write wrapper (replaces localStorage, persisted to userData/preferences.json)
// ============================================================
function getPref(key) {
  return ipcRenderer.sendSync('get-pref', key);
}
function setPref(key, value) {
  ipcRenderer.sendSync('set-pref', key, value);
}

// Read the hardware cache at startup (GPU name/VRAM, total memory, disk list — static info that never changes)
const hwCache = ipcRenderer.sendSync('get-hw-cache');

// UI language: resolved by the main process (manual preference or system locale)
const i18n = require('./i18n');
i18n.setLanguage(ipcRenderer.sendSync('get-language'));

// ============================================================
// 1. Theme system: follow system dark/light + manual toggle (persisted via the preferences file)
// Only modifies CSS variables via the data-theme attribute; no main-process involvement
// ============================================================
const THEME_KEY = 'theme';

// Create the theme toggle button dynamically (index.html untouched), inserted at the bottom-right of .widget
const toggleBtn = document.createElement('button');
toggleBtn.className = 'theme-toggle';
toggleBtn.setAttribute('aria-label', i18n.t('widget.themeAria'));
document.querySelector('.widget').appendChild(toggleBtn);

// Detect the system theme preference
const mql = window.matchMedia('(prefers-color-scheme: dark)');

function getSystemTheme() {
  return mql.matches ? 'dark' : 'light';
}

// Write the theme to <html data-theme="...">; CSS variables switch accordingly
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
}

function currentTheme() {
  return document.documentElement.getAttribute('data-theme') || getSystemTheme();
}

// Whether a manual preference exists ('dark'/'light' in the preferences file counts as a manual override)
function isManualOverride() {
  const v = getPref(THEME_KEY);
  return v === 'dark' || v === 'light';
}

// Sync the button icon and tooltip text (geometric glyphs ◐/●/○, not emoji, for a professional look)
function updateToggleUI() {
  const mode = currentTheme();
  const themeName = i18n.t(mode === 'dark' ? 'common.dark' : 'common.light');
  if (isManualOverride()) {
    // Manual mode: filled circle = dark / hollow circle = light
    toggleBtn.textContent = mode === 'dark' ? '●' : '○';
    toggleBtn.title = i18n.t('widget.themeManual', { theme: themeName });
  } else {
    // Follow system: a half circle indicates automatic
    toggleBtn.textContent = '◐';
    toggleBtn.title = i18n.t('widget.themeAuto', { theme: themeName });
  }
}

// Toggle the theme (used by both the button click and the menu)
function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  setPref(THEME_KEY, next);
  applyTheme(next);
  updateToggleUI();
}

// Init: prefer the stored preference, otherwise follow the system
(function initTheme() {
  const stored = getPref(THEME_KEY);
  const initial = isManualOverride() ? stored : getSystemTheme();
  applyTheme(initial);
  updateToggleUI();
})();

// Listen for system theme changes (live): follow only when there is no manual override
mql.addEventListener('change', (e) => {
  if (isManualOverride()) return; // User already set it manually; don't follow the system
  const t = e.matches ? 'dark' : 'light';
  applyTheme(t);
  updateToggleUI();
});

// Button click: manual toggle
toggleBtn.addEventListener('click', toggleTheme);

// Double-click: clear the manual preference and resume following the system
toggleBtn.addEventListener('dblclick', (e) => {
  e.preventDefault();
  setPref(THEME_KEY, null);
  applyTheme(getSystemTheme());
  updateToggleUI();
});

// Main-process menu "toggle theme" callback
ipcRenderer.on('toggle-theme', toggleTheme);

// Specific theme sent by the settings window (null = follow system / 'dark' / 'light')
ipcRenderer.on('apply-theme', (_e, theme) => {
  if (theme === null || theme === undefined) {
    // Clear the manual preference and follow the system
    setPref(THEME_KEY, null);
    applyTheme(getSystemTheme());
  } else {
    setPref(THEME_KEY, theme);
    applyTheme(theme);
  }
  updateToggleUI();
});

// ============================================================
// 1-1b. Glass effect: the data-glass attribute controls panel transparency and blur style
// ============================================================
const GLASS_KEY = 'glass';
let _liquidHL = null;  // Liquid glass highlight tracking state

function applyGlass(val) {
  const w = document.querySelector('.widget');
  if (val === 'off' || val === 'frost' || val === 'liquid') {
    w.setAttribute('data-glass', val);
  } else {
    w.setAttribute('data-glass', 'frost');
    val = 'frost';
  }
  if (val === 'liquid') {
    enableLiquidHighlight();
  } else {
    disableLiquidHighlight();
  }
}

// Liquid glass: cursor-following highlight + 3D perspective tilt
function enableLiquidHighlight() {
  if (_liquidHL) return;
  const widget = document.querySelector('.widget');
  if (!widget) return;

  const onMove = (e) => {
    const r = widget.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    // Radial highlight position
    widget.style.setProperty('--mx', x + 'px');
    widget.style.setProperty('--my', y + 'px');
    // 3D perspective tilt: leans slightly toward the cursor
    const rx = ((y / r.height) - 0.5) * -4;
    const ry = ((x / r.width) - 0.5) * 4;
    widget.style.transform = `perspective(800px) rotateX(${rx}deg) rotateY(${ry}deg)`;
  };

  const onLeave = () => {
    widget.style.transform = '';
  };

  widget.addEventListener('mousemove', onMove);
  widget.addEventListener('mouseleave', onLeave);
  _liquidHL = { widget, onMove, onLeave };
}

function disableLiquidHighlight() {
  if (!_liquidHL) return;
  const { widget, onMove, onLeave } = _liquidHL;
  widget.removeEventListener('mousemove', onMove);
  widget.removeEventListener('mouseleave', onLeave);
  widget.style.removeProperty('--mx');
  widget.style.removeProperty('--my');
  widget.style.transform = '';
  _liquidHL = null;
}

// Listen for glass-effect switches sent by the settings window
ipcRenderer.on('apply-glass', (_e, val) => {
  applyGlass(val);
  setPref(GLASS_KEY, val);
});

// Init: read from the preferences
(function initGlass() {
  const stored = getPref(GLASS_KEY);
  applyGlass(stored || 'frost');
})();

// ============================================================
// 1-1b-2. Panel opacity: the slider controls --panel-opacity (0-1)
// Affects only the panel background alpha in off / frost modes;
// liquid mode uses a hard-coded rgba background, so the slider has no effect (avoids breaking refraction).
// ============================================================
const PANEL_OPACITY_KEY = 'panelOpacity';

function applyPanelOpacity(val) {
  const n = Number(val);
  const clamped = (Number.isFinite(n) && n >= 0 && n <= 1) ? n : 1;
  document.documentElement.style.setProperty('--panel-opacity', String(clamped));
}

ipcRenderer.on('apply-panel-opacity', (_e, val) => {
  setPref(PANEL_OPACITY_KEY, val);
  applyPanelOpacity(val);
});

(function initPanelOpacity() {
  const stored = getPref(PANEL_OPACITY_KEY);
  applyPanelOpacity(stored);  // undefined → 1 (fully opaque by default)
})();

// ============================================================
// 1-1b-3. Font selection: the user can specify --font-family
// 'default' = restore the CSS default font stack; any other value is written to the CSS variable directly
// ============================================================
const FONT_FAMILY_KEY = 'fontFamily';

function applyFontFamily(val) {
  if (!val || val === 'default') {
    document.documentElement.style.removeProperty('--font-family');
    return;
  }
  document.documentElement.style.setProperty('--font-family', val);
}

ipcRenderer.on('apply-font-family', (_e, val) => {
  setPref(FONT_FAMILY_KEY, val);
  applyFontFamily(val);
});

(function initFontFamily() {
  const stored = getPref(FONT_FAMILY_KEY);
  applyFontFamily(stored);
})();

// ============================================================
// 1-1c. Color presets: html[data-preset] overrides --accent-color
// ============================================================
const PRESET_KEY = 'preset';
const VALID_PRESETS = ['qinglan', 'hailan', 'cuilv', 'zijin', 'jijian'];

function applyPreset(val) {
  if (!VALID_PRESETS.includes(val)) val = 'qinglan';
  document.documentElement.setAttribute('data-preset', val);
}

ipcRenderer.on('apply-preset', (_e, val) => {
  applyPreset(val);
  setPref(PRESET_KEY, val);
});

(function initPreset() {
  const stored = getPref(PRESET_KEY);
  applyPreset(stored || 'qinglan');
})();

// ============================================================
// 1-1c-2. Custom accent color: a color picker in addition to the 5 presets
// The picked color is written to --accent-color, overriding the preset
// ============================================================
const CUSTOM_ACCENT_KEY = 'customAccent';

function applyCustomAccent(color) {
  if (!color || typeof color !== 'string' || !/^#[0-9a-fA-F]{3,8}$/.test(color)) {
    // Clear the custom color and restore the preset
    document.documentElement.style.removeProperty('--accent-color');
    return;
  }
  document.documentElement.style.setProperty('--accent-color', color);
}

ipcRenderer.on('apply-custom-accent', (_e, color) => {
  setPref(CUSTOM_ACCENT_KEY, color || null);
  applyCustomAccent(color);
});

(function initCustomAccent() {
  const stored = getPref(CUSTOM_ACCENT_KEY);
  if (stored) applyCustomAccent(stored);
})();

// ============================================================
// 1-1d. Display mode: percentage / absolute value
// ============================================================
const DISPLAY_MODE_KEY = 'displayMode';
let _displayMode = 'percent'; // 'percent' | 'value'

function isValueMode() {
  return _displayMode === 'value';
}

function applyDisplayMode(val) {
  _displayMode = (val === 'value') ? 'value' : 'percent';
  // Re-render the existing data rows immediately (no re-collection, only the display text changes)
  const memEl = document.getElementById('mem');
  const memCompact = document.getElementById('mem-compact');
  const diskEl = document.getElementById('disklist');
  // CPU is always a percentage, so no re-render is needed
  // Trigger one memory and disk update to apply the new format (the data is still in memory, just re-render it)
  // Simple approach: mark it and let the next updateSlow/updateFast refresh naturally;
  // but for an immediate response, re-run these two functions directly
  updateMem();
  updateDisk();
}

ipcRenderer.on('apply-display-mode', (_e, val) => {
  applyDisplayMode(val);
  setPref(DISPLAY_MODE_KEY, val);
});

(function initDisplayMode() {
  const stored = getPref(DISPLAY_MODE_KEY);
  _displayMode = (stored === 'value') ? 'value' : 'percent';
})();

// ============================================================
// 1-1e. Optional metric toggles: system uptime / WiFi signal strength (off by default)
// ============================================================
let lastHeight = 0;  // Window height cache (must be initialized before resizeWindow's first call)
const SHOW_UPTIME_KEY = 'showUptime';
const SHOW_WIFI_KEY = 'showWifi';

function setUptimeVisible(on) {
  const el = document.getElementById('uptime');
  if (el) el.style.display = on ? '' : 'none';
  if (on) updateUptime();
  resizeWindow();
}

function setWifiVisible(on) {
  const el = document.getElementById('wifi');
  if (el) el.style.display = on ? '' : 'none';
  if (on) updateWifi();
  resizeWindow();
}

ipcRenderer.on('apply-show-uptime', (_e, on) => {
  setPref(SHOW_UPTIME_KEY, on);
  setUptimeVisible(on);
});
ipcRenderer.on('apply-show-wifi', (_e, on) => {
  setPref(SHOW_WIFI_KEY, on);
  setWifiVisible(on);
});

(function initOptionalMetrics() {
  setUptimeVisible(getPref(SHOW_UPTIME_KEY) === true);
  setWifiVisible(getPref(SHOW_WIFI_KEY) === true);
})();

// ============================================================
// 1-1f. Sparkline: small line charts of CPU/memory/network speed over the last 60 seconds
// Off by default, toggled in settings. When enabled, draws a 60×16 / 80×16 Canvas polyline next to the value
// ============================================================
const SPARK_KEY = 'sparkline';
const SPARK_MAX = 60;  // Ring buffer capacity (60 samples = 60 seconds)
const _sparkData = { cpu: [], mem: [], net: [] };

function _getSparkColor() {
  return getComputedStyle(document.documentElement).getPropertyValue('--accent-color').trim() || '#2c6e8a';
}

function _pushSpark(key, val) {
  const buf = _sparkData[key];
  buf.push(val);
  if (buf.length > SPARK_MAX) buf.shift();
}

function _drawSpark(canvasId, key, maxVal) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const buf = _sparkData[key];
  if (buf.length < 2) return;
  const color = _getSparkColor();
  const lo = Math.min(...buf);
  const hi = Math.max(...buf);
  const range = (hi - lo) || 1;
  const stepX = w / (SPARK_MAX - 1);
  // Polyline
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i < buf.length; i++) {
    const x = i * stepX;
    const y = h - ((buf[i] - lo) / range) * (h - 2) - 1;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  // Semi-transparent fill below
  ctx.lineTo((buf.length - 1) * stepX, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fillStyle = color + '22';
  ctx.fill();
}

function _drawAllSparks() {
  _drawSpark('spark-cpu', 'cpu', 100);
  _drawSpark('spark-mem', 'mem', 100);
  _drawSpark('spark-net', 'net', null);
}

function setSparklineVisible(on) {
  const ids = ['spark-cpu', 'spark-mem', 'spark-net'];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el) el.style.display = on ? 'inline-block' : 'none';
  }
  if (on) {
    _drawAllSparks();
  }
  resizeWindow();
}

ipcRenderer.on('apply-sparkline', (_e, on) => {
  setPref(SPARK_KEY, on);
  setSparklineVisible(on);
});

(function initSparkline() {
  setSparklineVisible(getPref(SPARK_KEY) === true);
})();

// ============================================================
// 1-1g-2. Enhanced data dimensions (all off by default)
//   1. CPU per-core load bars  — a row of small bars under the CPU row, one per logical core
//   2. Disk read/write speed   — DISK appends ↓12M/s ↑3M/s to each drive
//   3. GPU VRAM usage          — the GPU row shows current VRAM / total
//   4. Memory spec             — small text DDR4 3200MHz under the MEM row
// ============================================================
const SHOW_CPUCORES_KEY = 'showCpuCores';
const SHOW_DISKIO_KEY   = 'showDiskIO';
const SHOW_GPURAM_KEY   = 'showGpuRam';
const SHOW_MEMSPEC_KEY  = 'showMemSpec';

let _cpuCoresOn = false;  // Whether CPU per-core load bars are enabled
let _diskIOOn   = false;  // Whether disk read/write speed is enabled
let _gpuRamOn   = false;  // Whether GPU VRAM usage is enabled
let _memSpecOn  = false;  // Whether memory spec is enabled
let _coreBarsCreated = false;  // Whether the CPU core-bar DOM has been created (declared early to avoid TDZ)

function setCpuCoresVisible(on) {
  _cpuCoresOn = !!on;
  const el = document.getElementById('cpucores');
  if (el) el.style.display = _cpuCoresOn ? '' : 'none';
  // Reset the created flag: re-enabling after disabling requires regeneration
  _coreBarsCreated = false;
  if (_cpuCoresOn) safe(updateCPU, 3000);
  resizeWindow();
}

function setMemSpecVisible(on) {
  _memSpecOn = !!on;
  const el = document.getElementById('memspec');
  if (el) el.style.display = _memSpecOn ? '' : 'none';
  if (_memSpecOn) initMemSpec();
  resizeWindow();
}

function setGpuRamVisible(on) {
  _gpuRamOn = !!on;
  const el = document.getElementById('gpuram');
  if (el) el.style.display = _gpuRamOn ? '' : 'none';
  // Trigger one GPU collection immediately to fill in the VRAM field
  if (_gpuRamOn) safe(updateGPU, 3000);
  resizeWindow();
}

function setDiskIOVisible(on) {
  _diskIOOn = !!on;
  if (_diskIOOn) safe(updateDisk, 3500);
  resizeWindow();
}

ipcRenderer.on('apply-show-cpucores', (_e, on) => {
  setPref(SHOW_CPUCORES_KEY, on);
  setCpuCoresVisible(on);
});
ipcRenderer.on('apply-show-memspec', (_e, on) => {
  setPref(SHOW_MEMSPEC_KEY, on);
  setMemSpecVisible(on);
});
ipcRenderer.on('apply-show-gpuram', (_e, on) => {
  setPref(SHOW_GPURAM_KEY, on);
  setGpuRamVisible(on);
});
ipcRenderer.on('apply-show-diskio', (_e, on) => {
  setPref(SHOW_DISKIO_KEY, on);
  setDiskIOVisible(on);
});

(function initDataDims() {
  setCpuCoresVisible(getPref(SHOW_CPUCORES_KEY) === true);
  setMemSpecVisible(getPref(SHOW_MEMSPEC_KEY) === true);
  setGpuRamVisible(getPref(SHOW_GPURAM_KEY) === true);
  setDiskIOVisible(getPref(SHOW_DISKIO_KEY) === true);
})();

// ============================================================
// 1-1g. Metric visibility: users can hide unneeded rows in settings
// ============================================================
const VIS_METRICS = ['row-gpu', 'row-disk', 'row-net', 'cpumodel', 'row-power'];

function applyVisibility(metricId, hidden) {
  const el = document.getElementById(metricId) || document.querySelector('.' + metricId);
  if (el) el.style.display = hidden ? 'none' : '';
  resizeWindow();
}

function initVisibility() {
  for (const metricId of VIS_METRICS) {
    if (getPref('hidden.' + metricId) === true) {
      const el = document.getElementById(metricId) || document.querySelector('.' + metricId);
      if (el) el.style.display = 'none';
    }
  }
}

ipcRenderer.on('apply-visibility', (_e, metricId, hidden) => {
  applyVisibility(metricId, hidden);
});

initVisibility();

// ============================================================
// 1-1g-2. Quick-hide a metric row on double-click + Toast hint
// Double-click any row to hide it; restore it via Settings → Display items
// ============================================================

// Temporary toast: bottom-centered overlay, fades out after 3 seconds
let _toastTimer = null;
function _showToast(text) {
  let toast = document.getElementById('dp-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'dp-toast';
    toast.className = 'dp-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = text;
  toast.classList.add('show');
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => {
    toast.classList.remove('show');
  }, 2500);
}

// Row id → label-key mapping (for toast hints)
const ROW_LABEL_KEYS = {
  'row-gpu': 'toast.labels.gpu',
  'row-disk': 'toast.labels.disk',
  'row-net': 'toast.labels.net',
  'cpumodel': 'toast.labels.cpuModel',
  'row-power': 'toast.labels.power'
};

function _quickHide(metricId) {
  if (!VIS_METRICS.includes(metricId)) return;
  // Persist and broadcast via IPC, reusing the existing visibility system
  ipcRenderer.send('set-visibility', metricId, true);
  applyVisibility(metricId, true);  // Respond immediately, don't wait for the IPC round-trip
  const labelKey = ROW_LABEL_KEYS[metricId];
  const label = labelKey ? i18n.t(labelKey) : metricId;
  _showToast(i18n.t('toast.hidden', { label }));
}

(function initQuickHide() {
  // Add a dblclick listener to every hideable row
  VIS_METRICS.forEach(metricId => {
    const el = document.getElementById(metricId) || document.querySelector('.' + metricId);
    if (!el) return;
    el.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
      _quickHide(metricId);
    });
  });
})();

// ============================================================
// 1-2. Compact mode toggle: data-compact attribute + preference persistence
// ============================================================
const COMPACT_KEY = 'compact';
const COMPACT_WIDTH = 220;  // Compact-mode window width

function isCompact() {
  return document.querySelector('.widget').getAttribute('data-compact') === 'true';
}

function applyCompact(on) {
  const w = document.querySelector('.widget');
  w.setAttribute('data-compact', on ? 'true' : 'false');
  // Notify the main process to switch the window width + mouse pass-through policy (in compact mode the whole area is draggable and not click-through)
  ipcRenderer.send('set-compact', on, COMPACT_WIDTH);
  // Height is left to resizeWindow, which reads the accurate scrollHeight after DOM rendering
  resizeWindow();
}

// The main process triggers a compact-mode toggle
ipcRenderer.on('toggle-compact', () => {
  const next = !isCompact();
  setPref(COMPACT_KEY, next);
  applyCompact(next);
});

// The main process syncs the current compact state (for the settings window / tray menu checkmark)
ipcRenderer.on('set-compact-state', (_e, on) => {
  applyCompact(on);
});

// Init compact mode: read from the preferences
(function initCompact() {
  const stored = getPref(COMPACT_KEY);
  if (stored === true) {
    applyCompact(true);
  }
})();

// ============================================================
// 2. Menu button (⋮): triggers the context-style menu (toggle theme / reset position / quit)
// A button instead of a right-click, because the window body is click-through and the top is a drag zone, making right-click unreliable
// ============================================================
const menuBtn = document.createElement('button');
menuBtn.className = 'menu-btn';
menuBtn.setAttribute('aria-label', i18n.t('widget.menuAria'));
menuBtn.textContent = '⋮';
menuBtn.title = i18n.t('widget.menuTitle');
document.querySelector('.widget').appendChild(menuBtn);

menuBtn.addEventListener('click', () => ipcRenderer.send('show-context-menu'));
// Right-click also opens the menu in areas that receive events (buttons, drag zone)
document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  ipcRenderer.send('show-context-menu');
});

// ============================================================
// 3. Dynamic mouse pass-through switching
// The whole window is click-through by default (setIgnoreMouseEvents(true, {forward:true})),
// but pass-through is disabled temporarily when the cursor enters the top 50px drag zone or hovers over either button.
// ============================================================
// mousemove throttling: merge multiple mousemove events within the same frame via requestAnimationFrame,
// avoiding a getBoundingClientRect call per event during fast movement
let _mouseRAF = false;
let _mouseEvent = null;
document.addEventListener('mousemove', (e) => {
  _mouseEvent = e; // Keep the latest event
  if (_mouseRAF) return;
  _mouseRAF = true;
  requestAnimationFrame(() => {
    _mouseRAF = false;
    const e = _mouseEvent;
    if (!e) return;
    const inDragZone = e.clientY < 50;       // Within the top 50px
    // Pass-through must also be disabled over either button so clicks work
    let onButton = false;
    for (const el of [toggleBtn, menuBtn]) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 &&
          e.clientX >= r.left && e.clientX <= r.right &&
          e.clientY >= r.top && e.clientY <= r.bottom) {
        onButton = true;
        break;
      }
    }
    ipcRenderer.send('set-ignore-mouse', !(inDragZone || onButton)); // Any of these areas → no pass-through; otherwise → pass-through
  });
});

// ============================================================
// 4. Adaptive window height (content change → notify the main process)
// Notify the main process only when the height changes, avoiding per-second setSize jitter
// ============================================================
function resizeWindow() {
  const h = document.body.scrollHeight;
  if (h && h !== lastHeight) {
    lastHeight = h;
    ipcRenderer.send('resize', h);
  }
}
// ============================================================
// 4-2. Threshold alert coloring: CPU/MEM/GPU values turn red when above the threshold
// The threshold is adjustable in settings, default 80
// ============================================================
const ALERT_THRESHOLD_KEY = 'alertThreshold';
let _alertThreshold = 80;  // Default 80%

function _setAlert(el, pct) {
  if (!el) return;
  if (pct >= _alertThreshold && _alertThreshold > 0) {
    el.classList.add('alert');
  } else {
    el.classList.remove('alert');
  }
}

ipcRenderer.on('apply-alert-threshold', (_e, val) => {
  setPref(ALERT_THRESHOLD_KEY, val);
  const n = Number(val);
  _alertThreshold = (Number.isFinite(n) && n >= 0 && n <= 100) ? n : 80;
});

(function initAlertThreshold() {
  const v = getPref(ALERT_THRESHOLD_KEY);
  const n = Number(v);
  _alertThreshold = (Number.isFinite(n) && n >= 0 && n <= 100) ? n : 80;
})();

// ============================================================
// 5. Date/time (pure frontend, updates the DOM once per second)
// User-configurable: 12/24-hour clock, whether to show seconds, date format
// ============================================================
const CLOCK_HOUR_KEY = 'clockHour';       // '24' | '12', default '24'
const CLOCK_SECONDS_KEY = 'clockSeconds'; // bool, default true
const DATE_FMT_KEY = 'dateFormat';       // 'zh' | 'iso' | 'us' | 'dash', default 'zh'

let _clockHour = '24';
let _clockSeconds = true;
let _dateFormat = 'zh';

function applyClockFormat() {
  // Refresh immediately instead of waiting for the next second
  updateDateTime();
}

ipcRenderer.on('apply-clock-hour', (_e, val) => {
  setPref(CLOCK_HOUR_KEY, val);
  _clockHour = (val === '12') ? '12' : '24';
  applyClockFormat();
});
ipcRenderer.on('apply-clock-seconds', (_e, on) => {
  setPref(CLOCK_SECONDS_KEY, on);
  _clockSeconds = !!on;
  applyClockFormat();
});
ipcRenderer.on('apply-date-format', (_e, val) => {
  setPref(DATE_FMT_KEY, val);
  _dateFormat = ['zh', 'iso', 'us', 'dash'].includes(val) ? val : 'zh';
  applyClockFormat();
});

(function initClock() {
  const h = getPref(CLOCK_HOUR_KEY);
  _clockHour = (h === '12') ? '12' : '24';
  const s = getPref(CLOCK_SECONDS_KEY);
  _clockSeconds = (s === false) ? false : true;  // Default true
  const d = getPref(DATE_FMT_KEY);
  _dateFormat = ['zh', 'iso', 'us', 'dash'].includes(d) ? d : 'zh';
})();

function updateDateTime() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');

  // Locale-dependent date text (weekday / month names follow the UI language)
  const clockData = i18n.data().clock || {};
  const weekday = (clockData.weekdays || [])[now.getDay()] || '';
  const monthName = (clockData.months || [])[now.getMonth()] || m;

  // Date part
  let datePart;
  switch (_dateFormat) {
    case 'iso':  datePart = `${y}-${m}-${d}`; break;
    case 'us':   datePart = `${m}/${d}/${y}`; break;
    case 'dash': datePart = i18n.t('clock.dateDotted', { y, m, d, weekday }); break;
    case 'zh':
    default:     datePart = i18n.t('clock.dateLong', { y, m, d, weekday, month: monthName }); break;
  }

  // Time part: 12/24-hour clock + optional seconds
  let hh, suffix = '';
  if (_clockHour === '12') {
    hh = now.getHours() % 12;
    if (hh === 0) hh = 12;
    suffix = now.getHours() < 12 ? ' AM' : ' PM';
  } else {
    hh = now.getHours();
  }
  hh = String(hh).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  let timePart = `${hh}:${mm}`;
  if (_clockSeconds) {
    const ss = String(now.getSeconds()).padStart(2, '0');
    timePart += `:${ss}`;
  }
  timePart += suffix;

  document.getElementById('datetime').textContent = `${datePart} ${timePart}`;
}
updateDateTime();
setInterval(updateDateTime, 1000);

// System uptime, formatted as: 3d 12h 5m
function updateUptime() {
  const el = document.getElementById('uptime');
  if (!el || el.style.display === 'none') return;
  const secs = os.uptime();
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  let text;
  if (d > 0) text = i18n.t('clock.uptimeDays', { d, h, m });
  else if (h > 0) text = i18n.t('clock.uptimeHours', { h, m });
  else text = i18n.t('clock.uptimeMinutes', { m });
  el.textContent = text;
}
setInterval(updateUptime, 60000); // Refresh every minute

// ============================================================
// 6. OS name
// Windows: os.release() looks like "10.0.22000"; build >= 22000 means Windows 11
// ============================================================
function getOSName() {
  const platform = process.platform;
  if (platform === 'win32') {
    const release = os.release(); // e.g. "10.0.22631"
    const parts = release.split('.');
    const build = parts.length >= 3 ? parseInt(parts[2], 10) : 0;
    return build >= 22000 ? 'Windows 11' : 'Windows 10';
  }
  if (platform === 'darwin') return 'macOS';
  return 'Linux';
}
document.getElementById('osname').textContent = getOSName();

// ============================================================
// 7. Network speed: NIC whitelist filtering + utility functions
// Performance: interface detection (WMI query) moved out of the per-second hot path and refreshed in the background every 60s.
// The hot path only calls si.networkStats() (pure counter reads, no WMI) and filters by the cached interface name.
// ============================================================
let prevNet = { rx: 0, tx: 0, ts: 0 };
const GB = 1024 * 1024 * 1024;

// Keyword blacklist for virtual/loopback/dedicated interfaces (excluded if either iface or ifaceName matches)
const VIRTUAL_KEYWORDS = [
  'loopback', 'vmware', 'virtualbox', 'vbox', 'hyper-v', 'hyperv', 'vethernet',
  '(wsl)', 'wsl', 'docker', 'npcap', 'wan miniport', 'microsoft km-test',
  'tap-windows', 'tap-tor', 'bluetooth', 'btpan', 'mobile hotspot',
  'local area connection*', 'isatap', 'teredo tunneling', '6to4 adapter',
  'remote NDIS', 'wi-fi direct', 'microsoft wi-fi direct virtual',
  'pseudo-interface'
];
function isVirtualName(s) {
  if (!s) return false;
  const l = String(s).toLowerCase();
  return VIRTUAL_KEYWORDS.some(k => l.includes(k.toLowerCase()));
}

// Cache the active interface name (refreshed in the background, no WMI in the per-second hot path)
let _activeIface = null;

async function refreshActiveIface() {
  try {
    const [gw, ifaces] = await Promise.all([
      si.networkGatewayDefault().catch(() => null),
      si.networkInterfaces().catch(() => [])
    ]);
    // 1) The default gateway IP and an interface IP share the same subnet → that's the one
    if (typeof gw === 'string' && gw) {
      const gwParts = gw.split('.').map(Number);
      const gwValid = gwParts.length === 4 && gwParts.every(n => Number.isInteger(n) && n >= 0 && n < 256);
      if (gwValid) {
        for (const n of ifaces || []) {
          if (!n.ip4) continue;
          const ip = n.ip4.split('.').map(Number);
          if (ip.length === 4 && ip[0] === gwParts[0] && ip[1] === gwParts[1] && ip[2] === gwParts[2]) {
            _activeIface = n.iface;
            return;
          }
        }
      }
    }
    // 2) Fallback: the first non-virtual, up interface that has an ip4 and is not loopback
    for (const n of ifaces || []) {
      if (!n.virtual && !isVirtualName(n.iface) && !isVirtualName(n.ifaceName) &&
          (n.operstate === 'up' || n.operstate === 'unknown') &&
          n.ip4 && n.ip4 !== '127.0.0.1') {
        _activeIface = n.iface;
        return;
      }
    }
  } catch (e) { /* Fail silently; retry on the next refresh */ }
}

// Detect once at startup, then refresh in the background every 60s (keeps up with VPN switches / reconnects)
refreshActiveIface();
setInterval(refreshActiveIface, 60000);

// Format bytes/sec as B/s, KB/s or MB/s
function formatSpeed(bytesPerSec) {
  if (bytesPerSec < 1024) {
    return `${bytesPerSec.toFixed(0)} B/s`;
  }
  if (bytesPerSec < 1024 * 1024) {
    return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  }
  return `${(bytesPerSec / (1024 * 1024)).toFixed(2)} MB/s`;
}

// Format minutes as "1h12m" or "45m"
function formatDuration(minutes) {
  if (minutes <= 0) return '';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h > 0) return `${h}h${m}m`;
  return `${m}m`;
}

// Flag whether hwCache has changed; written to the file once after collection finishes
// Declared early so static functions like initCPUModel / initGPU can set it
let _hwCacheDirty = false;

// ============================================================
// 8. Static CPU model (fetched once at load via synchronous os.cpus(), no WMI)
// ============================================================
function initCPUModel() {
  const el = document.getElementById('cpumodel');

  // Cache hit → render directly
  if (hwCache.cpuModel) {
    el.textContent = hwCache.cpuModel;
    el.title = hwCache.cpuModel;
    return;
  }

  // os.cpus() is synchronous and does not use WMI, so read it directly
  try {
    const cpus = os.cpus();
    if (cpus && cpus.length > 0 && cpus[0].model) {
      // Strip redundant markers: Intel(R) Core(TM) i7-9700K CPU @ 3.60GHz → Intel Core i7-9700K @ 3.60GHz
      const model = cpus[0].model
        .replace(/\(R\)/g, '')
        .replace(/\(TM\)/g, '')
        .replace(/\s+CPU\s/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      el.textContent = model;
      el.title = model;
      hwCache.cpuModel = model;
      _hwCacheDirty = true;
      return;
    }
  } catch (e) { /* Fail silently */ }

  el.textContent = '—';
}
initCPUModel();

// ============================================================
// 8-1b. Static memory spec (DDR4 3200MHz) — fetched once at load and cached in hwCache
// ============================================================
function initMemSpec() {
  const el = document.getElementById('memspec');
  if (!el || !_memSpecOn) return;

  // 1) Cache hit → render directly
  if (hwCache.memSpec) {
    el.textContent = hwCache.memSpec;
    el.title = hwCache.memSpec;
    return;
  }

  // 2) Cache miss → async si.memLayout() query (with a 3s timeout)
  (async () => {
    try {
      const layout = await Promise.race([
        si.memLayout(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000))
      ]);
      if (layout && layout.length > 0) {
        // Take the first DIMM when several exist; clockSpeed is in MHz
        const m = layout[0];
        const type = (m.type && String(m.type).toUpperCase()) || '';
        const clock = (typeof m.clockSpeed === 'number' && m.clockSpeed > 0)
          ? Math.round(m.clockSpeed)
          : (typeof m.maxSpeed === 'number' && m.maxSpeed > 0)
            ? Math.round(m.maxSpeed)
            : 0;
        let text = '';
        if (type && clock) text = `${type} ${clock}MHz`;
        else if (type) text = type;
        else if (clock) text = `${clock}MHz`;
        if (text) {
          el.textContent = text;
          el.title = text;
          hwCache.memSpec = text;
          _hwCacheDirty = true;
          return;
        }
      }
      el.textContent = '—';
    } catch (e) {
      el.textContent = '—';
    }
  })();
}

// ============================================================
// 8-2. Static GPU info (fetched once at load; name/VRAM never change)
// Performance: cache hit → render directly, skipping si.graphics() (WMI queries are too slow)
//            cache miss → try PowerShell Win32_VideoController first (fast), then fall back to si.graphics()
// ============================================================
const { exec } = require('child_process');

function execCmd(cmd, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: timeoutMs, encoding: 'utf8' }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

async function initGPU() {
  const el = document.getElementById('gpu');

  // 1) Cache hit → render directly, no query (the GPU model never changes)
  if (hwCache.gpu && hwCache.gpu.model) {
    const parts = [hwCache.gpu.model];
    if (hwCache.gpu.vram) parts.push(`${hwCache.gpu.vram}GB`);
    const text = parts.join(' · ');
    el.textContent = text;
    el.title = text;
    return; // Skip si.graphics() to avoid minutes-long hangs
  }

  // 2) Cache miss → query via PowerShell WMI first (10x faster than si.graphics)
  try {
    const out = await execCmd(
      'powershell -NoProfile -Command "Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json"',
      4000
    );
    const data = JSON.parse(out.trim());
    const ctrl = Array.isArray(data) ? data[0] : data;
    if (ctrl && ctrl.Name) {
      const cleanModel = String(ctrl.Name).replace(/\s+/g, ' ').trim();
      let vramGB = null;
      // AdapterRAM is in bytes, but the Win32 32-bit field caps at 4GB
      if (ctrl.AdapterRAM && ctrl.AdapterRAM > 0) {
        vramGB = Math.round(ctrl.AdapterRAM / (1024 * 1024 * 1024));
        if (vramGB > 4) vramGB = 4; // 32-bit overflow guard
      }
      const parts = [cleanModel];
      if (vramGB && vramGB > 0) parts.push(`${vramGB}GB`);
      const text = parts.join(' · ');
      el.textContent = text;
      el.title = text;
      hwCache.gpu = { model: cleanModel, vram: vramGB };
      ipcRenderer.sendSync('set-hw-cache', hwCache);
      return;
    }
  } catch (e) { /* PowerShell failed; continue with the fallback */ }

  // 3) Fallback: si.graphics() with a 3s timeout (last resort)
  try {
    const g = await Promise.race([
      si.graphics(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000))
    ]);
    const ctrl = (g.controllers && g.controllers[0]) || null;
    const model = ctrl && (ctrl.name || ctrl.model || (ctrl.vendor && i18n.t('gpu.vendorPrefix', { vendor: ctrl.vendor })));
    if (model) {
      const cleanModel = model.replace(/\s+/g, ' ').trim();
      let vramGB = null;
      if (ctrl && typeof ctrl.vram === 'number' && ctrl.vram > 0) {
        vramGB = Math.round((ctrl.vram > 128) ? ctrl.vram / 1024 : ctrl.vram);
      }
      const parts = [cleanModel];
      if (vramGB) parts.push(`${vramGB}GB`);
      const text = parts.join(' · ');
      el.textContent = text;
      el.title = text;
      hwCache.gpu = { model: cleanModel, vram: vramGB };
      ipcRenderer.sendSync('set-hw-cache', hwCache);
      return;
    }
  } catch (e) { /* Timeout: keep '—' */ }

  el.textContent = '—';
}
initGPU();

// ============================================================
// 9. Per-metric collection (each metric has its own try/catch and they don't affect each other)
// ============================================================
async function safe(fn, timeoutMs = 3000) {
  try {
    await Promise.race([
      fn(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs))
    ]);
  } catch (e) { /* A single metric failing/timing out does not affect the others */ }
}

async function updateCPU() {
  const load = await si.currentLoad();
  const pct = `${Math.round(load.currentLoad)}%`;
  document.getElementById('cpu').textContent = pct;
  // Compact mode sync
  const compact = document.getElementById('cpu-compact');
  if (compact) compact.textContent = pct;
  // Threshold coloring
  _setAlert(document.getElementById('cpu'), load.currentLoad);
  _setAlert(compact, load.currentLoad);
  // Sparkline data collection
  _pushSpark('cpu', load.currentLoad);
  _drawSpark('spark-cpu', 'cpu', 100);
  // Per-core load bars
  updateCPUCores(load);
}

// CPU per-core load bars: uses the si.currentLoad().cpus[] array
function updateCPUCores(load) {
  if (!_cpuCoresOn) return;  // Skip when the toggle is off
  const container = document.getElementById('cpucores');
  if (!container) return;
  const cpus = load.cpus;
  if (!cpus || !cpus.length) return;
  // Create the DOM on first run
  if (!_coreBarsCreated) {
    container.innerHTML = cpus.map(() =>
      '<div class="core-bar"><div class="core-bar-fill" style="width:0%"></div></div>'
    ).join('');
    _coreBarsCreated = true;
  }
  // Update each bar's width
  const fills = container.querySelectorAll('.core-bar-fill');
  for (let i = 0; i < cpus.length && i < fills.length; i++) {
    const v = Math.max(0, Math.min(100, cpus[i].load));
    fills[i].style.width = v.toFixed(0) + '%';
  }
}

async function updateMem() {
  const mem = await si.mem();
  const pct = (mem.active / mem.total) * 100;
  const pctText = `${pct.toFixed(0)}%`;
  const valText = `${(mem.active / GB).toFixed(1)}/${(mem.total / GB).toFixed(1)} GB`;
  // Percent mode: 38%; value mode: 3.2/8.0 GB
  document.getElementById('mem').textContent = isValueMode() ? valText : pctText;
  // Compact mode writes only the percentage
  const compact = document.getElementById('mem-compact');
  if (compact) compact.textContent = pctText;
  // Threshold coloring
  _setAlert(document.getElementById('mem'), pct);
  _setAlert(compact, pct);
  // Sparkline data collection
  _pushSpark('mem', pct);
  _drawSpark('spark-mem', 'mem', 100);
  // Cache total memory (a static value, so it can render instantly on the next launch)
  if (hwCache.memTotal !== mem.total) {
    hwCache.memTotal = mem.total;
    _hwCacheDirty = true;
  }
}

async function updateDisk() {
  // In parallel: fsSize (capacity) + optional disk IO speed (WMI)
  const [raw, ioMap] = await Promise.all([
    si.fsSize(),
    _diskIOOn ? _readDiskIOSpeeds() : Promise.resolve({})
  ]);
  // Keep only drives with real storage (filters out size=0 entries such as empty optical drives, card readers without media, and invalid drive letters)
  const list = (raw || []).filter(f => f && f.size > 0);
  const el = document.getElementById('disklist');
  if (!list.length) {
    // si.fsSize failed temporarily; fall back to the cached disk list to show total capacity
    if (hwCache.disks && hwCache.disks.length) {
      el.innerHTML = hwCache.disks.map(d => {
        const m = d.mount.length > 8 ? d.mount.slice(0, 8) + '…' : d.mount;
        return `<div class="disk-item"><span class="m">${m}</span><span class="v">— / ${(d.size / GB).toFixed(0)}GB</span></div>`;
      }).join('');
    } else {
      el.innerHTML = '<div class="disk-item"><span class="m">—</span></div>';
    }
    return;
  }
  // Cache static disk info (mount + size are fixed; only available changes)
  const newDisks = list.map(f => ({ mount: f.mount || f.fs || '?', size: f.size }));
  const cacheChanged = !hwCache.disks ||
    hwCache.disks.length !== newDisks.length ||
    newDisks.some((d, i) => d.mount !== hwCache.disks[i].mount || d.size !== hwCache.disks[i].size);
  if (cacheChanged) {
    hwCache.disks = newDisks;
    _hwCacheDirty = true;
  }
  el.innerHTML = list.map(f => {
    const used = f.size - f.available;
    const pct = f.size > 0 ? (used / f.size) * 100 : 0;
    // Drive letter / mount point (Windows: "C:", macOS/Linux: "/")
    const mount = f.mount || f.fs || '?';
    const m = mount.length > 8 ? mount.slice(0, 8) + '…' : mount;
    // Percent mode: 45%; value mode: 230/512 GB
    const v = isValueMode()
      ? `${(used / GB).toFixed(0)}/${(f.size / GB).toFixed(0)} GB`
      : `${pct.toFixed(0)}%`;
    // Append disk IO speed: ↓12M/s ↑3M/s
    let ioText = '';
    if (_diskIOOn && ioMap && ioMap[mount]) {
      const io = ioMap[mount];
      ioText = `  ↓${_fmtDiskSpeed(io.read)} ↑${_fmtDiskSpeed(io.write)}`;
    }
    return `<div class="disk-item"><span class="m">${m}</span><span class="v">${v}${ioText}</span></div>`;
  }).join('');
}

// Disk read/write speed query: PowerShell WMI PerfDisk
// Name looks like "0 C:" or "_Total"; a regex extracts the drive letter (e.g. "C:")
async function _readDiskIOSpeeds() {
  try {
    const out = await execCmd(
      'powershell -NoProfile -Command "Get-CimInstance Win32_PerfFormattedData_PerfDisk_PerfDisk | Where-Object { $_.Name -ne \'_Total\' } | Select-Object Name, DiskReadBytesPerSec, DiskWriteBytesPerSec | ConvertTo-Json"',
      2500
    );
    const data = JSON.parse(out.trim());
    const list = Array.isArray(data) ? data : [data];
    const map = {};
    for (const item of list) {
      if (!item || !item.Name) continue;
      const m = String(item.Name).match(/([A-Z]:)/);
      if (!m) continue;
      const drive = m[1];  // "C:"
      map[drive] = {
        read:  Number(item.DiskReadBytesPerSec)  || 0,
        write: Number(item.DiskWriteBytesPerSec) || 0
      };
    }
    return map;
  } catch (e) { return {}; }
}

// Format disk read/write speed: B/s → K/s or M/s (compact display to save width)
function _fmtDiskSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec < 1024) return '0K/s';
  if (bytesPerSec < 1024 * 1024) return (bytesPerSec / 1024).toFixed(0) + 'K/s';
  return (bytesPerSec / (1024 * 1024)).toFixed(0) + 'M/s';
}

async function updateBattery() {
  const bat = await si.battery();
  const row = document.getElementById('row-power');
  if (!row) return;  // Row missing or manually hidden by the user; skip
  const el = document.getElementById('battery');
  if (bat.hasBattery && bat.hasBattery === true) {
    // Show only when not manually hidden by the user
    if (getPref('hidden.row-power') !== true) row.style.display = '';
    const parts = [`${bat.percent}%`];
    if (bat.isCharging) parts.push(i18n.t('status.charging'));
    const tr = bat.timeRemaining;
    const dur = formatDuration(tr);
    if (dur) parts.push(i18n.t('status.approx', { dur }));
    el.textContent = parts.join(' · ');
  } else {
    row.style.display = 'none';
  }
}

async function updateNet() {
  const rawStats = await si.networkStats();
  // Capture the timestamp right after reading the data, excluding later filtering time so dt stays precise
  const nowTs = Date.now();

  // Filter by the cached active interface name (pure in-memory comparison, no WMI)
  let net;
  if (_activeIface) {
    net = rawStats.filter(n => n.iface === _activeIface);
  }
  if (!net || !net.length) {
    // Fallback: operstate up + a non-virtual name
    net = rawStats.filter(n => n.operstate === 'up' && !isVirtualName(n.iface));
  }
  if (!net.length) net = rawStats; // Final fallback

  const totalRx = net.reduce((s, n) => s + (n.rx_bytes || 0), 0);
  const totalTx = net.reduce((s, n) => s + (n.tx_bytes || 0), 0);

  let rxSpeed = 0;
  let txSpeed = 0;
  if (prevNet.ts > 0) {
    const dt = (nowTs - prevNet.ts) / 1000;
    if (dt > 0.1) { // Guard against divide-by-zero from a too-small dt (skip when <100ms)
      rxSpeed = totalRx >= prevNet.rx ? (totalRx - prevNet.rx) / dt : 0;
      txSpeed = totalTx >= prevNet.tx ? (totalTx - prevNet.tx) / dt : 0;
    }
  }
  prevNet = { rx: totalRx, tx: totalTx, ts: nowTs };

  const rxText = `↓ ${formatSpeed(rxSpeed)}`;
  const txText = `↑ ${formatSpeed(txSpeed)}`;
  document.getElementById('netdown').textContent = rxText;
  document.getElementById('netup').textContent = txText;
  // Sparkline data collection (rx+tx combined, bytes/s → KB/s for easier visualization)
  _pushSpark('net', (rxSpeed + txSpeed) / 1024);
  _drawSpark('spark-net', 'net', null);
  // Compact mode sync
  const dc = document.getElementById('netdown-compact');
  const uc = document.getElementById('netup-compact');
  if (dc) dc.textContent = rxText;
  if (uc) uc.textContent = txText;
}

// WiFi signal strength: signalQuality (0-100) of the current connection via si.wifiConnections()
// Hidden when not on WiFi or when the query fails
async function updateWifi() {
  const el = document.getElementById('wifi');
  if (!el || el.style.display === 'none') return;
  try {
    const conns = await Promise.race([
      si.wifiConnections(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000))
    ]);
    if (conns && conns.length > 0) {
      const c = conns[0];
      const signal = typeof c.signalQuality === 'number' ? c.signalQuality : null;
      const ssid = c.ssid || c.bssid || '';
      if (signal !== null) {
        el.textContent = `${ssid ? ssid + ' ' : ''}${signal}%`;
        el.style.display = '';
        return;
      }
    }
    // Not connected to WiFi: hide
    el.style.display = 'none';
  } catch (e) {
    el.style.display = 'none';
  }
}

// GPU real-time utilization + optional VRAM usage: PowerShell Win32_PerfFormattedData_GPUAdapter (Windows only)
// Readable without admin rights; shows "—" on failure without affecting other metrics
async function updateGPU() {
  let usageText = '—';
  let vramText = '';
  try {
    const out = await execCmd(
      'powershell -NoProfile -Command "Get-CimInstance Win32_PerfFormattedData_GPUAdapter_GPUAdapter | Select-Object Name, UtilizationPercentage, DedicatedUsageBytes | ConvertTo-Json"',
      3000
    );
    const data = JSON.parse(out.trim());
    const list = Array.isArray(data) ? data : [data];
    let bestUtil = 0;
    let bestUsedBytes = 0;
    for (const item of list) {
      if (!item) continue;
      const util = Number(item.UtilizationPercentage);
      if (!Number.isFinite(util)) continue;
      if (util > bestUtil) {
        bestUtil = util;
        bestUsedBytes = Number(item.DedicatedUsageBytes) || 0;
      }
    }
    if (bestUtil > 0) usageText = `${Math.round(bestUtil)}%`;
    // VRAM usage: 3.2G / 8G (total comes from hwCache.gpu.vram, in GB)
    if (_gpuRamOn && bestUsedBytes > 0) {
      const usedGB = bestUsedBytes / (1024 * 1024 * 1024);
      const totalGB = (hwCache.gpu && hwCache.gpu.vram) ? hwCache.gpu.vram : null;
      vramText = totalGB
        ? `${usedGB.toFixed(1)}G / ${totalGB}G`
        : `${usedGB.toFixed(1)}G`;
    }
  } catch (e) { /* Keep — if unavailable */ }
  const gpuEl = document.getElementById('gpu-compact');
  if (gpuEl) gpuEl.textContent = usageText;
  // Threshold coloring (compact-mode GPU utilization)
  _setAlert(gpuEl, bestUtil);
  const vramEl = document.getElementById('gpuram');
  if (vramEl && _gpuRamOn) {
    vramEl.textContent = vramText || '—';
  }
}

// Fast metrics (CPU/memory/network) collected in parallel with an independent 3s timeout each, refreshed every second
// _updating guard: prevents setInterval from starting a new round before the previous one finishes (slow WMI queues make dt approach zero)
let _updating = false;
async function updateFast() {
  if (_updating) return;
  _updating = true;
  try {
    await Promise.all([
      safe(updateCPU, 3000),
      safe(updateMem, 3000),
      safe(updateNet, 3500)
    ]);
    if (_hwCacheDirty) {
      _hwCacheDirty = false;
      ipcRenderer.sendSync('set-hw-cache', hwCache);
    }
    resizeWindow();
  } finally {
    _updating = false;
  }
}

// Slow metrics (disk/battery/WiFi) collected in parallel, refreshed every 10s (they change slowly; reduces WMI overhead)
async function updateSlow() {
  await Promise.all([
    safe(updateDisk, 3000),
    safe(updateBattery, 3000),
    safe(updateWifi, 3000)
  ]);
  if (_hwCacheDirty) {
    _hwCacheDirty = false;
    ipcRenderer.sendSync('set-hw-cache', hwCache);
  }
  resizeWindow();
}

// Run once immediately on page load to avoid a blank widget; afterwards fast metrics run at 1s, slow metrics at 10s, GPU usage at 3s
updateFast();
updateSlow();
updateGPU();
setInterval(updateFast, 1000);
setInterval(updateSlow, 10000);
setInterval(updateGPU, 3000);

// ============================================================
// Language switch: re-render dynamic text in the current window (no page reload needed)
// ============================================================
ipcRenderer.on('apply-language', (_e, lang) => {
  i18n.setLanguage(lang);
  document.title = i18n.t('app.widgetTitle');
  document.documentElement.lang = i18n.getLanguage() === 'zh' ? 'zh-CN' : 'en';

  toggleBtn.setAttribute('aria-label', i18n.t('widget.themeAria'));
  updateToggleUI();

  menuBtn.setAttribute('aria-label', i18n.t('widget.menuAria'));
  menuBtn.title = i18n.t('widget.menuTitle');

  updateDateTime();
  updateUptime();
  updateBattery().catch(() => {});
});

document.title = i18n.t('app.widgetTitle');
document.documentElement.lang = i18n.getLanguage() === 'zh' ? 'zh-CN' : 'en';
