# Codex Desk Buddy

Codex Desk Buddy 是面向 M5Stack Tab5 Kit（SKU `K145`，ESP32-P4 + ESP32-C6）的桌面宠物与主动关怀项目。它连接 Codex App Server，展示最近活动的任务、Pet 动画、Token、等级、时钟和设备遥测，也会按可配置节奏偶尔观察、主动开口并继续多轮对话；设备可 USB-C 常联，也可拔线后通过 BLE 获取状态与执行轻量控制，或通过 Wi‑Fi 使用 Pet、语音和摄像头等完整能力。首次账户配对和 Wi‑Fi 配置仍通过加密认证的 USB 数据线完成。

## 当前已经实现

- 真实 Codex App Server 初始化、线程列表轮询和事件归一化。
- 官方 Codex Hooks 跨客户端状态同步：Codex Desktop、CLI 和 IDE 中的 Session、Turn、工具、等待审批与完成事件可由本机 Bridge 感知；乱序和陈旧事件会被丢弃。
- `running`、`needs-input`、`reviewing`、`completed`、`blocked` 等状态映射。
- 任务按真实最近更新时间倒序展示；线程 Token 使用 App Server 的累计用量，项目总量只统计实际返回的值，不用伪造数据补零。
- 命令执行、文件修改与额外权限请求的单次允许/拒绝；Bridge 会话使用原始 JSON-RPC 请求 ID，Desktop/CLI/IDE 会话使用官方 `PermissionRequest` Hook 返回值。只有审批详情完整时开放“允许”，屏幕放不下的请求只能拒绝或回本项目电脑控制面板处理。
- Codex Pet v1（8×9）和 v2（8×11）图集播放。
- 自定义 Pet 会校验 WebP 格式、实际尺寸、32 MiB 大小上限和 SHA‑256；声明了清单哈希时必须完全匹配。
- 9 个标准动画；v2 Pet 和内置 Pet 支持 16 个看向方向。
- 触摸/滑动、屏幕左右键、电脑下拉框、键盘方向键切换 Pet，所有界面共享 Bridge 选择状态。
- 浏览器和设备端中文语音提示、非阻塞提示音、时钟、电池、当前线程 Token 和等级进度。
- 真机每 30 秒上报电量、充电状态、Wi‑Fi RSSI 和 ESP32-P4 芯片温度；Bridge 诊断同时提供 RSS/堆内存，供 24 小时验收记录器分析趋势。
- Pet 对话通过临时只读 Codex 会话完成；语音对话使用 Codex App Server Realtime，语音命令先转写并在设备上明确确认后才创建可执行任务。
- Tab5 自带 2MP MIPI 摄像头可手动拍照，ESP32-P4 硬件编码 JPEG，经已认证的 USB/Wi‑Fi 加密分块传输后交给临时只读多模态会话观察；图片分析后立即删除。
- 主动关怀默认在 10～30 分钟内随机选择下一次观察；AI 可以保持安静、主动开口或建议更早复查。没有 6 小时冷却，只有默认 90 秒的技术性重复拍照保护。
- 摄像头观察、用户回答、动作结果和后续对话使用同一个 Care 会话；会话失效时用本地摘要和近期事件恢复上下文。
- 主动开口的 TTS 播放完成后自动进入半双工聆听，静音或超时后结束本轮；AI 可继续回答并再次聆听，用户也可以随时停止。
- AI 动作严格限定为立即观察、安排复查、Tab5 亮度/音量、Mac 音量以及用户配置的应用和媒体预设；每个动作带幂等键，执行结果会回传给同一 Care 会话。
- HTTP + SSE 控制面板、会话 Cookie、CSRF 防护、命令去重和仅本机回环监听。
- USB CDC 自动发现/重连、BLE 低带宽热备和独立 Wi‑Fi WebSocket 设备服务。Tab5 的 ESP32-P4 没有原生无线电，板载 ESP32-C6 负责 BLE 与 Wi‑Fi；Pet 大文件、语音和图片只允许走 USB/Wi‑Fi。
- USB 单次配对码、每设备独立密钥、HMAC 双向认证、AES‑256‑GCM 会话加密、凭据撤销、会话替换和未认证连接清理。
- ACK 窗口流控、指数退避、全量快照恢复、跨链路命令去重和 Pet 资源原子安装。
- 可实际编译为 Tab5 K145 固件的 PlatformIO 工程：1280×720 触摸界面、大尺寸 Pet、离线中文 TTS、扬声器提示、电池、RTC、看向方向、审批和 USB/Wi‑Fi 链路优先级。
- 电脑使用 Sharp 将 WebP 图集转换为设备专用的 384×416 透明 RGB565 帧；固件在 microSD 上做分块校验、断点续传、整包 SHA‑256 校验、不可变版本发布和双槽 active 指针断电回退。
- 配对后的电脑控制面板只会经 USB 加密会话写入 Wi‑Fi、Bridge 地址和端口；设备保存后自动重启。密码不进入浏览器存储、设备列表或日志。
- 已认证设备会上报板型、固件、协议、中文语音和 microSD 状态；Bridge 校验兼容性并在控制面板显示诊断结果。
- 可重复生成包含 bootloader、分区表、应用、OTA 初始化器和离线中文语音数据的完整工厂镜像；发布清单记录每个组件的偏移、大小与 SHA‑256，烧录前会再次验证。
- 固定种子的故障注入会完成 500 次 USB/Wi‑Fi 切换，并覆盖协议丢包、重复、乱序、ACK 丢失、Pet 中断续传、坏块和未完成提交；原生 C++ 另运行 50,000 次双槽断电与序号循环。
- macOS 用户级后台服务可在登录后自动启动 Bridge，并在异常退出后自动拉起。

