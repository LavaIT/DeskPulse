// main.js — Electron main process
// Responsibilities: create a transparent, frameless, always-on-top, click-through desktop widget window;
//       handle IPC (mouse pass-through toggling, auto height, context-style menu, quit);
//       remember the window's last position.

const { app, BrowserWindow, ipcMain, screen, Menu, Tray, nativeImage, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const i18n = require('./i18n');
const { exec, spawn, execSync } = require('child_process');  // Used to launch Task Manager / Resource Monitor / list system fonts

// Redirect Electron's user data directory to the project-local userData folder.
// This avoids writing to the system AppData (some sandboxed environments block that path and crash the process).
const userDataPath = path.join(__dirname, 'userData');
try { fs.mkdirSync(userDataPath, { recursive: true }); } catch (e) { /* ignore if already exists */ }
app.setPath('userData', userDataPath);

// Window position state file
const stateFile = path.join(userDataPath, 'window-state.json');
function loadState() {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')) || {}; }
  catch (e) { return {}; }
}
function saveState(state) {
  try { fs.writeFileSync(stateFile, JSON.stringify(state)); } catch (e) { /* ignore write failure */ }
}

// User preferences file (theme, etc.; replaces localStorage and is more reliable after packaging)
const prefsFile = path.join(userDataPath, 'preferences.json');
function loadPrefs() {
  try { return JSON.parse(fs.readFileSync(prefsFile, 'utf8')) || {}; }
  catch (e) { return {}; }
}
function savePrefs(prefs) {
  try { fs.writeFileSync(prefsFile, JSON.stringify(prefs, null, 2)); } catch (e) {}
}

// Static hardware info cache (GPU name/VRAM, total memory, disk list — read directly on next launch, no waiting for WMI)
const hwCacheFile = path.join(userDataPath, 'hw-cache.json');
function loadHwCache() {
  try { return JSON.parse(fs.readFileSync(hwCacheFile, 'utf8')) || {}; }
  catch (e) { return {}; }
}
function saveHwCache(cache) {
  try { fs.writeFileSync(hwCacheFile, JSON.stringify(cache, null, 2)); } catch (e) {}
}

const WINDOW_WIDTH = 320;      // Normal mode width
const COMPACT_WIDTH = 220;     // Compact mode width (keep in sync with the constant in renderer.js)
const MARGIN = 20;

let _compact = false;  // Whether compact mode is currently active; used for the menu checkmark / window width

let win;
let tray = null;        // Single-instance tray
let _quitting = false;  // Whether a real quit is in progress (the tray "Quit" menu sets this to true; then close really closes instead of hiding)

// Compute the default top-right position
function topRightPos() {
  const workArea = screen.getPrimaryDisplay().workArea;
  return {
    x: workArea.x + workArea.width - WINDOW_WIDTH - MARGIN,
    y: workArea.y + MARGIN
  };
}

// Reset the window to the top-right corner
function resetPosition() {
  if (!win || win.isDestroyed()) return;
  const p = topRightPos();
  win.setPosition(p.x, p.y);
  saveState(p);
}

// Move the window to the given corner (corner: 'tl' | 'tr' | 'bl' | 'br')
function moveToCorner(corner) {
  if (!win || win.isDestroyed()) return;
  const workArea = screen.getPrimaryDisplay().workArea;
  const [w, h] = win.getSize();
  let x, y;
  switch (corner) {
    case 'tl': x = workArea.x + MARGIN;            y = workArea.y + MARGIN;            break;
    case 'tr': x = workArea.x + workArea.width - w - MARGIN;  y = workArea.y + MARGIN;            break;
    case 'bl': x = workArea.x + MARGIN;            y = workArea.y + workArea.height - h - MARGIN; break;
    case 'br': x = workArea.x + workArea.width - w - MARGIN;  y = workArea.y + workArea.height - h - MARGIN; break;
    default: return;
  }
  win.setPosition(x, y);
  saveState({ x, y });
}

// Launch Windows system tools (Task Manager / Resource Monitor)
function launchSysTool(tool) {
  try {
    if (tool === 'taskmgr') {
      spawn('taskmgr.exe', [], { detached: true, stdio: 'ignore' }).unref();
    } else if (tool === 'resmon') {
      spawn('resmon.exe', [], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch (e) { /* fail silently; cannot launch without permission */ }
}

function createWindow() {
  const initialHeight = 260;

  // Read the last position; if missing or off-screen, use the top-right default
  let pos = topRightPos();
  const saved = loadState();
  if (typeof saved.x === 'number' && typeof saved.y === 'number') {
    // Find the display closest to that position so the window never lands off-screen
    const d = screen.getDisplayMatching({
      x: saved.x, y: saved.y, width: WINDOW_WIDTH, height: initialHeight
    });
    if (d && !d.bounds.isEmpty) pos = { x: saved.x, y: saved.y };
  }

  win = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: initialHeight, // Initial height; adjusted automatically to content later (see the resize IPC)
    x: pos.x,
    y: pos.y,
    transparent: true,        // Transparent background (lets the desktop wallpaper show through the frosted glass)
    frame: false,            // Frameless / no title bar
    // alwaysOnTop is set explicitly after creation via setAlwaysOnTop('screen-saver'),
    // covering the Start menu / notifications / UWP flyouts; true here is just a fallback
    alwaysOnTop: true,       // Always on top
    skipTaskbar: true,       // Do not show in the taskbar
    resizable: false,        // Not resizable
    maximizable: false,
    minimizable: false,
    webPreferences: {
      contextIsolation: false, // Disable context isolation
      nodeIntegration: true    // Allow the renderer to require Node modules directly (os / systeminformation)
    }
  });

  win.loadFile('index.html');

  // ====== Window close interception (frameless widgets stay tray-resident instead of exiting) ======
  // Rules:
  //  - _quitting=false (user Alt+F4 / ⋮ menu without Quit / any close other than system shutdown) → hide to tray, don't exit
  //  - _quitting=true (tray "Quit" menu or an app.quit() call) → really close
  win.on('close', (e) => {
    if (_quitting) return; // Real quit, allow it
    e.preventDefault();
    if (win && !win.isDestroyed()) win.hide();
  });

  // ====== Stable always-on-top (transparent frameless windows get covered easily on Windows; three layers of reinforcement) ======
  // 1) screen-saver level: above almost all system elements (Start menu, notifications, UWP flyouts)
  //    On Windows, relativeLevel can be: normal / floating / torn-off-menu /
  //    modal-panel / main-menu / status / pop-up-menu / screen-saver
  //    screen-saver is the highest level
  win.setAlwaysOnTop(true, 'screen-saver');
  // 2) visible-on-all-workspaces: stays visible across virtual desktops
  try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); }
  catch (e) { /* older Electron versions may not support this option */ }
  // 3) Periodic safeguard: re-assert always-on-top + moveTop every 10 seconds.
  //    Certain events (connecting a display, exiting a fullscreen app, Explorer restarting) can push the window out of the top layer.
  const topTimer = setInterval(() => {
    if (!win || win.isDestroyed()) { clearInterval(topTimer); return; }
    if (!win.isAlwaysOnTop()) win.setAlwaysOnTop(true, 'screen-saver');
    win.moveTop();
  }, 10000);
  win.on('closed', () => clearInterval(topTimer));

  // ====== Mouse pass-through (core interaction) ======
  // Note: setIgnoreMouseEvents(true) makes the whole window transparent to the mouse (clicks pass through to the desktop),
  // but it breaks the 50px drag region at the top. With { forward: true }, mouse-move events are still forwarded to the renderer,
  // which then decides whether the cursor is over the drag region/buttons: enter → temporarily disable pass-through so drag works; leave → re-enable pass-through.
  win.setIgnoreMouseEvents(true, { forward: true });

  // Debounce saving the window position after dragging (persist only after 400ms without movement)
  let saveTimer = null;
  win.on('moved', () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (win && !win.isDestroyed()) {
        const [x, y] = win.getPosition();
        saveState({ x, y });
      }
    }, 400);
  });
}

