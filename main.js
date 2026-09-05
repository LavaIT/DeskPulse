// main.js —— Electron 主进程
// 职责：创建透明、无边框、置顶、可鼠标穿透的桌面小组件窗口；
//       处理 IPC（鼠标穿透切换、高度自适应、右键式菜单、退出）；
//       记忆窗口上次位置。

const { app, BrowserWindow, ipcMain, screen, Menu, Tray, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

// 将 Electron 的用户数据目录重定向到项目本地 userData 文件夹。
// 这样可避免写入系统 AppData（部分沙箱环境会拦截该路径导致进程崩溃）。
const userDataPath = path.join(__dirname, 'userData');
try { fs.mkdirSync(userDataPath, { recursive: true }); } catch (e) { /* 忽略已存在 */ }
app.setPath('userData', userDataPath);

// 窗口位置记忆文件
const stateFile = path.join(userDataPath, 'window-state.json');
function loadState() {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')) || {}; }
  catch (e) { return {}; }
}
function saveState(state) {
  try { fs.writeFileSync(stateFile, JSON.stringify(state)); } catch (e) { /* 忽略写入失败 */ }
}

// 用户偏好文件（主题等，替代 localStorage，打包后更可靠）
const prefsFile = path.join(userDataPath, 'preferences.json');
function loadPrefs() {
  try { return JSON.parse(fs.readFileSync(prefsFile, 'utf8')) || {}; }
  catch (e) { return {}; }
}
function savePrefs(prefs) {
  try { fs.writeFileSync(prefsFile, JSON.stringify(prefs, null, 2)); } catch (e) {}
}

// 静态硬件信息缓存（GPU 名称/显存、内存总量、磁盘列表 — 下次启动直接读，不等 WMI）
const hwCacheFile = path.join(userDataPath, 'hw-cache.json');
function loadHwCache() {
  try { return JSON.parse(fs.readFileSync(hwCacheFile, 'utf8')) || {}; }
  catch (e) { return {}; }
}
function saveHwCache(cache) {
  try { fs.writeFileSync(hwCacheFile, JSON.stringify(cache, null, 2)); } catch (e) {}
}

const WINDOW_WIDTH = 320;      // 普通模式宽度
const COMPACT_WIDTH = 220;     // 紧凑模式宽度（同步 renderer.js 中的常量）
const MARGIN = 20;

let _compact = false;  // 当前是否紧凑模式，供菜单勾选/窗口宽度使用

let win;
let tray = null;        // 单例托盘
let _quitting = false;  // 是否正在真正退出（托盘"退出"菜单会置 true，此时 close 就直接关，不 hide）

// 计算右上角默认位置
function topRightPos() {
  const workArea = screen.getPrimaryDisplay().workArea;
  return {
    x: workArea.x + workArea.width - WINDOW_WIDTH - MARGIN,
    y: workArea.y + MARGIN
  };
}

// 把窗口重置到右上角
function resetPosition() {
  if (!win || win.isDestroyed()) return;
  const p = topRightPos();
  win.setPosition(p.x, p.y);
  saveState(p);
}

function createWindow() {
  const initialHeight = 260;

  // 读取上次位置；没存或离屏则用右上角默认
  let pos = topRightPos();
  const saved = loadState();
  if (typeof saved.x === 'number' && typeof saved.y === 'number') {
    // 找最接近该位置的显示器，避免窗口跑到看不见的屏幕外
    const d = screen.getDisplayMatching({
      x: saved.x, y: saved.y, width: WINDOW_WIDTH, height: initialHeight
    });
    if (d && !d.bounds.isEmpty) pos = { x: saved.x, y: saved.y };
  }

  win = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: initialHeight, // 初始高度，之后会根据内容自动调整（见 resize IPC）
    x: pos.x,
    y: pos.y,
    transparent: true,        // 透明背景（让桌面壁纸透出毛玻璃）
    frame: false,            // 无边框 / 无标题栏
    // alwaysOnTop 改为在创建后通过 setAlwaysOnTop('screen-saver') 显式设置，
    // 覆盖开始菜单/通知/UWP 悬浮窗；此处保留 true 作为兜底
    alwaysOnTop: true,       // 始终置顶
    skipTaskbar: true,       // 不在任务栏显示
    resizable: false,        // 不可调整大小
    maximizable: false,
    minimizable: false,
    webPreferences: {
      contextIsolation: false, // 关闭上下文隔离
      nodeIntegration: true    // 允许渲染进程直接 require Node 模块（os / systeminformation）
    }
  });

  win.loadFile('index.html');

  // ====== 窗口关闭拦截（无边框小组件通常靠托盘常驻，不退出进程）======
  // 规则：
  //  - _quitting=false（用户 Alt+F4 / ⋮菜单没点退出 / 系统关机以外的关闭）→ 隐藏到托盘，不退出
  //  - _quitting=true（托盘"退出"菜单或 app.quit() 调用）→ 真关闭
  win.on('close', (e) => {
    if (_quitting) return; // 真退出，放行
    e.preventDefault();
    if (win && !win.isDestroyed()) win.hide();
  });

  // ====== 稳定置顶（透明无边框窗口在 Windows 上易被盖，做三层加固）======
  // 1) screen-saver 级别：高于绝大多数系统元素（开始菜单、通知、UWP 悬浮窗）
  //    relativeLevel 在 Windows 上可选：normal / floating / torn-off-menu /
  //    modal-panel / main-menu / status / pop-up-menu / screen-saver
  //    screen-saver 是最高一级
  win.setAlwaysOnTop(true, 'screen-saver');
  // 2) visible-on-all-workspaces：跨虚拟桌面不被隐藏
  try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); }
  catch (e) { /* 旧版 Electron 可能不支持该选项 */ }
  // 3) 周期保险：每 10 秒重新声明置顶 + moveTop。
  //    某些事件（连接显示器、全屏应用退出、资源管理器重启）会把窗口挤下顶层。
  const topTimer = setInterval(() => {
    if (!win || win.isDestroyed()) { clearInterval(topTimer); return; }
    if (!win.isAlwaysOnTop()) win.setAlwaysOnTop(true, 'screen-saver');
    win.moveTop();
  }, 10000);
  win.on('closed', () => clearInterval(topTimer));

  // ====== 鼠标穿透（核心交互）======
  // 说明：setIgnoreMouseEvents(true) 会让整个窗口对鼠标透明（点击穿透到桌面），
  // 但会导致顶部 50px 拖拽区失效。用 { forward: true } 让鼠标移动事件仍转发到渲染进程，
  // 渲染进程据此判断光标是否进入拖拽区/按钮：进入→临时关闭穿透使 drag 生效；离开→重新穿透。
  win.setIgnoreMouseEvents(true, { forward: true });

  // 拖动后防抖保存窗口位置（400ms 内不再移动才落盘）
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
// 关于对话框
// ============================================================
function showAbout() {
  dialog.showMessageBox({
    type: 'info',
    title: '关于 DeskPulse',
    message: `DeskPulse v${app.getVersion()}`,
    detail: '桌面系统监控小组件\n\nCopyright © Lava (MIT License)\nhttps://github.com/LavaIT/DeskPulse',
    buttons: ['确定'],
    icon: path.join(__dirname, 'assets', 'icon.ico')
  });
}

