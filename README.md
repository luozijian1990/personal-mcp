# personal-mcp

个人 MCP 服务实验项目。目前包含：

- 一个无认证、仅监听 loopback 的主服务；
- 一个读取真实服务状态的响应式 Web 控制台；
- 一个通过插件接口加载的 SSH MCP；
- 一个通过 PromQL 查询指标的 Prometheus MCP；
- SSH MCP 的独立运行入口；
- MCP Streamable HTTP，兼容当前协议和 SDK 的旧版无状态请求回退。

## 要求

- Node.js 20 或更高版本；
- `ssh2` Node.js 依赖（`npm install` 会自动安装）；
- 本机拥有可用的 SSH 私钥和对应的 `known_hosts` 条目。

SSH MCP 使用配置的用户名、候选端口和私钥连接白名单主机。服务不会传递密码，不会关闭 host key 检查，也不会自动接受未知主机指纹。

## 安装与构建

```bash
npm install
npm run check
```

## 启动主服务

```bash
npm run dev
```

服务可以在没有 SSH 配置时启动。打开 Web 控制台，进入 SSH MCP 详情页填写本机配置，再点击“保存并重载 MCP”。也可以从脱敏模板开始：

```bash
cp .runtime-config.example.json .runtime-config.json
```

然后把 `.runtime-config.json` 中的示例主机和路径改成本机值。真实配置文件和 SSH 密钥都已加入 `.gitignore`，不会随代码提交；仓库只保留不含个人信息的 `.runtime-config.example.json`。

默认监听 `127.0.0.1:3100`：

- Web 控制台：`http://127.0.0.1:3100/`
- 服务状态 API：`http://127.0.0.1:3100/api/status`
- 健康检查：`http://127.0.0.1:3100/health`（兼容保留 `/healthz`）
- SSH MCP：`http://127.0.0.1:3100/ssh/mcp`
- Prometheus MCP：`http://127.0.0.1:3100/prometheus/mcp`

Web 控制台按三层信息结构组织：

1. 首页只展示 MCP 分类；
2. “MCP 明细”页按分类筛选具体 MCP；
3. 单个 MCP 详情页提供能力、端点，以及 Codex 和 Claude Code 的完整添加命令。

左侧导航只保留图标；在手机宽度下会切换成底部图标导航。

当前 SSH MCP 可直接添加到客户端：

```bash
codex mcp add ssh --url http://127.0.0.1:3100/ssh/mcp
claude mcp add --transport http ssh http://127.0.0.1:3100/ssh/mcp
```

Prometheus MCP 可直接添加到客户端：

```bash
codex mcp add prometheus --url http://127.0.0.1:3100/prometheus/mcp
claude mcp add --transport http prometheus http://127.0.0.1:3100/prometheus/mcp
```

## 运行时配置与重载

进入 Web 控制台的 SSH MCP 详情页，可以查看和修改以下变量：

- `SSH_MCP_ALLOWED_TARGETS`：允许连接的主机白名单，逗号分隔；
- `SSH_MCP_USERNAME`：SSH 登录用户名；
- `SSH_MCP_PORTS`：按顺序尝试的端口列表，逗号分隔；
- `SSH_MCP_ALLOW_COMMANDS`：是否开放可修改远端状态的命令；
- `SSH_MCP_PRIVATE_KEY_PATH`：本机 SSH 私钥路径；
- `SSH_MCP_KNOWN_HOSTS_PATH`：本机 `known_hosts` 路径。

Prometheus MCP 使用以下两个变量：

- `PROMETHEUS_MCP_URL`：Prometheus HTTP(S) 地址；
- `PROMETHEUS_MCP_QUERY_TIMEOUT`：单次查询超时秒数，范围 1-300，默认 30。

为兼容常见部署命名，首次启动时也可使用 `PROMETHEUS_URL` 和 `PROMETHEUS_QUERY_TIMEOUT`；控制台保存时统一写入带 `MCP` 前缀的变量。

控制台点击“保存并重载 MCP”后，新值写入项目根目录的 `.runtime-config.json`。该文件在后续启动时自动加载，并优先于同名环境变量。配置文件以 `0600` 权限原子写入，已加入 `.gitignore`，不应提交到仓库。可以通过 `MCP_RUNTIME_CONFIG_PATH` 修改保存位置。

环境变量仍可用作首次启动或临时配置，但源码中没有任何主机、用户名、端口、私钥或 `known_hosts` 的本机默认值：

```bash
SSH_MCP_ALLOWED_TARGETS=server.example.com \
SSH_MCP_USERNAME=ssh-user \
SSH_MCP_PORTS=22,2222 \
SSH_MCP_PRIVATE_KEY_PATH=~/.ssh/agent_ops_key \
SSH_MCP_KNOWN_HOSTS_PATH=~/.ssh/known_hosts \
npm run dev
```

Prometheus MCP 示例：

```bash
PROMETHEUS_MCP_URL=http://127.0.0.1:9090 \
PROMETHEUS_MCP_QUERY_TIMEOUT=30 \
npm run dev
```