// ============================================================
// About page (custom window, liquid glass)
// ============================================================
let aboutWin = null;
function showAbout() {
  if (aboutWin && !aboutWin.isDestroyed()) {
    aboutWin.show();
    aboutWin.focus();
    return;
  }
  aboutWin = new BrowserWindow({
    width: 320,
    height: 280,
    title: i18n.t('about.title'),
    resizable: false,
    maximizable: false,
    minimizable: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true
    }
  });
  aboutWin.setMenu(null);
  aboutWin.loadFile('about.html');
  aboutWin.on('closed', () => { aboutWin = null; });
}

// ============================================================
// Settings window (standalone small window, with title bar, minimal)
// ============================================================
let settingsWin = null;

function createSettingsWindow() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 380,
    height: 540,
    title: i18n.t('settings.title'),
    resizable: false,
    maximizable: false,
    minimizable: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true
    }
  });
  settingsWin.setMenu(null); // Remove the default menu entirely to avoid File/Edit/View/Window/Help
  settingsWin.loadFile('settings.html');
  settingsWin.on('closed', () => { settingsWin = null; });
}

// ============================================================
// IPC handlers (registered once, referencing the win variable above)
// ============================================================

// Renderer requests toggling mouse pass-through
ipcMain.on('set-ignore-mouse', (event, ignore) => {
  if (win && !win.isDestroyed()) {
    win.setIgnoreMouseEvents(ignore, { forward: true });
  }
});

