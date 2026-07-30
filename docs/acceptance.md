# Codex Desk Buddy v0.3.0 验收矩阵

结论分为四类：

- **已完成**：当前工作区有源代码、自动化测试或可复验产物直接证明。
- **真机部分完成**：旧版已有物理证据，但 v0.3.0 仍有明确子项需要复验。
- **软件完成，待真机**：非物理实现、虚拟闭环和真实工具链构建均已完成，最终结论仍依赖摄像头、麦克风、扬声器、无线或电源实测。
- **公开能力限制**：上游没有公开接口，项目保留边界而不伪造能力。

## 主动关怀十项证据

| # | 最终要求 | 实现证据 | 自动化证据 | 结论 |
| ---: | --- | --- | --- | --- |
| 1 | 不使用 OpenAI API Key | `src/server/json-rpc-client.js` 连接本机 `codex app-server`，复用 Codex Desktop/CLI 登录；项目不读取 `OPENAI_API_KEY` | `npm run smoke:codex` 真实初始化 App Server 并读取线程，User-Agent 为 Codex Desktop + Desk Buddy 0.3.0 | 已完成 |
| 2 | 摄像头可偶尔主动观察 | `src/server/observation-scheduler.js` 在 1～120 分钟范围调度；默认 10～30 分钟随机选择，设备只在 USB/Wi-Fi 高带宽链路可用时拍照 | `test/observation-scheduler.test.js` 与 `scripts/verify-virtual-care.mjs` 使用可控时钟触发真实协议拍照 | 软件完成，待真机 |
| 3 | 没有 6 小时冷却 | 设置默认仅有每设备 90 秒 `duplicateGuardSeconds`，AI 可安排 1～120 分钟动态复查 | “without a six-hour cooldown” 调度测试和虚拟重复拍照抑制通过 | 已完成 |
| 4 | AI 可安静，也可主动开口 | `src/server/care-agent.js` 接受严格 JSON；空 `say` 保持安静，非空话术通过 `care.reply` 朗读 | `test/care-agent.test.js` 覆盖安静观察、有效开场和无效 JSON 安全降级 | 已完成 |
| 5 | 摄像头、对话和动作共享上下文 | CareAgent 在同一个只读、禁止工具的 Codex 线程中发送图片、用户转写和动作结果；`src/server/care-memory-repository.js` 持久化摘要、偏好、常用应用和近期事件 | CareAgent 上下文测试、重建续接测试和虚拟 `sharedCareThread=true` | 已完成 |
| 6 | 可持续多轮对话，而非单向输出 | `src/server/voice-agent.js` 将自动语音转写送回同一个 CareAgent；`firmware/src/firmware_app.cpp` 在 TTS 完成后才自动录音，保持半双工 | 语音单测与虚拟 Tab5 连续完成 3 轮 TTS → 自动聆听 → 转写 → 回复 | 软件完成，待真机五轮 |
| 7 | 可执行有边界的关怀动作 | `src/server/care-action-service.js` 只接受 7 种动作；应用 Bundle ID 和媒体 URL 必须来自 `src/server/settings-repository.js` 校验的预设，模型不能提交 shell | 动作结构/范围/禁用/超时/恢复/幂等测试；虚拟设备只打开一次预设并只设置一次亮度 | 软件完成，待真机 |
| 8 | 可配置、可查看、可停止 | `src/server/http-server.js` 提供设置、记录、立即观察和停止 API；Web 面板显示状态、下次观察和历史；`care.stop` 会取消关怀音频与自动聆听但保留总开关 | HTTP、设置、VoiceAgent、DeviceHub 与固件核心测试通过；桌面和 760 px 浏览器检查无横向溢出、控制台 0 错误 | 已完成 |
| 9 | 失败后恢复且不重复执行 | 图片中断进入失败状态并重新调度；Codex 线程失效后用记忆新建线程；动作以幂等键缓存，跨 USB/Wi-Fi 命令全局去重 | 虚拟闭环覆盖图片中断、无效 AI JSON、Codex 断开/恢复、USB→Wi-Fi、重复拍照/动作、设备中途掉线；稳定性测试覆盖 500 次链路切换 | 已完成 |
| 10 | 可发布的 Bridge、协议与固件 | 项目/Bridge/App Server 客户端/固件均为 0.3.0，设备协议为 v5；发布清单固定 ESP32-P4 偏移、大小和逐文件 SHA-256 | `npm run check`、虚拟设备、稳定性、doctor、Codex 冒烟和真实 PlatformIO 发布构建 | 软件完成，待真机烧录与 24 小时验收 |

## 原项目能力

