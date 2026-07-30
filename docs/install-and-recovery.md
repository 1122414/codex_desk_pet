# Codex Desk Buddy 安装与恢复

这份说明面向第一次接触嵌入式开发的使用者。设备固定为 M5Stack Tab5 Kit `K145`（ESP32-P4 + ESP32-C6）；当前固件不适用于 CoreS3、Core2、Cardputer 或 StickC。

## 电脑准备

1. 安装 Node.js 22 或更高版本。
2. 安装 PlatformIO Core，并确认终端可以执行 `pio --version`。
3. 安装 Codex，并确认终端可以执行 `codex --version`。
4. 在项目目录运行 `npm install`。

使用 Codex Desktop 或 `codex login` 完成账户登录即可。项目通过本机 Codex App Server 复用这个登录态，不需要、也不会读取 OpenAI API Key；不要为本项目额外创建 `OPENAI_API_KEY`。AI 对话、语音识别和视觉理解期间，Codex App Server 与 Bridge 都必须保持运行。

准备完成后运行：

```bash
npm run doctor
```

只有 `ok` 为 `true` 时，Node、Codex App Server、当前实验性 Schema、PlatformIO 和完整发布包才同时就绪。若发布包尚未生成，先执行下一节，再重新运行诊断。

第一次构建需要联网下载固定版本的 ESP32 工具链和 Espressif ESP-SR v1.2.0 中文 TTS 资源。依赖版本、来源、文件大小和 SHA‑256 都由仓库配置或脚本固定；下载内容不提交到 Git。

## 启用 Codex Desktop、CLI 与 IDE 状态

先运行一次 Bridge 生成本机 Hook Token：

```bash
npm start
```

看到 Bridge 启动成功后按 `Ctrl+C` 停止，再安装用户级 Hooks：

```bash
npm run install:codex-hooks
```

重新运行并保持 `npm start`，然后在 Codex 中打开 `/hooks`，检查并信任“同步 Codex Desk Buddy 状态”命令，再新建任务。再次运行 `npm run doctor`，`hooks.configured` 应为 `true`。完整状态映射、隐私字段、卸载方法和外部审批限制见 [Codex 跨客户端状态同步](codex-hooks.md)。

这一步会合并修改用户的 `${CODEX_HOME:-$HOME/.codex}/hooks.json`，不会覆盖其他 Hook。项目不会在无人确认时自动替用户信任 Hook。

## 生成可烧录发布包

在干净的 Git 工作区运行：

```bash
npm run release:firmware
```

输出目录为 `dist/firmware/v0.3.0/`，其中包括：

- `codex-desk-buddy-tab5-factory.bin`：首次安装或完整恢复使用的整机镜像。
- `bootloader.bin`、`partitions.bin`、`boot_app0.bin`、`firmware.bin`、`voice_data.bin`、`spiffs.bin`：按固定偏移拆分的组件。
- `manifest.json`：板型、协议、Flash 容量、偏移、大小和逐文件 SHA‑256。
- `THIRD_PARTY_ESP_SR_LICENSE.txt`：随中文语音数据交付的上游许可。

发布脚本会先校验 TTS 资源、重新编译固件、检查每个组件是否越过分区、按 ESP32‑P4 的固定启动布局（bootloader 位于 `0x2000`）合并工厂镜像，再从磁盘重新读取全部文件验证大小和 SHA‑256。工作区有未提交改动时默认拒绝发布；`--allow-dirty` 只用于开发阶段验证，不能用于正式交付。

## 首次烧录

1. 用支持数据传输的 USB‑C 线连接 Tab5 和电脑。
2. 运行 `pio device list`，找到 Tab5 对应的串口。
3. 明确指定这个串口：

```bash
npm run flash:firmware -- --port /dev/cu.usbmodemXXXX
```

Windows 串口形如 `COM5`，Linux 通常形如 `/dev/ttyACM0`。脚本不会自动选择设备；在运行任何写入命令前，它会再次验证发布清单、每个组件和整机镜像。

默认不会擦除整片 Flash。只有在分区损坏、设备无法启动或需要彻底恢复时才使用：

```bash
npm run flash:firmware -- --port /dev/cu.usbmodemXXXX --erase
```

`--erase` 会清除设备上的 Wi‑Fi、配对凭据和 Pet 缓存指针，之后必须重新配网和配对。

## 配网与账户配对

