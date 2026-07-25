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
- 队列只保留最新事件。审批、错误等新状态到来时会停止旧播报，避免过期提示继续播放。
- `voice_data` 在首次初始化时校验完整 SHA‑256，并与同一套 `xiaoxin` 发音表绑定。分区缺失、数据损坏、TTS 初始化失败或播放失败时自动使用有区分度的非阻塞音型。

## Flash 布局

16 MiB Flash 保留双 OTA：

| 分区 | 大小 | 用途 |
| --- | ---: | --- |
| `app0` | 5.5 MiB | 当前/候选应用 |
| `app1` | 5.5 MiB | OTA 回退应用 |
| `voice_data` | 2.8125 MiB | 固定中文语音数据 |
| `spiffs` | 2.0625 MiB | 本地文件系统 |

自定义 Pet 的大资源继续存放在 microSD，不占用 `spiffs`。语音数据独立于应用 OTA，升级应用时不会重复搬运 2.8 MiB 语音包。

## 许可与产品边界

ESP-SR 使用 Espressif MIT License，许可范围限定在 Espressif Systems 产品上；Tab5 的 ESP32-P4 符合该限制，许可文本也明确允许复制、修改、分发和销售。发布包必须保留原始许可文本。这里没有使用操作系统自带语音、在线 TTS 抓取或来源不明的录音。

真机前已验证：官方文件哈希、C++ ABI 兼容层、静态库链接、Flash 分区尺寸、纯 C++ 音频计划测试和完整 ESP32-P4 固件构建。仍需真机验证：扬声器音量、破音、连续状态打断效果和实际中文听感。
