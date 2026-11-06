<div align="center">
<img src="../../../public/personal-mcp-icon.png" alt="personal-mcp" width="72" />

# Kafka MCP

提供 11 个只读工具，查询集群、Topic、消费组、Lag，并检查配置、存储、配额、重分配与元数据 quorum。

[返回项目首页](../../../README.md)
</div>

## 范围与兼容性

单集群，目标兼容 Kafka **2.8.0 及以上版本的 classic 消费组**。无生产、消息正文读取、消费组加入、心跳、提交/重置位点、Topic 创建/删除、配置变更、ACL 修改及通用命令入口。没有历史采样、速率和根因判断。

支持 PLAINTEXT、TLS（证书链及主机名校验）、自定义 CA、SASL/PLAIN、SCRAM-SHA-256、SCRAM-SHA-512。不支持双向 TLS、Kerberos、OAuth。发现的新 `consumer` / `share` / `streams` 组类型返回不支持，不套用 classic Lag。Broker 的 `advertised.listeners` 和 Coordinator 地址必须从 MCP 进程可达。

**第一阶段六工具已完成本地/模拟测试及用户集群实测；第二阶段新增五工具已完成本地/模拟验证，并于 2026-11-06 在测试集群及生产代理环境验证配置审计、存储、空配额和空重分配；quorum 正确返回 unsupported，KRaft 正向实测仍待补充。** 三个 Broker 连接、Topic 列表/结构/配置、消费组空列表及不存在对象错误已验证；后续生产代理实测已覆盖两个活跃消费组的成员分配、正常 Lag、指定分区查询和部分失败结果。不能把这一次实测称为全部目标版本已验证，详见验证记录。

适配使用固定版本 `kafkajs@2.2.4` 的 Broker/ConnectionPool 和只读协议编码器，内部依赖限定在 `client.ts`、`protocol.ts`、`admin-protocol.ts`。没有使用会丢掉 rack/internal/分区错误的高层 Admin 封装，也不调用具有写入分支的 `fetchOffsets(resolveOffsets=true)`。补充了 ListGroups v4/v5 和 DescribeGroups v4 编解码以返回状态、类型与静态成员 ID。升级依赖时必须执行协议回归测试，不允许直接放宽版本号。

## 启动与接入

Gateway endpoint：`http://127.0.0.1:3100/kafka/mcp`。在控制台 Kafka 页配置、保存并启用，或设置 `MCP_ENABLED_KAFKA=true`。

```bash
# 首次配置的独立服务（用实际地址替换占位地址）
KAFKA_BROKERS=broker.example:9092 npm run dev:kafka

# 构建后启动
npm run build:server
npm run start:kafka
```

独立默认端口 **3109**，endpoint 为 `/kafka/mcp`，`PORT` 可覆盖。复用公共 Runtime、配置管理和健康检查，不修改 Gateway/UI 主逻辑。控制台持久化配置优先于同名环境变量，Secret 空字符串保留旧值，`clearSecrets: ["KAFKA_PASSWORD"]` 显式清除（启用 SASL 时必须同时提供有效配置）。默认 Profile 挂载 endpoint；命名 Profile 不具有独立路由。

## 四层代理地址映射

Nginx stream 等四层代理需为每个 Broker 设置独立端口。配置 `KAFKA_BROKER_ADDRESS_MAP` 后，所有连接（包括元数据发现的 Broker 和消费组 Coordinator）按精确地址映射；不需要修改生产 advertised.listeners。例如：

```json
{"broker-a.internal:9092":"proxy.example:19092","broker-b.internal:9092":"proxy.example:19093"}
```

未配置的地址保持直连，映射只应用一次，不递归解析。结果仍保留 Kafka 公布的真实 Broker/Coordinator 地址，便于定位；不会把代理地址冒充集群身份。启用 TLS 时仍校验原 Broker 的证书身份，SNI 使用原 Broker 域名，不关闭证书验证。映射不持有认证凭据。

## 工具与调用示例