// Renderer requests resizing the window to fit the content height
ipcMain.on('resize', (event, height) => {
  if (win && !win.isDestroyed() && height > 0) {
    win.setSize(_compact ? COMPACT_WIDTH : WINDOW_WIDTH, height);
  }
});

// Compact mode: switch window width + mouse pass-through policy (in compact mode the whole area drags without pass-through, so clicks don't reach the game)
ipcMain.on('set-compact', (event, on, widthPx) => {
  _compact = !!on;
  if (win && !win.isDestroyed()) {
    const w = (typeof widthPx === 'number' && widthPx > 0) ? widthPx : (_compact ? COMPACT_WIDTH : WINDOW_WIDTH);
    // Height is handled separately by the renderer's resize IPC
    win.setSize(w, win.getSize()[1]);
    // Compact mode: the whole compact-content area has a drag marker, so disable whole-window pass-through to make dragging reliable
    // Normal mode: restore default pass-through
    win.setIgnoreMouseEvents(_compact ? false : true, { forward: true });
  }
  // Sync the tray/context menu checkmark state
  rebuildTrayMenu();
});

// Settings window IPC: query / set launch at login
ipcMain.on('get-auto-launch', (e) => {
  e.returnValue = app.getLoginItemSettings().openAtLogin;
});
ipcMain.on('set-auto-launch', (e, enabled) => {
  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      path: process.execPath,
      args: []
    });
  } catch (err) { /* fail silently without permission */ }
  e.returnValue = app.getLoginItemSettings().openAtLogin;
});

// User preference IPC: get-pref(key) → value / set-pref(key, value) → true
ipcMain.on('get-pref', (e, key) => {
  e.returnValue = loadPrefs()[key];
});
ipcMain.on('set-pref', (e, key, value) => {
  const prefs = loadPrefs();
  prefs[key] = value;
  savePrefs(prefs);
  e.returnValue = true;
});

