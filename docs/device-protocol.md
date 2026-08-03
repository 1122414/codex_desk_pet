# Codex Desk 设备协议

这份协议是电脑 Bridge 和 M5Stack Tab5 K145 固件之间的稳定边界。当前仓库已经实现协议、Bridge 会话、USB CDC、Wi‑Fi WebSocket、配对凭据、Pet 资源传输和故障测试；浏览器模拟器使用同一个 Bridge 状态，但不伪装成硬件链路。

## 传输

- USB：ESP32-P4 USB CDC，使用换行分隔的 UTF-8 JSON 消息。
- Wi‑Fi：独立设备 WebSocket 服务，默认 `ws://127.0.0.1:4318/device/ws`；每个文本消息包含一条完整 JSON 消息。真机接入时显式设置 `CODEX_DESK_DEVICE_HOST=0.0.0.0`，不能暴露电脑控制面板的 `4317` 端口。
- BLE：板载 ESP32-C6 提供低带宽 GATT 链路，用于拔线后的状态快照、Pet 选择和审批；资源、PCM 语音和 JPEG 图片因吞吐限制必须使用 USB 或 Wi‑Fi。
- Tab5 的 ESP32-P4 不带原生无线电，板载 ESP32-C6 同时负责 BLE 与 ESP-Hosted/SDIO Wi‑Fi。
- USB、Wi‑Fi 和 BLE 使用完全相同的认证、加密消息结构和轻量命令语义。
- USB 和 Wi‑Fi 同时在线时，USB 是首选控制链路，Wi‑Fi 保持热备；同一个 `commandId` 只能执行一次。
- 每条链路都有可靠消息在途上限；大 Pet 不会一次性灌满串口或 WebSocket 发送缓冲区。

## 消息封装

```json
{
  "version": 5,
  "id": "018f...",
  "sequence": 42,
  "type": "snapshot",
  "sentAt": 1784347200000,
  "sessionId": "经过双向认证后派生的会话 ID",
  "payload": {
    "encrypted": true,
    "algorithm": "A256GCM",
    "nonce": "12字节base64url",
    "data": "密文base64",
    "tag": "16字节认证标签base64url"
  }
}
```

字段约束：

- `version`：当前固定为 `5`；未知版本必须拒绝，不能按旧版本猜测。
- `id`：全局消息 ID，用于 ACK 和日志关联。
- `sequence`：每个方向的可靠消息独立递增。ACK、心跳和错误不占用可靠序号，使用下一个可靠序号作为关联位置，也不推进可靠接收窗口。
- `type`：配对与认证消息、业务消息、资源消息、`ack`、`heartbeat` 或 `error`。
- `sentAt`：发送端毫秒时间；Bridge 使用 Unix 时间，设备在时钟同步前可使用启动后的单调时间。它只用于关联和认证附加数据，不能跨设备比较。
- `sessionId`：认证完成后必填；会话外消息必须拒绝。
- `payload`：握手阶段是经过严格校验的明文对象；认证后的非握手消息必须是上述加密对象。解密后的 `command` 仍必须在协议白名单中。

完整消息类型：

- 配对与认证：`hello`、`pair.request`、`pair.accepted`、`pair.rejected`、`challenge`、`authenticate`、`ready`
- 状态与控制：`snapshot`、`event`、`command`
- 可靠性：`ack`、`heartbeat`、`error`
- Pet 资源：`resource.manifest`、`resource.request`、`resource.chunk`、`resource.commit`

当前命令白名单：

- `pet.select`
- `approval.decide`
- `companion.command.decide`
- `telemetry.update`
- `voice.start`
- `voice.stop`
- `camera.capture`
- `device.brightness.set`
- `device.volume.set`
- `state.preview`
- `wifi.provision`：只允许 Bridge 经已认证的 USB 会话发送，保存网络和 Bridge 地址后设备重启。

## 配对和双向认证

1. 电脑控制面板生成 6 位、单次使用、5 分钟过期的配对码；同时存在的配对码数量有上限。
2. 首次账户配对只开放 USB；Wi‑Fi 配对始终被拒绝。
3. Bridge 为每台设备生成独立 256 位随机密钥，凭据文件以 `0600` 权限原子写入；损坏的凭据文件会报错，绝不静默覆盖。
4. 后续连接使用设备 nonce、Bridge nonce、设备 ID、设备信息哈希和方向角色生成 HMAC-SHA256 证明，双方都验证成功后派生新的 `sessionId`。
5. 同一设备、同一传输的新认证会话会替换旧会话；撤销凭据会立即关闭该设备的所有链路。
6. 未完成认证的空连接 10 秒后关闭；Bridge 同时接收的设备会话有硬上限。

