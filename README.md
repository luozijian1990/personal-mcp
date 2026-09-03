# personal-mcp

个人 MCP 服务实验项目。目前包含：

- 一个无认证、仅监听 loopback 的主服务；
- 一个读取真实服务状态的响应式 Web 控制台；
- 一个通过插件接口加载的 SSH MCP；
- SSH MCP 的独立运行入口；
- MCP Streamable HTTP，兼容当前协议和 SDK 的旧版无状态请求回退。

## 要求

- Node.js 20 或更高版本；
- 本机可执行 `ssh`；
- 推荐在 `~/.ssh/config` 中配置目标别名，并使用 SSH agent 或密钥认证。

服务不会传递密码，不会关闭 host key 检查，也不会自动接受未知主机指纹。

## 安装与构建

```bash
npm install
npm run check
```

## 启动主服务

至少配置一个允许连接的 SSH 目标：

```bash
SSH_MCP_ALLOWED_TARGETS=dev-server,ops@example.com npm run dev
```

默认监听 `127.0.0.1:3100`：

- Web 控制台：`http://127.0.0.1:3100/`
- 服务状态 API：`http://127.0.0.1:3100/api/status`
- 健康检查：`http://127.0.0.1:3100/healthz`
- SSH MCP：`http://127.0.0.1:3100/mcp/ssh`

Web 控制台按三层信息结构组织：

1. 首页只展示 MCP 分类；
2. “MCP 明细”页按分类筛选具体 MCP；
3. 单个 MCP 详情页提供能力、端点，以及 Codex 和 Claude Code 的完整添加命令。

左侧导航只保留图标；在手机宽度下会切换成底部图标导航。

当前 SSH MCP 可直接添加到客户端：

```bash
codex mcp add ssh --url http://127.0.0.1:3100/mcp/ssh
claude mcp add --transport http ssh http://127.0.0.1:3100/mcp/ssh
```

## 独立启动 SSH MCP

```bash
SSH_MCP_ALLOWED_TARGETS=dev-server npm run dev:ssh
```

默认监听 `127.0.0.1:3101`，MCP endpoint 是：

```text
http://127.0.0.1:3101/mcp
```

## SSH 工具

### `ssh_get_system_snapshot`

在白名单目标上执行固定的只读基线：身份、主机名、时间、内核、运行时间和磁盘空间。

### `ssh_execute_command`

执行调用者传入的远程命令。它默认关闭，启用时必须同时满足：

```bash
SSH_MCP_ALLOWED_TARGETS=dev-server \
SSH_MCP_ALLOW_COMMANDS=true \
npm run dev
```

客户端调用时还必须传递 `acknowledgeRemoteChangeRisk: true`。这只是服务端风险门槛，不能代替用户对准确目标和命令的授权。

## MCP Inspector

主服务启动后，可以另开终端连接：

```bash
npx @modelcontextprotocol/inspector http://127.0.0.1:3100/mcp/ssh
```

当前没有身份认证，所以服务拒绝监听非 loopback 地址。后续加入 OAuth Resource Server 后，再考虑远程监听和公开部署。
