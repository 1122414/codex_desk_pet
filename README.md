# Codex Desk Buddy

Codex Desk Buddy 是面向 M5Stack CoreS3 完整版（SKU `K128`）的桌面宠物项目。它连接 Codex App Server，展示最近活动的任务、Pet 动画、Token、等级、时钟和设备遥测，并提供严格 320×240 的触摸屏模拟器。设备允许 USB-C 常联，也将支持拔线后通过 Wi-Fi 与仍在运行的电脑 Bridge 通信；Bluetooth LE 用于配网和恢复。

## 当前已经实现

- 真实 Codex App Server 初始化、线程列表轮询和事件归一化。
- `running`、`needs-input`、`reviewing`、`completed`、`blocked` 等状态映射。
- 命令执行与文件修改的单次允许/拒绝；只在持有原始 JSON-RPC 请求 ID 且审批详情完整时开放“允许”。
- Codex Pet v1（8×9）和 v2（8×11）图集播放。
- 自定义 Pet 会校验 WebP 格式、实际尺寸、16 MiB 大小上限和 SHA‑256；声明了清单哈希时必须完全匹配。
- 9 个标准动画；v2 Pet 和内置 Pet 支持 16 个看向方向。
- 触摸/滑动、屏幕左右键、电脑下拉框、键盘方向键切换 Pet，所有界面共享 Bridge 选择状态。
- 声音、中文语音提示、时钟、电池、当前线程 Token 和等级进度。
- HTTP + SSE 控制面板、会话 Cookie、CSRF 防护、命令去重和仅本机回环监听。
- USB CDC 自动发现/重连、独立 Wi‑Fi WebSocket 设备服务、BLE GATT 分片抽象，以及三条链路共用的版本化协议。
- USB/BLE 单次配对码、每设备独立密钥、HMAC 双向认证、凭据撤销、会话替换和未认证连接清理。
- ACK 窗口流控、指数退避、全量快照恢复、跨链路命令去重和 Pet 资源原子安装。
- 可实际编译为 CoreS3 K128 固件的 PlatformIO 工程：320×240 双缓冲界面、电容触摸、Port B GPIO 8/9 双按键、扬声器提示、电池、RTC、看向方向、审批和链路优先级。
- 电脑使用 Sharp 将 WebP 图集转换为设备专用的 144×156 透明 RGB565 帧；固件在 microSD 上做分块校验、断点续传、整包 SHA‑256 校验和不可变版本发布。
- Web Bluetooth 首次写入 Wi‑Fi、Bridge 地址和端口；设备屏幕上的独立 6 位配网码用于防止误配。

## 快速启动

需要 Node.js 22 或更高版本。本机还需要可用的 `codex` 命令才能连接真实 Codex。

先运行不依赖真实 Codex 的完整演示：

```bash
npm run start:mock
```

