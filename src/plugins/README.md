# 插件开发规范

[返回项目首页](../../README.md)

本文件说明 `src/plugins/` 下所有插件共同遵守的开发规范。各插件的能力、配置、调用示例和限制写在对应的 `<plugin-id>/README.md` 中，并随代码同步更新。

## 职责边界

- 插件负责目标服务的配置校验、协议适配、工具定义、结果解释和领域权限检查。
- 公共 Runtime 负责挂载、配置生命周期、持久化协调、实例替换、Profile 隔离、健康检查调度和中央日志；Console 按配置 metadata 渲染界面。
- 普通 Gateway 接入只需新增插件目录，并在 [catalog.ts](./catalog.ts) 的 `pluginDefinitions` 注册 Definition。只有新增框架尚不支持的通用能力时，才修改 Core、Gateway 或 UI。
- 插件应提供可复用的服务能力。公司业务字段、环境地址和具体排障流程由调用方或业务 Skill 管理，不硬编码进插件。

## 目录与文件职责

```text
src/plugins/<plugin-id>/
├── README.md          # 能力、配置、启动、示例及限制
├── definition.ts      # metadata、默认端口和实例/配置管理器工厂
├── index.ts           # 插件工厂、MCP Server 与工具注册
├── config.ts          # 配置字段、环境加载与领域校验
├── config-manager.ts  # 接入公共配置生命周期（需要运行时配置时）
├── client.ts          # 后端访问适配（按需）
├── output-schemas.ts  # 结构化结果 schema（按需）
└── *.test.ts          # 配置、工具与后端适配测试
```

按复杂度拆分查询、转换和工具实现，不要求每个插件都有全部可选文件。后端协议处理应与 MCP 工具注册分离，便于独立验证兼容性和失败行为。

## Definition 与接入

使用 [公共插件契约](../core/plugin.ts) 的 `PersonalMcpPluginDefinition`，提供稳定的 metadata、`defaultPort` 和 `createPlugin`；需要运行时配置时提供 `createConfigManager`。工厂返回的插件 ID 和展示 metadata 必须与 Definition 一致。

插件通过 `createServer()` 创建 MCP Server，通过 `tools` 声明工具风险与日志策略，通过 `config.fields` 提供通用配置字段。注册后，默认 MCP endpoint 为 `/<plugin-id>/mcp`。

需要独立运行时：

1. 新增 `src/apps/<plugin-id>-standalone.ts`，直接导入自身 Definition，调用 `startStandalonePlugin` 和 `reportStartedPluginRuntime`。
2. 在 `package.json` 同时增加 `dev:<plugin-id>` 和 `start:<plugin-id>`。
3. 为独立运行选择不与现有插件冲突的默认端口，保持 Definition、启动日志和插件 README 一致；支持通过 `PORT` 覆盖。

standalone 入口只负责启动，不复制 Gateway 或 Runtime 逻辑。

## 配置、Secret 与 Profile

复用 `createGenericConfigManager`，插件只提供加载、值映射、更新解析、领域校验、持久化映射和实例创建 hooks。不要自行维护 revision、串行更新队列或热替换流程；配置校验或持久化失败时，应保留旧实例继续服务。

配置字段使用公共契约支持的类型与 metadata，按类型声明默认值、必填、选项、分组等信息。需要新增字段类型时，作为通用框架能力处理。

Secret 字段设置 `secret: true`，通常使用 `password` 类型，并遵守统一更新语义：

- 省略或提交空字符串：保留已有值。
- 提交非空值：替换。
- 在 `clearSecrets` 中显式列出 key：清除。

公开快照只返回 Secret 的 configured 状态，不返回真实值。不得把真实凭据、内部环境配置或本地密钥路径写入源码、示例和测试 fixture。

每个插件有隐式 `default` Profile；需要命名 Profile 时，使用公共 Runtime 的隔离机制，不自行拼装持久化 key。当前只有 default Profile 对外挂载 MCP endpoint，文档不能把命名 Profile 描述为已支持独立路由。

## 工具与结果契约

