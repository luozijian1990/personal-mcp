# 🔭 SkyWalking APM MCP

[返回项目首页](../../../README.md)

只读查询 SkyWalking OAP 的服务、实例、Trace 和服务拓扑。已针对 OAP 9.7.0 实测。

| 工具 | 功能 |
| --- | --- |
| `skywalking_list_services` | 按 layer 列出服务，默认 GENERAL |
| `skywalking_list_instances` | 按 serviceId 和时间范围查询实例 |
| `skywalking_query_traces` | 分页查询 Trace 摘要，支持服务、endpoint 和错误状态过滤 |
| `skywalking_get_trace` | 按 Trace ID 查询 Span、调用关系、标签和异常堆栈，支持筛选及分页 |
| `skywalking_query_service_topology` | 按 serviceIds 查询拓扑，省略或空数组查询全局拓扑 |

| 配置 | 说明 |
| --- | --- |
| `SKYWALKING_MCP_URL` | OAP 主机地址，包含 http/https，自动补全 `/graphql`；兼容 `SKYWALKING_URL` |
| `SKYWALKING_MCP_USERNAME` | 可选 Basic Auth 用户名 |
| `SKYWALKING_MCP_PASSWORD` | 可选 Basic Auth 密码，Secret 字段 |

配置更新仅接受表中的三个 `SKYWALKING_MCP_*` 字段，字段值必须是字符串；未知字段、错误类型和无效 URL 会拒绝保存。密码省略或空字符串时保留原值，通过 `clearSecrets` 显式清除。更新或持久化失败时保留原运行实例。

网关：`npm run dev`，endpoint 为网关地址下的 `/skywalking/mcp`。

独立运行：`npm run dev:skywalking`；构建后使用 `npm run start:skywalking`。默认 endpoint 为 `http://127.0.0.1:3105/skywalking/mcp`，`PORT` 可覆盖端口。启动后在控制台启用插件并配置 OAP 地址。

工具调用示例：

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"skywalking_query_traces","arguments":{"start":"now-30m","end":"now","view":"errors_only","pageSize":20}}}
```

时间支持 `now`、`now-<整数>s/m/h/d` 或带时区的 ISO 8601。查询使用 OAP 返回的时间和时区，转换为 MINUTE 精度，秒数向下取整。默认最近 30 分钟。不存在的日期（如 `2026-02-30`）、越界时分秒和起点晚于终点会被拒绝。

Trace `summary` / `errors_only` 返回 traceIds、duration、isError；`full` 增加 segmentId、endpointNames、start，仍为 BasicTrace 记录，不包含 spans。OAP 9.7 不提供此查询的 total，不伪造总数。pageNum 默认 1，pageSize 默认 20、最大 100。endpointName 精确匹配且必须配合 serviceId；名称搜索最多 100 个候选，不能唯一解析时应传 endpointId，不能同时传两者。

健康检查验证 GraphQL 可访问并读取版本，不代表所有 OAP 子系统健康。请求超时 15 秒，健康检查支持 Runtime 的取消信号。所有工具均为只读，输入输出日志仅记录 metadata；OAP 账号权限和网络访问控制仍由服务端负责。

## Span 详情与异常定位

先通过 `skywalking_query_traces` 的 `errors_only` 视图取得 traceIds，再查询详情：

```json
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"skywalking_get_trace","arguments":{"traceId":"<traceIds 中的一个 ID>","errorsOnly":true,"serviceName":"[test-tms]tmsexpresscharging","limit":50}}}
```

- 必填 `traceId`。`serviceName` 精确匹配 OAP 的 serviceCode，省略时查询整条跨服务链路；`errorsOnly` 默认 false。
- 返回 segmentId/spanId/parentSpanId、跨 Segment refs、服务与实例、端点、peer、组件、毫秒时间戳、durationMs、isError、tags 和 logs。HTTP 状态通常位于 tags，异常类型、message、stack 位于 logs.data，保留后端原始内容。
- 同一 Segment 内用 parentSpanId 连接父节点；跨 Segment 使用 refs。spanId 不能单独作为全链路唯一标识，应使用 segmentId + spanId。
- offset 默认 0，limit 默认 50、最大 100；过滤后按 startTime、segmentId、spanId 排序分页。totalSpans 是整条链路的 Span 数，matchedSpans 是过滤后数量；hasMore/nextOffset 用于继续读取。
- OAP queryTrace 不提供后端分页，插件获取完整 Trace 后筛选并分页。筛选或分页可能使父节点不在当前结果中；还原完整调用关系时不筛选并读完所有页。tags/logs 不按字符串长度截断。
- 无数据返回空 spans 和 totalSpans=0（可能为 ID 不存在或数据已过保留期）；过滤无匹配时 totalSpans 可非零。OAP 失败仍返回工具错误，不伪装为空结果。
- Span tags/logs 可能包含业务数据；工具将原始内容返回调用方，但中央运行日志只记录 metadata。
