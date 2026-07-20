# Codex Desk 设备协议

这份协议是电脑 Bridge 和 CoreS3 K128 固件之间的稳定边界。当前仓库已经实现协议、Bridge 会话、USB CDC、Wi‑Fi WebSocket、BLE GATT 分片抽象、配对凭据、Pet 资源传输和故障测试；浏览器模拟器使用同一个 Bridge 状态，但不伪装成硬件链路。

## 传输

- USB：ESP32-S3 USB CDC，使用换行分隔的 UTF-8 JSON 消息。
- Wi‑Fi：独立设备 WebSocket 服务，默认 `ws://127.0.0.1:4318/device/ws`；每个文本消息包含一条完整 JSON 消息。真机接入时显式设置 `CODEX_DESK_DEVICE_HOST=0.0.0.0`，不能暴露电脑控制面板的 `4317` 端口。
- BLE：协议消息按协商 MTU 分片、校验并重组，用于首次配对、恢复和低带宽控制；大图集会明确要求改用 Wi‑Fi 或 USB。
- 三条链路使用完全相同的消息结构和命令语义。
- USB 和 Wi‑Fi 同时在线时，USB 是首选控制链路，Wi‑Fi 保持热备；同一个 `commandId` 只能执行一次。
- 每条链路都有可靠消息在途上限；大 Pet 不会一次性灌满串口或 WebSocket 发送缓冲区。

## 消息封装

```json
{
  "version": 1,
  "id": "018f...",
  "sequence": 42,
  "type": "snapshot",
  "sentAt": 1784347200000,
  "sessionId": "经过双向认证后派生的会话 ID",
  "payload": {}
}
```

字段约束：

- `version`：当前固定为 `1`；未知版本必须拒绝，不能按旧版本猜测。
- `id`：全局消息 ID，用于 ACK 和日志关联。
- `sequence`：每个方向独立递增的正整数。
- `type`：配对与认证消息、业务消息、资源消息、`ack`、`heartbeat` 或 `error`。
- `sentAt`：发送端 Unix 毫秒时间。
- `sessionId`：认证完成后必填；会话外消息必须拒绝。
- `payload`：对象；`command` 消息的命令必须在协议白名单中。

完整消息类型：

- 配对与认证：`hello`、`pair.request`、`pair.accepted`、`pair.rejected`、`challenge`、`authenticate`、`ready`
- 状态与控制：`snapshot`、`event`、`command`
- 可靠性：`ack`、`heartbeat`、`error`
- Pet 资源：`resource.manifest`、`resource.request`、`resource.chunk`、`resource.commit`

当前命令白名单：

- `pet.select`
- `approval.decide`
- `telemetry.update`
- `state.preview`

## 配对和双向认证

1. 电脑控制面板生成 6 位、单次使用、5 分钟过期的配对码；同时存在的配对码数量有上限。
2. 未配对设备只能通过 USB 或 BLE 发送 `pair.request`；Wi‑Fi 配对会被拒绝。
3. Bridge 为每台设备生成独立 256 位随机密钥，凭据文件以 `0600` 权限原子写入；损坏的凭据文件会报错，绝不静默覆盖。
4. 后续连接使用设备 nonce、Bridge nonce、设备 ID 和方向角色生成 HMAC-SHA256 证明，双方都验证成功后派生新的 `sessionId`。
5. 同一设备、同一传输的新认证会话会替换旧会话；撤销凭据会立即关闭该设备的所有链路。
6. 未完成认证的空连接 10 秒后关闭；Bridge 同时接收的设备会话有硬上限。

配对密钥只允许在 USB/BLE 的本地配对链路下发，不会进入浏览器 API、设备列表或日志。

## 可靠性规则

1. Bridge 每 5 秒发送一次心跳；15 秒未收到任何有效消息即判定链路失效。
2. 收到重复序号时不重复执行，只重发 ACK。
3. 收到序号缺口时停止应用增量，发送代码为 `RESYNC_REQUIRED` 的 `error`，并等待新的全量 `snapshot`。
4. `snapshot` 可以跨过序号缺口并重置接收窗口；普通 `event` 不可以。
5. 控制命令必须携带独立 `commandId`；会话内和跨 USB/Wi‑Fi 链路都会去重。
6. 断线重连采用带抖动的指数退避：1、2、4、8、16 秒，之后不超过 30 秒。
7. 重新连接后先完成身份验证，再由 Bridge 主动发送最新全量快照；不能从本地缓存继续发送旧审批。
8. Pet 切换和遥测是幂等状态；审批是一次性操作，成功或失效后必须从快照中移除。

## ACK 示例

```json
{
  "version": 1,
  "id": "ack-message-id",
  "sequence": 43,
  "type": "ack",
  "sentAt": 1784347200120,
  "payload": {
    "acknowledgedId": "018f...",
    "acknowledgedSequence": 42
  }
}
```

## 审批安全

- 设备只显示 `accept`（允许一次）和 `decline`（拒绝）。MVP 不提供会话级永久授权。
- `accept` 只有在 Bridge 仍持有同一个原始 JSON-RPC 请求 ID、请求未失效、命令或文件范围可完整显示时才可用。
- 设备命令需要同时匹配 `requestId` 和一次性 `commandId`。
- 重连、序号缺口或审批被其他客户端处理后，旧按钮立即失效。
- 屏幕无法完整呈现的高风险详情必须转到电脑确认，不能用截断文本直接批准。

## Wi‑Fi 产品化门槛

真机版本不能直接信任局域网：

- 首次配对由 USB 或设备屏幕上的短时验证码完成。
- 每台设备保存独立、可撤销的随机凭据。
- WebSocket 建连后的设备协议必须完成 HMAC 双向认证；未配对客户端不能进入业务会话。
- 凭据不得写入日志或前端静态文件。
- 当前 MVP 的局域网 WebSocket 尚未提供传输加密，只允许在受信局域网测试。正式产品必须在真机性能验证后启用证书固定的 WSS 或等价的应用层加密，才能把任务与审批详情视为保密数据。

## Pet 资源同步

- Bridge 发送 manifest、文件大小和 SHA-256；设备按 hash 判断是否已有缓存。
- 图集分块传输，每块带偏移、长度和校验；全部完成后再原子替换当前文件。
- USB/Wi‑Fi 资源分块受 ACK 窗口流控；BLE 会返回 `resource.requires-high-bandwidth`，不尝试低速传完整图集。
- 断点续传只接受与 manifest hash 一致的临时文件。
- v1/v2 尺寸或 manifest 不匹配时拒绝安装，并保留上一个可用 Pet。
- microSD 是多 Pet 缓存的默认位置；内部 Flash 只保留固件和最小回退 Pet。
- Bridge 不会把原始 WebP 直接交给微控制器解码。它先将 192×208 单格按 3/4 缩放为 144×156，再转换为小端 RGB565；透明像素使用保留色 `0x0001`，原本会量化为该颜色的不透明像素改为 `0x0000`。
- `resource.manifest` 固定声明 `format=rgb565-key-v1`、单帧尺寸、帧数和透明色。v1 是 72 帧，v2 是 88 帧；设备会据此验证精确字节数，不能只相信 Bridge 声明。
- 固件先写 `<pet>.part` 和可恢复区间清单；整包 SHA‑256 通过后才重命名为以完整 hash 命名的不可变资源，并最后切换 active 指针。断电不会覆盖上一份已验证资源。
