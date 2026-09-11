# 🔎 Jaeger Tracing MCP

[返回项目首页](../../../README.md)

只读查询 Jaeger Query 的服务、操作与 Trace，返回可用于分析错误及慢请求的 Span 证据。HTTP JSON 适配器针对 Jaeger 1.76.0；不承诺其他版本兼容。网关、配置界面、Profile、健康检查和日志使用项目公共 Runtime。

| 工具 | 功能 |
| --- | --- |
| `jaeger_list_services` | 列出服务名称，排序后本地分页 |
| `jaeger_list_operations` | 按精确 serviceName 列出操作名称，排序后本地分页 |
| `jaeger_query_traces` | 按服务、时间、操作、耗时及 tags 搜索 Trace 摘要 |
| `jaeger_get_trace` | 按 Trace ID 查询 Span、引用、process、tags、logs 和错误依据 |
| `jaeger_query_service_topology` | 查询聚合服务依赖图、调用方向与次数，支持服务过滤 |

| 配置 | 说明 |
| --- | --- |
| `JAEGER_MCP_URL` | Query HTTP 根地址，如 `http://127.0.0.1:16686`，可带反向代理前缀，不包含 `/api` |
| `JAEGER_MCP_USERNAME` | 可选 Basic Auth 用户名 |
| `JAEGER_MCP_PASSWORD` | 可选 Basic Auth 密码，Secret 字段 |

只接受以上配置字段与字符串值。URL 只允许 HTTP(S)，不能包含用户名、密码、query 或 fragment。密码省略或空字符串时保留；通过 `clearSecrets` 显式清除。公开配置仅返回 Secret configured 状态。验证或持久化失败保留旧运行实例。

## 启动与 endpoint

网关：`npm run dev`，endpoint 为网关地址下的 `/jaeger/mcp`。在 Web 控制台启用 Jaeger 并填写 Query 地址，配置字段由通用界面自动渲染。

独立运行：

```sh
JAEGER_MCP_URL=http://127.0.0.1:16686 MCP_ENABLED_JAEGER=true npm run dev:jaeger
# 或 npm run build 后：
JAEGER_MCP_URL=http://127.0.0.1:16686 MCP_ENABLED_JAEGER=true npm run start:jaeger
```

默认独立 endpoint：`http://127.0.0.1:3107/jaeger/mcp`；`PORT` 可覆盖。默认 Profile 挂载该地址；命名 Profile 配置由 Runtime 隔离管理，当前不单独暴露 MCP endpoint。已有持久化配置可能覆盖环境变量，请以控制台状态为准。

## 调用示例

HTTP 请求使用 `Content-Type: application/json` 和 `Accept: application/json, text/event-stream`。

