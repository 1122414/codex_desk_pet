# Codex Desk Buddy 安装与恢复

这份说明面向第一次接触嵌入式开发的使用者。设备固定为 M5Stack CoreS3 完整版 `K128`；不要为当前固件购买 CoreS3 Lite、Core2、Cardputer 或 StickC。

## 电脑准备

1. 安装 Node.js 22 或更高版本。
2. 安装 PlatformIO Core，并确认终端可以执行 `pio --version`。
3. 安装 Codex，并确认终端可以执行 `codex --version`。
4. 在项目目录运行 `npm install`。

第一次构建需要联网下载固定版本的 ESP32 工具链和 Espressif ESP-SR v1.2.0 中文 TTS 资源。依赖版本、来源、文件大小和 SHA‑256 都由仓库配置或脚本固定；下载内容不提交到 Git。

## 生成可烧录发布包

在干净的 Git 工作区运行：

```bash
npm run release:firmware
```

输出目录为 `dist/firmware/v0.1.0/`，其中包括：

- `codex-desk-buddy-cores3-factory.bin`：首次安装或完整恢复使用的整机镜像。
- `bootloader.bin`、`partitions.bin`、`boot_app0.bin`、`firmware.bin`、`voice_data.bin`：按固定偏移拆分的组件。
- `manifest.json`：板型、协议、Flash 容量、偏移、大小和逐文件 SHA‑256。
- `THIRD_PARTY_ESP_SR_LICENSE.txt`：随中文语音数据交付的上游许可。

发布脚本会先校验 TTS 资源、重新编译固件、检查每个组件是否越过分区、合并工厂镜像，再从磁盘重新读取全部文件验证大小和 SHA‑256。工作区有未提交改动时默认拒绝发布；`--allow-dirty` 只用于开发阶段验证，不能用于正式交付。

## 首次烧录

1. 用支持数据传输的 USB‑C 线连接 CoreS3 和电脑。
2. 运行 `pio device list`，找到 CoreS3 对应的串口。
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
2. 用 Chrome 或 Edge 打开 `http://127.0.0.1:4317`。
3. 展开“通过蓝牙配置 Wi‑Fi”，输入设备屏幕显示的配网码、2.4 GHz Wi‑Fi、电脑局域网地址和设备端口 `4318`。
4. 浏览器会发起系统蓝牙安全配对。写入成功后设备轮换配网码并重启。
5. 首次账户配对仍保持 USB 连接：在控制面板生成一次性账户配对码，再在设备屏幕输入。
6. 配对成功后可以拔掉数据线；设备通过 Wi‑Fi 连接仍在运行的电脑 Bridge。USB 与 Wi‑Fi 同时存在时，USB 自动成为首选，Wi‑Fi 保持备用。

Web Bluetooth 只写入 Wi‑Fi 和 Bridge 地址，不接触账户配对密钥。当前没有电脑端原生 BLE 日常通信适配器，因此蓝牙不能替代 Wi‑Fi 或 USB 获取 Codex 状态。

## 故障恢复顺序

按从轻到重的顺序处理：

1. 确认电脑 Bridge、2.4 GHz Wi‑Fi 和设备端口 `4318` 可用，等待设备指数退避重连。
2. 用 USB 连接；设备应自动切到 USB，Bridge 会重新发送完整快照。
3. 在控制面板撤销旧设备凭据，保持 USB 连接并重新生成一次性配对码。
4. 重新执行不带 `--erase` 的完整工厂镜像烧录，保留设备配置的可能性。
5. 只有前述步骤都失败时才使用 `--erase`，然后从配网开始重做。

Pet 资源更新失败不会替换正在使用的版本。设备保留双槽 active 指针和最后一份已验证资源；microSD 不可用或资源损坏时回退到内置 Pet。

## 到货后必须完成的真机验收

当前仓库能证明代码、协议、资源、工厂包和恢复脚本在非硬件环境中的行为，但以下项目只能在实物上确认：

- USB 枚举、首次烧录和启动日志。
- 屏幕色彩、撕裂、帧率、触摸坐标和外接按键手感。
- 中文语音音质、扬声器音量、RTC、电池读数、充电和温升。
- 2.4 GHz Wi‑Fi、BLE 配网、电脑睡眠与路由器重启后的恢复。
- 不同 microSD 的兼容性、真实断电恢复和连续 72 小时运行。

Secure Boot、Flash Encryption 和签名升级需要正式生产密钥与真机 eFuse 流程；eFuse 操作不可逆，因此不在无硬件、无量产密钥阶段假装完成。
