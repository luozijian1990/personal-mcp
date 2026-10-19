<div align="center">

<img src="../../../public/personal-mcp-icon.png" alt="personal-mcp" width="72" />

# Redis MCP

只读查询 Redis 业务数据、实例状态、慢日志和单 key 内存。

[返回项目首页](../../../README.md)

</div>

## 能力与接入

单地址 Redis，支持 TCP、TLS、自定义 CA、无认证、仅密码及 ACL 用户名/密码。使用有界 RESP2 连接适配层，不引入第三方 Redis 客户端。目标命令兼容 Redis 4+（MEMORY USAGE 需要 Redis 4），真实验证版本为 7.2.1；未对所有版本宣称兼容性验证。

不支持 Sentinel 发现、原生 Cluster 路由、Stream、Pub/Sub、模块类型、脚本、写入、配置修改、慢日志重置、任意命令或全库大 key 分析。代理入口仅在兼容这些单节点命令时适用；不将单个入口的 INFO 当作整个集群状态。

Gateway：`http://127.0.0.1:3100/redis/mcp`。注册后在控制台 Redis 页面填写配置、保存并启用；环境开关为 `MCP_ENABLED_REDIS=true`。

```bash
# 首次启动示例，地址/端口按自己的环境填写
REDIS_HOST=127.0.0.1 REDIS_PORT=6379 npm run dev:redis
# 构建后的独立服务
npm run build:server
npm run start:redis
```

独立 endpoint：`http://127.0.0.1:3108/redis/mcp`，支持 `PORT` 覆盖。控制台已保存的运行时配置优先于启动环境变量。只挂载 default Profile endpoint，不声称命名 Profile 有独立路由。

## 工具

| 名称 | 用途 | 范围/续查 |
| --- | --- | --- |
| `redis_scan_keys` | 按 Redis glob pattern 查 key，例如 `orders:*` | 有界 SCAN；传回 `nextCursor` 续查 |
| `redis_read_key` | String、Hash、List、Set、Sorted Set | String 按字节 offset/length；List/ZSet 按 offset/limit；Hash/Set 用 cursor |
| `redis_inspect_key` | 类型、TTL、内存占用 | PTTL 毫秒，-1 无过期、-2 不存在；MEMORY USAGE 固定采样 5 |
| `redis_diagnose` | INFO 七个分区 | server、clients、memory、stats、persistence、replication、keyspace；逐项标记 available/unavailable |
| `redis_get_slowlog` | 最近慢查询窗口 | 时间为 Unix 秒、耗时为微秒；默认隐藏参数及客户端地址 |

所有工具可传 `db` 覆盖默认逻辑 DB，结果包含实际 DB。连接不共享 SELECT 状态。INFO/慢日志属于实例范围，并不会因为选择 DB 而过滤成该 DB 的统计。

结果同时提供可读 JSON 和 `structuredContent`，工具声明具体 `outputSchema`。`complete` 描述遍历/窗口完整性，不代表原子快照，也不替代每个 value 的 `truncated` 标记。慢日志始终是有限的最新窗口，`complete=false`；`responseTruncated` 单独标记插件是否再次裁剪该窗口。诊断权限不足时保留可用分区，整体 `complete=false`；认证或连接失败返回错误，不伪装空数据。

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `REDIS_HOST` | localhost | 单地址主机 |
| `REDIS_PORT` | 6379 | 1–65535 |
| `REDIS_USERNAME` | 空 | 可选 ACL 用户名；设置后必须提供密码 |
| `REDIS_PASSWORD` | 空 | Secret，可选密码 |
| `REDIS_DB` | 0 | 默认 DB；实际可用 DB 范围由后端决定 |
| `REDIS_TLS` | false | true/false；强制证书链和主机名校验 |
| `REDIS_CA` | 空 | 自定义 CA 的 PEM 文本，需开启 TLS |
| `REDIS_SLOWLOG_ARGUMENTS` | false | 显式允许慢日志参数预览；每参数最多 1024 字节，且不超过 value 上限 |
| `REDIS_CONNECT_TIMEOUT_MS` | 5000 | 连接超时，1–60000 ms |
| `REDIS_TIMEOUT_MS` | 5000 | 单次调用总时限，1–60000 ms，包含连接和认证 |
| `REDIS_SCAN_ROUNDS` | 10 | 每次调用最多 SCAN 轮数，1–100 |
| `REDIS_MAX_ITEMS` | 100 | 单次返回 key/集合项/慢查询条数上限，1–1000 |
| `REDIS_MAX_VALUE_BYTES` | 16384 | String 每次读取、Hash/List 单值预览上限，1–1048576 |
| `REDIS_MAX_RESPONSE_BYTES` | 262144 | MCP tool result 的 JSON 字节上限，4096–4194304；包含文本和结构化内容两份数据，不含 HTTP/JSON-RPC 封装 |

Secret 省略或提交空字符串保留旧值，非空替换，`clearSecrets: ["REDIS_PASSWORD"]` 显式清除。用户名仍存在时清除密码会因配置无效被拒绝。公共配置快照只显示密码 configured 状态，校验/持久化失败保留旧实例。复用框架热配置与持久化，不修改共享 UI/Core；规范见 [插件开发规范](../README.md)。

## 示例

