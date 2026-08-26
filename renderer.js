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
// 一、主题系统：跟随系统深色/浅色 + 手动切换（localStorage 持久化）
// 仅修改 CSS 变量（data-theme 属性），不涉及主进程
// ============================================================
const THEME_KEY = 'desk-pulse-theme';

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

// 是否存在手动偏好（localStorage 存 'dark'/'light' 视为手动覆盖）
function isManualOverride() {
  const v = localStorage.getItem(THEME_KEY);
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
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
  updateToggleUI();
}

// 初始化：优先 localStorage，否则跟随系统
(function initTheme() {
  const stored = localStorage.getItem(THEME_KEY);
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
  localStorage.removeItem(THEME_KEY);
  applyTheme(getSystemTheme());
  updateToggleUI();
});

// 主进程菜单“切换主题”回调
ipcRenderer.on('toggle-theme', toggleTheme);

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
document.addEventListener('mousemove', (e) => {
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

// ============================================================
// 四、窗口自适应高度（内容变化→通知主进程）
// 仅在高度变化时通知主进程，避免每秒重复 setSize 造成抖动
// ============================================================
let lastHeight = 0;
function resizeWindow() {
  const h = document.body.scrollHeight;
  if (h && h !== lastHeight) {
    lastHeight = h;
    ipcRenderer.send('resize', h);
  }
}
// requestResizeWindow 防抖：避免同一帧内多次触发（如隐藏 TEMP 列+初始化其他 DOM）
let _resizeTimer = null;
function requestResizeWindow() {
  if (_resizeTimer) clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(resizeWindow, 0);
}

// ============================================================
// 五、日期时间（纯前端，每秒更新一次 DOM）
// 格式：2026年08月24日 周一 14:30:25
// ============================================================
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function updateDateTime() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const w = WEEKDAYS[now.getDay()];
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  document.getElementById('datetime').textContent =
    `${y}年${m}月${d}日 ${w} ${hh}:${mm}:${ss}`;
}
updateDateTime();
setInterval(updateDateTime, 1000);

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
// 关键修正：之前汇总 si.networkStats() 全接口，会把 Hyper-V/VMware/WSL/Docker/Loopback
// 等虚拟网卡的流量也算进来，导致数值虚高或重复。改为"默认路由网卡优先"的两级筛选：
//   1) 若能解析到默认路由对应接口 → 只统计该接口
//   2) 否则 → 用 iface / operstate / virtual / 关键字黑名单过滤
// 网速必须通过两次轮询 si.networkStats() 的字节差值计算，不能直接显示累计流量
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

// 缓存默认路由接口名，每 60 秒重新识别一次（VPN 切换/断线重连时会变）
let _defaultIfaceCache = { iface: null, ts: 0 };
const DEFAULT_CACHE_TTL = 60000;

async function detectDefaultIface() {
  const now = Date.now();
  if (_defaultIfaceCache.iface && now - _defaultIfaceCache.ts < DEFAULT_CACHE_TTL) {
    return _defaultIfaceCache.iface;
  }
  try {
    const [gw, ifaces] = await Promise.all([
      si.networkGatewayDefault().catch(() => null),
      si.networkInterfaces().catch(() => [])
    ]);
    let hit = null;
    if (typeof gw === 'string' && gw) {
      // 默认路由网关 IP 与接口 IP 落在同一网段 → 就是这个接口
      const gwParts = gw.split('.').map(Number);
      const gwValid = gwParts.length === 4 && gwParts.every(n => Number.isInteger(n) && n >= 0 && n < 256);
      if (gwValid) {
        for (const n of ifaces || []) {
          if (!n.ip4) continue;
          const ip = n.ip4.split('.').map(Number);
          if (ip.length === 4 && ip[0] === gwParts[0] && ip[1] === gwParts[1] && ip[2] === gwParts[2]) {
            hit = n.iface;
            break;
          }
        }
      }
    }
    _defaultIfaceCache = { iface: hit, ts: now };
    return hit;
  } catch (e) {
    return null;
  }
}

// 给定 networkStats 数组，返回应统计的接口集合（数组子集）
async function pickNetInterfaces(netStats) {
  const defIface = await detectDefaultIface();
  if (defIface) {
    const found = (netStats || []).filter(n => n.iface === defIface);
    if (found.length) return found;
  }
  // 回退：基于接口清单的黑名单筛选
  try {
    const ifaces = (await si.networkInterfaces().catch(() => [])) || [];
    const goodNames = new Set(
      ifaces
        .filter(n => !n.virtual &&
                     !isVirtualName(n.iface) && !isVirtualName(n.ifaceName) &&
                     (n.operstate === 'up' || n.operstate === 'unknown') &&
                     n.ip4 && n.ip4 !== '127.0.0.1')
        .map(n => n.iface)
    );
    // 如果过滤后全没了（兜底），保留 stats 中 operstate===up 的那些
    let picked = (netStats || []).filter(n =>
      goodNames.has(n.iface) ||
      (n.operstate === 'up' && !isVirtualName(n.iface))
    );
    if (picked.length === 0) picked = (netStats || []).filter(n => n.operstate === 'up');
    return picked;
  } catch (e) {
    return netStats || [];
  }
}

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

// ============================================================
// 八、GPU 静态信息（仅加载时取一次，名称/显存不会变）
// 注意：si.graphics() 在不同平台/驱动上 ctrl.name 与 ctrl.model 稳定性不一致，
// Windows 上常见 name=undefined 但 model=有值，必须两者兜底。
// ============================================================
async function initGPU() {
  const el = document.getElementById('gpu');
  try {
    const g = await si.graphics();
    const ctrl = (g.controllers && g.controllers[0]) || null;
    // 型号字段优先 name，回退 model（Windows 常见情形），再回退 vendor
    const model = ctrl && (ctrl.name || ctrl.model || (ctrl.vendor && `显卡 · ${ctrl.vendor}`));
    if (!model) { el.textContent = '—'; return; }
    const parts = [];
    parts.push(model.replace(/\s+/g, ' ').trim());
    // vram 单位判断：systeminformation 在独立显卡上通常返回 GB，
    // 在集成显卡（Intel UHD/Hyper-V 虚拟）上常返回 MB。
    // 简单阈值：> 128 认为是 MB，否则是 GB。
    // 统一格式化为整数 GB（2047MB → 2GB）
    if (ctrl && typeof ctrl.vram === 'number' && ctrl.vram > 0) {
      const v = ctrl.vram;
      const vramGB = (v > 128) ? v / 1024 : v; // >128 视为 MB 单位
      parts.push(`${Math.round(vramGB)}GB`);
    }
    // GPU 温度若可用就附带
    if (ctrl && typeof ctrl.temperatureGpu === 'number' && ctrl.temperatureGpu > 0) {
      parts.push(`${ctrl.temperatureGpu}°C`);
    }
    const text = parts.join(' · ');
    el.textContent = text;
    el.title = text; // 超长名省略号截断时，悬停看完整内容
  } catch (e) {
    el.textContent = '—';
  }
}
initGPU();

// ============================================================
// 九、分指标采集（每指标独立 try/catch，互不影响）
// ============================================================
async function safe(fn) {
  try { await fn(); } catch (e) { /* 单指标失败不影响其他 */ }
}

async function updateCPU() {
  const load = await si.currentLoad();
  document.getElementById('cpu').textContent = `${Math.round(load.currentLoad)}%`;
}

async function updateMem() {
  const mem = await si.mem();
  const pct = (mem.active / mem.total) * 100;
  document.getElementById('mem').textContent =
    `${pct.toFixed(0)}%  ${(mem.active / GB).toFixed(1)}/${(mem.total / GB).toFixed(1)} GB`;
}

async function updateDisk() {
  const list = await si.fsSize();
  const el = document.getElementById('disklist');
  if (!list || !list.length) {
    el.innerHTML = '<div class="disk-item"><span class="m">—</span></div>';
    return;
  }
  el.innerHTML = list.map(f => {
    const used = f.size - f.available;
    const pct = f.size > 0 ? (used / f.size) * 100 : 0;
    // 盘符/挂载点（Windows 形如 "C:"，macOS/Linux 形如 "/"）
    const mount = f.mount || f.fs || '?';
    const m = mount.length > 8 ? mount.slice(0, 8) + '…' : mount;
    return `<div class="disk-item"><span class="m">${m}</span><span class="v">${pct.toFixed(0)}%  ${(used / GB).toFixed(0)}/${(f.size / GB).toFixed(0)}GB</span></div>`;
  }).join('');
}

async function updateBattery() {
  const bat = await si.battery();
  const el = document.getElementById('battery');
  if (bat.hasBattery && bat.hasBattery === true) {
    const parts = [`${bat.percent}%`];
    if (bat.isCharging) parts.push('充电中');
    // timeRemaining：充满/耗尽所需分钟；-1 未知，-2 无限（插电已满）
    const tr = bat.timeRemaining;
    const dur = formatDuration(tr);
    if (dur) parts.push(`约${dur}`);
    el.textContent = parts.join(' · ');
  } else {
    el.textContent = '台式机';
  }
}

async function updateNet() {
  const rawStats = await si.networkStats();
  // 先过滤虚拟/内部网卡，再汇总字节（默认路由优先 + 黑名单兜底两级筛选）
  const net = await pickNetInterfaces(rawStats);
  const totalRx = net.reduce((s, n) => s + (n.rx_bytes || 0), 0);
  const totalTx = net.reduce((s, n) => s + (n.tx_bytes || 0), 0);
  const nowTs = Date.now();

  let rxSpeed = 0;
  let txSpeed = 0;
  if (prevNet.ts > 0) {
    const dt = (nowTs - prevNet.ts) / 1000; // 经过的秒数
    if (dt > 0) {
      // 计算差值；若计数器被重置（新值更小），则用新值作为本次增量
      rxSpeed = totalRx >= prevNet.rx ? (totalRx - prevNet.rx) / dt : totalRx / dt;
      txSpeed = totalTx >= prevNet.tx ? (totalTx - prevNet.tx) / dt : totalTx / dt;
    }
  }
  prevNet = { rx: totalRx, tx: totalTx, ts: nowTs };

  document.getElementById('netdown').textContent = `↓ ${formatSpeed(rxSpeed)}`;
  document.getElementById('netup').textContent = `↑ ${formatSpeed(txSpeed)}`;
}

async function updateHardware() {
  await safe(updateCPU);
  await safe(updateMem);
  await safe(updateDisk);
  await safe(updateBattery);
  await safe(updateNet);
  resizeWindow();
}

// 页面加载时立即执行一次，避免空白；之后每秒刷新
updateHardware();
setInterval(updateHardware, 1000);