// ============================================================
// 设置窗口（独立小窗口，有标题栏，极简）
// ============================================================
let settingsWin = null;

function createSettingsWindow() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 360,
    height: 220,
    title: 'DeskPulse 设置',
    resizable: false,
    maximizable: false,
    minimizable: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true
    }
  });
  settingsWin.setMenu(null); // 彻底移除默认菜单栏，避免出现 File/Edit/View/Window/Help
  settingsWin.loadFile('settings.html');
  settingsWin.on('closed', () => { settingsWin = null; });
}

// ============================================================
// IPC 处理（注册一次，引用上层 win 变量）
// ============================================================

// 渲染进程请求切换鼠标穿透状态
ipcMain.on('set-ignore-mouse', (event, ignore) => {
  if (win && !win.isDestroyed()) {
    win.setIgnoreMouseEvents(ignore, { forward: true });
  }
});

// 渲染进程请求按内容高度自适应调整窗口大小
ipcMain.on('resize', (event, height) => {
  if (win && !win.isDestroyed() && height > 0) {
    win.setSize(_compact ? COMPACT_WIDTH : WINDOW_WIDTH, height);
  }
});

// 紧凑模式：切换窗口宽度 + 鼠标穿透策略（紧凑模式整区可拖不穿透，避免穿透到游戏画面）
ipcMain.on('set-compact', (event, on, widthPx, heightPx) => {
  _compact = !!on;
  if (win && !win.isDestroyed()) {
    const w = (typeof widthPx === 'number' && widthPx > 0) ? widthPx : (_compact ? COMPACT_WIDTH : WINDOW_WIDTH);
    const h = (typeof heightPx === 'number' && heightPx > 0) ? heightPx : win.getSize()[1];
    win.setSize(w, h);
    // 紧凑模式：整个 compact-content 带 drag 标记，关闭整窗穿透，让拖动可靠
    // 普通模式：恢复默认穿透
    win.setIgnoreMouseEvents(_compact ? false : true, { forward: true });
  }
  // 托盘/右键菜单勾选状态同步
  rebuildTrayMenu();
});