| 工具 | 输入 | 输出要点 |
| --- | --- | --- |
| `kafka_cluster_overview` | `{}` | Cluster ID、Broker/host/port/rack、客户端可见 Controller、API 版本能力 |
| `kafka_list_topics` | `nameFilter?`、`includeInternal=false`、`limit=100` | 可见名称、内部标记、返回数、可见匹配数、截断标记 |
| `kafka_describe_topic` | `topic`、`includeAllConfigs=false` | 分区 Leader/Replicas/ISR/offlineReplicas、配置及来源，结构与配置独立状态 |
| `kafka_list_groups` | `nameFilter?`、`limit=100` | Group ID、协议、可获取的状态/类型、是否支持；各 Broker 错误 |
| `kafka_describe_group` | `groupId` | 状态、Coordinator、策略、成员、client ID/host、静态 ID、订阅和分配 |
| `kafka_get_lag` | `groupId`、`topic?`、`partitions?`、`isolationLevel?` | 分区起始/末端/提交位点、Lag、消费者归属、异常和汇总 |

`nameFilter` 是区分大小写的字面子串，不是正则表达式。分区列表必须配合精确 `topic`，不接受重复或负数分区。示例为 `tools/call` 的 params：

```json
{"name":"kafka_cluster_overview","arguments":{}}
{"name":"kafka_list_topics","arguments":{"nameFilter":"orders","limit":20}}
{"name":"kafka_describe_topic","arguments":{"topic":"orders"}}
{"name":"kafka_describe_topic","arguments":{"topic":"orders","includeAllConfigs":true}}
{"name":"kafka_list_groups","arguments":{"nameFilter":"billing","limit":20}}
{"name":"kafka_describe_group","arguments":{"groupId":"billing-worker"}}
{"name":"kafka_get_lag","arguments":{"groupId":"billing-worker"}}
{"name":"kafka_get_lag","arguments":{"groupId":"billing-worker","topic":"orders","partitions":[0,1]}}
{"name":"kafka_get_lag","arguments":{"groupId":"billing-worker","topic":"orders","isolationLevel":"read_committed"}}
```

Topic 默认配置：`retention.ms`、`retention.bytes`、`cleanup.policy`、`min.insync.replicas`、`max.message.bytes`、`segment.ms`、`segment.bytes`。配置保留 `source/sourceCode/isSensitive/readOnly`，敏感值始终为 null，不返回 synonyms/userData。

## 结果语义

所有工具有具体 `outputSchema`，同时返回 JSON 文本和 `structuredContent`。共有 `clusterId`、`startedAt`、`observedAt`（UTC ISO 时间）、`complete`、`truncated`、`warnings` 和带 scope/code 的 `errors`。

- `complete` 表示本次选定查询范围未失败/截断，不代表全局可见、原子快照、没有异常或根因已确定。
- 部分成功保留成功项；结构/配置、Broker、分区、成员归属失败分别呈现。完全无法完成核心查询时返回 MCP `isError=true`。后端错误消息经过处理，不透传认证消息或凭据。
- 列表先从 Broker 获取可见数据，再本地过滤、排序和截断；无服务端分页或快照游标。`matchedVisibleCount` 是本次实际获取的可见匹配数量，不是集群总数；部分 Broker 失败时只是局部计数。
- API 版本支持不能证明资源权限。overview 的其他查询能力为 `not_probed`，实际资源调用才能确定权限；Controller ID 不是 KRaft quorum 清单。
- 健康检查只验证 bootstrap 连接/认证和元数据，不证明所有 advertised 地址可达或所有查询获授权。

### Lag

所有 offset、Lag 使用十进制字符串，内部 BigInt 计算。`lag = endOffset - committedOffset`。默认 `read_uncommitted`；`read_committed` 使用事务隔离对应的末端位点。offset 差不是精确消息条数，也不是消费者当前内存处理位置。

| 状态 | 行为 |
| --- | --- |
| `ok` | 正常差值，可参与有效 Lag 汇总 |
| `no_committed_offset` | 提交位点、Lag 为 null，不替消费者假设起点 |
| `offset_before_start` | 提交位点早于保留起点，保留原始差值，排除正常汇总 |
| `offset_after_end` | 提交位点超过末端，保留负差值，不归零，排除正常汇总 |
| `inconsistent_snapshot` | 起始大于末端，Lag 为 null，需要重查 |
| `query_error` | 对应查询失败/返回缺项，Lag 为 null，保留分区错误 |

自动范围包含提交位点、当前成员分配及订阅 Topic 的分区；显式 Topic 也可以查看尚无提交的分区。没有提交且不活跃的组无法恢复历史订阅，工具不会扫描全集群来猜测。过滤后的 OffsetFetch 与 ListOffsets 只请求选定分区；单 Topic 的 Metadata 仍会返回该 Topic 全部分区。

