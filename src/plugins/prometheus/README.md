<div align="center">

<img src="../../../public/personal-mcp-icon.png" alt="personal-mcp" width="72" />

# Prometheus MCP

让 MCP 客户端通过 PromQL 查询 Prometheus 指标和时间序列。

[返回项目首页](../../../README.md)

</div>

Prometheus MCP 提供即时查询与区间查询，适合查看服务健康、分析资源趋势，以及为故障排查获取指标证据。两个工具均为只读操作，并返回 Prometheus 原生查询结果。

## 工具

| 工具 | 用途 | 必填参数 |
| --- | --- | --- |
| `prometheus_query` | 在单个时间点执行 PromQL | `query` |
| `prometheus_query_range` | 在一段时间内按步长执行 PromQL | `query`、`start`、`end`、`step` |

`prometheus_query` 还支持可选的 `time`。时间可以使用 Unix 秒数或 RFC3339 字符串；区间查询的 `step` 可以是秒数，也可以是 `15s`、`5m` 等 Prometheus 支持的格式。

返回结构包含：

- `status`：`success` 或 `error`。
- `data`：Prometheus 返回的 `resultType` 和 `result`。
- `errorType`、`error`：上游错误或超时信息。
- `durationMs`：完整 HTTP 请求耗时。

## 配置

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `PROMETHEUS_MCP_URL` | 是 | Prometheus HTTP(S) 地址 |
| `PROMETHEUS_MCP_QUERY_TIMEOUT` | 否 | 查询超时秒数，1–300，默认 30 |

可以在主服务的 Web 控制台中保存并热重载配置，也可以在首次启动时使用环境变量：

```bash
PROMETHEUS_MCP_URL=http://127.0.0.1:9090 \
PROMETHEUS_MCP_QUERY_TIMEOUT=30 \
npm run dev
```

首次启动也兼容 `PROMETHEUS_URL` 和 `PROMETHEUS_QUERY_TIMEOUT`；控制台保存时统一使用带 `MCP` 前缀的名称。

## 启动与接入

使用统一网关：

```bash
npm run dev
```

Endpoint：`http://127.0.0.1:3100/prometheus/mcp`

```bash
codex mcp add prometheus --url http://127.0.0.1:3100/prometheus/mcp
claude mcp add --transport http prometheus http://127.0.0.1:3100/prometheus/mcp
```

独立运行：

```bash
npm run dev:prometheus
```

独立 endpoint：`http://127.0.0.1:3102/prometheus/mcp`。可通过 `PORT` 修改端口。

## 调用示例

即时查询：

```json
{
  "query": "up"
}
```

区间查询：

```json
{
  "query": "rate(http_requests_total[5m])",
  "start": "2026-09-08T00:00:00Z",
  "end": "2026-09-08T01:00:00Z",
  "step": "30s"
}
```

## 使用边界

- 插件只调用 Prometheus 的查询 API，不执行写入操作。
- PromQL 由客户端直接提供；大范围或高基数查询仍可能给 Prometheus 带来负载。
- 超过配置时间的请求会中止并返回结构化错误。
- 查询表达式和结果可能进入项目日志，请按监控数据的敏感级别管理日志。