| 原始需求 | 实现与证据 | 结论 |
| --- | --- | --- |
| 触摸屏 | Tab5 诊断固件已在 1280×720 全屏读取多点触摸并显示正确触点；配对键盘使用真实按下边沿、40 ms 释放去抖和局部数字刷新；2026-07-27 真机确认输入准确、无重复并成功配对 | 已完成 |
| 展示 PC 端全部状态和动画 | `src/shared/codex-state.js` 归一化 Codex 生命周期；官方 Hooks 接收 Desktop、CLI、IDE 的 Session、Turn、工具、审批和完成事件；`src/shared/pet-spec.js` 定义 9 个图集动画和 16 个看向方向 | 已完成；用户需审查并信任 Hooks |
| 设备允许/拒绝审批 | Bridge 会话关联原始 RPC ID；Desktop、CLI、IDE 使用官方 `PermissionRequest` Hook 的 `allow`/`deny` 输出；详情不完整或小屏放不下时禁止设备允许 | 已完成 |
| 内置与自定义 Pet | `src/server/pet-catalog.js` 校验 v1/v2；`src/server/device-pet-asset.js` 转换设备帧；`firmware/src/pet_store.cpp` 缓存和回退；浏览器、触摸、滑动和屏幕按钮均可切换 | 已完成 |
| 按键、电脑与设备切换同步 | 触摸和屏幕按钮向 Bridge 发 `pet.select`，控制面板写同一选择状态并广播所有设备 | 项目内同步已完成；Codex 官方客户端没有公开 Pet 选择事件 |
| 显示最近运行任务 | Bridge 调用 `thread/list`，Hooks 补充其他 Codex 客户端的实时生命周期；状态模型按审批、活动和最近完成任务的明确优先级展示 | 已完成 |
| 中文语音、时钟、电量、Token、等级 | 固件独立任务播放 ESP-SR 离线中文 TTS；Realtime 负责语音转写；UI 读取 RTC、电池和真实线程 Token | 真机部分完成；v0.3.0 自动聆听、音量、电量曲线和温升待实测 |
| USB 常联和稳定无线 | 旧版真机完成账户配对、加密 USB 状态同步和 BLE 拔线同步；虚拟设备完成 USB/Wi-Fi 高带宽热备、500 次切换和故障恢复 | 真机部分完成；真实 Wi-Fi、弱信号、睡眠与路由器恢复待实测 |
| Pet 接入 LLM 对话 | 文本和语音进入只读、禁止工具的 Codex 会话；命令只排队，设备明确确认后才创建可执行任务；主动关怀另使用可续接 Care 会话 | 软件完成，待 v0.3.0 真机语音 |
| 摄像头与视觉 | Tab5 官方 MIPI CSI 驱动采集 2MP RGB565，P4 硬件 JPEG；Bridge 校验身份、链路、顺序、大小和 SHA-256，分析后删除；既支持手动拍照，也支持随机主动观察 | 软件完成，待真机方向、曝光、色彩与传输时间 |
| 产品化稳定性 | 每设备密钥、会话加密、凭据撤销、CSRF、回环控制面板、资源双槽回退、固定依赖、完整工厂镜像、逐文件 SHA-256 和故障压力测试 | 真机前软件基线完成；生产签名、eFuse 和认证测试不在个人版当前范围 |

## 一次性复验命令

```bash
npm run check
npm run test:virtual-tab5
npm run test:stability
npm run doctor
npm run smoke:codex
npm run release:firmware
git diff --check
```

- `check` 检查全部 JavaScript 语法，运行 173 项领域、协议、HTTP、语音、视觉、虚拟设备、真机验收和工具链选择测试，并用 C++17 重新编译固件核心测试。
- `test:virtual-tab5` 在临时目录完成一次性 USB 配对、AES 加密、双链路、最大规格 V2 Pet、审批，以及主动观察、三轮自动对话、动作和故障恢复。
- `test:stability` 打印 501 个认证会话、500 次链路切换、250 次资源恢复和各类故障的实际计数。
- `doctor` 检查 Node、Codex 登录/App Server Schema、Hooks、PlatformIO 和 v0.3.0 发布包；不读取线程标题或凭据。
- `smoke:codex` 真实初始化 App Server 并读取最近线程，不创建或修改 Codex 任务，不需要 API Key。
- `release:firmware` 用真实 ESP32-P4 工具链重新构建，合并工厂镜像并从磁盘复验清单、大小和全部 SHA-256。

## 2026-07-30 软件复验结果

- `npm run check`：173/173 测试和固件核心检查通过。
- `npm run test:virtual-tab5`：配对、加密双链路、Pet、审批和完整主动关怀闭环通过；三轮自动语音共用一个 Care 线程，动作各执行一次。
- `npm run test:stability`：501 个认证会话、500 次链路切换、250 次资源恢复和全部固定种子故障注入通过。
- 浏览器控制面板：桌面与 760 px 视口均无横向溢出，主动关怀设置保存/恢复、立即观察无设备提示和停止入口通过，控制台 0 错误。
- `npm run smoke:codex`：Codex Desktop `0.146.0-alpha.3.1` 的 App Server 初始化和最近线程读取通过，客户端版本为 0.3.0。
- v0.3.0 完整工厂镜像由真实 ESP32-P4 工具链构建并逐组件复验：16,711,680 Bytes，SHA-256 `3e635222d3795520f217e4be518c12bff6051cf9203610cc589284ea0dd7e786`。
- `npm run acceptance:hardware` 的受控 Bridge 验收通过：记录器可以原子保存、接收停止信号、从检查点恢复，并对五轮会话、六组动作、重复、失败、Wi‑Fi 重连、RSS、电量和温度作出机器可复验判定。

## 开发板恢复连接后的最终清单

以下结论依赖当前无法连接的 Tab5，不能用虚拟设备代替：

1. 写入 v0.3.0 完整工厂镜像，确认固件版本、协议 v5、配对和 USB/Wi-Fi 链路。
2. 实测普通状态下 10～30 分钟随机拍照，记录方向、曝光、色彩和传输时间。
3. 完成“主动开口 → TTS → 自动聆听 → 静音结束 → AI 继续回答”至少五轮，并记录麦克风增益、转写延迟、扬声器听感和回声。
4. 实测 Tab5 亮度/音量及恢复、Mac 音量、一个应用/媒体预设、立即再拍和动态复查。
5. 连续运行至少 24 小时，记录观察次数、失败恢复、重复动作、内存趋势、Wi-Fi 重连、电量和温升。

使用 `npm run acceptance:hardware -- --device-id <设备 ID>` 执行上述验收；中断后用 `--resume <报告路径>` 继续。这些入口、协议、原子检查点和机器判定已经就绪；恢复连接后只做物理验收，不需要重新设计软件架构。
