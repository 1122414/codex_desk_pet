# Codex Desk Buddy 验收矩阵

结论分为三类：

- **已完成**：当前工作区有源代码、自动化测试或可复验产物直接证明。
- **真机部分完成**：已获得某项物理证据，但仍有明确的真机子项需要复验。
- **代码完成，待真机**：所有非物理实现和构建已完成，但结果依赖实际屏幕、射频、电源或外设。
- **公开能力限制**：上游没有公开接口，项目明确保留边界而不伪造能力。

## 需求逐项验收

| 原始需求 | 实现与证据 | 结论 |
| --- | --- | --- |
| 触摸屏 | Tab5 诊断固件已在 1280×720 全屏读取多点触摸并显示正确触点；配对键盘已停止 50 ms 整屏刷新并改为按下立即响应；原生 C++ 继续验证手势与审批冷却 | 真机部分完成；最新配对键盘手感待用户回公司复验 |
| 展示 PC 端全部状态和动画 | `src/shared/codex-state.js` 归一化 Codex 生命周期；官方 Hooks 接收 Desktop、CLI、IDE 的 Session、Turn、工具、等待审批和完成事件；`src/shared/pet-spec.js` 定义 9 个图集动画和 16 个看向方向 | 已完成；用户需审查并信任 Hooks |
| 设备允许/拒绝审批 | Bridge 会话关联原始 RPC ID；Desktop、CLI、IDE 使用官方 `PermissionRequest` Hook 的 `allow`/`deny` 输出；Hook 最长等待 115 秒，详情不完整或小屏放不下时禁止设备允许 | 已完成 |
| 内置与自定义 Pet，自由切换；新 Pet 在 PC 制作 | `src/server/pet-catalog.js` 校验 v1/v2；`src/server/device-pet-asset.js` 转换 384×416 设备帧；`firmware/src/pet_store.cpp` 缓存和回退；浏览器、触摸、滑动和屏幕左右按钮都可切换 | 已完成 |
| 按键切换、电脑切换、Codex 同步 | 触摸和屏幕左右按钮向 Bridge 发 `pet.select`，电脑控制面板写同一 Bridge 选择状态并广播所有设备；Tab5 外接物理按键映射保留给真机验收 | 设备与本项目电脑端同步已完成；Codex 官方客户端没有公开 Pet 选择事件，不能宣称原生双向同步 |
| 显示最近运行任务 | Bridge 调用 `thread/list`，官方 Hooks 补充其他 Codex 客户端的实时生命周期；状态模型在审批、活动和最近完成任务之间按明确优先级选取显示线程 | 已完成 |
| 声音、中文语音、时钟、电量、Token、等级 | `firmware/src/device_audio.cpp` 使用独立任务播放 ESP-SR 离线中文 TTS 并安全降级提示音；真机语音分区已烧录、映射并通过 CRC 完整性校验；UI 读取 RTC、电池并显示 Token/等级 | 真机部分完成；音质、音量、电量曲线和温升待实测 |
| USB 常联和稳定无线 | 真机已完成整机烧录、USB 枚举和应用分区升级；协议 v3 使用双向 HMAC、AES‑256‑GCM、ACK、快照重同步和指数退避；虚拟 Tab5 完成加密 USB/Wi-Fi 接管；501 个会话形成 500 次链路切换并注入四类故障 | 真机部分完成；真实账户配对、天线、路由器和电脑睡眠环境待实测 |
| 蓝牙或其他无线方式 | Tab5 的 ESP32-C6 经 SDIO 提供 2.4 GHz Wi‑Fi；已配对的 USB 加密会话写入网络与 Bridge 地址，重启后日常无线走 Wi‑Fi | Wi‑Fi 代码完成，待真机；Tab5 MVP 明确不启用 BLE |
| 产品化稳定性 | 每设备密钥、会话加密、凭据撤销、CSRF、回环控制面板、资源双槽回退、固定依赖、完整工厂镜像、逐文件 SHA‑256、显式串口恢复和故障压力测试 | 真机前软件基线完成；生产签名、eFuse、72 小时和认证测试待硬件与量产密钥 |
| 不要求电脑关机后仍获取 Codex 状态 | Bridge 是 Codex 数据源；电脑关闭时设备保留本地 Pet/时钟并显示离线，不伪造实时任务 | 按约定排除 |
| 不要求 6/8 小时续航承诺 | 固件读取电量与充电状态，但没有无实测的续航承诺 | 按约定排除 |

## 一次性复验命令

```bash
npm run test:virtual-tab5
npm run doctor
npm run check
npm run test:stability
PIO=/path/to/pio npm run release:firmware
npm run smoke:codex
```

- `test:virtual-tab5` 在临时目录中自动完成一次性 USB 配对、密钥保存、加密双链路、遥测、28,114,944 Bytes V2 Pet 转换/安装、审批和 Wi-Fi 接管，不修改正式设备凭据。
- `doctor` 检查 Node、Codex 版本、实际 App Server 连接、当前实验性 Schema 的四个必要方法、Hooks、PlatformIO 和完整固件包。
- `check` 检查全部 JavaScript 语法，运行 94 项领域/协议/HTTP/虚拟设备测试，并用 C++17 重新编译固件核心测试。
- `test:stability` 打印 500 次链路切换、各类故障和 250 次资源恢复的实际计数。
- `release:firmware` 使用真实 ESP32-P4 工具链构建并复验完整工厂镜像。
- `smoke:codex` 真实初始化 App Server 并读取最近线程，不创建或修改 Codex 任务。

## 2026-07-26 离线复验结果

- `npm run check`：94/94 项测试和固件核心检查通过。
- `npm run test:virtual-tab5`：真实协议的一次性配对、AES 加密、USB/Wi-Fi 双链路、遥测、28,114,944 Bytes V2 Pet 转换/安装、审批和 Wi-Fi 接管通过。
- `npm run test:stability`：501 个认证会话、500 次链路切换、250 次资源中断恢复和全部故障注入通过。
- 浏览器 Mock 验收：1280×720 布局、9/9 动画、16/16 V2 看向方向、V1 能力禁用、Pet 切换和审批均通过，浏览器控制台 0 错误。
- `npm run smoke:codex`：Codex Desktop `0.146.0-alpha.3.1` 的 App Server 初始化和最近线程读取通过。
- `npm run doctor`：Codex Hooks 已安装并识别 6 类事件；PlatformIO 与完整发布包健康。
- 最新工厂镜像：14,513,649 Bytes，SHA-256 `09442c197903a9622572183c4bfcbcdac70f0d6f5eeb5da85e1170240d857557`。

## 用户回公司后的剩余清单

只有以下项目没有办法在无实物状态下诚实关闭：

1. 输入一次新配对码，确认数字按下立即响应、命中准确并成功建立账户密钥。
2. 通过加密 USB 会话配置 2.4 GHz Wi-Fi，拔线后检查任务、Pet 与审批同步；再测试弱信号、路由器重启和电脑睡眠恢复。
3. 插入 microSD，传输并切换一个自定义 Pet，检查断点续传、重启保持和物理随机断电回退。
4. 实听中文语音与提示音，检查 RTC、电量、充电状态和温升。
5. 连续运行 72 小时，记录内存趋势、断线次数、恢复时间、充电和温度。
6. 确定量产密钥管理后再启用 Secure Boot、Flash Encryption 与签名升级；eFuse 不做无真机演练。

这些项目已经有明确入口和预期结果，设备到手后不需要重新设计架构。
