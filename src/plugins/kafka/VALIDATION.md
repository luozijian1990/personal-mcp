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


## 第二阶段本地开发与验证

新增 5 个工具，总计 11 个。用户明确测试/生产集群当前不可达，本阶段没有尝试连接这两个环境，也没有重跑 `.scratch` 中的真实集群脚本。

本地测试覆盖：

- DescribeLogDirs v1–v4、DescribeClientQuotas v0/v1、ListPartitionReassignments v0、DescribeQuorum v0/v1 的编解码、请求字段与版本协商。
- 64 位副本大小、卷容量、quorum 位点和未知时间戳；截断报文、非法数组长度、非有限配额值、尾部多余数据拒绝。
- 五工具通过真实本地 HTTP MCP 与 TCP 模拟 Broker 调用；11 工具注册、只读 metadata、严格参数和禁止调用时覆盖基线。
- 服务端基线与存储阈值解析、持久化和无效更新保留原配置；内部 Topic 不应用业务基线。
- 配置冲突/运行风险/基线/观察分别返回；配置查询超时后保留 Topic 元数据证据。
- 存储当前/未来副本分别统计；任一 Broker/目录失败、未知或缺失副本、元数据分区错误、重复当前副本均抑制整体判断。
- 配额默认实体与候选补查，不将空结果解释为无限制；重分配合法空结果与失败区分。
- unsupported、forbidden、failed、partial 状态及 MCP isError 行为；不根据 API 失败推断 ZooKeeper。

### 真实环境待验清单

| 工具 | 待验证 |
| --- | --- |
| kafka_audit_config | 实际 Topic/Broker 配置来源、权限不足、内部 Topic、已配置业务基线 |
| kafka_inspect_storage | 各 Broker 目录及副本大小、目录错误、代理映射、容量字段的版本可用性 |
| kafka_describe_quotas | 实际用户/client ID/default 配额实体及权限，不修改配额 |
| kafka_list_reassignments | 合法空状态或现有迁移状态；不会人为发起迁移 |
| kafka_describe_quorum | 可用 KRaft 环境经 Broker 查询；不为测试修改模式或开放 Controller 入口 |

等用户通知环境恢复后，再进行现有资源的只读验收。本地模拟通过不代表第二阶段真实集群、KRaft 或所有版本兼容性已通过。第二阶段固定评估题见 `evaluations/phase2-fixture.xml`，未执行独立模型评估。

第二阶段最终 `npm run check`：退出码 0，构建通过，全仓 **165/165**、Kafka **27/27** 测试通过。

## 第二阶段自审后的验证

自审确认并修复 6 项 P2 问题，详见 [REVIEW.md](REVIEW.md)。六条新增回归用例均先复现失败，再验证修复。最终 `npm run check` 退出码 0，全仓 **171/171**、Kafka **33/33** 测试通过。
本轮没有连接测试/生产集群，没有新增真实环境验收结论。


## 第二阶段测试集群实测（2026-11-06）

用户通知可连接测试环境后，于 2026-11-06 09:31（Asia/Singapore）通过临时本地 HTTP MCP 服务执行 12 次只读调用。本轮未访问生产环境，未修改持久化配置或 Kafka 数据。

| 检查 | 结果 |
| --- | --- |
| 工具注册/连接 | 11 工具注册，测试集群元数据成功 |
| Topic/消费组 | 8 个可见 Topic、0 个可见消费组 |
| 配置审计 | 单 Topic 加相关 Broker 配置、全量 7 个非内部 Topic 均 available/complete；单副本仅作为 info，未误报为违反未配置基线 |
| Broker 配置证据 | 代表 Topic 的相关 Broker 返回 7 项配置 |
| 存储分布 | 单 Topic 及全量均 available/complete；3 Broker、3 目录、57 个当前副本（包含内部 Topic），无目录错误或未来副本 |
| 存储容量 | totalBytes/usableBytes 为 null，保留未知而非填零；未配置不均衡阈值，因此不告警 |
| 配额 | 全量及默认用户候选查询均 available/complete，entries 为空；不推断“无限制” |
| 重分配 | 指定 Topic 及全量查询均 available/complete，当前无正在重分配的分区 |
| quorum | API 55 无受支持版本，正确返回 unsupported、complete=false、data=null；不推断部署模式或 quorum 健康 |

本轮未发现新的实现缺陷，不需要代码修复。上述空配额/空迁移结果验证了合法空状态，尚未在此环境验证非空配额或实际迁移的实时数据；quorum 正向实测仍需要提供支持相应 API 的 KRaft 集群。权限拒绝、全版本兼容性仍不由此次无认证环境证明。

原始响应：Git 忽略目录 `.scratch/kafka-phase2/test-live-result.json`。本轮构建 `npm run build:server` 通过；没有改变实现代码，未重复运行此前已通过的 171 项本地回归。


## 第二阶段生产代理只读实测（2026-11-06）

用户明确授权后，于 2026-11-06 09:33（Asia/Singapore）经现有三端口代理、临时 HTTP MCP 服务执行 12 次只读调用。未修改 Kafka/代理配置、未读取消息正文、未加入消费组或提交位点，未改持久化连接配置。

| 项目 | 结果 |
| --- | --- |
| 连通与发现 | 同一生产集群、39 可见 Topic、2 个 Stable 消费组 |
| 配置审计 | 代表 Topic + Broker 配置、全量 38 个业务 Topic + 3 个相关 Broker 配置均 available/complete，无查询错误 |
| 审计发现 | 25 个业务 Topic、75 个分区为单副本；38 Topic 的 retention.bytes=-1 但 retention.ms=86400000，不能解释为无限保留 |
| Broker 配置关系 | 三 Broker 均为 message.max.bytes=104857600、replica.fetch.max.bytes=1048576；仅记录观察，不推断复制失败 |
| 存储查询 | 代表 Topic、全量均 available/complete；3 个 Broker、3 个目录、237 个当前副本（各 79），无目录错误/未来副本 |
| 当前副本字节分布 | Broker 1: 109050000603；Broker 2: 270088403147；Broker 3: 106605184484。占比约 22.45% / 55.60% / 21.95%，最大/平均比约 1.6681 |
| 存储判断 | 阈值未配置，comparison.status=not_configured；不将字节占比当成磁盘容量使用率、压力或故障 |
| 配额 | 全量和默认用户候选查询正常，当前 entries=[]；不推断无限制 |
| 重分配 | 代表 Topic 和全量查询正常，当前 partitions=[] |
| quorum | API 55 无受支持版本，返回 unsupported/complete=false/data=null；正向 KRaft 仍未验证 |

全部业务基线保持默认空值；审计没有 error/warning 评级，但这不代表已满足业务可靠性标准。卷总容量/剩余容量字段仍不可用，返回 null。

本轮未发现新的实现缺陷。`npm run build:server` 通过；未改实现代码，没有重复运行此前通过的 171 项本地回归。原始响应在 Git 忽略目录 `.scratch/kafka-phase2/production-live-result.json`，不把生产资源清单和连接配置写入源码/fixture。

第二阶段在测试与生产代理环境的可用查询路径均已验证；仍未覆盖非空配额、进行中的真实重分配、KRaft quorum 正向、真实权限拒绝及所有发行版本。不会为补齐这些场景主动修改生产环境。
