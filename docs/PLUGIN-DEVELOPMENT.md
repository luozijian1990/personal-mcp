# Plugin Development

本文说明如何在 `personal-mcp` 中新增一个普通 MCP Plugin。框架是显式 Catalog、local-first 的 Runtime；不做文件系统自动发现，也不要求插件共享同一种业务结果 Schema。

## 最小接入面

Gateway 场景只需要两类改动：

```text
src/plugins/<plugin-id>/   # Plugin 自身实现与测试
src/plugins/catalog.ts    # 一条显式 Definition 注册
```

无需修改 `src/apps/gateway.ts`、`src/core/http-app.ts`、`src/core/plugin-runtime.ts` 或 `src/ui/App.tsx`。只有引入一种框架尚未支持的通用能力（例如新的通用配置控件）时，才应修改 Core/UI。

## Definition 与运行实例

`PersonalMcpPluginDefinition` 是声明和工厂，不是正在运行的连接：

```ts
export const EXAMPLE_PLUGIN_DEFINITION: PersonalMcpPluginDefinition = {
  metadata: EXAMPLE_PLUGIN_METADATA,
  defaultPort: 3104,
  createPlugin: (environment) => createExamplePlugin({
    config: loadExamplePluginConfig(environment),
  }),
  createConfigManager: createExampleConfigManager,
};
```

Definition 必须提供稳定的 `id`、展示 metadata、standalone 默认端口和 `createPlugin`。需要运行时配置时再提供 `createConfigManager`。工厂创建的 Plugin ID 和展示 metadata 必须与 Definition 一致，Catalog 会在启动时校验。

运行中的 `PersonalMcpPlugin` 声明：

- `tools`：Tool 名称、风险和日志策略等发现 metadata。
- `config.fields`：供状态 API 和 Console 消费的通用字段 metadata。
- `createServer()`：创建真正处理 MCP 请求的 `McpServer`。
- `checkHealth(signal)`：可选、无副作用的后端健康检查。

## 配置生命周期

使用 `createGenericConfigManager`，让 Runtime 负责 revision、`updatedAt`、序列化更新、持久化协调、`changedKeys`、reload 和成功后的原子实例替换。Plugin hooks 只负责：

1. 从环境加载并规范化领域配置。
2. 将配置映射为通用字段值。
3. 解析更新并执行领域校验。
4. 映射持久化值并创建新的 Plugin 实例。

配置失败或持久化失败时，旧实例继续服务。现有默认 Profile 沿用原环境变量和 `.runtime-config.json` key；命名 Profile 使用 Runtime 隔离的持久化 key 和 `/api/config/:pluginId/profiles/:profileId` API。

配置字段支持 `text`、`password`、`number`、`boolean`、`select`、`multiselect`、`textarea` 和服务端 `path`。字段可声明 required、dangerous、Secret、默认值、placeholder、options 和 group；Console 完全按这些 metadata 渲染。

## Secret

Secret 字段必须设置 `secret: true`，通常使用 `password` 类型。公开 snapshot 不返回真实值，只返回 configured 状态。更新时：

- 省略或提交空字符串：保留已有 Secret。
- 提交非空新值：替换 Secret。
- 在 `clearSecrets` 中显式列出 key：清除 Secret。

Runtime 在状态、配置错误、健康消息和 Tool 日志边界统一脱敏。Plugin 不应自行打印请求、响应或 Secret。

## Tool 风险、日志和结果

每个 Tool 在 Plugin metadata 中声明：

- `risk`：`read-only`、`write`、`destructive` 或 `privileged`。
- `requiresConfirmation`：交互提示，不是权限控制。
- `disabledByDefault`：发现/暴露提示，不是服务端 allowlist。
- `logging.input` / `logging.output`：`full`、`metadata`、`redacted` 或 `none`。

服务端权限、allowlist、RBAC、数据库账号和命令 gate 始终是权威安全边界。

Tool handler 使用公共结果 helper：

```ts
return toolSuccessResult(contentBlocks);
return toolTextResult("done");
return toolErrorResult(error, { prefix: "Query failed: " });
return toolStructuredResult(domainResult, {
  isError: domainResult.status === "error",
});
```

