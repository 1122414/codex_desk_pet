# Codex 跨客户端状态同步

Codex Desk Buddy 同时使用两条官方集成路径：

- Codex App Server 提供线程详情、Token 和 Bridge 自己收到的原始审批请求。
- Codex Hooks 把 Codex Desktop、CLI 和 IDE 中正在发生的生命周期事件发送给本机 Bridge，并把明确的设备审批决定返回原客户端。

这样，设备不再只依赖 Bridge 新启动的 App Server 进程来判断最近运行、等待输入和完成状态。Hooks 是稳定的生命周期扩展点；App Server 仍是实验性接口，因此 `npm run doctor` 会实际检查当前版本的 Schema。

## 安装

先启动一次 Bridge，让它生成只属于当前用户的 256 位本机 Hook Token：

```bash
npm start
```

看到 Bridge 启动成功后按 `Ctrl+C` 停止，再安装用户级 Hooks：

```bash
npm run install:codex-hooks
```

安装后重新运行 `npm start`，并保持 Bridge 在电脑上运行。

安装器会：

1. 把转发脚本复制到 `${CODEX_HOME:-$HOME/.codex}/codex-desk/hooks/`。
2. 以合并方式更新 `${CODEX_HOME:-$HOME/.codex}/hooks.json`。
3. 保留所有不属于 Codex Desk Buddy 的既有 Hook。
4. 把新文件限制为当前用户可读写。

安装后在 Codex 中打开 `/hooks`，检查并信任这组命令 Hook，然后新建任务。再次运行安装命令是幂等的，不会重复增加处理器。可用下面的命令检查 `hooks.configured`：

```bash
npm run doctor
```

需要移除时：

```bash
npm run remove:codex-hooks
```

移除器只删除带有“同步 Codex Desk Buddy 状态”标识的处理器和转发脚本，不删除其他 Hook。

仓库也包含可打包安装的 `plugins/codex-desk-buddy/`。用户级安装器适合当前本地开发与首次使用；插件目录适合之后的产品分发。无论使用哪种方式，Codex 都要求用户审查并信任非托管命令 Hook。

## 状态映射

| 官方事件 | 设备状态 | 说明 |
| --- | --- | --- |
| `SessionStart` | Ready | 新建、恢复、清空或压缩会话 |
| `UserPromptSubmit` | Running | 用户提交新任务 |
| `PreToolUse` / `PostToolUse` | Running | 任务正在调用或完成工具 |
| `PermissionRequest` | Needs input | 另一个 Codex 客户端正在等待审批；设备决定可返回原客户端 |
| `Stop` | Completed，然后 Ready | 完成动画显示 4 秒 |

乱序 Hook 会按事件时间和同一时刻的状态优先级丢弃；30 分钟没有新 Hook 的外部状态会失效，避免设备永久卡在 Running 或 Needs input。App Server 能提供更精确状态时，错误和真实待审批仍具有更高优先级。

## 外部客户端审批

官方 `PermissionRequest` Hook 当前允许返回 `allow` 或 `deny`。转发器收到该事件后会等待设备或本项目电脑控制面的明确决定，最长 115 秒，再按官方 `hookSpecificOutput` 格式把结果返回原 Codex Desktop、CLI 或 IDE。

允许操作采用失败关闭规则：

- 只有审批详情完整到达 Bridge 时才允许点击“允许”。
- CoreS3 小屏必须能完整显示详情，最多 96 Bytes、3 行；超出时设备只能拒绝，用户可在本项目电脑控制面板完整查看后决定。
- 输入超过本地 64 KiB、详情超过 4 KiB、Bridge 不可用、Token 错误或等待超时，Hook 都不替用户作决定，Codex 继续显示原生审批框。
- 多个 Hook 同时返回结果时，Codex 官方规则仍以任何一个 `deny` 为优先。

Bridge 自己启动的 App Server 审批继续使用原始 JSON-RPC 请求 ID 回应；外部客户端审批只使用官方 Hook 返回值。项目不读取私有数据库，也不伪造另一个客户端的 RPC。

## 隐私与安全

转发器只向 `127.0.0.1:4317` 发送以下有限字段：

- 事件名、会话 ID、Turn ID。
- 用户刚提交提示的前 120 个字符，用作设备任务标题。
- 工作目录的最后一级名称。
- 工具名称和本机时间戳。

普通生命周期事件不会发送工具参数。只有 `PermissionRequest` 会额外发送最多 4 KiB 的完整待审批命令或工具输入摘要，以及最多 160 字符的审批原因；这是设备安全显示并由用户决定所必需的数据。它不会读取或发送 `transcript_path`、工具结果、模型输出、账户 Token 或 Pet 文件。

请求使用保存在 `~/.codex-desk/hook-token` 的随机 256 位 Token 验证；Bridge 未运行、Token 不存在或请求超时都不会阻止 Codex 回到自己的正常审批流程。

如不希望任务标题离开 Codex 进程，可在转发器中移除 `title` 字段；设备仍能显示生命周期状态和工作区名称。
