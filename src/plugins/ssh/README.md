<div align="center">

<img src="../../../public/personal-mcp-icon.png" alt="personal-mcp" width="72" />

# SSH MCP

通过受控 SSH 连接获取远程主机状态，并在明确授权后执行命令。

[返回项目首页](../../../README.md)

</div>

SSH MCP 适合让 MCP 客户端诊断 Linux/Unix 主机：服务只连接白名单目标，使用指定私钥认证，并强制校验 `known_hosts` 中的主机指纹。

> [!WARNING]
> `ssh_execute_command` 能够修改或删除远程数据。该工具默认关闭，不能替代操作者对具体目标和命令的授权。

## 工具

| 工具 | 用途 | 风险 |
| --- | --- | --- |
| `ssh_get_system_snapshot` | 获取身份、主机名、时间、内核、运行时间和磁盘空间 | 只读 |
| `ssh_execute_command` | 在一台白名单主机上执行一条 shell 命令 | 可修改远端状态 |

两个工具都接受：

- `target`：`SSH_MCP_ALLOWED_TARGETS` 中的精确主机名或 IP 地址。
- `timeoutSeconds`：执行超时，5–300 秒，默认 30。
- `maxOutputCharacters`：返回的 stdout/stderr 字符上限，1,000–100,000，默认 20,000。

返回结果包含实际端口、已尝试端口、退出码、耗时、stdout、stderr，以及输出是否被截断。

## 配置

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `SSH_MCP_ALLOWED_TARGETS` | 是 | 允许连接的主机名或 IP，多个值用逗号分隔 |
| `SSH_MCP_USERNAME` | 是 | 所有目标共用的 SSH 用户名 |
| `SSH_MCP_PORTS` | 是 | 按顺序尝试的端口，如 `22,2222` |
| `SSH_MCP_PRIVATE_KEY_PATH` | 是 | 本机 SSH 私钥路径，支持 `~/` |
| `SSH_MCP_KNOWN_HOSTS_PATH` | 是 | 用于校验目标指纹的 `known_hosts` 路径 |
| `SSH_MCP_ALLOW_COMMANDS` | 否 | 是否开放任意命令，默认 `false` |

可以在主服务的 Web 控制台中保存并热重载配置，也可以在首次启动时使用环境变量：

```bash
SSH_MCP_ALLOWED_TARGETS=server.example.com \
SSH_MCP_USERNAME=ops-user \
SSH_MCP_PORTS=22,2222 \
SSH_MCP_PRIVATE_KEY_PATH=~/.ssh/ops_key \
SSH_MCP_KNOWN_HOSTS_PATH=~/.ssh/known_hosts \
npm run dev
```

配置保存前会检查字段、私钥格式，以及每个目标是否能在至少一个候选端口上匹配主机指纹。校验失败时，当前运行中的插件不会被替换。

## 启动与接入

使用统一网关：

```bash
npm run dev
```

Endpoint：`http://127.0.0.1:3100/ssh/mcp`

```bash
codex mcp add ssh --url http://127.0.0.1:3100/ssh/mcp
claude mcp add --transport http ssh http://127.0.0.1:3100/ssh/mcp
```

独立运行：

```bash
npm run dev:ssh
```

独立 endpoint：`http://127.0.0.1:3101/ssh/mcp`。可通过 `PORT` 修改端口。

## 调用示例

获取系统快照：

```json
{
  "target": "server.example.com",
  "timeoutSeconds": 30,
  "maxOutputCharacters": 20000
}
```

执行命令前，需要将 `SSH_MCP_ALLOW_COMMANDS` 设为 `true`，并在每次调用中显式确认风险：

```json
{
  "target": "server.example.com",
  "command": "systemctl status nginx --no-pager",
  "timeoutSeconds": 30,
  "maxOutputCharacters": 20000,
  "acknowledgeRemoteChangeRisk": true
}
```

## 安全边界

- 服务不会传递 SSH 密码，也不会自动接受未知主机指纹。
- 目标必须与白名单中的值精确匹配。
- 候选端口只在建立连接前依次尝试；连接成功后，命令只执行一次。
- 私钥内容不会写入运行时配置，但私钥路径属于本机敏感信息。
- MCP 请求和响应可能进入项目日志，请避免在命令中直接携带凭据。