// 设置窗口 IPC：查询 / 设置开机自启
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
  } catch (err) { /* 无权限时静默失败 */ }
  e.returnValue = app.getLoginItemSettings().openAtLogin;
});

// 用户偏好 IPC：get-pref(key) → value / set-pref(key, value) → true
ipcMain.on('get-pref', (e, key) => {
  e.returnValue = loadPrefs()[key];
});
ipcMain.on('set-pref', (e, key, value) => {
  const prefs = loadPrefs();
  prefs[key] = value;
  savePrefs(prefs);
  e.returnValue = true;
});

// 版本号 IPC：get-version() → "1.0.2"
ipcMain.on('get-version', (e) => {
  e.returnValue = app.getVersion();
});

// 硬件缓存 IPC：get-hw-cache() → cacheObj / set-hw-cache(cacheObj) → true
ipcMain.on('get-hw-cache', (e) => {
  e.returnValue = loadHwCache();
});
ipcMain.on('set-hw-cache', (e, cache) => {
  saveHwCache(cache);
  e.returnValue = true;
});

// 广播主题切换到主窗口和设置窗口
function broadcastTheme() {
  if (win && !win.isDestroyed()) win.webContents.send('toggle-theme');
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('toggle-theme');
}

// 渲染进程请求弹出右键式菜单（切换主题 / 重置位置 / 设置 / 关于 / 退出）
ipcMain.on('show-context-menu', () => {
  if (!win || win.isDestroyed()) return;
  const menu = Menu.buildFromTemplate([
    {
      label: '切换主题',
      click: () => broadcastTheme()
    },
    {
      label: '紧凑模式',
      type: 'checkbox',
      checked: _compact,
      click: () => { if (win && !win.isDestroyed()) win.webContents.send('toggle-compact'); }
    },
    {
      label: '重置到右上角',
      click: () => resetPosition()
    },
    { type: 'separator' },
    {
      label: '设置...',
      click: () => createSettingsWindow()
    },
    {
      label: '关于',
      click: () => showAbout()
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => app.quit()
    }
  ]);
  menu.popup(); // 在光标位置弹出
});

