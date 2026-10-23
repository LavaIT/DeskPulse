// renderer.js —— 渲染进程
// 职责：深色/浅色主题（跟随系统 + 手动切换 + 菜单触发）、日期时间更新、
//       硬件数据采集（CPU/温度/GPU/内存/存储多盘/电池续航/网速，每秒刷新）、
//       窗口自适应高度、鼠标穿透动态切换、菜单按钮。
// 由于 main.js 中开启了 nodeIntegration，可直接 require Node 模块。

const { ipcRenderer, shell } = require('electron');
const os = require('os');
const fs = require('fs');
const si = require('systeminformation');

// ============================================================
// 偏好读写封装（替代 localStorage，持久化到 userData/preferences.json）
// ============================================================
function getPref(key) {
  return ipcRenderer.sendSync('get-pref', key);
}
function setPref(key, value) {
  ipcRenderer.sendSync('set-pref', key, value);
}

// 启动时读取硬件缓存（GPU 名称/显存、内存总量、磁盘列表 — 不变的静态信息）
const hwCache = ipcRenderer.sendSync('get-hw-cache');

// ============================================================
// 一、主题系统：跟随系统深色/浅色 + 手动切换（偏好文件持久化）
// 仅修改 CSS 变量（data-theme 属性），不涉及主进程
// ============================================================
const THEME_KEY = 'theme';

// 动态创建主题切换按钮（不修改 index.html），插入到 .widget 右下角
const toggleBtn = document.createElement('button');
toggleBtn.className = 'theme-toggle';
toggleBtn.setAttribute('aria-label', '切换主题');
document.querySelector('.widget').appendChild(toggleBtn);

// 检测系统主题偏好
const mql = window.matchMedia('(prefers-color-scheme: dark)');

function getSystemTheme() {
  return mql.matches ? 'dark' : 'light';
}

// 将主题写到 <html data-theme="...">，CSS 变量随之切换
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
}

function currentTheme() {
  return document.documentElement.getAttribute('data-theme') || getSystemTheme();
}

// 是否存在手动偏好（偏好文件存 'dark'/'light' 视为手动覆盖）
function isManualOverride() {
  const v = getPref(THEME_KEY);
  return v === 'dark' || v === 'light';
}

// 同步按钮图标与提示文案（几何符号 ◐/●/○，非 emoji，适配专业风）
function updateToggleUI() {
  const t = currentTheme();
  if (isManualOverride()) {
    // 手动模式：实心圆=深色 / 空心圆=浅色
    toggleBtn.textContent = t === 'dark' ? '●' : '○';
    toggleBtn.title = `当前：${t === 'dark' ? '深色' : '浅色'}（手动）｜点击切换，双击恢复跟随系统`;
  } else {
    // 跟随系统：半圆表示自动
    toggleBtn.textContent = '◐';
    toggleBtn.title = `当前：跟随系统（${t === 'dark' ? '深色' : '浅色'}）｜点击手动切换`;
  }
}

// 切换主题（按钮点击与菜单都走这个）
function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  setPref(THEME_KEY, next);
  applyTheme(next);
  updateToggleUI();
}

// 初始化：优先偏好文件，否则跟随系统
(function initTheme() {
  const stored = getPref(THEME_KEY);
  const initial = isManualOverride() ? stored : getSystemTheme();
  applyTheme(initial);
  updateToggleUI();
})();

// 监听系统主题变化（实时）：仅在未手动覆盖时跟随
mql.addEventListener('change', (e) => {
  if (isManualOverride()) return; // 用户已手动设置，不跟随系统
  const t = e.matches ? 'dark' : 'light';
  applyTheme(t);
  updateToggleUI();
});

// 按钮点击：手动切换
toggleBtn.addEventListener('click', toggleTheme);

// 双击：清除手动偏好，恢复跟随系统
toggleBtn.addEventListener('dblclick', (e) => {
  e.preventDefault();
  setPref(THEME_KEY, null);
  applyTheme(getSystemTheme());
  updateToggleUI();
});

// 主进程菜单"切换主题"回调
ipcRenderer.on('toggle-theme', toggleTheme);

