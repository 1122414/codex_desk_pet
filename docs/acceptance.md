# Codex Desk Buddy 验收矩阵

结论分为三类：

- **已完成**：当前工作区有源代码、自动化测试或可复验产物直接证明。
- **真机部分完成**：已获得某项物理证据，但仍有明确的真机子项需要复验。
- **代码完成，待真机**：所有非物理实现和构建已完成，但结果依赖实际屏幕、射频、电源或外设。
- **公开能力限制**：上游没有公开接口，项目明确保留边界而不伪造能力。

## 需求逐项验收

| 原始需求 | 实现与证据 | 结论 |
| --- | --- | --- |
| 触摸屏 | Tab5 诊断固件已在 1280×720 全屏读取多点触摸并显示正确触点；配对键盘使用真实按下边沿、40 ms 释放去抖和局部数字刷新；列表使用 8 像素圆形点击容差，任意方向滑动一旦超限便锁定为滚动，松手不再打开会话；2026-07-27 真机确认输入准确、无重复并成功配对 | 代码与自动化已完成；v0.4.0 滑动手感待用户复验 |
| 展示 PC 端全部状态和动画 | `src/shared/codex-state.js` 归一化 Codex 生命周期；官方 Hooks 接收 Desktop、CLI、IDE 的 Session、Turn、工具、等待审批和完成事件；`src/shared/pet-spec.js` 定义 9 个图集动画和 16 个看向方向 | 已完成；用户需审查并信任 Hooks |
| 设备允许/拒绝审批 | Bridge 会话关联原始 RPC ID；Desktop、CLI、IDE 使用官方 `PermissionRequest` Hook 的 `allow`/`deny` 输出；Hook 最长等待 115 秒，详情不完整或小屏放不下时禁止设备允许 | 已完成 |
| 内置与自定义 Pet，自由切换；新 Pet 在 PC 制作 | `src/server/pet-catalog.js` 校验 v1/v2；`src/server/device-pet-asset.js` 转换 384×416 设备帧；`firmware/src/pet_store.cpp` 缓存和回退；浏览器、触摸、滑动和屏幕左右按钮都可切换 | 已完成 |
| 按键切换、电脑切换、Codex 同步 | 触摸和屏幕左右按钮向 Bridge 发 `pet.select`，电脑控制面板写同一 Bridge 选择状态并广播所有设备；Tab5 外接物理按键映射保留给真机验收 | 设备与本项目电脑端同步已完成；Codex 官方客户端没有公开 Pet 选择事件，不能宣称原生双向同步 |
| 显示最近运行任务 | Bridge 调用 `thread/list`，官方 Hooks 补充其他 Codex 客户端的实时生命周期；状态模型在审批、活动和最近完成任务之间按明确优先级选取显示线程 | 已完成 |
| Chibi Skadi、菲比 Q 版主题与会话详情 | `chibi-skadi` 系列启用深海蓝、冰晶青、珊瑚粉主题；`feibi` 启用深莓紫、奶油白、香槟金、紫罗兰与玫瑰粉主题。状态栏、电量、链路、额度、Token、卡片、按钮和滚动条均随 Pet 切换；含 Git 信息的线程显示为项目文件夹卡，无 Git 信息的线程显示为对话气泡卡；轻点卡片后通过只读 `thread/read` 展开最近 12 条用户/助手消息，过滤 reasoning、工具参数与内部事件 | 两套主题的电脑端视觉验收、协议测试、真实固件构建和 v0.4.0 部署已完成；真机主题观感仍需用户目视确认 |
| 声音、中文语音、时钟、电量、Token、等级 | `firmware/src/device_audio.cpp` 使用独立任务播放 ESP-SR 离线中文 TTS；单击开始/结束对话或命令，ChatGPT 登录使用电脑本地 `whisper.cpp` 转写且不需要 API Key，命令必须二次确认；UI 读取 RTC、电池并显示真实线程 Token/等级；真机上报 `voiceDataReady=true`，当前任务累计 Token 来自会话记录，官方当日桶尚未生成时由当天会话增量补齐 | 本地转写、模型校验、真机数据源与自动化完成；真机完整对话、扬声器听感、电量曲线和温升待实测 |
| USB 常联和稳定无线 | 真机已完成整机烧录、USB 枚举、真实账户配对和加密 USB 状态同步；USB 接收缓存按协议上限配置，并修复同一轮轮询中新消息时间戳导致的误超时。2026-07-29 普通升级保留 NVS 配对配置，重载 Bridge 后设备恢复 USB+BLE；虚拟 Tab5 另完成 500 次 USB/Wi-Fi 主链切换和四类故障注入 | USB 基础链路和升级保配对已完成；真实插拔长稳、Wi‑Fi 天线、路由器和电脑睡眠环境待实测 |
| 蓝牙或其他无线方式 | ESP32-C6 BLE 已在 2026-07-27 完成拔线状态同步；2026-07-29 v0.4.0 升级后无需重新配对，重载 Bridge 后真机再次回报 USB+BLE 双链路。BLE 可承载任务列表、只读会话详情、Pet 选择、审批和遥测；Pet、语音和图片走 USB/Wi‑Fi | BLE 轻量无线链路已完成；本轮大资源传输后曾需重载 Bridge，自动恢复长稳与 Wi‑Fi 弱信号恢复待真机 |
| Pet 接入 LLM 对话 | 文本和语音对话进入临时、只读、禁止工具的 Codex 会话；ChatGPT 订阅登录可直接使用，无需 API Key；语音命令只排队，设备明确确认后才创建 `workspace-write/on-request` 任务。原生 ChatGPT Voice 可在官方 Codex 界面使用，但当前 App Server Realtime 对 `chatgpt` 登录仍要求 API Key，设备因此使用本地 Whisper，不依赖或伪造该私有界面 | 无 Key 文本真实往返、代码与自动化完成；真机无 Key 语音待验收 |
| 摄像头与 CV | Tab5 官方 MIPI CSI 驱动采集 2MP RGB565，P4 硬件 JPEG 编码；USB/Wi‑Fi 加密分块、512 KiB 上限、SHA‑256、`0600` 临时文件和用后删除；只描述清楚可见内容 | 代码和真实工具链构建完成；v0.2.0 真机画面、方向和色彩待验收 |
| 产品化稳定性 | 每设备密钥、会话加密、凭据撤销、CSRF、回环控制面板、资源双槽回退、固定依赖、完整工厂镜像、逐文件 SHA‑256、显式串口恢复和故障压力测试 | 真机前软件基线完成；生产签名、eFuse、72 小时和认证测试待硬件与量产密钥 |
| 不要求电脑关机后仍获取 Codex 状态 | Bridge 是 Codex 数据源；电脑关闭时设备保留本地 Pet/时钟并显示离线，不伪造实时任务 | 按约定排除 |
| 不要求 6/8 小时续航承诺 | 固件读取电量与充电状态，但没有无实测的续航承诺 | 按约定排除 |