// ============================================================
// 托盘功能：单例，不随窗口销毁而销毁
// ============================================================
function resolveTrayIcon() {
  // 优先级：用户专用 tray.png（最清晰）→ icon.ico（打包用，尺寸全）→ icon.png/jpg → 旧名 tray.jpg → 系统默认
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

  // tray.png / icon.ico(≥256) 都会缩到 32 再下采样 16，过一次 best 质量抗锯齿
  const scaled = img.resize({ width: 32, height: 32, quality: 'best' });
  // 若图像原本有透明通道就直接用；否则也不做白底抠（图案和背景都是白的情况下抠不干净）
  // 你给的 tray.png 若真是透明 PNG，hasTransparency=true → 直接生效
  const bitmap = scaled.getBitmap();
  let hasTransparency = false;
  for (let i = 3; i < bitmap.length; i += 4) {
    if (bitmap[i] < 255) { hasTransparency = true; break; }
  }
  void hasTransparency; // 保留检测逻辑占位，暂不分流
  return scaled.resize({ width: 16, height: 16, quality: 'best' });
}

function createTray() {
  if (tray && !tray.isDestroyed()) return; // 单例，防止重复创建
  const icon = resolveTrayIcon();
  tray = new Tray(icon);
  tray.setToolTip('DeskPulse · 桌面系统监控');

  // 左键单击托盘：切换显示/隐藏
  tray.on('click', () => {
    if (!win || win.isDestroyed()) { createWindow(); return; }
    if (win.isVisible()) win.hide();
    else { win.show(); win.moveTop(); }
  });

  rebuildTrayMenu();
}

// 重建托盘右键菜单（窗口显隐状态变化时刷新菜单文字）
function rebuildTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  const visible = win && !win.isDestroyed() && win.isVisible();

  const template = [
    {
      label: visible ? '隐藏小组件' : '显示小组件',
      click: () => {
        if (!win || win.isDestroyed()) { createWindow(); return; }
        if (win.isVisible()) win.hide();
        else { win.show(); win.moveTop(); }
      }
    },
    { type: 'separator' },
    {
      label: '切换主题',
      click: () => broadcastTheme()
    },
    {
      label: '紧凑模式',
      type: 'checkbox',
      checked: _compact,
      click: () => { if (win && !win.isDestroyed()) win.webContents.send('toggle-compact'); }
    },
    {
      label: '重置到右上角',
      click: () => {
        if (!win || win.isDestroyed()) createWindow();
        resetPosition();
        if (win && !win.isVisible()) { win.show(); win.moveTop(); }
      }
    },
    { type: 'separator' },
    {
      label: '设置...',
      click: () => createSettingsWindow()
    },
    {
      label: '关于',
      click: () => showAbout()
    },
    { type: 'separator' },
    {
      label: '退出 DeskPulse',
      click: () => {
        _quitting = true;
        app.quit();
      }
    }
  ];
  const menu = Menu.buildFromTemplate(template);
  tray.setContextMenu(menu);
}

// 保证每次窗口显隐状态或自启状态变化后，菜单文字能同步更新
const _origRebuild = rebuildTrayMenu;
// 包装 rebuildTrayMenu 到 app.whenReady 之后才能执行（因为 app.getLoginItemSettings 在 ready 前不可用）
// 这里我们在 app.whenReady().then() 里调用 createTray，所以不用再包。

app.whenReady().then(() => {
  // 启动前同步紧凑模式偏好，避免菜单勾选与实际状态不一致
  const savedPrefs = loadPrefs();
  if (savedPrefs.compact === true) _compact = true;

  createWindow();
  createTray();
});

// 托盘状态同步：窗口显示/隐藏时刷新菜单文字
app.on('browser-window-show', () => _origRebuild && rebuildTrayMenu());
app.on('browser-window-hide', () => _origRebuild && rebuildTrayMenu());

// macOS 下点击 dock 图标时若没有窗口则重新创建
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// 所有窗口关闭时不自动退出（托盘常驻）
// 但 macOS 平台习惯保留退出行为，这里也和我们"托盘常驻"一致就不区分了。
// 说明：窗口 close 事件已改为 hide 而不是 destroy，所以此事件平时不会触发；
// 只有托盘"退出"把 _quitting=true 后才会真关闭窗口 → 此时 app.quit() 已调用，不再需要该回调。
app.on('window-all-closed', () => {
  // 托盘在，不退出；真退出走托盘"退出"菜单
});