// UI language IPC: query the effective language, read the raw preference,
// and switch languages at runtime.
ipcMain.on('get-language', (e) => {
  e.returnValue = i18n.getLanguage();
});
ipcMain.on('get-language-pref', (e) => {
  e.returnValue = loadPrefs().language || 'auto';
});
ipcMain.on('set-language', (_e, val) => {
  const prefs = loadPrefs();
  if (val === 'auto' || val === null || val === undefined) {
    delete prefs.language;
  } else {
    prefs.language = (val === 'en') ? 'en' : 'zh';
  }
  savePrefs(prefs);
  i18n.init(prefs.language, app.getLocale());
  broadcastLanguage(i18n.getLanguage());
  rebuildTrayMenu();
});

// Settings window requests setting the theme (null=follow system / 'dark' / 'light')
ipcMain.on('set-theme', (_e, theme) => {
  const prefs = loadPrefs();
  if (theme === null || theme === undefined) {
    delete prefs.theme;
  } else {
    prefs.theme = theme;
  }
  savePrefs(prefs);
  broadcastSetTheme(theme === undefined ? null : theme);
});

// Settings window requests toggling compact mode (forwarded to the main window's renderer)
ipcMain.on('request-set-compact', (_e, on) => {
  if (win && !win.isDestroyed()) win.webContents.send('set-compact-state', on);
});

// Settings window requests setting the glass effect (off / frost / liquid)
ipcMain.on('set-glass', (_e, val) => {
  const prefs = loadPrefs();
  prefs.glass = val;
  savePrefs(prefs);
  if (win && !win.isDestroyed()) win.webContents.send('apply-glass', val);
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('apply-glass', val);
});

// Settings window requests setting the color preset (qinglan / hailan / cuilv / zijin / jijian)
ipcMain.on('set-preset', (_e, val) => {
  const prefs = loadPrefs();
  prefs.preset = val;
  savePrefs(prefs);
  if (win && !win.isDestroyed()) win.webContents.send('apply-preset', val);
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('apply-preset', val);
});

// Settings window requests setting the font ('default' = restore the default font stack, otherwise used directly as the font-family value)
ipcMain.on('set-font-family', (_e, val) => {
  const prefs = loadPrefs();
  if (!val || val === 'default') delete prefs.fontFamily;
  else prefs.fontFamily = val;
  savePrefs(prefs);
  if (win && !win.isDestroyed()) win.webContents.send('apply-font-family', val);
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('apply-font-family', val);
});

// Settings window requests setting panel opacity (0-1, only effective in off/frost mode)
ipcMain.on('set-panel-opacity', (_e, val) => {
  const prefs = loadPrefs();
  prefs.panelOpacity = val;
  savePrefs(prefs);
  if (win && !win.isDestroyed()) win.webContents.send('apply-panel-opacity', val);
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('apply-panel-opacity', val);
});

// Settings window requests setting a custom accent color ('#xxxxxx' / null=restore preset)
ipcMain.on('set-custom-accent', (_e, val) => {
  const prefs = loadPrefs();
  if (!val) delete prefs.customAccent;
  else prefs.customAccent = val;
  savePrefs(prefs);
  if (win && !win.isDestroyed()) win.webContents.send('apply-custom-accent', val);
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('apply-custom-accent', val);
});

// Settings window requests setting clock options (hour/seconds/dateformat)
ipcMain.on('set-clock-hour', (_e, val) => {
  const prefs = loadPrefs();
  prefs.clockHour = val;
  savePrefs(prefs);
  if (win && !win.isDestroyed()) win.webContents.send('apply-clock-hour', val);
});
ipcMain.on('set-clock-seconds', (_e, on) => {
  const prefs = loadPrefs();
  prefs.clockSeconds = !!on;
  savePrefs(prefs);
  if (win && !win.isDestroyed()) win.webContents.send('apply-clock-seconds', !!on);
});
ipcMain.on('set-date-format', (_e, val) => {
  const prefs = loadPrefs();
  prefs.dateFormat = val;
  savePrefs(prefs);
  if (win && !win.isDestroyed()) win.webContents.send('apply-date-format', val);
});