// 设置窗口发来的指定主题（null=跟随系统 / 'dark' / 'light'）
ipcRenderer.on('apply-theme', (_e, theme) => {
  if (theme === null || theme === undefined) {
    // 清除手动偏好，跟随系统
    setPref(THEME_KEY, null);
    applyTheme(getSystemTheme());
  } else {
    setPref(THEME_KEY, theme);
    applyTheme(theme);
  }
  updateToggleUI();
});

// ============================================================
// 一-1b、玻璃效果：data-glass 属性控制面板透明度与模糊风格
// ============================================================
const GLASS_KEY = 'glass';
let _liquidHL = null;  // 液态玻璃高光追踪状态

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

// 液态玻璃：鼠标跟随高光 + 3D 透视倾斜
function enableLiquidHighlight() {
  if (_liquidHL) return;
  const widget = document.querySelector('.widget');
  if (!widget) return;

  const onMove = (e) => {
    const r = widget.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    // 径向高光位置
    widget.style.setProperty('--mx', x + 'px');
    widget.style.setProperty('--my', y + 'px');
    // 3D 透视倾斜：朝鼠标方向微倾
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

// 监听设置窗口发来的玻璃效果切换
ipcRenderer.on('apply-glass', (_e, val) => {
  applyGlass(val);
  setPref(GLASS_KEY, val);
});

// 初始化：从偏好读取
(function initGlass() {
  const stored = getPref(GLASS_KEY);
  applyGlass(stored || 'frost');
})();

// ============================================================
// 一-1b-2、面板透明度：滑块控制 --panel-opacity（0-1）
// 仅影响 off / frost 模式的面板背景 alpha；
// liquid 模式背景为硬编码 rgba，天然不受滑块影响（避免破坏折射）。
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
  applyPanelOpacity(stored);  // undefined → 1（默认完全不透明）
})();

// ============================================================
// 一-1b-3、字体选择：用户可指定 --font-family
// 'default' = 恢复 CSS 默认字体栈；其他值直接写入 CSS 变量
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
// 一-1c、配色预设：html[data-preset] 覆盖 --accent-color
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
// 一-1c-2、主题色自定义：5 个预设之外加一个色盘选择器
// 选完写入 --accent-color，覆盖预设
// ============================================================
const CUSTOM_ACCENT_KEY = 'customAccent';

