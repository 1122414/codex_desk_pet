# Codex Desk 设备协议

这份协议是浏览器模拟器和后续 CoreS3 Lite 固件之间的稳定边界。当前仓库已实现消息封装、校验、序号窗口、ACK 和命令去重；物理 USB/Wi‑Fi 传输将在硬件阶段实现。

## 传输

- USB：ESP32-S3 USB CDC，使用换行分隔的 UTF-8 JSON 消息。
- Wi‑Fi：局域网 WebSocket，每个文本帧包含一条完整 JSON 消息。
- 两条链路使用完全相同的消息结构和命令语义。
- USB 和 Wi‑Fi 同时在线时，USB 是首选控制链路，Wi‑Fi 保持热备；同一个 `commandId` 只能执行一次。

## 消息封装

```json
{
  "version": 1,
  "id": "018f...",
  "sequence": 42,
  "type": "snapshot",
  "sentAt": 1784347200000,
  "payload": {}
}
```

字段约束：

- `version`：当前固定为 `1`；未知版本必须拒绝，不能按旧版本猜测。
- `id`：全局消息 ID，用于 ACK 和日志关联。
- `sequence`：每个方向独立递增的正整数。
- `type`：`snapshot`、`event`、`command`、`ack`、`heartbeat` 或 `error`。
- `sentAt`：发送端 Unix 毫秒时间。
- `payload`：对象；`command` 消息的命令必须在协议白名单中。

当前命令白名单：

- `pet.select`
- `approval.decide`
- `telemetry.update`
- `state.preview`

## 可靠性规则

1. Bridge 每 5 秒发送一次心跳；15 秒未收到任何有效消息即判定链路失效。
2. 收到重复序号时不重复执行，只重发 ACK。
3. 收到序号缺口时停止应用增量，发送 `resync.request` 控制错误，并等待新的全量 `snapshot`。
4. `snapshot` 可以跨过序号缺口并重置接收窗口；普通 `event` 不可以。
5. 控制命令必须携带独立 `commandId`；接收端至少保留最近 256 个 ID 的去重窗口。
6. 断线重连采用带抖动的指数退避：1、2、4、8、16 秒，之后不超过 30 秒。
7. 重新连接后先完成身份验证，再请求全量快照；不能从本地缓存继续发送旧审批。
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
- WebSocket 握手必须认证；未配对客户端不能读取任务、命令或文件信息。
- 凭据不得写入日志或前端静态文件。
- 后续评估 ESP32-S3 上的 TLS 成本；如果首版仅使用受信局域网明文 WebSocket，审批必须继续走 USB 或在设备上二次确认，并明确标为非最终产品模式。

## Pet 资源同步

- Bridge 发送 manifest、文件大小和 SHA-256；设备按 hash 判断是否已有缓存。
- 图集分块传输，每块带偏移、长度和校验；全部完成后再原子替换当前文件。
- 断点续传只接受与 manifest hash 一致的临时文件。
- v1/v2 尺寸或 manifest 不匹配时拒绝安装，并保留上一个可用 Pet。
- microSD 是多 Pet 缓存的默认位置；内部 Flash 只保留固件和最小回退 Pet。