当前配对密钥只通过 USB 本地链路下发，不会进入浏览器 API、设备列表或日志。网络配置同样只允许在已完成配对的 USB 加密会话中写入：浏览器将 Wi‑Fi 名称、密码、电脑局域网地址和端口交给本机 Bridge，Bridge 不记录密码，只经对应 USB 会话发送 `wifi.provision`。固件拒绝任何 Wi‑Fi 链路发来的配网命令，保存成功后自动重启。

## 会话加密

- `ready` 之前的配对/认证消息保持明文，但由双向 HMAC 证明保护身份；`ready` 之后的所有非握手消息都必须使用 AES‑256‑GCM，包括 ACK、心跳、错误、快照、命令和资源。
- 每个方向使用不同的 256 位会话密钥。密钥通过配对密钥对 `deviceId`、双方 nonce、协议版本和方向做 HMAC-SHA256 派生。
- `hello` 中的板型、固件、能力和健康状态先按固定字段顺序计算 SHA‑256；该哈希进入双方握手证明和会话派生，不能被中间链路静默替换。
- GCM nonce 是方向密钥对消息 ID 和序号做 HMAC-SHA256 后的前 12 字节。即使多个不可靠控制帧共享同一个可靠序号，只要消息 ID 不同，nonce 仍不复用。
- `version`、消息 ID、序号、类型、发送时间和 `sessionId` 作为 GCM 附加认证数据。修改任一元数据或密文字节都会导致认证失败。
- 认证后的明文消息会触发 `ENCRYPTION_REQUIRED` 并关闭或重新认证链路；密文认证失败会触发 `DECRYPTION_FAILED`。
- 外层消息类型、长度和时序仍可见；应用层加密保护 payload 的机密性和完整性，不等同于隐藏流量特征。

## 可靠性规则

1. Bridge 每 5 秒发送一次心跳；15 秒未收到任何有效消息即判定链路失效。
2. 收到重复序号时不重复执行，只重发 ACK。
3. 收到序号缺口时停止应用增量，发送代码为 `RESYNC_REQUIRED` 的 `error`，并等待新的全量 `snapshot`。
4. `snapshot` 可以跨过序号缺口并重置接收窗口；普通 `event` 不可以。
5. 控制命令必须携带独立 `commandId`；会话内和跨 USB/Wi‑Fi 链路都会去重。
6. 断线重连采用带抖动的指数退避：1、2、4、8、16 秒，之后不超过 30 秒。
7. 重新连接后先完成身份验证，再由 Bridge 主动发送最新全量快照；不能从本地缓存继续发送旧审批。
8. Pet 切换和遥测是幂等状态；审批是一次性操作，成功或失效后必须从快照中移除。
9. ACK、心跳和错误帧不进入可靠窗口；丢失它们不会制造永久序号缺口，可靠消息仍按原序号重试。

## ACK 示例

线上 ACK 仍使用加密 payload；解密后的逻辑内容为：

```json
{
  "acknowledgedId": "018f...",
  "acknowledgedSequence": 42
}
```

## 审批安全

- 设备只显示 `accept`（允许一次）和 `decline`（拒绝）。MVP 不提供会话级永久授权。
- 命令、文件修改和 `item/permissions/requestApproval` 都使用同一审批卡。额外权限允许时只回传请求中的权限子集并固定为 turn 作用域；拒绝时回传空权限集合。
- `accept` 只有在 Bridge 仍持有同一个原始 JSON-RPC 请求 ID、请求未失效、命令或文件范围可完整显示时才可用。
- 设备命令需要同时匹配 `requestId` 和一次性 `commandId`。
- 重连、序号缺口或审批被其他客户端处理后，旧按钮立即失效。
- 屏幕无法完整呈现的高风险详情必须转到电脑确认，不能用截断文本直接批准。

## Wi‑Fi 安全边界

真机版本不能直接信任局域网：