## 一次性复验命令

```bash
npm run test:virtual-tab5
npm run test:live-tab5
npm run doctor
npm run check
npm run test:stability
PIO=/path/to/pio npm run release:firmware
npm run smoke:codex
```

- `test:virtual-tab5` 在临时目录中自动完成一次性 USB 配对、密钥保存、加密双链路、遥测、28,114,944 Bytes V2 Pet 转换/安装、审批和 Wi-Fi 接管，不修改正式设备凭据。
- `test:live-tab5` 只读检查真实 Bridge 与 Tab5，不修改设备、Wi‑Fi、Pet 或凭据；可等待语音/视觉完成证据，并只输出长度、尺寸和状态。
- `doctor` 检查 Node、Codex 版本、实际 App Server 连接、当前实验性 Schema 的四个必要方法、Hooks、PlatformIO 和完整固件包。
- `check` 检查全部 JavaScript 语法，运行领域、协议、HTTP、语音、视觉和虚拟设备测试，并用 C++17 重新编译固件核心测试。
- `test:stability` 打印 500 次链路切换、各类故障和 250 次资源恢复的实际计数。
- `release:firmware` 使用真实 ESP32-P4 工具链构建并复验完整工厂镜像。
- `smoke:codex` 真实初始化 App Server 并读取最近线程，不创建或修改 Codex 任务。

## 2026-07-28 复验结果

