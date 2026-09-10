<div align="center">

<img src="../../../public/personal-mcp-icon.png" alt="personal-mcp" width="72" />

# Elasticsearch 7 MCP

通过只读、范围受控的查询发现 Elasticsearch 7 当前结构，诊断分片分配，并执行 Query DSL 搜索。

[返回项目首页](../../../README.md)

</div>

## 能力边界

这个插件直接调用 Elasticsearch 7 REST API，提供集群健康、索引和分片发现、allocation explain、mapping、field capabilities、少量文档采样，以及带原生 aggregation DSL 的 Query DSL 搜索。

V1 只支持 Elasticsearch 7。它不提供 ES|QL、写入、删除、reroute、raw HTTP、向量/RAG、Dataset Catalog 或自动根因分析。标准 Node TLS 校验始终启用，不提供 `skipTlsVerify`。

## 工具

| 工具 | 用途 | 主要限制 |
| --- | --- | --- |
| `elasticsearch_get_capabilities` | 返回版本、distribution、Query DSL 和 ES|QL 能力 | 仅 Elasticsearch 7 标记为 supported；ES|QL 固定为 false |
| `elasticsearch_cluster_health` | 返回节点、活动/迁移/初始化/未分配分片和 pending task 数量 | 仅返回诊断摘要 |
| `elasticsearch_list_indices` | 按 pattern、health、status 列出索引 | 默认 50，最大 200；大集群应使用窄 pattern |
| `elasticsearch_list_shards` | 按 index、state、node 列出主/副分片 | 默认 50，最大 200 |
| `elasticsearch_allocation_explain` | 解释指定分片或一个自动选择的未分配分片 | 只调用 `_cluster/allocation/explain` |
| `elasticsearch_get_mapping` | 将 ES 7 typed/typeless mapping 展平为字段清单 | 支持 `fieldPattern`；默认 200，最大 1000 字段 |
| `elasticsearch_field_caps` | 查询字段类型及 searchable/aggregatable 能力 | 跨索引多类型会明确标记 `conflict` |
| `elasticsearch_sample_documents` | 返回少量样本文档以辅助动态 Schema 探索 | 最大 5 条；日志索引建议传时间范围 |
| `elasticsearch_search` | 执行 Query DSL、sort、`_source` 选择和原生 aggregations | 默认 10 hits；不能超过配置上限 |

所有 Tool 都声明为 `read-only`、non-destructive、idempotent、open-world。metadata 只是客户端提示；Elasticsearch 用户权限仍是实际授权边界。

## 配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ELASTICSEARCH_MCP_URL` | 无 | 必填 HTTP(S) URL；允许反向代理 base path，不允许内嵌凭据、query 或 fragment |
| `ELASTICSEARCH_MCP_USERNAME` | 空 | Basic Auth 用户名；匿名访问时留空 |
| `ELASTICSEARCH_MCP_PASSWORD` | 空 | Basic Auth 密码，Framework Secret；必须与 username 同时配置或同时留空 |
| `ELASTICSEARCH_MCP_REQUEST_TIMEOUT` | `10000` | 单次请求超时毫秒，范围 100–120000 |
| `ELASTICSEARCH_MCP_MAX_HITS` | `100` | search hits 上限，范围 1–1000；超限请求直接失败 |
| `ELASTICSEARCH_MCP_MAX_RESPONSE_BYTES` | `1048576` | 序列化 MCP `CallToolResult`（text + structuredContent）的 UTF-8 上限，范围 16384–4194304；不含 JSON-RPC/HTTP envelope |

可以在 Web 控制台保存配置，或通过环境变量启动：

```bash
ELASTICSEARCH_MCP_URL=https://elasticsearch.example.com:9200 \
ELASTICSEARCH_MCP_USERNAME=mcp_reader \
ELASTICSEARCH_MCP_PASSWORD='replace-me' \
MCP_ENABLED_ELASTICSEARCH=true \
npm run dev:elasticsearch
```

