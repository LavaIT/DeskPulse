// main.js —— Electron 主进程
// 职责：创建透明、无边框、置顶、可鼠标穿透的桌面小组件窗口；
//       处理 IPC（鼠标穿透切换、高度自适应、右键式菜单、退出）；
//       记忆窗口上次位置。

const { app, BrowserWindow, ipcMain, screen, Menu, Tray, nativeImage } = require('electron');
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

const WINDOW_WIDTH = 320;
const MARGIN = 20;

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
    win.setSize(WINDOW_WIDTH, height);
  }
});

// 渲染进程请求弹出右键式菜单（切换主题 / 重置位置 / 退出）
ipcMain.on('show-context-menu', () => {
  if (!win || win.isDestroyed()) return;
  const menu = Menu.buildFromTemplate([
    {
      label: '切换主题',
      click: () => { if (win && !win.isDestroyed()) win.webContents.send('toggle-theme'); }
    },
    {
      label: '重置到右上角',
      click: () => resetPosition()
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

// 根据开机自启状态重建托盘右键菜单（开/关"开机自启"需要动态更新 checked 状态）
function rebuildTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  // 当前开机自启状态
  const login = app.getLoginItemSettings();
  const autoLaunch = login.openAtLogin;
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
      click: () => { if (win && !win.isDestroyed()) win.webContents.send('toggle-theme'); }
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
      label: '开机自启',
      type: 'checkbox',
      checked: !!autoLaunch,
      click: (item) => {
        // 勾选后用 setLoginItemSettings 写入注册表（Windows）
        // path 用 process.execPath（electron.exe）——打包成 exe 后会自动变成 DeskPulse.exe
        // args 空数组即可（直接启动）
        try {
          app.setLoginItemSettings({
            openAtLogin: item.checked,
            path: process.execPath,
            args: []
          });
        } catch (e) { /* 无权限时静默失败，菜单勾选状态会在下一次 rebuild 回到原值 */ }
        // 立即重建菜单，反映最新状态（setLoginItemSettings 未必同步成功，下次点击兜底）
        setTimeout(rebuildTrayMenu, 100);
      }
    },
    { type: 'separator' },
    {
      label: '退出 DeskPulse',
      click: () => {
        _quitting = true;   // 解除窗口 close 拦截 → 真关
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