- 新工具名称使用插件前缀和明确动作，例如 `elasticsearch_list_indices`；修改已有工具时保持名称和输入输出兼容，破坏性调整需明确说明。
- 在调用后端前校验输入，说明时间单位、时区、范围、默认值和上限；结构化输出定义对应的 `outputSchema`。
- 使用 [公共结果 helper](../core/tool-result.ts)：`toolTextResult`、`toolSuccessResult`、`toolStructuredResult` 和 `toolErrorResult`。结构化结果保留领域对象，不为统一外观丢失原始语义。
- 区分成功、合法空结果、后端失败和不完整结果。鉴权失败、超时、解析错误不能伪装成“无数据”。
- 集合查询提供合理的结果上限，明确分页是在后端还是本地进行。发生裁剪时显式说明；无法安全裁剪的证据返回明确错误，不静默丢失。
- 不把当前返回数量当作全量总数，不把采样数据当作完整事实，不把观测到的异常直接宣称为根因。

## 安全、日志与后端访问

每个工具在插件 metadata 中声明 `risk`、`requiresConfirmation`、`disabledByDefault` 和 `logging.input` / `logging.output`，并保持 MCP annotations 与实际行为一致。

风险和确认 metadata 是客户端提示。写入、删除、命令执行等操作必须有实际的服务端权限或 gate，不能仅靠提示保护。

后端访问应设置明确超时，支持调用取消，并按数据规模约束响应大小。保留正常 TLS 校验，不通过关闭证书校验解决连接问题。错误信息应可诊断，但不得暴露凭据。

使用中央日志策略，不自行打印完整请求、响应或 Secret。包含业务正文的查询和结果优先使用 `metadata` 或 `none`；配置 Secret 脱敏不能替代业务数据的日志控制。

## 健康检查

只在存在安全、无副作用的探测方式时实现 `checkHealth(signal)`，并将取消信号传递到后端访问。Runtime 提供五秒超时；未实现检查时状态为 `unknown`。

检查结果按实际情况返回 `unconfigured`、`healthy`、`degraded` 或 `unhealthy`。在插件 README 说明探测范围，单个接口可用不能代表整个后端系统健康。

## 单个插件 README

每个插件必须提供自己的 README，包含以下内容：

| 内容 | 要求 |
| --- | --- |
| 简介与能力边界 | 支持的后端、版本范围、功能与不支持的能力 |
| 工具与资源 | 名称、用途、主要限制；未提供的类型无需空列 |
| 配置 | 环境变量、默认值、必填项、Secret 和更新语义 |
| 启动与接入 | Gateway endpoint、启用方式；提供 standalone 时列出命令和默认端口 |
| 调用示例 | 与实际输入 schema 一致，使用占位数据 |
| 查询与安全限制 | 分页、超时、裁剪、权限、日志和数据完整性边界 |
| 验证 | 检查命令、依赖环境，以及已完成验证的范围 |

顶部保留图标或标识及返回项目首页链接。通用开发约定引用本文件，插件 README 重点解释自身行为；新增或调整工具、配置、端口和限制时同步更新。

## 验证与交付

- 验证 Definition 注册、默认 endpoint，以及配置、风险、日志和健康 metadata。
- 为插件新增的配置解析和映射覆盖有效/无效更新、Secret 保留与清除、失败保留旧实例等行为；复用公共生命周期测试，避免重复测试框架内部实现。
- 验证 `tools/list`、`tools/call` 的输入输出契约，包括参数错误、空结果、后端错误，以及适用的分页、超限、超时和取消场景。
- 对危险操作验证实际服务端检查；需要 standalone 时验证其入口及脚本。
- 从仓库根目录运行 `npm run check`，同步更新插件 README。
- 明确区分静态检查、单元测试、模拟后端测试与真实后端验证。未连接真实服务时，不宣称已完成真实兼容性或端到端验证。

可参考 [Elasticsearch](./elasticsearch/) 的结构化查询和响应限制、[Jaeger](./jaeger/) 的时间与证据语义、[Kubernetes](./kubernetes/) 的配置和权限边界，按需求选择相关实现，不机械复制整个插件。