## 快速启动

需要 Node.js 22 或更高版本。本机还需要已登录的 Codex Desktop/CLI 和可用的 `codex` 命令。项目复用 Codex App Server 的账户登录，不读取 `OPENAI_API_KEY`，也不要求单独申请 OpenAI API Key；Codex App Server 和 Bridge 必须在电脑上保持运行，AI 对话、语音识别和视觉理解才可用。

先检查电脑环境、Codex App Server Schema、PlatformIO 和固件发布包：

```bash
npm run doctor
```

先运行不依赖真实 Codex 的完整演示：

```bash
npm run start:mock
```

然后打开 [http://127.0.0.1:4317](http://127.0.0.1:4317)。右下角的“生成一次审批请求”可以验证设备审批流程。

没有实体板时，可以让临时虚拟 Tab5 自动完成一次性 USB 配对、加密会话、USB/Wi‑Fi 双链路、遥测、Pet 切换、最大规格 V2 Pet 安装、审批，以及“定时拍照 → AI 开场 → 三轮自动语音 → 动作结果回传 → 下次观察”的主动关怀闭环：

```bash
npm run test:virtual-tab5
```

该命令只使用系统临时目录和内存传输，结束后自动删除虚拟凭据；它不会给正式 Bridge 或真机固件加入免认证入口。

让真机通过局域网连接 Bridge 时，只开放独立的设备端口：

```bash
CODEX_DESK_DEVICE_HOST=0.0.0.0 npm start
```

设备连接 `ws://<电脑局域网地址>:4318/device/ws`。控制面板仍只监听 `127.0.0.1:4317`。设备协议 v5 在认证后会加密包括任务、审批、ACK、心跳、Pet 资源、语音、图片和关怀动作结果在内的全部 payload，并把设备版本与能力哈希绑定到握手证明；明文降级、方向错误、设备信息、元数据或密文篡改都会被拒绝。外层消息类型和时序元数据不加密，因此设备端口仍不应暴露到公网。

macOS 可安装用户级后台服务；它会自动启用 USB、BLE 和局域网设备端口，并在登录后持续运行。设备端口监听所有本机网络接口，控制面板仍只允许本机访问：

```bash
npm run install:macos-service
npm run status:macos-service
```

更新代码后重新执行安装命令即可原子替换后台运行副本。日志位于 `~/Library/Logs/CodexDeskBuddy/`，卸载使用 `npm run remove:macos-service`。

USB CDC 可以指定端口，也可以自动发现：

```bash
CODEX_DESK_USB_PORT=/dev/cu.usbmodem101 npm start
CODEX_DESK_USB_AUTO=1 npm start
```

连接一个独立的本机 App Server：

```bash
npm start
```

让设备同时感知 Codex Desktop、CLI 和 IDE 中运行的任务，需要启动一次 Bridge 生成本机 Token，然后安装用户级 Hooks：

```bash
npm start # 首次启动成功后按 Ctrl+C
npm run install:codex-hooks
npm start
```

安装后在 Codex 中打开 `/hooks` 检查并信任命令，再新建任务。Hooks 只发送有限生命周期元数据；详细隐私字段、卸载方式与审批边界见 [Codex 跨客户端状态同步](docs/codex-hooks.md)。

连接已经启动的托管 App Server daemon：

```bash
codex app-server daemon start
CODEX_DESK_MODE=daemon npm start
```

daemon 模式只表示 Bridge 通过官方 `proxy` 命令连接托管服务。审批按钮仍只会在 Bridge 实际收到原始审批请求时出现；项目不会猜测或伪造另一个客户端中的审批。

## 使用界面

- 在设备屏幕上左右滑动、点左右箭头，或在页面上按 `←` / `→` 切换 Pet。
- 触摸/拖动内置或 v2 Pet，会播放最接近的 22.5° 看向方向。
- 按住“对话”说话，松开后 Pet 会回复；按住“命令”说话，松开后仍需在设备上确认；点“拍照”会拍一张照片并让 Pet 简短描述。
- 控制面板的“主动关怀”区域可启停关怀、设置观察范围和自动聆听时长、编辑人设、选择动作白名单、配置应用/媒体预设、立即观察、停止当前对话并查看近期记录。
- “停止当前对话”会终止正在进行的关怀语音并通知设备，但不会关闭主动关怀总开关；总开关关闭后才会取消后续定时观察。
- “全部状态”可以预览 9 个标准动画；真实审批和错误状态会强制覆盖实验室预览。
- 声音和语音需要用户点击开启，以符合浏览器的自动播放限制。
- `Mock` 模式可以调整电池与链路标识，验证未来设备遥测界面。
- “设备配对”生成的 6 位码只能使用一次，并在 5 分钟后过期；首次账户配对必须保持 USB 连接。配对完成后，控制面板会只向该 USB 加密会话写入 Wi‑Fi 与 Bridge 地址，设备随即重启。

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

v2 图集必须为 1536×2288；v1 图集为 1536×1872。单格均为 192×208。`spriteVersionNumber` 可以省略，此时 Bridge 按真实尺寸识别版本；如果声明了版本或 `spritesheetSha256`，文件必须匹配。图集最大 32 MiB。新 Pet 继续在电脑端制作，设备端只同步、缓存和播放成品。

真机自定义 Pet 需要一张 FAT32 microSD 卡。内置 `codex-core` 不依赖存储卡；microSD 缺失或资源损坏时固件会继续显示内置回退 Pet。

## 编译 Tab5 固件

安装 PlatformIO Core 后运行：

```bash
npm run setup:firmware-tts
npm run build:firmware
npm run release:firmware
```

第一条命令从 Espressif 官方仓库下载固定 commit 的 ESP-SR P4 中文 TTS 文件，并逐个校验 SHA‑256。下载物不进入 Git。固件目标、PioArduino 框架和库版本都固定在 `firmware/platformio.ini`。当前构建目标为 `m5stack-tab5-p4`，使用 Tab5 专用板型把 microSD 固定到 SDMMC Slot 0，并通过 Slot 1 上的 C6 SDIO 连线启用 Wi‑Fi 与 BLE。

TTS 使用独立的 `voice_data` 分区；只烧录应用固件不会得到语音。`release:firmware` 会把 bootloader、分区表、应用和经过校验的语音数据合并为完整工厂镜像。设备到手后明确指定串口烧录：

```bash
npm run flash:firmware -- --port /dev/cu.usbmodemXXXX
```

脚本会在接触设备前校验清单、所有组件和整机镜像；不会自动猜测串口，也不会默认擦除整片 Flash。完整新手安装与恢复步骤见 [安装与恢复](docs/install-and-recovery.md)。当前 Tab5 已完成整机烧录、USB 枚举、真实账户配对、加密 USB 状态同步和触摸硬件诊断；扬声器试听、无线和长稳仍按真机清单验收。

## 验证

```bash
npm test
npm run test:virtual-tab5
npm run doctor
npm run check
npm run test:stability
npm run smoke:codex
npm run acceptance:hardware -- --device-id <已配对设备 ID>
```

- `npm test`：运行领域、协议、审批、配对、传输、Pet 资源与 HTTP 安全测试。
- `npm run test:virtual-tab5`：使用临时虚拟设备完成真实协议的一次性配对、加密 USB/Wi-Fi 双链路、28,114,944 Bytes V2 Pet 转换/安装、遥测、审批、USB 断开后的 Wi-Fi 接管，以及主动观察、三轮自动语音、白名单动作、重复抑制和故障恢复。
- `npm run doctor`：检查 Node、Codex 实际连接与必要 Schema 方法、PlatformIO 和完整固件包；输出不包含线程标题或凭据。
- `npm run check`：先检查全部 JavaScript 语法，再运行测试。
- `npm run test:firmware`：使用本机 C++17 编译器运行不依赖硬件的固件状态机、动画、输入、重连、序号与资源恢复测试。
- `npm run setup:firmware-tts`：下载并校验 Espressif 官方离线中文 TTS 库、许可与语音数据。
- `npm run build:firmware`：使用真实 ESP32-P4 工具链链接 TTS 并编译完整 Tab5 固件。
- `npm run release:firmware`：重新构建并生成经过逐文件 SHA‑256 校验的完整工厂镜像。
- `npm run flash:firmware -- --port <串口>`：验证发布包后写入明确指定的 Tab5；只有显式增加 `--erase` 才会先整片擦除。
- `npm run test:stability`：运行可复现的长循环与故障注入，打印每类实际完成次数，再运行固件核心压力测试。
- `npm run smoke:codex`：真实启动 App Server 并读取最近线程，然后立即关闭。
- `npm run acceptance:hardware`：连接真机后每 30 秒保存一次原子检查点，连续 24 小时记录定时观察、同一会话五轮对话、白名单动作、重复/失败、Wi‑Fi 重连、Bridge RSS、电量和芯片温度；中断后可用 `--resume <报告路径>` 继续。

## 重要边界

- 当前 Codex App Server 没有公开 Pet 列表或 Pet 选择事件。MVP 由 Desk Bridge 同步触屏和电脑控制面板，但不会写入 Codex 原生客户端的私有设置。
- Hooks 能让设备看到其他 Codex 客户端的 Running、Needs input 和 Completed 生命周期，并把设备对 `PermissionRequest` 的明确允许/拒绝返回原客户端。详情不完整、超过设备显示上限、Bridge 不可用或 115 秒超时时不代替用户决定，Codex 回到原生审批流程。
- 当前等级根据“正在展示的线程”的累计 Token 计算，每 50,000 Token 一级；它不是 Codex 官方等级。
- v0.3.0 Tab5 固件已经通过真实 ESP32-P4 工具链编译；旧版真机已完成整机烧录、USB 枚举、真实账户配对、加密 USB 状态同步、触摸键盘和 BLE 拔线状态同步。v0.3.0 的主动摄像头、自动多轮语音、C6 Wi‑Fi、microSD 自定义 Pet、扬声器、音量/亮度动作和电量曲线仍需连接开发板后物理验收。
- 设备固件已链接 Espressif ESP-SR v1.2.0 离线中文 TTS；六种状态、Pet 安装/切换和配对都在独立音频任务中播报，缺失或损坏的 `voice_data` 会安全降级为不同音型。真机语音分区已完成烧录、映射和 CRC 完整性校验，音质与音量仍需真机试听。
- BLE 只承担状态、Pet 选择和审批等小消息，不传 Pet 素材、PCM 语音或 JPEG 图片。语音识别、LLM 回复和视觉理解都依赖已登录且仍在运行的电脑 Codex App Server；电脑关机或退出登录时设备保留本地动画、时间和最近缓存状态，但不会伪造新的 Codex 信息。
- 控制面板固定监听 `127.0.0.1`；真机只连接独立的 `4318` 设备端口。设备 payload 已做应用层加密，但公网部署仍需额外的防火墙、WSS/反向代理和产品运维方案。

详细链路约束见 [设备协议](docs/device-protocol.md)，跨客户端状态见 [Codex Hooks](docs/codex-hooks.md)，音频实现与许可边界见 [固件音频](docs/firmware-audio.md)，故障注入边界见 [稳定性验证](docs/stability.md)，首次使用见 [安装与恢复](docs/install-and-recovery.md)，逐项结论见 [验收矩阵](docs/acceptance.md)，主动关怀完整路线见 [2026-07-30_001.md](2026-07-30_001.md)。