1. 在电脑运行 `CODEX_DESK_DEVICE_HOST=0.0.0.0 npm start`。
2. 用浏览器打开 `http://127.0.0.1:4317`。
3. 保持 USB 数据线连接，在控制面板生成一次性账户配对码，再在 Tab5 屏幕输入。
4. 配对成功后，展开“通过已配对的 USB 连接配置 Wi‑Fi”，选择这台 Tab5，输入 2.4 GHz Wi‑Fi、电脑局域网 IPv4 地址和设备端口 `4318`。
5. 浏览器把配置作为一次加密认证的 USB 协议命令发给设备；密码不写进浏览器存储或日志。设备保存后自动重启。
6. 拔掉数据线后，设备通过 Wi‑Fi 连接仍在运行的电脑 Bridge。USB 与 Wi‑Fi 同时存在时，USB 自动成为首选，Wi‑Fi 保持备用。

BLE 配对后可在拔线状态下继续同步任务、Pet、遥测和轻量操作，但不参与首次账户配对或 Wi‑Fi 配置，也不传输 Pet 大文件、语音或图片。完整语音与摄像头能力需要 USB 或 Wi‑Fi。

## 配置主动关怀

在控制面板展开“主动关怀”：

1. 保持总开关开启，设置随机观察的最短/最长间隔。默认是 10～30 分钟；这不是固定冷却，AI 也可以安排 1～120 分钟内的动态复查。
2. 设置自动聆听时长，默认 20 秒。AI 主动开口后会等 TTS 完整播放，再自动打开麦克风；静音或到时后结束这一轮，后续回答仍使用同一个 Care 会话。
3. 编辑 AI 人设，并只勾选愿意让它执行的动作。应用必须配置固定 Bundle ID 预设，媒体必须配置固定 HTTP(S) URL 预设；模型不能传入任意应用名、网址或 shell 命令。
4. 可用“立即观察”直接测试摄像头链路。默认 90 秒重复保护只防止同一设备短时间重复拍照，不是 6 小时关怀冷却。
5. “停止当前对话”会中断当前 TTS/自动聆听并让 Care 回到空闲，但保留总开关和下一轮正常调度；若不希望继续观察，请关闭总开关。

AI 每次看完可以保持安静，也可以自然开口。照片、用户回答、动作结果和后续追问进入同一个 Care 上下文；会话重建时会使用本地摘要和近期事件续接。

## 故障恢复顺序

按从轻到重的顺序处理：

1. 对话或录音卡住时先点“停止当前对话”；这会终止当前关怀，不会清除设置或配对信息。
2. 检查控制面板状态与近期关怀记录。图片中断、无效模型 JSON、Codex 断开或设备掉线都会进入失败状态并重新安排观察，不应形成忙循环。
3. 确认 Codex 仍已登录、Bridge 正在运行、2.4 GHz Wi‑Fi 和设备端口 `4318` 可用，等待设备指数退避重连。
4. 用 USB 连接；设备应自动切到 USB，Bridge 会重新发送完整快照。USB 与 Wi‑Fi 上的重复命令会被同一个幂等键抑制。
5. 在控制面板撤销旧设备凭据，保持 USB 连接并重新生成一次性配对码。
6. 重新执行不带 `--erase` 的完整工厂镜像烧录，保留设备配置的可能性。
7. 只有前述步骤都失败时才使用 `--erase`，然后从配网开始重做。

Pet 资源更新失败不会替换正在使用的版本。设备保留双槽 active 指针和最后一份已验证资源；microSD 不可用或资源损坏时回退到内置 Pet。

## 当前真机进度与剩余验收

Tab5 的旧版固件已完成整机烧录、USB 枚举、应用升级、屏幕显示、全屏多点触摸诊断、BLE 拔线状态同步和中文语音分区完整性校验。v0.3.0 主动关怀固件已离线构建并通过虚拟设备闭环，但开发板当前无法连接；恢复连接后继续完成：

- 写入 v0.3.0 工厂镜像，确认原配对凭据是否保留；如因分区布局升级需完整恢复，再重新配对一次。
- 验证一次主动拍照、AI 开场、TTS 后自动聆听和至少五轮连续对话。
- 验证摄像头方向、曝光、色彩、JPEG 发送、AI 保持安静/开口两种路径和临时图片删除。
- 验证 Tab5 音量/亮度、Mac 音量、用户配置应用或媒体预设、立即再拍和动态复查。
- USB 加密配网、2.4 GHz Wi‑Fi、电脑睡眠与路由器重启后的恢复。
- 不同 microSD 的兼容性、真实断电恢复和连续 24 小时主动关怀运行，并记录观察数、失败恢复、重复动作、内存、电量和温升。

Secure Boot、Flash Encryption 和签名升级需要正式生产密钥与真机 eFuse 流程；eFuse 操作不可逆，因此不在无硬件、无量产密钥阶段假装完成。