- `npm run check`：157/157 项 JavaScript 测试和固件核心检查通过。
- `npm run test:virtual-tab5`：真实协议的一次性配对、AES 加密、USB/Wi-Fi 双链路、遥测、28,114,944 Bytes V2 Pet 转换/安装、审批和 Wi-Fi 接管通过。
- `npm run test:stability`：501 个认证会话、500 次链路切换、250 次资源中断恢复和全部故障注入通过。
- 浏览器 Mock 验收：1280×720 布局、9/9 动画、16/16 V2 看向方向、V1 能力禁用、Pet 切换和审批均通过，浏览器控制台 0 错误。
- Chibi Skadi 主题浏览器验收：主页、项目详情和纯对话详情三种 1280×720 画面均通过；项目使用冰晶切角卡和文件夹徽记，纯对话使用珊瑚圆角气泡，长消息无溢出。
- `npm run smoke:codex`：Codex Desktop `0.146.0-alpha.3.1` 的 App Server 初始化和最近线程读取通过。
- `npm run doctor`：Codex Hooks 已安装并识别 6 类事件；PlatformIO 与完整发布包健康。
- `npm run test:live-tab5` 的历史证据已验证真机板型 `m5stack-tab5-k145`、固件 0.2.0、协议 v4、USB+BLE、microSD、中文语音数据、最近任务倒序和今日 Token；当前部署后 USB 已复验，BLE 权限、语音与视觉仍待本轮完成记录。
- v0.2.0 完整工厂镜像已通过真实 ESP32-P4 工具链构建并逐组件复验：16,711,680 Bytes，SHA-256 `86df4d8eee613fb5299328d6b7d9e87659c9b986672b17fb65fb210ee64fcc42`。
- v0.3.0 完整工厂镜像已通过真实 ESP32-P4 工具链构建并逐组件复验：16,711,680 Bytes，SHA-256 `b39c7c53ce12ccf10745ddefa25eeeb7db503eaf7c982f6a0c16ab729a20afe5`。同版本固件已写入真机并通过写入哈希校验；Bridge 0.3.0 已重装，真机回报固件 0.3.0、协议 v4、USB 在线、microSD 与中文语音数据就绪。

## 2026-07-29 复验结果

- `npm run check`：158/158 项 JavaScript 测试和固件核心检查通过；其中覆盖横向、纵向、斜向滑动与轻微触摸抖动。
- 真实 ESP32-P4 发布构建通过：应用占用 6,371,580 / 6,553,600 Bytes（97.2%）；v0.4.0 整机镜像 16,711,680 Bytes，SHA-256 `6cdad9e0949a22c252e75c62e8d79932c06f542552875eeaea82b01dd9b5fa90`。
- v0.4.0 已用非擦除升级写入真机，bootloader、分区表、应用、离线中文语音和 SPIFFS 均通过写后哈希校验；设备没有重新配对，重载 Bridge 后回报协议 v4、USB+BLE、microSD 与离线中文语音健康。
- 菲比已通过 USB 选择并触发设备资源安装，Bridge 未报告资源错误；随后恢复用户原先的 `chibi-skadi-v2` 选择。菲比主题主页、项目详情和纯对话详情已在 1280×720 浏览器画面验收。
- `npm run test:live-tab5`：只读真机验收通过，确认 4 个 Pet、12 条最近任务倒序、当前任务 Token、今日 Token、USB+BLE、microSD 和离线中文语音状态。

## 剩余真机与产品化清单

只有以下项目没有办法在无实物状态下诚实关闭：

1. v0.4.0 已写入；目视确认滑动松手不打开会话、轻点仍能进入、返回响应、Skadi/菲比主题与项目/对话卡后，继续实测语音转写/回复/命令确认和摄像头画面/色彩/观察回复。
2. 当前公司 Wi‑Fi 需要浏览器或企业认证，不能作为嵌入式设备测试网；到普通 2.4 GHz 同局域网后配置 Wi‑Fi，拔线检查任务、Pet 与审批同步，再测试弱信号、路由器重启和电脑睡眠恢复。
3. 菲比已触发 USB 预装；切换到菲比并重启，确认 microSD 保持，再做物理随机断电回退。
4. 实听中文语音与提示音，检查 RTC、电量、充电状态和温升。
5. 连续运行 72 小时，记录内存趋势、断线次数、恢复时间、充电和温度。
6. 确定量产密钥管理后再启用 Secure Boot、Flash Encryption 与签名升级；eFuse 不做无真机演练。

这些项目已经有明确入口和预期结果，不需要重新设计架构。当前权威收尾状态见 [2026-07-28_001.md](../2026-07-28_001.md)。