function applyCustomAccent(color) {
  if (!color || typeof color !== 'string' || !/^#[0-9a-fA-F]{3,8}$/.test(color)) {
    // 清除自定义色，恢复预设
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
// 一-1d、显示方式：百分比 / 具体数值
// ============================================================
const DISPLAY_MODE_KEY = 'displayMode';
let _displayMode = 'percent'; // 'percent' | 'value'

function isValueMode() {
  return _displayMode === 'value';
}

function applyDisplayMode(val) {
  _displayMode = (val === 'value') ? 'value' : 'percent';
  // 立即重渲染已有的数据行（不重新采集，只改显示文本）
  const memEl = document.getElementById('mem');
  const memCompact = document.getElementById('mem-compact');
  const diskEl = document.getElementById('disklist');
  // CPU 永远是百分比，无需重渲染
  // 触发一次内存和磁盘的更新以应用新格式（数据仍在内存中，直接重渲染即可）
  // 这里简单做法：标记后让下一轮 updateSlow/updateFast 自然刷新；
  // 但为了即时响应，直接重跑这两个函数
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
// 一-1e、可选指标开关：系统运行时间 / WiFi 信号强度（默认关闭）
// ============================================================
let lastHeight = 0;  // 窗口高度缓存（必须在 resizeWindow 首次调用前初始化）
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
// 一-1f、迷你趋势图（Sparkline）：CPU/内存/网速最近 60 秒小折线图
// 默认关闭，在设置里开关。开启后在数值旁画 60×16 / 80×16 的 Canvas 折线
// ============================================================
const SPARK_KEY = 'sparkline';
const SPARK_MAX = 60;  // 环形缓冲区容量（60 个采样点 = 60 秒）
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
  // 折线
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
  // 下方填充半透明
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
// 一-1g-2、数据维度增强（默认全部关闭）
//   1. CPU 每核负载条  — CPU 行下方一排小横条，每个逻辑核心一条
//   2. 磁盘读写速度    — DISK 每个盘符附加 ↓12M/s ↑3M/s
//   3. GPU 显存占用    — GPU 行显示当前显存/总量
//   4. 内存规格        — MEM 行下方小字 DDR4 3200MHz
// ============================================================
const SHOW_CPUCORES_KEY = 'showCpuCores';
const SHOW_DISKIO_KEY   = 'showDiskIO';
const SHOW_GPURAM_KEY   = 'showGpuRam';
const SHOW_MEMSPEC_KEY  = 'showMemSpec';

let _cpuCoresOn = false;  // 是否启用 CPU 每核负载条
let _diskIOOn   = false;  // 是否启用磁盘读写速度
let _gpuRamOn   = false;  // 是否启用 GPU 显存占用
let _memSpecOn  = false;  // 是否启用内存规格
let _coreBarsCreated = false;  // CPU 每核负载条 DOM 是否已创建（提前声明，避免 TDZ）

function setCpuCoresVisible(on) {
  _cpuCoresOn = !!on;
  const el = document.getElementById('cpucores');
  if (el) el.style.display = _cpuCoresOn ? '' : 'none';
  // 重置已创建标记：关闭后再开启需要重新生成
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
  // 立即触发一次 GPU 采集以填充显存字段
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
// 一-1g、指标显隐：用户可在设置中隐藏不需要的行
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
// 一-1g-2、双击指标行快速隐藏 + Toast 提示
// 双击任意一行直接隐藏，进设置 → 显示项 可恢复
// ============================================================

// 临时 toast：底部居中浮层，3 秒后淡出
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

// 行 id → 中文名映射（用于 toast 提示）
const ROW_LABELS = {
  'row-gpu': 'GPU',
  'row-disk': '存储',
  'row-net': '网速',
  'cpumodel': 'CPU 型号',
  'row-power': '电源'
};

function _quickHide(metricId) {
  if (!VIS_METRICS.includes(metricId)) return;
  // 通过 IPC 持久化 + 广播，复用现有 visibility 系统
  ipcRenderer.send('set-visibility', metricId, true);
  applyVisibility(metricId, true);  // 立即响应，不等 IPC 往返
  const label = ROW_LABELS[metricId] || metricId;
  _showToast(`已隐藏 ${label}（设置 → 显示项 可恢复）`);
}

(function initQuickHide() {
  // 给每个可隐藏的行加 dblclick 监听
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
// 一-2、紧凑模式开关：data-compact 属性 + 偏好持久化
// ============================================================
const COMPACT_KEY = 'compact';
const COMPACT_WIDTH = 220;  // 紧凑模式窗口宽度

function isCompact() {
  return document.querySelector('.widget').getAttribute('data-compact') === 'true';
}

function applyCompact(on) {
  const w = document.querySelector('.widget');
  w.setAttribute('data-compact', on ? 'true' : 'false');
  // 通知主进程切换窗口宽度 + 鼠标穿透策略（紧凑模式整区可拖不穿透）
  ipcRenderer.send('set-compact', on, COMPACT_WIDTH);
  // 高度交给 resizeWindow，它会在 DOM 渲染后取准确 scrollHeight
  resizeWindow();
}

// 主进程触发紧凑模式切换
ipcRenderer.on('toggle-compact', () => {
  const next = !isCompact();
  setPref(COMPACT_KEY, next);
  applyCompact(next);
});

// 主进程同步当前紧凑状态（设置窗口 / 托盘菜单勾选用）
ipcRenderer.on('set-compact-state', (_e, on) => {
  applyCompact(on);
});

// 初始化紧凑模式：从偏好读取
(function initCompact() {
  const stored = getPref(COMPACT_KEY);
  if (stored === true) {
    applyCompact(true);
  }
})();

// ============================================================
// 二、菜单按钮（⋮）：触发右键式菜单（切换主题 / 重置位置 / 退出）
// 用按钮而非右键，因为窗口主体鼠标穿透 + 顶部拖拽区，右键不可靠
// ============================================================
const menuBtn = document.createElement('button');
menuBtn.className = 'menu-btn';
menuBtn.setAttribute('aria-label', '菜单');
menuBtn.textContent = '⋮';
menuBtn.title = '菜单（切换主题 / 重置位置 / 退出）';
document.querySelector('.widget').appendChild(menuBtn);

menuBtn.addEventListener('click', () => ipcRenderer.send('show-context-menu'));
// 右键在可接收事件的区域（按钮、拖拽区）也弹出菜单
document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  ipcRenderer.send('show-context-menu');
});

// ============================================================
// 三、鼠标穿透动态切换
// 整个窗口默认穿透（setIgnoreMouseEvents(true, {forward:true})），
// 但鼠标进入顶部 50px 拖拽区、或悬停在两个按钮上时，临时关闭穿透。
// ============================================================
// mousemove 节流：用 requestAnimationFrame 合并同一帧内的多次 mousemove，
// 避免高频移动时每事件都调 getBoundingClientRect 造成不必要开销
let _mouseRAF = false;
let _mouseEvent = null;
document.addEventListener('mousemove', (e) => {
  _mouseEvent = e; // 保留最新事件
  if (_mouseRAF) return;
  _mouseRAF = true;
  requestAnimationFrame(() => {
    _mouseRAF = false;
    const e = _mouseEvent;
    if (!e) return;
    const inDragZone = e.clientY < 50;       // 顶部 50px 以内
    // 鼠标在任一按钮范围内时，也需关闭穿透以便点击
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
    ipcRenderer.send('set-ignore-mouse', !(inDragZone || onButton)); // 任一区域→不穿透；其余→穿透
  });
});

// ============================================================
// 四、窗口自适应高度（内容变化→通知主进程）
// 仅在高度变化时通知主进程，避免每秒重复 setSize 造成抖动
// ============================================================
function resizeWindow() {
  const h = document.body.scrollHeight;
  if (h && h !== lastHeight) {
    lastHeight = h;
    ipcRenderer.send('resize', h);
  }
}
// ============================================================
// 四-2、阈值变色告警：CPU/MEM/GPU 超过阈值时数值变红
// 阈值可在设置中调整，默认 80
// ============================================================
const ALERT_THRESHOLD_KEY = 'alertThreshold';
let _alertThreshold = 80;  // 默认 80%

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
// 五、日期时间（纯前端，每秒更新一次 DOM）
// 支持用户自定义：12/24 小时制、是否显示秒、日期格式
// ============================================================
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const CLOCK_HOUR_KEY = 'clockHour';       // '24' | '12'，默认 '24'
const CLOCK_SECONDS_KEY = 'clockSeconds'; // bool，默认 true
const DATE_FMT_KEY = 'dateFormat';       // 'zh' | 'iso' | 'us' | 'dash'，默认 'zh'

let _clockHour = '24';
let _clockSeconds = true;
let _dateFormat = 'zh';

function applyClockFormat() {
  // 立即刷新一次，避免等到下一秒
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
  _clockSeconds = (s === false) ? false : true;  // 默认 true
  const d = getPref(DATE_FMT_KEY);
  _dateFormat = ['zh', 'iso', 'us', 'dash'].includes(d) ? d : 'zh';
})();

function updateDateTime() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const w = WEEKDAYS[now.getDay()];

  // 日期部分
  let datePart;
  switch (_dateFormat) {
    case 'iso':  datePart = `${y}-${m}-${d}`; break;
    case 'us':   datePart = `${m}/${d}/${y}`; break;
    case 'dash': datePart = `${y}.${m}.${d} ${w}`; break;
    case 'zh':
    default:     datePart = `${y}年${m}月${d}日 ${w}`; break;
  }

  // 时间部分：12/24 小时制 + 可选秒
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

// 系统运行时间（uptime），格式化：3d 12h 5m
function updateUptime() {
  const el = document.getElementById('uptime');
  if (!el || el.style.display === 'none') return;
  const secs = os.uptime();
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  let text;
  if (d > 0) text = `已运行 ${d}天 ${h}时 ${m}分`;
  else if (h > 0) text = `已运行 ${h}时 ${m}分`;
  else text = `已运行 ${m}分`;
  el.textContent = text;
}
setInterval(updateUptime, 60000); // 每分钟刷新

// ============================================================
// 六、操作系统名称
// Windows：os.release() 形如 "10.0.22000"，build 号 >= 22000 为 Windows 11
// ============================================================
function getOSName() {
  const platform = process.platform;
  if (platform === 'win32') {
    const release = os.release(); // 形如 "10.0.22631"
    const parts = release.split('.');
    const build = parts.length >= 3 ? parseInt(parts[2], 10) : 0;
    return build >= 22000 ? 'Windows 11' : 'Windows 10';
  }
  if (platform === 'darwin') return 'macOS';
  return 'Linux';
}
document.getElementById('osname').textContent = getOSName();

// ============================================================
// 七、网速：网卡白名单筛选 + 工具函数
// 性能优化：接口识别（WMI 查询）移出每秒热路径，改为后台 60s 刷新一次。
// 热路径只调 si.networkStats()（纯计数器读取，不走 WMI），按缓存接口名过滤。
// ============================================================
let prevNet = { rx: 0, tx: 0, ts: 0 };
const GB = 1024 * 1024 * 1024;

// 虚拟/环回/专用接口关键字黑名单（iface / ifaceName 任一命中即排除）
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

// 缓存活跃接口名（后台刷新，不在每秒热路径里调 WMI）
let _activeIface = null;

async function refreshActiveIface() {
  try {
    const [gw, ifaces] = await Promise.all([
      si.networkGatewayDefault().catch(() => null),
      si.networkInterfaces().catch(() => [])
    ]);
    // 1) 默认路由网关 IP 与接口 IP 落在同网段 → 就是它
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
    // 2) 回退：第一个非虚拟、up、有 ip4 的接口
    for (const n of ifaces || []) {
      if (!n.virtual && !isVirtualName(n.iface) && !isVirtualName(n.ifaceName) &&
          (n.operstate === 'up' || n.operstate === 'unknown') &&
          n.ip4 && n.ip4 !== '127.0.0.1') {
        _activeIface = n.iface;
        return;
      }
    }
  } catch (e) { /* 静默失败，下次刷新重试 */ }
}

// 启动时识别一次，之后每 60s 后台刷新（VPN 切换/断线重连时自动跟上）
refreshActiveIface();
setInterval(refreshActiveIface, 60000);

// 把字节数/秒格式化为 B/s、KB/s 或 MB/s
function formatSpeed(bytesPerSec) {
  if (bytesPerSec < 1024) {
    return `${bytesPerSec.toFixed(0)} B/s`;
  }
  if (bytesPerSec < 1024 * 1024) {
    return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  }
  return `${(bytesPerSec / (1024 * 1024)).toFixed(2)} MB/s`;
}

// 把分钟数格式化为 "1h12m" 或 "45m"
function formatDuration(minutes) {
  if (minutes <= 0) return '';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h > 0) return `${h}h${m}m`;
  return `${m}m`;
}

// 标记 hwCache 是否有变更，待采集结束后统一写一次文件
// 提前声明，供 initCPUModel / initGPU 等静态函数设置
let _hwCacheDirty = false;

// ============================================================
// 八、CPU 静态型号（仅加载时取一次，用 os.cpus() 同步读取，不走 WMI）
// ============================================================
function initCPUModel() {
  const el = document.getElementById('cpumodel');

  // 有缓存 → 直接渲染
  if (hwCache.cpuModel) {
    el.textContent = hwCache.cpuModel;
    el.title = hwCache.cpuModel;
    return;
  }

  // os.cpus() 是同步的，不走 WMI，直接取
  try {
    const cpus = os.cpus();
    if (cpus && cpus.length > 0 && cpus[0].model) {
      // 清理冗余标记：Intel(R) Core(TM) i7-9700K CPU @ 3.60GHz → Intel Core i7-9700K @ 3.60GHz
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
  } catch (e) { /* 静默失败 */ }

  el.textContent = '—';
}
initCPUModel();

// ============================================================
// 八-1b、内存静态规格（DDR4 3200MHz）— 仅加载时取一次，缓存到 hwCache
// ============================================================
function initMemSpec() {
  const el = document.getElementById('memspec');
  if (!el || !_memSpecOn) return;

  // 1) 有缓存 → 直接渲染
  if (hwCache.memSpec) {
    el.textContent = hwCache.memSpec;
    el.title = hwCache.memSpec;
    return;
  }

  // 2) 无缓存 → si.memLayout() 异步查询（带 3s 超时）
  (async () => {
    try {
      const layout = await Promise.race([
        si.memLayout(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000))
      ]);
      if (layout && layout.length > 0) {
        // 多 DIMM 时取第一条；clockSpeed 单位 MHz
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
// 八-2、GPU 静态信息（仅加载时取一次，名称/显存不会变）
// 性能优化：有缓存 → 直接渲染，跳过 si.graphics()（WMI 查询太慢）
//           无缓存 → 先用 PowerShell Win32_VideoController（快），再回退 si.graphics()
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

  // 1) 有缓存 → 直接渲染，不再查询（GPU 型号不会变）
  if (hwCache.gpu && hwCache.gpu.model) {
    const parts = [hwCache.gpu.model];
    if (hwCache.gpu.vram) parts.push(`${hwCache.gpu.vram}GB`);
    const text = parts.join(' · ');
    el.textContent = text;
    el.title = text;
    return; // 跳过 si.graphics()，避免几分钟卡死
  }

  // 2) 无缓存 → 先用 PowerShell WMI 查（比 si.graphics 快 10 倍）
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
      // AdapterRAM 单位是字节，但 Win32 32 位字段上限 4GB
      if (ctrl.AdapterRAM && ctrl.AdapterRAM > 0) {
        vramGB = Math.round(ctrl.AdapterRAM / (1024 * 1024 * 1024));
        if (vramGB > 4) vramGB = 4; // 32 位溢出保护
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
  } catch (e) { /* PowerShell 失败，继续回退 */ }

  // 3) 回退：si.graphics() 带 3s 超时（最后手段）
  try {
    const g = await Promise.race([
      si.graphics(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000))
    ]);
    const ctrl = (g.controllers && g.controllers[0]) || null;
    const model = ctrl && (ctrl.name || ctrl.model || (ctrl.vendor && `显卡 · ${ctrl.vendor}`));
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
  } catch (e) { /* 超时：保持 '—' */ }

  el.textContent = '—';
}
initGPU();

// ============================================================
// 九、分指标采集（每指标独立 try/catch，互不影响）
// ============================================================
async function safe(fn, timeoutMs = 3000) {
  try {
    await Promise.race([
      fn(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs))
    ]);
  } catch (e) { /* 单指标失败/超时不影响其他 */ }
}

async function updateCPU() {
  const load = await si.currentLoad();
  const pct = `${Math.round(load.currentLoad)}%`;
  document.getElementById('cpu').textContent = pct;
  // 紧凑模式同步
  const compact = document.getElementById('cpu-compact');
  if (compact) compact.textContent = pct;
  // 阈值变色
  _setAlert(document.getElementById('cpu'), load.currentLoad);
  _setAlert(compact, load.currentLoad);
  // Sparkline 数据采集
  _pushSpark('cpu', load.currentLoad);
  _drawSpark('spark-cpu', 'cpu', 100);
  // 每核负载条
  updateCPUCores(load);
}

// CPU 每核负载条：利用 si.currentLoad().cpus[] 数组
function updateCPUCores(load) {
  if (!_cpuCoresOn) return;  // 开关关闭时跳过
  const container = document.getElementById('cpucores');
  if (!container) return;
  const cpus = load.cpus;
  if (!cpus || !cpus.length) return;
  // 首次创建 DOM
  if (!_coreBarsCreated) {
    container.innerHTML = cpus.map(() =>
      '<div class="core-bar"><div class="core-bar-fill" style="width:0%"></div></div>'
    ).join('');
    _coreBarsCreated = true;
  }
  // 更新每条宽度
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
  // 百分比模式：38%；数值模式：3.2/8.0 GB
  document.getElementById('mem').textContent = isValueMode() ? valText : pctText;
  // 紧凑模式只写百分比
  const compact = document.getElementById('mem-compact');
  if (compact) compact.textContent = pctText;
  // 阈值变色
  _setAlert(document.getElementById('mem'), pct);
  _setAlert(compact, pct);
  // Sparkline 数据采集
  _pushSpark('mem', pct);
  _drawSpark('spark-mem', 'mem', 100);
  // 缓存内存总量（不变的静态值，下次启动可立即渲染）
  if (hwCache.memTotal !== mem.total) {
    hwCache.memTotal = mem.total;
    _hwCacheDirty = true;
  }
}

async function updateDisk() {
  // 并行：fsSize（容量）+ 可选的磁盘 IO 速度（WMI）
  const [raw, ioMap] = await Promise.all([
    si.fsSize(),
    _diskIOOn ? _readDiskIOSpeeds() : Promise.resolve({})
  ]);
  // 只保留有实际存储空间的盘（过滤空光驱、无介质读卡器、无效盘符等 size=0 的条目）
  const list = (raw || []).filter(f => f && f.size > 0);
  const el = document.getElementById('disklist');
  if (!list.length) {
    // si.fsSize 暂时失败，用缓存盘列表兜底显示总量
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
  // 缓存磁盘静态信息（mount + size 不变，只有 available 在变）
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
    // 盘符/挂载点（Windows 形如 "C:"，macOS/Linux 形如 "/"）
    const mount = f.mount || f.fs || '?';
    const m = mount.length > 8 ? mount.slice(0, 8) + '…' : mount;
    // 百分比模式：45%；数值模式：230/512 GB
    const v = isValueMode()
      ? `${(used / GB).toFixed(0)}/${(f.size / GB).toFixed(0)} GB`
      : `${pct.toFixed(0)}%`;
    // 附加磁盘 IO 速度：↓12M/s ↑3M/s
    let ioText = '';
    if (_diskIOOn && ioMap && ioMap[mount]) {
      const io = ioMap[mount];
      ioText = `  ↓${_fmtDiskSpeed(io.read)} ↑${_fmtDiskSpeed(io.write)}`;
    }
    return `<div class="disk-item"><span class="m">${m}</span><span class="v">${v}${ioText}</span></div>`;
  }).join('');
}

// 磁盘读写速度查询：PowerShell WMI PerfDisk
// Name 形如 "0 C:" 或 "_Total"，用正则提取盘符（如 "C:"）
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

// 格式化磁盘读写速度：B/s → K/s 或 M/s（紧凑显示，节省宽度）
function _fmtDiskSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec < 1024) return '0K/s';
  if (bytesPerSec < 1024 * 1024) return (bytesPerSec / 1024).toFixed(0) + 'K/s';
  return (bytesPerSec / (1024 * 1024)).toFixed(0) + 'M/s';
}

async function updateBattery() {
  const bat = await si.battery();
  const row = document.getElementById('row-power');
  if (!row) return;  // 行不存在或被用户手动隐藏，跳过
  const el = document.getElementById('battery');
  if (bat.hasBattery && bat.hasBattery === true) {
    // 仅在未被用户手动隐藏时才显示
    if (getPref('hidden.row-power') !== true) row.style.display = '';
    const parts = [`${bat.percent}%`];
    if (bat.isCharging) parts.push('充电中');
    const tr = bat.timeRemaining;
    const dur = formatDuration(tr);
    if (dur) parts.push(`约${dur}`);
    el.textContent = parts.join(' · ');
  } else {
    row.style.display = 'none';
  }
}

async function updateNet() {
  const rawStats = await si.networkStats();
  // 时间戳在数据读取后立即取，不包含后续过滤时间，保证 dt 精确
  const nowTs = Date.now();

  // 按缓存的活跃接口名过滤（纯内存比较，不走 WMI）
  let net;
  if (_activeIface) {
    net = rawStats.filter(n => n.iface === _activeIface);
  }
  if (!net || !net.length) {
    // 回退：operstate up + 非虚拟名
    net = rawStats.filter(n => n.operstate === 'up' && !isVirtualName(n.iface));
  }
  if (!net.length) net = rawStats; // 最后兜底

  const totalRx = net.reduce((s, n) => s + (n.rx_bytes || 0), 0);
  const totalTx = net.reduce((s, n) => s + (n.tx_bytes || 0), 0);

  let rxSpeed = 0;
  let txSpeed = 0;
  if (prevNet.ts > 0) {
    const dt = (nowTs - prevNet.ts) / 1000;
    if (dt > 0.1) { // 防止 dt 过小导致除零（<100ms 跳过本次）
      rxSpeed = totalRx >= prevNet.rx ? (totalRx - prevNet.rx) / dt : 0;
      txSpeed = totalTx >= prevNet.tx ? (totalTx - prevNet.tx) / dt : 0;
    }
  }
  prevNet = { rx: totalRx, tx: totalTx, ts: nowTs };

  const rxText = `↓ ${formatSpeed(rxSpeed)}`;
  const txText = `↑ ${formatSpeed(txSpeed)}`;
  document.getElementById('netdown').textContent = rxText;
  document.getElementById('netup').textContent = txText;
  // Sparkline 数据采集（上下行合计，bytes/s → KB/s 便于可视化）
  _pushSpark('net', (rxSpeed + txSpeed) / 1024);
  _drawSpark('spark-net', 'net', null);
  // 紧凑模式同步
  const dc = document.getElementById('netdown-compact');
  const uc = document.getElementById('netup-compact');
  if (dc) dc.textContent = rxText;
  if (uc) uc.textContent = txText;
}

// WiFi 信号强度：si.wifiConnections() 取当前连接的 signalQuality（0-100）
// 非 WiFi 环境或查询失败时隐藏
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
    // 没连 WiFi：隐藏
    el.style.display = 'none';
  } catch (e) {
    el.style.display = 'none';
  }
}

