# MCP Framework Refactor Result

## Summary

`personal-mcp` 已从三个由 Gateway 分别装配的服务，收敛为显式 Catalog 驱动的本地 Plugin Runtime。SSH、Prometheus 和 MySQL 共用 Definition、配置生命周期、Profile、Health、日志、安全脱敏、HTTP 暴露、Tool Result 和启动路径；本轮没有新增业务 MCP。

## Architecture Changes

```text
Plugin Definition + Catalog
            |
            v
  Plugin/Profile instances
            |
            v
 Registry + Config lifecycle
            |
            v
 HTTP API / MCP / Health / Logging / UI
```

- `PersonalMcpPluginDefinition` 分离声明/构造与运行实例，并包含 standalone 默认端口。
- Catalog 校验 Definition、建立 canonical mounts、默认 Profile 和配置管理器。
- Generic Config Manager 统一 revision、时间、串行更新、持久化、reload、`changedKeys`、Secret 语义和原子替换。
- Runtime Profile Registry 表达隐式 default 与可选命名 Profile。
- HTTP Runtime 从 metadata 提供状态、配置、Health、中央日志和 MCP 路由，不含插件 ID 分支。
- `startPluginRuntime` 同时服务 Gateway 与 standalone；各 standalone 入口仅选择 Definition。
- Tool result helpers 统一 text、error 和 structured 结果约定，并保留领域 Schema。
- Console 从 config、risk、health 和 Profile metadata 渲染，不含插件专用页面。

`http-app.ts` 保留了紧密耦合的 Express 路由装配与 MCP 日志捕获。它仍然完全按 Registry/metadata 迭代，增加第十个 Plugin 不需要修改该文件；当前继续拆成多个路由文件只会增加跨文件追踪成本，因此本轮没有机械拆分。

## New Plugin Lifecycle

1. Plugin 在自己的目录声明 metadata、Tool、配置字段和工厂。
2. `src/plugins/catalog.ts` 显式注册 Definition。
3. Runtime 从环境和 Runtime Config Store 创建 default Profile；部署可添加命名 Profile。
4. Registry 将 default 实例挂载到 `/<plugin-id>/mcp`。
5. Console 和 `/api/status` 直接消费 Plugin metadata。
6. 配置 update/reload 先解析、验证和持久化，成功后才原子替换实例。
7. `/api/status` 并发执行可选 Health，并隔离异常与超时。
8. MCP 请求/响应按 Tool policy 记录，所有字段在中央 Secret 边界脱敏。

## File Changes

- `src/core/plugin.ts`：Definition、Plugin、Config、Risk、Logging、Health 和 Profile contract。
- `src/core/plugin-catalog.ts`：Definition/Profile 初始化与校验。
- `src/core/plugin-config-manager.ts`：通用配置生命周期。
- `src/core/plugin-profile.ts`：Profile identity、隔离和实例替换。
- `src/core/plugin-runtime.ts`：Gateway/standalone 公共启动。
- `src/core/tool-result.ts`：Tool text/error/structured result helper。
- `src/core/http-app.ts`：metadata 驱动的状态、配置、Health、MCP 和日志边界。
- `src/plugins/catalog.ts`：唯一内置 Plugin 注册表与默认 standalone 端口。
- `src/ui/*`：通用 metadata 控件、Health 和 Profile 展示。
- `docs/PLUGIN-DEVELOPMENT.md`：新 Plugin 接入 Contract 与清单。

## Compatibility

- Gateway 继续监听 `127.0.0.1:3100`，endpoint 保持 `/ssh/mcp`、`/prometheus/mcp`、`/mysql/mcp`。
- standalone 命令保持 `dev:ssh`、`dev:prometheus`、`dev:mysql` 和相应 `start:*`，默认端口保持 3101、3102、3103，仍支持 `PORT` 覆盖。
- 主要 Tool 名保持 `ssh_get_system_snapshot`、`ssh_execute_command`、`prometheus_query`、`prometheus_query_range`、`execute_sql`。
- 现有环境变量、`.runtime-config.json` 和 default Profile 配置 API 保持兼容。
- SSH target allowlist、known_hosts、私钥校验、命令开关、逐次风险确认、超时和输出上限继续由服务端强制执行。

## Security

- Risk/confirmation/default-disabled metadata 用于表达和交互，不替代服务端授权。
- Secret snapshot 只公开 configured 状态；空值保留，清除必须显式请求。
- 中央 logging policy 分别控制 Tool 输入和输出，Secret 始终优先脱敏。
- Health/日志异常不会改变 MCP 请求结果；服务仍拒绝非 loopback 绑定。

## Tests

最终验证命令：

```bash
npm run check
```

覆盖 Registry/Catalog、配置生命周期、Secret、Risk/UI metadata、日志策略、Health、Profile、Tool results、共享 standalone startup、SSH 安全、Prometheus client，以及三个内置 Plugin 的 endpoint、Tool 名与默认端口兼容性。

最终结果：62/62 tests passed。Vite 同时报告一个现有的 bundle 大小提示（主 JS 约 573 kB），不影响构建和测试通过。

## Known Limitations

- Catalog 是显式注册，不提供文件系统自动发现或动态包加载。
- 当前仅 default Profile 挂载 MCP endpoint；命名 Profile 已支持配置与 Health，但尚未定义客户端路由选择方式。
- 内置 Plugin 尚未实现后端 Health probe，因此诚实报告 `unknown`。
- standalone 仍是一 Plugin 一薄入口；没有引入统一 CLI 框架。
- Runtime 无认证且只允许 loopback，不适合直接暴露到局域网、公网或多用户环境。
- 静态/集成测试不等于对真实 SSH、Prometheus、MySQL 后端的连通性验证。

## Next MCP Readiness

普通 Kubernetes Gateway 接入只需新增 `src/plugins/kubernetes/` 的实现/测试，并在 `src/plugins/catalog.ts` 注册 Definition。kubeconfig、context、namespace、Profile、Health、Risk、Logging 和 Tool result 均已有通用 Contract，不需要修改 `gateway.ts`、`http-app.ts`、Runtime Config 或 UI 主逻辑。

只有在同时要求专用 `dev:kubernetes` / `start:kubernetes` 命令时，才需额外增加一个调用 `startStandalonePlugin` 的薄入口和 package scripts；这不会改变 Framework。