- 首次配对由 USB 或设备屏幕上的短时验证码完成。
- 每台设备保存独立、可撤销的随机凭据。
- WebSocket 建连后的设备协议必须完成 HMAC 双向认证；未配对客户端不能进入业务会话。
- 凭据不得写入日志或前端静态文件。
- 协议 v5 已提供应用层 AES‑256‑GCM 加密、认证设备信息绑定和独立可靠序号语义，并已通过篡改、方向隔离、设备信息替换、nonce 唯一性和明文降级测试；任务、审批、语音、图片和关怀动作结果 payload 不再以明文出现。
- 设备服务仍必须与控制面板分端口、限制会话数、保持凭据可撤销。公网部署还需要防火墙、速率限制和 WSS/反向代理，不能只依赖应用层加密。

## Pet 资源同步

- Bridge 发送 manifest、文件大小和 SHA-256；设备按 hash 判断是否已有缓存。
- 图集分块传输，每块带偏移、长度和校验；全部完成后再原子替换当前文件。
- USB/Wi‑Fi 资源分块受 ACK 窗口流控；BLE 明确拒绝 Pet、语音和图片传输。
- 断点续传只接受与 manifest hash 一致的临时文件。
- v1/v2 尺寸或 manifest 不匹配时拒绝安装，并保留上一个可用 Pet。
- microSD 是多 Pet 缓存的默认位置；内部 Flash 只保留固件和最小回退 Pet。
- Bridge 不会把原始 WebP 直接交给微控制器解码。它将每个 192×208 单格放大为 384×416，再转换为小端 RGB565；透明像素使用保留色 `0x0001`，原本会量化为该颜色的不透明像素改为 `0x0000`。
- `resource.manifest` 固定声明 `format=rgb565-key-v1`、单帧尺寸、帧数和透明色。v1 是 72 帧，v2 是 88 帧；设备会据此验证精确字节数，不能只相信 Bridge 声明。
- 固件先写 `<pet>.part` 和可恢复区间清单；重复区间必须与已写字节逐字节一致，否则拒绝。
- 整包 SHA‑256 通过后才重命名为以完整 hash 命名的不可变资源。active 指针使用两个带 generation 的槽位交替发布；更新任一槽位时另一个已验证槽位保持不动，断电后选择最高的可用 generation，损坏则回退上一槽或内置 Pet。

## 语音、视觉与主动关怀

- 设备按住“对话”或“命令”后发送 `voice.start`，随后通过加密 `event` 发送 16 kHz、单声道 PCM 分块，松开时发送 `voice.stop`。
- Bridge 把 PCM 汇成临时 WAV，使用本机 `whisper-cli` 多语言模型得到文字并立即删除临时音频；对话交给临时只读 Pet 会话，命令只进入设备确认队列，未确认时绝不创建可执行任务。
- 手动拍照或 Bridge 的主动观察调度都会发送 `camera.capture`。P4 把相机 RGB565 帧硬件编码为不超过 512 KiB 的 JPEG，依次发送 `vision.capture.begin/chunk/end`。
- Bridge 强制校验设备身份、USB/Wi‑Fi 链路、分块顺序、总大小与 SHA‑256；临时文件权限为 `0600`，多模态回合结束后立即删除。
- 主动观察默认在 10～30 分钟内随机触发；AI 可根据本轮结果安排 1～120 分钟内的复查。没有固定 6 小时冷却，每台设备只保留默认 90 秒的技术性重复拍照保护。
- 图片、用户转写、动作执行结果和后续回复进入同一个只读、禁止工具的 Care 会话。AI 可以返回空话术保持安静，也可以用 `care.reply` 让设备朗读；朗读完成后设备自动进入半双工聆听，静音或超时后发送 `voice.stop`，再由同一个 Care 会话继续回答。
- `care.reply` 带 `continueListening` 和 `autoListenSeconds`。设备只在 TTS 完成后启动麦克风，不会同时播放和录音；`care.stop` 会取消待启动或正在进行的自动聆听并停止当前关怀音频。
- AI 只能提议 Bridge 设置中启用的动作：立即观察、安排复查、Tab5 亮度/音量、Mac 音量，以及用户预先配置的应用或媒体。Bridge 再做严格结构校验、范围校验、预设解析、超时和幂等去重；设备调整通过 `device.brightness.set` / `device.volume.set` 下发，并用 `command.result` 回传。
- 摄像头不会连续录像；每次观察都是一张明确边界的 JPEG。照片仅用于当前 Care 回合并在分析后删除。
- `telemetry.update` 每 30 秒上报电量、充电状态、Wi‑Fi RSSI 和 ESP32-P4 芯片温度；温度必须在 -40～125 °C 范围内。Bridge 同时在本机诊断中暴露 RSS/堆内存，用于 24 小时真机趋势验收。