// GPU 实时使用率 + 可选显存占用：PowerShell Win32_PerfFormattedData_GPUAdapter（Windows 专用）
// 非管理员下也能读，失败时显示 "—"，不影响其他指标
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
    // 显存占用：3.2G / 8G（总量来自 hwCache.gpu.vram，单位 GB）
    if (_gpuRamOn && bestUsedBytes > 0) {
      const usedGB = bestUsedBytes / (1024 * 1024 * 1024);
      const totalGB = (hwCache.gpu && hwCache.gpu.vram) ? hwCache.gpu.vram : null;
      vramText = totalGB
        ? `${usedGB.toFixed(1)}G / ${totalGB}G`
        : `${usedGB.toFixed(1)}G`;
    }
  } catch (e) { /* 拿不到就保持 — */ }
  const gpuEl = document.getElementById('gpu-compact');
  if (gpuEl) gpuEl.textContent = usageText;
  // 阈值变色（紧凑模式 GPU 使用率）
  _setAlert(gpuEl, bestUtil);
  const vramEl = document.getElementById('gpuram');
  if (vramEl && _gpuRamOn) {
    vramEl.textContent = vramText || '—';
  }
}

// 快指标（CPU/内存/网速）并行采集 + 每指标 3 秒独立超时，每秒刷新
// _updating guard：防止上一轮还没跑完 setInterval 就触发下一轮（WMI 慢时排队导致 dt 趋零）
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

// 慢指标（磁盘/电池/WiFi）并行采集，每 10 秒刷新（变化慢，减少 WMI 开销）
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

// 页面加载时立即执行一次，避免空白；之后快指标 1s、慢指标 10s、GPU 使用率 3s
updateFast();
updateSlow();
updateGPU();
setInterval(updateFast, 1000);
setInterval(updateSlow, 10000);
setInterval(updateGPU, 3000);