```json
{"db":0,"pattern":"orders:*","limit":20}
```

以上调用 `redis_scan_keys`。续查时保留 DB/pattern，加入响应中的 `nextCursor`：

```json
{"db":0,"pattern":"orders:*","limit":20,"cursor":"<返回的 UUID>"}
```

读取 key：

```json
{"db":0,"key":"orders:123","offset":0,"length":1024}
```

String 续查使用 `data.nextOffset`；List/ZSet 也使用 `data.nextOffset`，但单位是项序号；ZSet 按分数升序。Hash/Set 传回 `nextCursor`，offset 必须为 0。key 本身若为二进制，传 `keyEncoding: "base64"` 和规范 Base64 字符串。key 输入的编码字符串长度上限为 `max(8192, REDIS_MAX_RESPONSE_BYTES)`（保留原有最小上限；UTF-8 和 Base64 共用此字符数上限），保证当前预算内扫描返回的完整 key 可直接用于读取和检查；仍受 HTTP 请求大小限制。返回值含 encoding/value/bytes/returnedBytes/truncated，不自动解析 JSON、解压或反序列化。String 分片切断 UTF-8 字符时返回 Base64，调用方按字节重组。

## 分页、资源限制和安全边界

- 两层只读限制：工具仅提供固定查询操作，后端适配层再次校验命令及子命令白名单。AUTH/SELECT 仅用于连接初始化，不是工具入口。即使账号有写权限，也不能通过工具执行写命令。可再配专用最小权限账号。
- 使用 SCAN/HSCAN/SSCAN，不使用 KEYS、HGETALL 或无限集合读取。[SCAN COUNT 是提示而非返回上限](https://redis.io/docs/latest/commands/scan/)。超过本页的结果保留在服务端游标中，不静默丢弃。COUNT 固定为 100，不代表每轮只访问 100 个元素。
- 游标绑定 DB/key/type/pattern，实例内有效 5 分钟，最多保存 64 个、总计 8 MiB；内存压力会淘汰最旧游标。重载配置、重启或淘汰后返回明确错误，调用方重新扫描。空页且 `complete=false` 必须续查，不能据此判断不存在。
- SCAN 不是快照，可能重复；分页过程中 key 过期或数据变化会影响结果。数量是实际本页或瞬时观测值，不冒充全量一致性证据。游标缓存可能包含已过期 key 的先前观测。
- 每个 RESP 后端响应最多为配置 MCP 响应上限的 4 倍；遇到超大集合项或 SCAN 超量回复会断开并报错，不分配无限内存。插件无法保证 Redis 端计算量；超时仅停止等待和后续请求，不能撤销 Redis 已开始执行的命令。
- String 从后端读取有界字节范围，达到响应预算后可进一步缩小并返回 nextOffset；`value.bytes` 始终为本次 GETRANGE 原始返回长度，`returnedBytes` 为裁剪后长度，整个 String 长度见 `totalBytes`。Hash/List 的大单值返回有限预览，标记 truncated；需要更多内容时提高配置中的预览上限。字段名、Set/ZSet 成员和 key 保持完整，单项超预算时报错。后端原始单值已经超过协议响应上限时无法预览，直接报错。
- 单 key MEMORY USAGE 使用固定采样，返回估算值；没有自动全库内存扫描。INFO 统计为累计计数，不将其解释成当前瞬时命中率或根因。
- 无自动重连和请求重试；每次调用独立连接，结束/超时/取消时关闭。正常读操作仍可能影响 Redis 访问统计、LRU/LFU 或触发正常的惰性过期。
- 中央日志 input/output 均为 metadata，不记录 key、业务结果或慢日志正文。服务端错误只保留错误类别，不回显包含参数的 Redis 原始错误文本。
- 健康检查仅验证配置、连接、认证、默认 DB 和 PING，不代表所有 key 权限、INFO 权限、复制状态或整个实例健康。

## 验证

```bash
npm run check
# 仅 Redis 测试（先 build:server）
node --test dist/plugins/redis/redis.test.js
```

自动测试覆盖 RESP2 分片和二进制、拒绝写入和危险子命令、配置/Secret 生命周期、分页溢出、部分诊断、日志脱敏、响应大小、超时取消、TLS 信任/主机名校验和独立 HTTP MCP 契约。TLS 测试使用 openssl 临时生成测试证书，结束后清理。

本地 Redis 7.2.1 已通过真实独立 HTTP MCP 验证：五种数据类型、二进制、分页、并发 DB 隔离、TTL/内存、INFO、慢日志隐藏参数和健康探测；仅创建唯一前缀测试数据，前后 DUMP 一致，并已清理。TLS/ACL 权限拒绝使用本地模拟服务/单元测试，未宣称真实 Redis TLS/ACL 环境验证，也未做负载或浏览器 E2E 测试。

2026-10-19 在同一本地 Redis 7.2.1 通过真实 HTTP MCP 回归：超过 8192 字符的 UTF-8/Base64 key 可从 SCAN 结果继续读取和检查；4 KiB 响应预算下，转义文本、二进制与 UTF-8 String 多轮裁剪保持原始字节数，按 nextOffset 重组与原值一致。测试 key 均带唯一前缀和 TTL，调用前后 DUMP 一致，结束后精确清理。