// Settings window requests setting the alert threshold percentage (0-100)
ipcMain.on('set-alert-threshold', (_e, val) => {
  const prefs = loadPrefs();
  prefs.alertThreshold = val;
  savePrefs(prefs);
  if (win && !win.isDestroyed()) win.webContents.send('apply-alert-threshold', val);
});

// Settings window requests "Restore Defaults": clear all preferences but keep the window position state and hardware cache
ipcMain.on('reset-all-prefs', (e) => {
  // Clear the preferences file (equivalent to deleting the whole prefs object)
  try { fs.writeFileSync(prefsFile, '{}'); } catch (err) { /* ignore write failure */ }
  // Clear the language preference too, back to following the system
  i18n.init(undefined, app.getLocale());
  broadcastLanguage(i18n.getLanguage());
  // Reset the compact flag held by the main process so it doesn't diverge from the reloaded renderer
  _compact = false;
  if (win && !win.isDestroyed()) {
    // Restore the normal-mode width before reloading; the renderer will readjust the height via the resize IPC afterwards
    win.setSize(WINDOW_WIDTH, win.getSize()[1]);
    win.setIgnoreMouseEvents(true, { forward: true });
    win.webContents.reload();
  }
  // Sync the tray menu checkmark state
  rebuildTrayMenu();
  e.returnValue = true;
});

// Settings window requests setting the display mode (percent / value)
ipcMain.on('set-display-mode', (_e, val) => {
  const prefs = loadPrefs();
  prefs.displayMode = val;
  savePrefs(prefs);
  if (win && !win.isDestroyed()) win.webContents.send('apply-display-mode', val);
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('apply-display-mode', val);
});

// Settings window requests toggling the "system uptime" display
ipcMain.on('set-show-uptime', (_e, on) => {
  const prefs = loadPrefs();
  prefs.showUptime = !!on;
  savePrefs(prefs);
  if (win && !win.isDestroyed()) win.webContents.send('apply-show-uptime', !!on);
});

// Settings window requests toggling the "WiFi signal strength" display
ipcMain.on('set-show-wifi', (_e, on) => {
  const prefs = loadPrefs();
  prefs.showWifi = !!on;
  savePrefs(prefs);
  if (win && !win.isDestroyed()) win.webContents.send('apply-show-wifi', !!on);
});

// Settings window requests toggling the "sparkline" display
ipcMain.on('set-sparkline', (_e, on) => {
  const prefs = loadPrefs();
  prefs.sparkline = !!on;
  savePrefs(prefs);
  if (win && !win.isDestroyed()) win.webContents.send('apply-sparkline', !!on);
});

// Settings window requests toggling the "CPU per-core load bars" display
ipcMain.on('set-show-cpucores', (_e, on) => {
  const prefs = loadPrefs();
  prefs.showCpuCores = !!on;
  savePrefs(prefs);
  if (win && !win.isDestroyed()) win.webContents.send('apply-show-cpucores', !!on);
});

// Settings window requests toggling the "disk read/write speed" display
ipcMain.on('set-show-diskio', (_e, on) => {
  const prefs = loadPrefs();
  prefs.showDiskIO = !!on;
  savePrefs(prefs);
  if (win && !win.isDestroyed()) win.webContents.send('apply-show-diskio', !!on);
});

// Settings window requests toggling the "GPU VRAM usage" display
ipcMain.on('set-show-gpuram', (_e, on) => {
  const prefs = loadPrefs();
  prefs.showGpuRam = !!on;
  savePrefs(prefs);
  if (win && !win.isDestroyed()) win.webContents.send('apply-show-gpuram', !!on);
});

// Settings window requests toggling the "memory specification" display
ipcMain.on('set-show-memspec', (_e, on) => {
  const prefs = loadPrefs();
  prefs.showMemSpec = !!on;
  savePrefs(prefs);
  if (win && !win.isDestroyed()) win.webContents.send('apply-show-memspec', !!on);
});