然后打开 [http://127.0.0.1:4317](http://127.0.0.1:4317)。右下角的“生成一次审批请求”可以验证设备审批流程。

让真机通过局域网连接 Bridge 时，只开放独立的设备端口：

```bash
CODEX_DESK_DEVICE_HOST=0.0.0.0 npm start
```

设备连接 `ws://<电脑局域网地址>:4318/device/ws`。控制面板仍只监听 `127.0.0.1:4317`。当前 MVP 的 WebSocket 已做设备双向认证，但尚未加密内容，因此只用于受信局域网；正式产品会在真机阶段启用 WSS 或等价加密。

USB CDC 可以指定端口，也可以自动发现：

```bash
CODEX_DESK_USB_PORT=/dev/cu.usbmodem101 npm start
CODEX_DESK_USB_AUTO=1 npm start
```

连接一个独立的本机 App Server：

```bash
npm start
```

连接已经启动的托管 App Server daemon：

```bash
codex app-server daemon start
CODEX_DESK_MODE=daemon npm start
```

daemon 模式只表示 Bridge 通过官方 `proxy` 命令连接托管服务。审批按钮仍只会在 Bridge 实际收到原始审批请求时出现；项目不会猜测或伪造另一个客户端中的审批。

## 使用界面

- 在设备屏幕上左右滑动、点左右箭头，或在页面上按 `←` / `→` 切换 Pet。
- 触摸/拖动内置或 v2 Pet，会播放最接近的 22.5° 看向方向。
- “全部状态”可以预览 9 个标准动画；真实审批和错误状态会强制覆盖实验室预览。
- 声音和语音需要用户点击开启，以符合浏览器的自动播放限制。
- `Mock` 模式可以调整电池与链路标识，验证未来设备遥测界面。
- “设备配对”生成的 6 位码只能使用一次，并在 5 分钟后过期；首次配对只接受 USB 或 BLE。

## 添加自定义 Pet

项目读取 `${CODEX_HOME:-$HOME/.codex}/pets/<pet-id>/`：

```text
~/.codex/pets/my-pet/
  pet.json
  spritesheet.webp
```

v2 manifest 示例：

```json
{
  "id": "my-pet",
  "displayName": "My Pet",
  "description": "A custom Codex companion.",
  "spriteVersionNumber": 2,
  "spritesheetPath": "spritesheet.webp",
  "spritesheetSha256": "可选的64位小写SHA-256"
}
```

v2 图集必须为 1536×2288；v1 图集为 1536×1872。单格均为 192×208。`spriteVersionNumber` 可以省略，此时 Bridge 按真实尺寸识别版本；如果声明了版本或 `spritesheetSha256`，文件必须匹配。图集最大 16 MiB。新 Pet 继续在电脑端制作，设备端只同步、缓存和播放成品。

真机自定义 Pet 需要一张 FAT32 microSD 卡。内置 `codex-core` 不依赖存储卡；microSD 缺失或资源损坏时固件会继续显示内置回退 Pet。

## 编译 CoreS3 固件

安装 PlatformIO Core 后运行：

```bash
npm run build:firmware
```

固件目标、Arduino 框架和库版本都固定在 `firmware/platformio.ini`。当前构建证据使用 PlatformIO 6.1.19、`espressif32@6.9.0` 与 `m5stack-cores3`。拿到设备后才执行 `pio run -d firmware -t upload`，避免在没有真机时声称烧录成功。

## 验证

```bash
npm test
npm run check
npm run smoke:codex
```

- `npm test`：运行 64 项领域、协议、审批、配对、传输、Pet 资源与 HTTP 安全测试。
- `npm run check`：先检查全部 JavaScript 语法，再运行测试。
- `npm run test:firmware`：使用本机 C++17 编译器运行不依赖硬件的固件状态机、动画、输入、重连、序号与资源恢复测试。
- `npm run build:firmware`：使用真实 ESP32-S3 工具链编译完整 CoreS3 固件。
- `npm run smoke:codex`：真实启动 App Server 并读取最近线程，然后立即关闭。

## 重要边界

- 当前 Codex App Server 没有公开 Pet 列表或 Pet 选择事件。MVP 由 Desk Bridge 同步触屏和电脑控制面板，但不会写入 Codex 原生客户端的私有设置。
- 当前等级根据“正在展示的线程”的累计 Token 计算，每 50,000 Token 一级；它不是 Codex 官方等级。
- 完整 CoreS3 固件已经通过真实 ESP32-S3 工具链编译，但 USB CDC、Wi‑Fi、BLE、microSD、触摸、扬声器与电量读取仍需设备到手后做物理验证。
- 浏览器已有中文语音提示；当前固件只提供不同状态的扬声器音型。设备端离线中文语音包仍属于真机前待完成项，不能把提示音称作语音。
- 控制面板固定监听 `127.0.0.1`；真机只连接独立的 `4318` 设备端口。明文 WebSocket 不是最终产品的保密方案。

详细链路约束见 [设备协议](docs/device-protocol.md)，完整路线和逐项证据见 [2026-07-19_001.md](2026-07-19_001.md)。
