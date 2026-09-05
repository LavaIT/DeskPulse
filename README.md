# DeskPulse

> 一款极简的 Windows 桌面系统监控小组件，始终置于顶层。
> 基于 Electron 构建 · 透明窗口 · 无边框 · 系统托盘 · 支持浅色 / 深色双主题。

---

## 功能特性

- **稳定置顶**：高于开始菜单、通知中心、全屏应用和 UWP 悬浮窗。
- **透明无边框**：无窗口装饰，无缝融入桌面。
- **鼠标穿透**：默认穿透到桌面；拖拽区和操作区悬停时自动解除穿透，兼顾移动与遮挡。
- **浅色 / 深色双主题**：自动跟随系统配色，同时支持在小组件菜单与托盘菜单中手动切换。
- **系统托盘**：一键显示/隐藏、切换主题、重置位置、设置、关于、退出。关闭窗口会退到托盘，不退出进程。
- **开机自启**：设置窗口中开关控制，通过 Electron `app.setLoginItemSettings` 写入 Windows 注册表。
- **位置记忆**：拖拽结束后防抖落盘，下次启动自动回到上次位置；离屏时自动回落到右上角默认值。
- **紧凑模式**：游戏/追剧时切换为单行迷你面板（CPU / GPU / MEM / 网速），仅占用屏幕一角。偏好自动保存。

### 监控指标

| 指标 | 说明 |
|---|---|
| 日期与时间 | 本地日期、星期、实时时钟 |
| 系统信息 | Windows 版本 + 内核平台 |
| 电池 | 剩余电量百分比 + 充电状态（台式机显示"台式机"） |
| CPU | 实时使用率 % + CPU 型号 |
| 内存 | 已用 / 总量 GB |
| 存储 | 各盘符已用 / 总量 GB |
| 网络 | 实时上行 / 下行速率（自动选择已连接的物理网卡） |
| GPU | 厂商、型号、显存 GB；紧凑模式下额外显示实时使用率 % |

---

## 截图

> _截图待补充_。运行后效果：主屏右上角一张 320 像素宽的卡片。

---

## 版本历史

| 版本 | 主要变更 |
|---|---|
| v1.0.0 | 首发：8 项监控指标、双主题、系统托盘、窗口位置记忆 |
| v1.0.1 | 5 指标并行采集（Promise.all）、每指标 3s 独立超时、NET 行省略号修复 |
| v1.0.2 | 网速失真修复、GPU 查询卡死修复、设置窗口 + 关于对话框、偏好持久化、硬件缓存 |
| v1.0.3 | 刷新频率分层（磁盘/电池 10s）、CPU 型号显示、设置窗口版本号动态读取、主题同步 |
| v1.0.4 | 紧凑模式（单行迷你面板）、GPU 实时使用率、设置窗口移除默认菜单栏 |

---

## 快速开始

### 运行环境要求

- Node.js **≥ 18**（推荐 LTS）
- npm **≥ 9**

### 开发模式运行

```bash
# 1. 安装依赖
npm install

# 2. 启动小组件
npm start
```

启动后小组件出现在主屏右上角。按住顶部拖拽条可移动位置，点击右上角 `⋮` 弹出操作菜单。

---

## 打包发布

打包产物包含 **NSIS 安装包** 与 **便携版单文件 exe**，同时生成一份解压目录用于快速调试。全部产物输出到 `build-output/`。

```bash
# 仅生成解压目录（最快，用于冒烟测试）
npm run build:dir

# 完整打包：安装包 + 便携版
npm run build
```

打包产物：

```
build-output/
├── DeskPulse Setup 1.0.4.exe    # NSIS 安装包（自定义安装路径 + 桌面/开始菜单快捷方式）
├── DeskPulse 1.0.4.exe          # 便携版单文件 exe
└── win-unpacked/DeskPulse.exe   # 解压后的调试版本
```

> 打包时会自动读取项目根目录资源：`assets/icon.ico`（应用/安装器/快捷方式图标）与 `assets/tray.png`（透明托盘图标）。若 `tray.png` 不存在，主进程会自动使用 `icon.ico` 缩放作为托盘图标。

### 国内网络环境说明

`.npmrc` 已固定 npm registry 至 `registry.npmmirror.com`。执行打包前建议同时设置以下环境变量，以加速 Electron 预编译包与 electron-builder 辅助二进制的下载：

```powershell
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
$env:ELECTRON_CACHE = "$PWD\.cache\electron"
$env:ELECTRON_BUILDER_CACHE = "$PWD\.cache\electron-builder"
npm run build
```

---

## 系统托盘菜单

| 菜单项 | 作用 |
|---|---|
| 显示 / 隐藏小组件 | 切换小组件显隐 |
| 切换主题 | 在浅色与深色之间切换 |
| 紧凑模式 | 在完整面板与单行迷你面板之间切换（游戏/追剧时使用） |
| 重置到右上角 | 将窗口移回主屏右上角默认位置 |
| 设置... | 打开设置窗口（开机自启开关） |
| 关于 | 查看版本号与版权信息 |
| 退出 DeskPulse | 关闭窗口并真正退出进程 |

**鼠标左键** 点击托盘图标等同于显示 / 隐藏小组件。

---

## 项目结构

```
desk-pulse/
├── main.js            # Electron 主进程：窗口创建、托盘、IPC、窗口位置记忆
├── renderer.js        # 渲染进程：systeminformation 采集、主题、UI 更新
├── index.html         # 小组件 DOM 结构
├── style.css          # 主题变量与布局（浅色/深色通过 CSS 变量切换）
├── settings.html      # 设置窗口页面（开机自启开关 + 版本信息）
├── assets/
│   ├── icon.ico       # 应用/安装器/快捷方式图标（多尺寸 ICO，≥ 256×256）
│   └── tray.png       # 透明托盘图标（≥ 64×64 为佳）
├── .gitignore         # 忽略 node_modules / .cache / build-output / userData
├── .npmrc             # registry 与国内镜像说明
├── package.json       # 元信息 + 打包配置
└── userData/          # 运行时数据（窗口位置、偏好、硬件缓存，不进 git）
```

---

## 常见问题

### 为什么没有 CPU 温度？

Windows 读取 CPU DTS 寄存器需要内核级驱动或管理员权限（例如 LibreHardwareMonitor）。为了让应用轻量化、零额外依赖、普通用户权限即可运行，CPU 温度被有意移除。

### 为什么关闭窗口后程序没退出？

小组件关闭并不会退出进程，而是隐藏到系统托盘（桌面小组件的标准做法）。**左键托盘图标** 即可重新显示。真正退出请使用托盘菜单的「退出 DeskPulse」。

### 怎么替换图标？

- 替换 `assets/icon.ico`：一张多尺寸 `.ico`（含 16/32/48/64/128/256），会同时用于 exe、快捷方式、安装器与卸载器。
- 替换 `assets/tray.png`：一张带透明通道的 PNG，主进程会以最高画质缩放至 16×16 供托盘使用。

---

## 开源协议

MIT © Lava