保存前会校验字段、用户名、端口范围、私钥可读且可被 `ssh2` 解析，以及每个白名单目标至少能在一个候选端口上匹配 `known_hosts`。校验或落盘失败时，当前 SSH MCP 实例保持不变；成功后新请求使用新实例，已经执行中的请求继续使用原实例，不需要重启 Node 主进程。

连接时按 `SSH_MCP_PORTS` 从左到右尝试。没有匹配主机指纹或连接认证失败时继续下一个端口；一旦 SSH 连接成功，命令只执行一次，即使命令返回非零也不会换端口重试。

配置 API：

```text
GET  /api/config
GET  /api/config/ssh
PUT  /api/config/ssh
POST /api/config/ssh/reload
GET  /api/config/prometheus
PUT  /api/config/prometheus
POST /api/config/prometheus/reload
```

`PUT` 请求体示例：

```json
{
  "values": {
    "SSH_MCP_ALLOWED_TARGETS": "server.example.com",
    "SSH_MCP_USERNAME": "ssh-user",
    "SSH_MCP_PORTS": "22,2222",
    "SSH_MCP_ALLOW_COMMANDS": false,
    "SSH_MCP_PRIVATE_KEY_PATH": "/path/to/agent_ops_key",
    "SSH_MCP_KNOWN_HOSTS_PATH": "/path/to/known_hosts"
  }
}
```

Prometheus 配置请求体示例：

```json
{
  "values": {
    "PROMETHEUS_MCP_URL": "http://127.0.0.1:9090",
    "PROMETHEUS_MCP_QUERY_TIMEOUT": "30"
  }
}
```

## 日志

主服务会记录每次 MCP 请求和响应，包含 request_id、插件、路径、JSON-RPC 方法、工具、输入、输出、状态码和耗时。每个事件使用一行 `key=value` 日志，`INFO` 输出到 stdout，`ERROR` 输出到 stderr，并全部追加写入 `logs/mcp.log`：

```text
2026-09-03 18:42:10.123 +08:00 INFO  personal-mcp-gateway mcp.request request_id=8f12 plugin=ssh endpoint=/ssh/mcp http_method=POST rpc_id=2 rpc_method=tools/call tool=ssh_get_system_snapshot input="{...}"
2026-09-03 18:42:10.487 +08:00 INFO  personal-mcp-gateway mcp.response request_id=8f12 plugin=ssh status=200 duration_ms=364 completed=true truncated=false output="{...}"
```

可通过 `MCP_LOG_FILE_PATH` 指定日志文件路径。输出中的换行会转义为 `\n`；SSE 包装不会写入日志。单条输入或输出超过 100000 个字符时会截断，避免日志本身占满磁盘。

## 独立启动 SSH MCP

```bash
npm run dev:ssh
```

独立服务同样读取 `.runtime-config.json` 和环境变量。

默认监听 `127.0.0.1:3101`，MCP endpoint 是：

```text
http://127.0.0.1:3101/ssh/mcp
```

## 独立启动 Prometheus MCP

```bash
npm run dev:prometheus
```

默认监听 `127.0.0.1:3102`，MCP endpoint 是：

```text
http://127.0.0.1:3102/prometheus/mcp
```

## SSH 工具

### `ssh_get_system_snapshot`

在白名单目标上执行固定的只读基线：身份、主机名、时间、内核、运行时间和磁盘空间。

### `ssh_execute_command`

执行调用者传入的远程命令。它默认关闭，启用时必须同时满足：

```bash
SSH_MCP_ALLOWED_TARGETS=server.example.com \
SSH_MCP_USERNAME=ssh-user \
SSH_MCP_PORTS=22,2222 \
SSH_MCP_ALLOW_COMMANDS=true \
npm run dev
```

客户端调用时还必须传递 `acknowledgeRemoteChangeRisk: true`。这只是服务端风险门槛，不能代替用户对准确目标和命令的授权。

## Prometheus 工具

### `prometheus_query`

对配置的 Prometheus 服务执行一次 PromQL 即时查询。`query` 必填，`time` 可选（Unix 秒数或 RFC3339 时间）。

### `prometheus_query_range`

对配置的 Prometheus 服务执行 PromQL 区间查询。`query`、`start`、`end` 和 `step` 必填；时间可以使用 Unix 秒数或 Prometheus 支持的时间字符串，步长例如 `15s` 或 `5m`。

两个工具都只读，并返回 Prometheus 原生响应中的 `resultType` 和 `result`（位于 `data` 字段）。请求超过 `PROMETHEUS_MCP_QUERY_TIMEOUT` 后会返回结构化的超时错误，不会无限等待。

## MCP Inspector

主服务启动后，可以另开终端连接：

```bash
npx @modelcontextprotocol/inspector http://127.0.0.1:3100/ssh/mcp
```

当前没有身份认证，所以服务拒绝监听非 loopback 地址。后续加入 OAuth Resource Server 后，再考虑远程监听和公开部署。
