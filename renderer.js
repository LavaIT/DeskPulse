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

// 主进程菜单“切换主题”回调
ipcRenderer.on('toggle-theme', toggleTheme);

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
  // 通知主进程调整窗口宽度 + 切换鼠标穿透策略（紧凑模式整区可拖不穿透）
  ipcRenderer.send('set-compact', on, COMPACT_WIDTH, document.body.scrollHeight);
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
}

async function updateMem() {
  const mem = await si.mem();
  const pct = (mem.active / mem.total) * 100;
  const pctText = `${pct.toFixed(0)}%`;
  document.getElementById('mem').textContent =
    `${pctText}  ${(mem.active / GB).toFixed(1)}/${(mem.total / GB).toFixed(1)} GB`;
  // 紧凑模式只写百分比
  const compact = document.getElementById('mem-compact');
  if (compact) compact.textContent = pctText;
  // 缓存内存总量（不变的静态值，下次启动可立即渲染）
  if (hwCache.memTotal !== mem.total) {
    hwCache.memTotal = mem.total;
    _hwCacheDirty = true;
  }
}

async function updateDisk() {
  const list = await si.fsSize();
  const el = document.getElementById('disklist');
  if (!list || !list.length) {
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
  // 紧凑模式同步
  const dc = document.getElementById('netdown-compact');
  const uc = document.getElementById('netup-compact');
  if (dc) dc.textContent = rxText;
  if (uc) uc.textContent = txText;
}

// GPU 实时使用率：PowerShell Win32_PerfFormattedData_GPUAdapter（Windows 专用）
// 非管理员下也能读，失败时显示 "—"，不影响其他指标
async function updateGPU() {
  let usageText = '—';
  try {
    const out = await execCmd(
      'powershell -NoProfile -Command "Get-CimInstance Win32_PerfFormattedData_GPUAdapter_GPUAdapter | Select-Object Name,UtilizationPercentage | ConvertTo-Json"',
      3000
    );
    const data = JSON.parse(out.trim());
    const list = Array.isArray(data) ? data : [data];
    let best = 0;
    for (const item of list) {
      if (!item) continue;
      const util = Number(item.UtilizationPercentage);
      if (!Number.isFinite(util)) continue;
      if (util > best) best = util; // 多 GPU 时取最高
    }
    if (best > 0) usageText = `${Math.round(best)}%`;
  } catch (e) { /* 拿不到就保持 — */ }
  const gpuEl = document.getElementById('gpu-compact');
  if (gpuEl) gpuEl.textContent = usageText;
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
      safe(updateNet, 3500),
      safe(updateGPU, 3000)
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

// 慢指标（磁盘/电池）并行采集，每 10 秒刷新（变化慢，减少 WMI 开销）
async function updateSlow() {
  await Promise.all([
    safe(updateDisk, 3000),
    safe(updateBattery, 3000)
  ]);
  if (_hwCacheDirty) {
    _hwCacheDirty = false;
    ipcRenderer.sendSync('set-hw-cache', hwCache);
  }
  resizeWindow();
}

// 页面加载时立即执行一次，避免空白；之后快指标 1s、慢指标 10s
updateFast();
updateSlow();
setInterval(updateFast, 1000);
setInterval(updateSlow, 10000);