Password 不会出现在公开配置快照中。空字符串更新会保留现有 Password；非空值会替换；只有 `clearSecrets` 显式请求才会清除。

## 启动与接入

网关运行：

```bash
npm run dev
```

网关 endpoint：`http://127.0.0.1:3100/elasticsearch/mcp`

独立运行：

```bash
npm run dev:elasticsearch
```

独立 endpoint：`http://127.0.0.1:3106/elasticsearch/mcp`。`PORT` 可以覆盖 3106。插件默认关闭，需要通过控制台、启停 API 或 `MCP_ENABLED_ELASTICSEARCH=true` 显式启用。

每个 Plugin 自动拥有 `default` Profile。部署可以使用 Framework 的 `PersonalMcpProfileDefinition` 创建互相隔离的命名连接；当前只有 default Profile 对外挂载 MCP endpoint，命名 Profile 独立路由尚未实现。

## 调用示例

发现日志字段及跨索引冲突：

```json
{
  "name": "elasticsearch_field_caps",
  "arguments": {
    "index": "logs-*",
    "fields": ["@timestamp", "service.name", "status", "message"]
  }
}
```

诊断未分配分片：

```json
{
  "name": "elasticsearch_allocation_explain",
  "arguments": {}
}
```

查询最近 30 分钟并聚合状态码：

```json
{
  "name": "elasticsearch_search",
  "arguments": {
    "index": "logs-*",
    "query": {
      "range": {
        "@timestamp": { "gte": "now-30m" }
      }
    },
    "source": ["@timestamp", "service.name", "status", "message"],
    "size": 20,
    "aggregations": {
      "by_status": {
        "terms": { "field": "status" }
      }
    }
  }
}
```

## Elasticsearch 权限

建议使用专门的最小权限只读用户。实际权限应按准备查询的索引范围收窄；通常需要：

- cluster `monitor`：cluster health 和 allocation diagnostics；
- index `read`：sample 和 search；
- index `view_index_metadata`：mapping 和 field capabilities。

插件不会提升或绕过 Elasticsearch 权限。权限不足会返回经过裁剪的 HTTP 状态、error type 和 reason。

## 安全与数据处理

- 客户端只暴露代码定义的九类读取操作；不存在由 Agent 控制的 method/path。
- Index expression 拒绝空值、控制字符、普通路径中的 `/`、`\\`、`?` 和 `#`；合法 date-math（例如 `<logs-{now/d}>`）中的 `/` 和转义符会被允许，并与整个表达式一起进行 URL encoding。
- 所有请求组合配置超时与 MCP 调用取消信号。Search body 同时向 ES 传递 query timeout。
- 后端响应通过流式字节计数设置硬上限；最终 `CallToolResult` 同时计算 pretty text 和 `structuredContent`，按配置限制裁剪，并用 `status: truncated` 和 `truncation` 明示不完整。
- Search/sample 的输入日志仅记录 metadata，输出正文完全不进入中央 MCP 日志，避免 `_source`、查询值或 aggregation 数据形成第二份敏感副本。
- URL 中禁止凭据，Authorization 仅在内存中构造；错误结果和配置日志会脱敏 Password。

## Business Semantics Belong to Skills

插件不知道任何公司的业务系统、索引命名、字段含义或 Incident workflow。业务 Skill 可以维护自己的 reference：

```yaml
datasets:
  ingress:
    index_pattern: "ingress-*"
    time_field: "@timestamp"
    fields:
      service: "service_name"
      status: "status"
      trace: "trace_id"
```

Skill 先读取 reference，再调用 `field_caps` 验证当前真实 Schema，最后组合 `search`。插件本身不会加载该 YAML。

## 兼容性验证

单元和 loopback mock Elasticsearch 验证了 Elasticsearch 7 根响应、typed/typeless mapping、field caps 冲突、CAT JSON、Basic Auth、路径编码、查询构造、Health、超时/取消、日志和响应限制。只有连接真实 Elasticsearch 7 集群完成 smoke test 后，才能把兼容性从“设计并模拟验证”提升为“真实集群验证”。