```json
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"jaeger_list_services","arguments":{}}}
```

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"jaeger_query_traces","arguments":{"serviceName":"service-a","start":"now-30m","end":"now","tags":{"error":"true"},"limit":20}}}
```

```json
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"jaeger_query_traces","arguments":{"serviceName":"service-c","minDurationMs":3000,"limit":20}}}
```

```json
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"jaeger_get_trace","arguments":{"traceId":"<16 或 32 位非全零十六进制 ID>","errorsOnly":true,"limit":50}}}
```

## 数据与查询边界

- 时间支持 `now`、`now-<整数>s/m/h/d` 或带时区 ISO 8601，必须带秒，可带三位毫秒。默认最近 30 分钟。无效日期、负 epoch、超出安全整数范围或 start > end 被拒绝。传给 Jaeger 的 start/end 为 Unix 微秒，不做分钟取整。
- 搜索必须提供精确 `serviceName`；可选 `operationName`、`minDurationMs`、`maxDurationMs`、字符串字典 `tags`。耗时范围为 0～86,400,000ms（max 必须大于 0），仅接受 0.001ms（1 微秒）的整数倍；更细精度在调用后端前拒绝，不隐式舍入。耗时和 tags 由后端按其匹配 Span 的语义过滤。`error=true` 不是所有错误证据的并集，可能漏掉仅有异常事件或 HTTP 5xx 的 Span。
- 搜索默认 limit=20、最大 100。只返回摘要，按返回数据的起始时间降序排序。`returnedCount` 是本次返回数；`limitReached` 仅表示达到请求上限，可能还有结果，不保证存在下一页。后端没有本插件可用的分页游标/全量总数，需缩小时间范围继续查询。
- 摘要 `durationMs` 为返回 Span 的最早开始到最晚结束，不能将并发 Span 耗时相加。`isError` 表示返回 Trace 内存在错误证据，不等价于入口 HTTP 失败，更不代表已确定根因。
- 服务、操作和详情 offset 默认 0、limit 默认 50、最大 100；后端一次获取，本地排序、过滤和分页。`totalSpans` 是本次后端 Trace 的 Span 数，`matchedSpans` 是过滤后数量，不证明采集链路完整。`hasMore`/`nextOffset` 只针对本次已取回的数据；多次查询期间数据可能变化。
- 详情保留原始 `traceID/spanID/processID`、所有引用类型与引用 Trace ID、process tags、Span tags/logs/warnings。原始 `startTime`、`duration`、日志 `timestamp` 为微秒；派生 `startTimeMs`、`durationMs` 为毫秒。后端 null 数组原样保留；缺失 process 映射返回 null。还原完整关系需要不筛选并读完所有页，不能把 `FOLLOWS_FROM` 当作父子关系。
- 错误依据包括 `error=true`、`otel.status_code=ERROR/2`、HTTP 5xx、`exception.*` 字段或 `event=exception`；普通事件不算错误。`errorEvidence` 返回判据，原始数据供调用者复核。
- HTTP 成功且 data 为空时详情返回 `found=false`；HTTP 404、鉴权失败、后端 errors、无效 JSON 或响应结构不兼容返回 Tool 错误，不伪装为空结果。Trace 查不到也可能是未采样、尚未入库或已过期。

## 安全与兼容性

所有后端请求使用 GET，超时 15 秒，不跟随重定向，响应体最大 16 MiB。超限报错，不静默截断证据。工具日志仅记录 metadata；返回给调用方的 tags/logs/process 可能包含业务数据，需要由 Jaeger 权限与网络访问控制保护。健康检查只验证服务列表接口和响应结构，支持 Runtime 取消信号，不代表所有存储/采集子系统健康。

Jaeger `/api/*` 是 UI 使用的内部 HTTP JSON API，官方推荐稳定的 gRPC QueryService 用于程序化查询；本插件将 HTTP 访问隔离在 `client.ts`。升级 Jaeger 后应重新跑契约和真实测试。[Jaeger 1.76 API 文档](https://www.jaegertracing.io/docs/1.76/architecture/apis/)

## 验证

```sh
npm run check
# 要求 go-otel-demo 已运行，并可从本机访问其网关与 Jaeger：
node scripts/verify-jaeger-demo.mjs
```

无需预先生成 Trace：脚本先执行四个场景并等待入库，再检查服务和操作索引，索引尚未可见时最多轮询 45 秒。实测脚本在临时端口启动正式 standalone Runtime，通过 MCP `tools/list`/`tools/call` 验证五个工具；请求 Demo 的 MySQL 错误、分支错误、Redis 慢请求、成功降级接口，并对照 Jaeger 原始响应逐项核对 Span、references、tags、logs、process 与耗时。结果写入 `.scratch/jaeger-mcp/live-verification.json`。可用 `JAEGER_MCP_URL` 和 `JAEGER_DEMO_URL` 覆盖目标；脚本用于无鉴权的本地 Demo，会触发 Demo 请求及其测试数据操作。

Demo Collector 尾部采样等待 10 秒、批处理 2 秒，脚本最长轮询 45 秒。普通成功请求仅采样 1%，因此确定性实测选择被保留的错误/慢请求和包含内部错误的成功降级场景；不修改 Demo 采样配置。

## 服务拓扑

`jaeger_query_service_topology` 调用 Jaeger `/api/dependencies`，返回结构化 `nodes` 和 `edges`，可供调用方绘图；不直接生成图片。

```json
{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"jaeger_query_service_topology","arguments":{"start":"now-1h","end":"now","serviceNames":["service-b"],"limit":100}}}
```

- 默认最近一小时，时间格式同 Trace 搜索，要求 start < end；传给后端的 `endTs` 和 `lookback` 均为毫秒。
- `serviceNames` 省略或为空时返回全局依赖；非空时精确匹配任一端点，保留所选服务的直接上游/下游，不递归展开。
- `edges` 的 `source` 为调用方、`target` 为被调用方、`callCount` 为后端依赖计数。保留后端结果，不通过搜索 Trace 猜测全局关系。
- 按 source/target 排序后本地边分页，offset 默认 0，limit 默认 100、最大 500。`totalEdges` 是本次后端返回数，`matchedEdges` 是筛选后数量；`hasMore/nextOffset` 指示后续页。`nodes` 仅包含当前页边的端点，不补入不存在于结果的服务或孤立节点。
- `requestedStartTimeMs/requestedEndTimeMs` 表示请求窗口；后端存储可能忽略或粗化窗口，依赖计算可能有延迟或需额外配置，工具不宣称已经验证时间过滤。采样/保留期影响 callCount，不能作为业务全量请求统计。
- 空结果不证明没有依赖；HTTP 或后端错误仍返回 Tool 错误。既有 15 秒超时与 16 MiB 响应上限同样适用。
- `node scripts/verify-jaeger-demo.mjs` 同时验证五个工具，并核对真实依赖方向、计数及 service-b 的直接关联过滤。

## 全功能黑盒回归

保持独立 MCP 在 `http://127.0.0.1:3107/jaeger/mcp` 运行，先执行 `node scripts/verify-jaeger-demo.mjs` 刷新真实样本，再执行 `node scripts/verify-jaeger-all.mjs`。后者通过真实 MCP 验证五工具的分页、筛选、参数边界、空结果与健康状态，和 Jaeger 原始响应对照，报告写入 `.scratch/jaeger-mcp/full-live-verification.json`。可通过 `JAEGER_TEST_MCP_URL` 覆盖 MCP 地址；测试针对无鉴权的本地 Demo。

故障、响应大小、真实计时超时、配置变更和启停测试由 `npm run check` 在隔离测试实例中执行。
