# Kafka MCP 验证记录

日期：2026-11-05。

## 本地测试

- `npm run check`：退出码 0，前端/服务端构建通过，全仓 **153/153** 测试通过。
- Kafka 插件 **15** 项测试通过，包含本地 TCP/TLS 模拟 Kafka 后端和实际 HTTP MCP 请求。
- 六工具的 tools/list、tools/call、outputSchema、参数拒绝、默认 endpoint、standalone 端口、目录 metadata 已验证。
- TLS 自签 CA 信任、错误 CA 拒绝、主机名不匹配拒绝；PLAIN、SCRAM-SHA-256、SCRAM-SHA-512 的模拟握手通过。
- Kafka 2.8 时代的 ListGroups v4 和新版本 v5、DescribeGroups v4、classic assignment 0–3 的模拟协议通过。
- 64 位 offset 精度、缺失提交位点、越界、部分失败、遗漏响应、过滤与截断、分区上限、超时/取消 socket 清理、帧和 MCP 响应预算通过。
- 模拟协议记录仅出现只读查询和 ApiVersions；Metadata 的自动创建标志为 false。本地测试使用模拟服务，真实实测范围另列于下文。

测试依赖 loopback 监听；受限沙箱内第一次执行因 EPERM 失败，允许本地监听后重新执行并通过，未跳过测试。

## 真实集群只读验证

2026-11-05 17:57–18:01（Asia/Singapore），通过本地临时 HTTP MCP server 调用实际插件，对用户提供的三个 Broker 执行只读查询；不修改持久化配置，不把内部地址写入可跟踪文档。

| 项目 | 结果 |
| --- | --- |
| 三个 bootstrap / advertised Broker | 分别连接成功，返回同一个 Cluster ID；Controller 为节点 0，rack 未配置 |
| Topic 列表 | 8 项（含 1 个内部 Topic），与用户提供列表完全一致 |
| 7 个业务 Topic 详情 | 全部成功；各 1 分区、1 副本，ISR 与副本一致，无离线副本 |
| Topic 常用配置与来源 | 每个业务 Topic 返回 7 项；默认配置/静态 Broker 配置来源已验证 |
| 全量配置 | 代表 Topic 返回 26 项 |
| 名称过滤与数量限制 | 2 个匹配项限制为 1，正确标记截断及不完整 |
| 消费组列表 | 三个 Broker 查询成功，可见组为 0；独立 KafkaJS Admin.listGroups 复核也为 0 |
| 不存在 Topic | 明确 UNKNOWN_TOPIC_OR_PARTITION；查询前后 Topic 列表均为相同 8 项，未自动创建 Topic |
| 不存在消费组 | describe_group 返回 GROUP_NOT_FOUND；get_lag 返回 GROUP_UNAVAILABLE |
| Coordinator 查找 | 修复下述参数问题后成功，缺失组返回明确领域错误 |
| ListOffsets 适配层 | 直接只读查询 7 个业务分区的 earliest/latest 全部成功；这是适配层范围查询，不是正常消费组 Lag 验收 |
| 真实成员分配 / 提交位点 / 正常 Lag | 当前无可见消费组，尚未验证 |
| 实际版本 | 用户此前给出 2.8.0 基线；此次未从服务端独立确认精确发行版本，不依据 ApiVersions 推断版本号 |
| TLS/SASL / ACL 拒绝 | 此集群无认证，不覆盖真实 TLS/SASL 或权限拒绝；本地模拟测试仍有效 |

位点观测中七个分区的起始与末端均相等；这仅说明该次观测下的可用位点范围，不能当作消费组 Lag=0。

### 实测发现与修复

FindCoordinator 调用把协议工厂参数误写为 `coordinatorKey`，而 KafkaJS 工厂接受 `groupId` 并内部转换；导致线上请求携带 null key，Broker 断开连接。改为传递 `groupId`。原有模拟后端没有检查请求体，已补上真实 HTTP→socket 路径中 Group ID 长度、内容、GROUP 类型的字节断言。

回归断言修复前失败（编码长度 -1 而非 1），修复后 Kafka 14/14 测试通过，`npm run check` 再次通过（152/152，退出码 0），真实集群重查得到明确的不存在组错误。没有创建消费组、加入组、生产消息、提交位点或修改 Kafka 配置。

### 证据与后续

原始结果仅保留于 Git 忽略的 `.scratch/kafka-readonly/`：`live-result.json`、`live-boundaries-result.json`、`live-offsets-result.json`；包含内部资源信息，不加入源码或测试 fixture。

测试环境当时无可见消费组，因此未覆盖正向成员/Lag；后续已在下节生产代理环境补齐。固定 fixture 评估题未进行独立模型评估。

## 生产四层代理实测（2026-11-05）

用户提供三端口 Nginx TCP 代理。新增通用 `KAFKA_BROKER_ADDRESS_MAP` 配置，将 advertised 地址映射到各自代理端口；没有修改 Kafka 配置，也没有保存用户生产地址到可跟踪代码/文档。

通过临时 HTTP MCP server 自动发现资源，六工具均已实际调用。生产查询按对象串行执行，未进行持续轮询或消息正文读取。

| 项目 | 结果 |
| --- | --- |
| 集群/Topic | 三 Broker 同集群，39 个可见 Topic，列表无错误/截断 |
| 消费组发现 | 2 个 classic 组，均为 Stable；独立 KafkaJS Admin.listGroups 复核一致 |
| 组 A 成员 | 61 个成员，Coordinator 为节点 2，分配解析成功 |
| 组 A Lag | 首次快照 60 个有效分区，Lag 合计 13396；另一个订阅 Topic 返回 UNKNOWN_TOPIC_OR_PARTITION，整体 complete=false、fullSelectedScopeLag=null |
| 组 B 成员 | 1 个成员，Coordinator 为节点 1，分配解析成功 |
| 组 B Lag | 3 个分区、Lag=0、complete=true |
| Topic 详情 | 两个消费组关联的代表 Topic 均返回分区和配置来源 |
| 分区筛选 | 指定组/Topic/partition=0 成功，complete=true |
| 事务隔离选项 | read_committed 的 3 分区查询成功；不等于已构造真实事务边界测试 |
| 位点独立复核 | 独立 Admin.fetchOffsets(resolveOffsets=false) 的三个提交位点与 MCP 结果完全相等；独立成员查询也返回 1 个成员 |

以上 Lag 是不同时间的快照，不是趋势分析或故障根因结论。组 A 的部分失败保留了有效分区数据，并未把 13396 声称为完整组总积压。

代理映射测试覆盖配置解析/持久化、无效更新保持旧值、不可直连的 advertised Broker 与 Coordinator 的实际 socket 路由、TLS 继续验证原始 Broker 身份。未映射地址仍直连；输出保留原始地址。

真实原始证据位于 Git 忽略目录 `.scratch/kafka-readonly/production-result.json` 和 `production-crosscheck-result.json`，含内部对象名称与成员地址，不加入测试 fixture。

仍未覆盖：所有 Kafka 发行版本、真实 SASL/TLS 集群、ACL 拒绝、真实事务写入边界；这些不能从本次无认证代理测试推断。

代理映射完成后再次运行 `npm run check`：退出码 0，全仓 153/153 通过，Kafka 专项 15/15 通过。