// Settings window requests hiding/showing a metric (metricId, hidden=true means hidden)
ipcMain.on('set-visibility', (_e, metricId, hidden) => {
  const prefs = loadPrefs();
  if (!hidden) {
    delete prefs['hidden.' + metricId];
  } else {
    prefs['hidden.' + metricId] = true;
  }
  savePrefs(prefs);
  if (win && !win.isDestroyed()) win.webContents.send('apply-visibility', metricId, !!hidden);
});

// Version IPC: get-version() → "1.0.2"
ipcMain.on('get-version', (e) => {
  e.returnValue = app.getVersion();
});

// Hardware cache IPC: get-hw-cache() → cacheObj / set-hw-cache(cacheObj) → true
ipcMain.on('get-hw-cache', (e) => {
  e.returnValue = loadHwCache();
});
ipcMain.on('set-hw-cache', (e, cache) => {
  saveHwCache(cache);
  e.returnValue = true;
});

// PowerShell script that enumerates system fonts (base64-encoded and run via -EncodedCommand to avoid shell escaping of $_)
// Picks the LCID by current UI language (English 1033 / Chinese 2052); falls back to the font's own name when empty; outputs a JSON array
function _fontPsB64() {
  const lcid = i18n.getLanguage() === 'en' ? 1033 : 2052;
  const script = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing
$f = (New-Object System.Drawing.Text.InstalledFontCollection).Families
$result = $f | ForEach-Object {
  $name = $_.GetName(${lcid})
  if ([string]::IsNullOrWhiteSpace($name)) { $name = $_.Name }
  $name
}
$result | ConvertTo-Json -Compress
`;
  return Buffer.from(script, 'utf16le').toString('base64');
}

function _fetchSystemFonts() {
  try {
    const out = execSync(
      `powershell -NoProfile -EncodedCommand ${_fontPsB64()}`,
      { encoding: 'utf8', timeout: 15000, maxBuffer: 10 * 1024 * 1024 }
    );
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

// Get the list of installed system fonts (display names, localized name preferred), cached in hw-cache.json
// The font list rarely changes; cache it after the first query and serve it from cache later
ipcMain.on('get-system-fonts', (e) => {
  const cache = loadHwCache();
  const lang = i18n.getLanguage();
  if (Array.isArray(cache.systemFonts) && cache.systemFonts.length > 0 && cache.systemFontsLang === lang) {
    e.returnValue = cache.systemFonts;
    return;
  }
  const fonts = _fetchSystemFonts();
  if (fonts.length > 0) {
    cache.systemFonts = fonts;
    cache.systemFontsLang = lang;
    saveHwCache(cache);
  }
  e.returnValue = fonts;
});

// Broadcast a theme toggle to all windows (toggle mode: dark↔light)
function broadcastTheme() {
  if (win && !win.isDestroyed()) win.webContents.send('toggle-theme');
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('toggle-theme');
  if (aboutWin && !aboutWin.isDestroyed()) aboutWin.webContents.send('toggle-theme');
}

// Broadcast the specified theme to all windows (used by the settings window: follow system/light/dark)
function broadcastSetTheme(theme) {
  if (win && !win.isDestroyed()) win.webContents.send('apply-theme', theme);
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('apply-theme', theme);
  if (aboutWin && !aboutWin.isDestroyed()) aboutWin.webContents.send('apply-theme', theme);
}

// Broadcast a language switch: all windows retranslate, menus and window titles are updated too
function broadcastLanguage(lang) {
  [win, settingsWin, aboutWin].forEach((w) => {
    if (w && !w.isDestroyed()) w.webContents.send('apply-language', lang);
  });
  if (tray && !tray.isDestroyed()) tray.setToolTip(i18n.t('app.trayTooltip'));
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.setTitle(i18n.t('settings.title'));
  if (aboutWin && !aboutWin.isDestroyed()) aboutWin.setTitle(i18n.t('about.title'));
}

// Renderer requests the context-style menu (compact mode / move to corners / settings / about / quit)
ipcMain.on('show-context-menu', () => {
  if (!win || win.isDestroyed()) return;
  const menu = Menu.buildFromTemplate([
    {
      label: i18n.t('menu.compact'),
      type: 'checkbox',
      checked: _compact,
      click: () => { if (win && !win.isDestroyed()) win.webContents.send('toggle-compact'); }
    },
    {
      label: i18n.t('menu.moveTo'),
      submenu: [
        { label: i18n.t('menu.topLeft'), click: () => moveToCorner('tl') },
        { label: i18n.t('menu.topRight'), click: () => moveToCorner('tr') },
        { label: i18n.t('menu.bottomLeft'), click: () => moveToCorner('bl') },
        { label: i18n.t('menu.bottomRight'), click: () => moveToCorner('br') }
      ]
    },
    {
      label: i18n.t('menu.resetTopRight'),
      click: () => resetPosition()
    },
    { type: 'separator' },
    {
      label: i18n.t('menu.taskManager'),
      click: () => launchSysTool('taskmgr')
    },
    {
      label: i18n.t('menu.resourceMonitor'),
      click: () => launchSysTool('resmon')
    },
    { type: 'separator' },
    {
      label: i18n.t('menu.settings'),
      click: () => createSettingsWindow()
    },
    {
      label: i18n.t('menu.about'),
      click: () => showAbout()
    },
    { type: 'separator' },
    {
      label: i18n.t('menu.quit'),
      click: () => app.quit()
    }
  ]);
  menu.popup();
});

// ============================================================
// Tray: single instance, not destroyed with the window
// ============================================================
function resolveTrayIcon() {
  // Priority: user-provided tray.png (sharpest) → icon.ico (for packaging, all sizes) → icon.png/jpg → legacy tray.jpg → system default
  const tryPaths = [
    path.join(__dirname, 'assets', 'tray.png'),
    path.join(__dirname, 'assets', 'icon.ico'),
    path.join(__dirname, 'assets', 'icon.png'),
    path.join(__dirname, 'assets', 'icon.jpg'),
    path.join(__dirname, 'assets', 'tray.jpg')
  ];
  let img = nativeImage.createEmpty();
  for (const p of tryPaths) {
    if (!fs.existsSync(p)) continue;
    const candidate = nativeImage.createFromPath(p);
    if (!candidate.isEmpty()) { img = candidate; break; }
  }
  if (img.isEmpty()) return img;

  // tray.png / icon.ico (≥256) are scaled to 32 then downsampled to 16, with one pass of best-quality antialiasing
  const scaled = img.resize({ width: 32, height: 32, quality: 'best' });
  return scaled.resize({ width: 16, height: 16, quality: 'best' });
}

function createTray() {
  if (tray && !tray.isDestroyed()) return; // Single instance, prevent duplicate creation
  const icon = resolveTrayIcon();
  tray = new Tray(icon);
  tray.setToolTip(i18n.t('app.trayTooltip'));

  // Left-click on the tray: toggle show/hide
  tray.on('click', () => {
    if (!win || win.isDestroyed()) { createWindow(); return; }
    if (win.isVisible()) win.hide();
    else { win.show(); win.moveTop(); }
  });

  rebuildTrayMenu();
}

// Rebuild the tray context menu (refresh the menu text when the window's visibility changes)
function rebuildTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  const visible = win && !win.isDestroyed() && win.isVisible();

  const template = [
    {
      label: visible ? i18n.t('menu.hide') : i18n.t('menu.show'),
      click: () => {
        if (!win || win.isDestroyed()) { createWindow(); return; }
        if (win.isVisible()) win.hide();
        else { win.show(); win.moveTop(); }
      }
    },
    { type: 'separator' },
    {
      label: i18n.t('menu.compact'),
      type: 'checkbox',
      checked: _compact,
      click: () => { if (win && !win.isDestroyed()) win.webContents.send('toggle-compact'); }
    },
    {
      label: i18n.t('menu.moveTo'),
      submenu: [
        { label: i18n.t('menu.topLeft'), click: () => moveToCorner('tl') },
        { label: i18n.t('menu.topRight'), click: () => moveToCorner('tr') },
        { label: i18n.t('menu.bottomLeft'), click: () => moveToCorner('bl') },
        { label: i18n.t('menu.bottomRight'), click: () => moveToCorner('br') }
      ]
    },
    {
      label: i18n.t('menu.resetTopRight'),
      click: () => {
        if (!win || win.isDestroyed()) createWindow();
        resetPosition();
        if (win && !win.isVisible()) { win.show(); win.moveTop(); }
      }
    },
    { type: 'separator' },
    {
      label: i18n.t('menu.taskManager'),
      click: () => launchSysTool('taskmgr')
    },
    {
      label: i18n.t('menu.resourceMonitor'),
      click: () => launchSysTool('resmon')
    },
    { type: 'separator' },
    {
      label: i18n.t('menu.settings'),
      click: () => createSettingsWindow()
    },
    {
      label: i18n.t('menu.about'),
      click: () => showAbout()
    },
    { type: 'separator' },
    {
      label: i18n.t('menu.quitApp'),
      click: () => {
        _quitting = true;
        app.quit();
      }
    }
  ];
  const menu = Menu.buildFromTemplate(template);
  tray.setContextMenu(menu);
}

// Ensures the menu text is updated whenever the window visibility or launch-at-login state changes

app.whenReady().then(() => {
  // Determine the UI language before creating windows/menus (manual preference first, otherwise follow the system)
  i18n.init(loadPrefs().language, app.getLocale());

  // Sync the compact-mode preference before startup to avoid a mismatch between the menu checkmark and the actual state
  const savedPrefs = loadPrefs();
  if (savedPrefs.compact === true) _compact = true;

  createWindow();
  createTray();

  // Global shortcut: Ctrl+Alt+M toggles compact / standard mode
  globalShortcut.register('Control+Alt+M', () => {
    if (win && !win.isDestroyed()) win.webContents.send('toggle-compact');
  });

  // Warm up the system font list in the background (the first PowerShell run takes ~1-2 seconds; running in the background doesn't block the main window)
  // Once cached in hw-cache.json, the settings window responds instantly
  setTimeout(() => {
    const cache = loadHwCache();
    const lang = i18n.getLanguage();
    if (Array.isArray(cache.systemFonts) && cache.systemFonts.length > 0 && cache.systemFontsLang === lang) return;
    const fonts = _fetchSystemFonts();
    if (fonts.length > 0) {
      cache.systemFonts = fonts;
      cache.systemFontsLang = lang;
      saveHwCache(cache);
    }
  }, 2000);
});

// Tray state sync: refresh the menu text when the window is shown/hidden
app.on('browser-window-show', (e) => { if (e === win) rebuildTrayMenu(); });
app.on('browser-window-hide', (e) => { if (e === win) rebuildTrayMenu(); });

// On macOS, recreate the window when the dock icon is clicked and no window exists
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// Don't quit automatically when all windows are closed (the tray stays resident)
// macOS convention keeps the quit behavior, but here it matches our "stay in the tray" behavior, so there's no special casing.
// Note: the window close event now hides instead of destroys, so this event normally never fires;
// the window only really closes after the tray "Quit" sets _quitting=true → app.quit() has already been called by then, so this callback isn't needed.
app.on('window-all-closed', () => {
  // The tray is there, so don't quit; a real quit goes through the tray "Quit" menu
});

// Unregister global shortcuts before quitting to avoid leftovers
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