`toolSuccessResult` 表达任意 MCP content blocks 的成功结果，`toolTextResult` 是纯文本快捷方式。`toolStructuredResult` 会验证输入是合法、非循环的 JSON object，同时返回 JSON text 和原始 `structuredContent`，但不会改变或扁平化领域对象；Plugin 仍为每个 Tool 定义自己的 `outputSchema`。

## Health 与 Profile

健康检查是可选能力。未实现时状态为 `unknown`；实现时返回 `unconfigured`、`healthy`、`degraded` 或 `unhealthy`。Runtime 提供五秒超时和 `AbortSignal`，将异常隔离为当前 Profile 的 unhealthy 状态，不影响 Gateway 或其他 Plugin。

每个 Plugin 自动拥有隐式 `default` Profile，并继续挂载在 `/<plugin-id>/mcp`。部署可以通过 `startPluginRuntime({ profileDefinitions })` 传入 `PersonalMcpProfileDefinition` 创建命名 Profile；内置部署在 `src/plugins/catalog.ts` 的 `pluginProfileDefinitions` 中聚合它们。当前只有 default Profile 对外挂载，因此不要为了 Profile 强制改变现有 Tool 输入。

## Catalog、Gateway 与 standalone

每个 Definition 放在对应 Plugin 目录；把它加入中央 `pluginDefinitions` 后，Gateway 会自动完成：Catalog 初始化、canonical endpoint、Registry、配置 API、状态 metadata、Health、中央日志和 UI 展示。standalone 直接导入自身 Definition，不会加载其他 Plugin 模块。

如需独立进程，新增极薄入口：

```ts
const runtime = await startStandalonePlugin(EXAMPLE_PLUGIN_DEFINITION);
reportStartedPluginRuntime("standalone Example MCP", runtime);
```

再在 `package.json` 增加对应 `dev:*` / `start:*` 命令。`PORT` 可覆盖 Definition 的 `defaultPort`。这一步只提供独立命令，不是 Gateway 普通接入的必要条件。

## Mock Kubernetes 扩展验证

假设下一个 Plugin 支持 kubeconfig、context、namespace、多集群 Profile、Health，以及只读/写入/删除 Tool：

```text
新增 src/plugins/kubernetes/definition.ts
新增 src/plugins/kubernetes/config.ts
新增 src/plugins/kubernetes/client.ts
新增 src/plugins/kubernetes/tools/*
新增 src/plugins/kubernetes/index.ts
新增 src/plugins/kubernetes/*.test.ts
修改 src/plugins/catalog.ts
```

其中 kubeconfig 可使用 Secret/path metadata，context 和 namespace 使用 select/text；命名集群 Definition 可加入同一 Catalog 的 `pluginProfileDefinitions`，并由 Gateway 通过正式 Runtime 启动 seam 传入。Health 使用可选 hook，各 Tool 使用现有 risk/logging/result contract。因此普通 Gateway 接入不需要修改 Core、Gateway 或 UI。若同时要求 `npm run dev:kubernetes`，再增加薄 standalone 入口和两个 package scripts。

## 交付与文档一致性

每个新增 Plugin 都必须完成以下检查，避免只注册 Gateway 而遗漏独立运行或使用说明：

- 如果需求包含独立运行，必须新增 `src/apps/<plugin-id>-standalone.ts`，调用 `startStandalonePlugin`，并在 `package.json` 同时加入 `dev:<plugin-id>` 与 `start:<plugin-id>` 脚本；Definition 的 `defaultPort`、启动日志和文档中的 endpoint 必须一致。
- 必须新增 `src/plugins/<plugin-id>/README.md`，参照现有 Plugin README 的统一结构：顶部图标和返回项目首页链接、插件简介、工具/资源表格、配置表格、网关与独立启动方式、endpoint、调用示例和安全边界。新增或调整配置、Tool、端口和限制时，代码与 README 必须同步更新。
- 根 README 只说明通用使用方式；当前 Plugin 清单和能力以 Web 控制台为准，不在根 README 维护固定 endpoint 列表。

## 验证清单

- Catalog 能初始化 Definition，endpoint 为 `/<id>/mcp`。
- `/api/status` 暴露 config、risk、logging、health 和 Profile metadata。
- 成功更新才替换运行实例；reload、并发和 Secret 语义有测试。
- Tool 的 `tools/list` 和 `tools/call` 契约保持稳定。
- 危险操作有服务端强制检查，而不只依赖 metadata。
- `npm run check` 通过。