默认关联成员。成员查询失败时保留可算出的 Lag，归属为 unknown；Rebalance 中的未分配也不当成稳定无消费者。`summary.validPartitionsLag` 仅累加 `ok` 分区；`fullSelectedScopeLag` 只有选定范围全部正常且无查询错误时才有值。这不代表未选择 Topic 的完整组积压。

## 配置

| 变量 | 默认值 | 范围/说明 |
| --- | --- | --- |
| `KAFKA_BROKERS` | 空 | 必需才可查询；逗号分隔 host:port / [IPv6]:port，最多 20 个 |
| `KAFKA_BROKER_ADDRESS_MAP` | `{}` | JSON 对象，精确映射 advertised host:port 到代理 host:port，最多 1000 项 |
| `KAFKA_CLIENT_ID` | personal-mcp-kafka | 1–255 UTF-8 字节 |
| `KAFKA_TLS` | false | true/false；强制正常证书与主机名验证 |
| `KAFKA_CA` | 空 | 可选 PEM 文本，需 TLS |
| `KAFKA_SASL_MECHANISM` | none | none/plain/scram-sha-256/scram-sha-512 |
| `KAFKA_USERNAME` | 空 | SASL 必填 |
| `KAFKA_PASSWORD` | 空 | SASL 必填 Secret；不写入日志或公开配置快照 |
| `KAFKA_AUDIT_BASELINE` | `{}` | 服务端 JSON 业务基线；默认仅启用证据规则，不允许调用参数覆盖 |
| `KAFKA_STORAGE_IMBALANCE_RATIO` | 0 | 0 禁用告警；或大于 1、至多 1000 的最大/平均当前副本字节比阈值 |
| `KAFKA_TIMEOUT_MS` | 10000 | 1–30000；整次调用共用时间预算，含连接、认证、查询 |
| `KAFKA_MAX_ITEMS` | 1000 | 1–1000；列表默认 min(100, 此值) |
| `KAFKA_MAX_PARTITIONS` | 1000 | 1–10000；超限必须缩小范围，不自动采样 |
| `KAFKA_CONCURRENCY` | 5 | 1–20；每次调用的后端请求并发上限 |
| `KAFKA_MAX_RESPONSE_BYTES` | 2097152 | 4096–16777216；包含 JSON 文本与 structuredContent 的序列化响应 |
| `KAFKA_MAX_BROKER_RESPONSE_BYTES` | 16777216 | 4096–67108864；每个 Kafka 响应帧，在客户端缓冲前检查 |

每次调用使用独立连接会话；关闭、取消和期限到达时销毁本次 sockets，禁止继续连接。查询不进行自动业务重试；bootstrap 地址按顺序尝试，均受同一时间预算约束。列表和不指定 Topic 的 OffsetFetch 不提供服务端分页，响应预算会明确拒绝过大的结果。并发限制是每调用级别，不是跨所有 MCP 请求的全局配额。

## 只读与 ACL

固定协议 allowlist：Metadata、ListOffsets、OffsetFetch、FindCoordinator、DescribeGroups、ListGroups、DescribeConfigs、DescribeLogDirs、DescribeClientQuotas、ListPartitionReassignments、DescribeQuorum，另有连接所需的 ApiVersions、SaslHandshake、SaslAuthenticate。Metadata 强制 `allowAutoTopicCreation=false`。工具风险 metadata 和 annotations 均标记只读；底层没有通用操作透传。

使用专用账号，由 Kafka ACL 负责可见范围，不额外维护插件白名单。按目标版本配置 Topic/Group 的 Describe、Topic 的 DescribeConfigs 等必要权限。ListGroups 可由 Cluster Describe 或逐组权限提供可见列表，不必为了列出组就授予全局访问。不要用广泛的 Group Read 权限代替 Describe（Read 也参与消费组加入、提交位点等操作的授权）。新版 Broker 为辨认组类型，会在其 Coordinator 查询 ListGroups；组不可见时明确无法验证类型。

日志采用中央 `metadata` 策略，不打印凭据、完整业务查询和响应。通用约定见 [插件开发规范](../README.md)。

## 验证

```bash
npm run check
# 定向验证（先构建）
node --test dist/plugins/kafka/*.test.js
```

测试使用本地模拟 TCP/TLS Broker 及 HTTP MCP；需要允许 loopback 监听。覆盖配置与 Secret 生命周期、六工具契约、严格参数校验、只读请求、精确对象匹配、64 位位点、异常/缺失位点、部分失败、查询上限、帧/响应预算、取消和 TLS 信任/主机名、SASL 握手。无认证真实集群的验证范围见下方记录；实际 ACL 拒绝行为和多版本兼容矩阵仍待验证。

