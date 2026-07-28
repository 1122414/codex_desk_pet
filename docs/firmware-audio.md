# Tab5 固件音频

## 实现

设备使用 Espressif ESP-SR 的 ESP32-P4 离线中文 TTS 静态库，配合 PioArduino / ESP-IDF 5.4 工具链。

`npm run setup:firmware-tts` 从 Espressif 官方仓库的固定 commit `2f8c4b0459db5bbb39abd77adae27962d6d94bcb` 下载：

- ESP32-P4 TTS 静态库；
- 包含 `xiaoxin` 声音集的静态库；
- `xiaoxin_small` 中文语音数据；
- 原始头文件和 Espressif 许可。

每个文件都必须通过仓库脚本内固定的 SHA‑256，损坏、替换或下载失败都会中止安装。依赖缓存位于 `firmware/.pio/esp-tts/p4-2f8c4b04/`，不会提交进 Git。

## 设备行为

- 六种状态分别播报“准备就绪”“代码助手正在运行”“代码助手需要确认”“代码助手正在审查”“任务已完成”“任务遇到问题”。
- Pet 安装、Pet 切换和配对成功也有固定中文短句。
- 音频由独立 FreeRTOS 任务生成和送入 M5Unified 扬声器队列；主网络/UI 循环不等待语音或多段提示音。
- 单击“对话”或“命令”开始时，设备暂停扬声器并以 16 kHz 单声道录音；再次单击结束后，经已认证的 USB/Wi‑Fi 加密链路发送。ChatGPT 登录由电脑端 `whisper.cpp` 以 CPU 模式离线转写，不需要 API Key；API Key 登录仍可使用 Codex App Server Realtime。
- 对话转写进入只读 Pet 会话并朗读回复；命令转写只显示确认卡，用户明确允许后才创建工作区任务。BLE 不传 PCM。
- 队列只保留最新事件。审批、错误等新状态到来时会停止旧播报，避免过期提示继续播放。
- `voice_data` 在首次初始化时以内部 RAM 小块从 Flash 读取、使用 ESP ROM 的流式 CRC32 校验完整数据，再存入 Tab5 的 PSRAM，并与同一套 `xiaoxin` 发音表绑定。Tab5 的 P4 SHA 加速器在这份大流式负载下会给出不稳定结果，运行时因此使用稳定的 ROM CRC32；发布和烧录流程仍对原始 TTS 文件及完整工厂镜像做 SHA‑256 校验。分区缺失、数据损坏、TTS 初始化失败或播放失败时自动使用有区分度的非阻塞音型。

## Flash 布局

16 MiB Flash 保留双 OTA：

| 分区 | 大小 | 用途 |
| --- | ---: | --- |
| `app0` | 6.25 MiB | 当前/候选应用 |
| `app1` | 6.25 MiB | OTA 回退应用 |
| `voice_data` | 2.8125 MiB | 固定中文语音数据 |
| `spiffs` | 0.5625 MiB | 无损压缩的内置 Pet 资源 |

自定义 Pet 的大资源继续存放在 microSD，不占用 `spiffs`。语音数据独立于应用 OTA，升级应用时不会重复搬运 2.8 MiB 语音包；完整工厂镜像包含 `spiffs` 内置 Pet，恢复出厂后也能直接显示。

## 许可与产品边界

ESP-SR 使用 Espressif MIT License，许可范围限定在 Espressif Systems 产品上；Tab5 的 ESP32-P4 符合该限制，许可文本也明确允许复制、修改、分发和销售。发布包必须保留原始许可文本。电脑转写使用 MIT 许可的 `whisper.cpp`，安装的可执行文件和模型不打包进本仓库。这里没有使用操作系统自带语音、在线 TTS 抓取或来源不明的录音。

真机前已验证：官方文件哈希、C++ ABI 兼容层、静态库链接、Flash 分区尺寸、Realtime 状态机、命令确认边界和完整 ESP32-P4 固件构建。仍需在 v0.2.0 真机验证：麦克风增益、转写延迟、扬声器音量、破音、录放切换和实际中文听感。
