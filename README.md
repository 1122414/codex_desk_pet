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
- USB/Wi‑Fi/BLE 共用的版本化消息封装、序号、ACK、心跳和断线恢复契约。

## 快速启动

需要 Node.js 22 或更高版本。本机还需要可用的 `codex` 命令才能连接真实 Codex。

先运行不依赖真实 Codex 的完整演示：

```bash
npm run start:mock
```

然后打开 [http://127.0.0.1:4317](http://127.0.0.1:4317)。右下角的“生成一次审批请求”可以验证设备审批流程。

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

## 验证

```bash
npm test
npm run check
npm run smoke:codex
```

- `npm test`：运行 27 项领域、协议、审批、Pet 资源与 HTTP 安全测试。
- `npm run check`：先检查全部 JavaScript 语法，再运行测试。
- `npm run smoke:codex`：真实启动 App Server 并读取最近线程，然后立即关闭。

## 重要边界

- 当前 Codex App Server 没有公开 Pet 列表或 Pet 选择事件。MVP 由 Desk Bridge 同步触屏和电脑控制面板，但不会写入 Codex 原生客户端的私有设置。
- 当前等级根据“正在展示的线程”的累计 Token 计算，每 50,000 Token 一级；它不是 Codex 官方等级。
- 真机 USB Serial、Wi‑Fi、BLE、Pet 文件传输、扬声器与电量读取尚未经过物理验证；设备服务、虚拟链路和 CoreS3 固件会在硬件到手前完成到可测试、可构建状态。
- MVP HTTP 服务只监听 `127.0.0.1`。真机 Wi‑Fi 接入必须先实现配对认证，不能直接把当前控制端口暴露到局域网。

详细链路约束见 [设备协议](docs/device-protocol.md)，完整路线和逐项证据见 [2026-07-19_001.md](2026-07-19_001.md)。