实际验收只运行上述查询，不创建测试 Topic/组或提交消息/位点。提供 bootstrap 地址、版本、认证方式/CA，并选定一个可查询的 Topic 和消费组后，逐项记录六工具结果、错误语义和连接可达范围。凭据通过本地运行时配置录入，不写入测试记录。

固定模拟数据的十条多工具评估题见 [fixture.xml](evaluations/fixture.xml)，答案来自测试 fixture，不代表已运行模型评估或生产事实。协议扩展参考 Apache Kafka 的 [ListGroups](https://github.com/apache/kafka/blob/3.9/clients/src/main/resources/common/message/ListGroupsResponse.json)、[DescribeGroups](https://github.com/apache/kafka/blob/3.9/clients/src/main/resources/common/message/DescribeGroupsResponse.json) 和 [ConsumerProtocolAssignment](https://github.com/apache/kafka/blob/3.9/clients/src/main/resources/common/message/ConsumerProtocolAssignment.json) 定义。

本次验证结果与真实集群待验项见 [验证记录](VALIDATION.md)。


## 第二阶段：运维查询

五个工具始终注册，不因连接失败或接口不可用而从工具列表消失。默认显式指定对象；只有 `all=true` 才请求完整可见范围，不能与范围过滤混用（存储允许同时指定 topics 和 brokerIds）。

| 工具 | 参数 | 结果与边界 |
| --- | --- | --- |
| `kafka_audit_config` | `topics` 或 `all=true`；`includeInternal=false`、`includeBrokerConfigs=false` | 有效配置、来源编号、基线、逐条规则证据、建议方向。不开启 Broker 配置时标记证据不足，不生成变更命令 |
| `kafka_inspect_storage` | `topics` / `brokerIds` 或 `all=true` | 日志目录、目录错误、副本大小和 offsetLag；当前/未来副本分别统计，容量可为空 |
| `kafka_describe_quotas` | `components` 或 `all=true`；`strict=false`、`includeDefaults=true` | 配额实体、默认实体候选及配置值；不计算最终有效配额，不读取实际限流指标 |
| `kafka_list_reassignments` | `topics` 或 `all=true` | 当前、增加、移除副本列表；无历史、进度百分比或卡住判断 |
| `kafka_describe_quorum` | `{}` | 经 Broker 查询 `__cluster_metadata:0`，返回 Leader、epoch、高水位、voters/observers 和可获得的时间戳 |

### 状态与范围

新增工具的结构化结果带 `status`：`available`、`partial`、`unsupported`、`not_applicable`、`forbidden`、`failed`。`data` 在完全不可用时为 null；`forbidden`/`failed` 同时标记 MCP `isError=true`。部分成功保留证据与作用域错误。`complete` 只表示查询范围完整，不代表配置通过全部规则或集群健康。

`not_applicable` 仅用于有明确证据的“不适用”；当前 quorum 查询不会把 API 缺失、版本不支持、权限拒绝或失败推断成 ZooKeeper 模式。因此这些情况下返回真实的 unsupported/forbidden/failed，不假造 not_applicable。

沿用默认 10 秒/最大 30 秒总预算及默认并发 5。审计/存储/重分配在元数据阶段检查 `KAFKA_MAX_ITEMS` 与 `KAFKA_MAX_PARTITIONS`；存储还按目标副本数量检查分区预算。结果集合超限时明确失败，不采样。元数据发现及无过滤配额没有后端分页，仍受帧字节限制；按 Broker 选存储范围时，元数据预检仍可能读取全部可见 Topic，但数量上限在投影到所选 Broker 后计算；原始响应仍受帧预算约束。实际返回的副本/目录累计超限后停止调度后续 Broker，已经发出的并发请求仍受同一总期限约束。查询完成前超时会保留已经获得的证据。

### 审计基线

`KAFKA_AUDIT_BASELINE` 支持以下可选字段；数字必须为正的安全整数，未知字段拒绝：

```json
{
  "minReplicationFactor": 3,
  "minMinIsr": 2,
  "maxRetentionMs": 604800000,
  "maxRetentionBytes": 1073741824,
  "maxMessageBytes": 1048576,
  "allowInfiniteRetention": false,
  "cleanupPolicies": ["delete", "compact", "compact,delete"]
}
```

这是可选示例，**默认值为 `{}`，不预设生产标准**。`min.insync.replicas` 大于副本数、当前 ISR 不足、离线副本等规则基于明确证据；单副本、无限保留维度、Topic 配置覆盖首先作为事实展示。配置冲突、运行风险、基线偏离、普通观察分别标记。有效配置缺失时返回 insufficient_evidence，不当作通过。

全量审计默认排除内部 Topic；若显式 topics 包含内部 Topic 却未开启 includeInternal，会返回 INTERNAL_TOPIC_EXCLUDED 并标记不完整，不能当成审计通过。显式 includeInternal 后检查其结构风险，但不对内部 Topic 套用业务保留/清理/副本基线。不开启 Broker 配置时不会声称已验证节点间一致性。开启后只读取相关 Broker 的必要配置，展示差异及消息大小/复制抓取大小的关系，不将差异或首批次例外简单判成错误。客户端 acks、发送/接收配置仍不可见，不宣称端到端兼容。

### 存储比较

全量统计计入内部 Topic，显式 topics 查询则只统计所选 Topic。`currentBytes` 和 `futureBytes` 是日志副本字节，不等于主机磁盘使用量或远程分层存储。`offsetLag` 是副本日志的协议位点差，不是消费组 Lag。容量未知用 null；同一卷可能有多个目录，工具不累加卷容量。

默认显示副本数量、大小、观测数据占比和最大/平均比，不告警。配置阈值后，仅在至少两个选定 Broker、完整查询、非零当前副本数据时做判断，比较仅针对选定范围、不按磁盘容量归一化；阈值判断使用精确十进制交叉相乘，不依赖展示比例的舍入。一个 Broker/目录失败、未知大小或元数据里的副本未返回，都会抑制整体判断。迁移中的 future 副本不计入当前分布的分子分母。

### 配额和 quorum

配额组件的 entityType 为 user 或 client-id；match 为 exact/default/any。只有 exact 必须提供 name，default 以协议 null 表示默认实体，不把字符串 `<default>` 当成默认值。includeDefaults 会补查默认 user/client-id 以及相关单实体/组合候选；这不是请求身份的最终配额优先级解析。all=true 要求 strict=false。实际 throttle、延迟、吞吐交给 Prometheus 等监控工具。

quorum 仅使用现有 Broker 连接与代理映射，不追连独立 Controller 端点。位点、时间戳为十进制字符串；未知的 -1 转成 null，时间单位为 Unix 毫秒。显示相对 Leader 的日志位点差，不单凭单次快照断言多数节点存活、稳定健康或根因。

新增协议版本：DescribeLogDirs v1–v4（v4 才有卷容量）、DescribeClientQuotas v0/v1、ListPartitionReassignments v0、DescribeQuorum v0/v1。协商版本交集为空时明确 unsupported；新版本服务端兼容旧协议不等于所有发行版都已实测。quorum v2 的目录 UUID/Controller listener 不在本阶段返回范围。

```json
{"name":"kafka_audit_config","arguments":{"topics":["orders"]}}
{"name":"kafka_audit_config","arguments":{"all":true,"includeInternal":true,"includeBrokerConfigs":true}}
{"name":"kafka_inspect_storage","arguments":{"brokerIds":[1,2],"topics":["orders"]}}
{"name":"kafka_inspect_storage","arguments":{"all":true}}
{"name":"kafka_describe_quotas","arguments":{"components":[{"entityType":"user","match":"exact","name":"reader"}]}}
{"name":"kafka_describe_quotas","arguments":{"components":[{"entityType":"client-id","match":"default"}],"strict":true}}
{"name":"kafka_describe_quotas","arguments":{"all":true}}
{"name":"kafka_list_reassignments","arguments":{"topics":["orders"]}}
{"name":"kafka_describe_quorum","arguments":{}}
```

新增查询可能需要更高的 Describe/DescribeConfigs 权限（按目标 Kafka 版本 ACL 对照配置）。不自动扩大账号权限；代理支持不意味着 Broker 的全部管理查询都获授权。源码级协议参考 Apache Kafka 的 [DescribeLogDirs](https://github.com/apache/kafka/blob/trunk/clients/src/main/resources/common/message/DescribeLogDirsResponse.json)、[DescribeClientQuotas](https://github.com/apache/kafka/blob/trunk/clients/src/main/resources/common/message/DescribeClientQuotasResponse.json)、[DescribeQuorum](https://github.com/apache/kafka/blob/3.9/clients/src/main/resources/common/message/DescribeQuorumResponse.json)。
