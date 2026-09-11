<div align="center">

<img src="../../../public/personal-mcp-icon.png" alt="personal-mcp" width="72" />

# Kubernetes MCP

通过只读、范围受控的查询收集 Kubernetes 应用故障排查证据。

[返回项目首页](../../../README.md)

</div>

## 能力边界

这个插件使用官方 `@kubernetes/client-node` 直接访问 API Server，不执行 `kubectl`。一个运行实例固定使用一个显式 kubeconfig context，所有 namespace 和集群级权限完全由该身份的 Kubernetes RBAC 决定。

V1 面向 Kubernetes 1.23+ 的标准资源，不支持 CRD、Gateway API、in-cluster 认证、容器 exec、日志流或真实网络探测。返回结果是安全摘要，不是原始 YAML/JSON。

## 工具

| 工具 | 用途 | 主要限制 |
| --- | --- | --- |
| `k8s_list_nodes` | 独立列出 Node 标签、taints、条件、capacity/allocatable | 集群级；支持分页，不依赖 Pod 已调度 |
| `k8s_list_pvcs` | 独立列出 PVC 状态、请求容量、绑定 PV 与 StorageClass 名称 | 支持 namespace、显式 allNamespaces 和分页 |
| `k8s_list_resource_quotas` | 列出 ResourceQuota hard/used、scopes 和 scopeSelector | 支持 namespace、显式 allNamespaces 和分页 |
| `k8s_list_namespaces` | 分页列出 Namespace 摘要 | 默认 50，最大 200 |
| `k8s_list_workloads` | 按 kind 列出 Deployment、StatefulSet、DaemonSet、Job、CronJob 或 Pod | 全集群查询必须显式设置 `allNamespaces: true` |
| `k8s_get_workload_snapshot` | 聚合工作负载、Pod、Event、Service、HPA、PDB、存储、网络策略、Node 及 ResourceQuota 证据 | 关联查询可部分成功 |
| `k8s_get_service_snapshot` | 追踪 Service selector、EndpointSlice、Pod 和引用它的 Ingress | 不执行连通性探测 |
| `k8s_get_ingress_snapshot` | 按名称或 host/path 反查 ingress-nginx 声明链路 | host-only 查询需要跨 namespace RBAC |
| `k8s_list_events` | 按 namespace、对象、类型和时间窗口过滤 Event | Event 是有保留期的辅助证据 |
| `k8s_get_pod_logs` | 读取单个 Pod、单个容器的有界日志 | 默认 200 行，最大 2,000 行/100 KiB，不支持 follow |

所有 Tool 的风险均为 `read-only`。普通 Tool 未传 `namespace` 时使用默认 namespace；`namespace` 和 `allNamespaces: true` 互斥。

## 配置

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `KUBERNETES_KUBECONFIG_PATH` | 是 | 服务端可读的 kubeconfig 绝对路径；不会自动读取 `~/.kube/config` 或 `KUBECONFIG` |
| `KUBERNETES_CONTEXT` | 是 | 固定使用的 context；不会使用或跟随 `current-context` |
| `KUBERNETES_DEFAULT_NAMESPACE` | 是 | 未显式传入 namespace 时的默认值 |

可以在 Web 控制台保存配置，或通过环境变量启动：

```bash
KUBERNETES_KUBECONFIG_PATH=/absolute/path/to/kubeconfig \
KUBERNETES_CONTEXT=production-readonly \
KUBERNETES_DEFAULT_NAMESPACE=apps \
npm run dev:kubernetes
```

保存配置时会验证文件可读且 context 存在。Health Check 再执行最长 5 秒的只读版本查询；它不代表每一种资源都已获得 RBAC 权限。

## 启动与接入

网关运行：

```bash
npm run dev
```

网关 endpoint：`http://127.0.0.1:3100/kubernetes/mcp`

独立运行：

```bash
npm run dev:kubernetes
```

独立 endpoint：`http://127.0.0.1:3105/kubernetes/mcp`。`PORT` 可以覆盖 3105。插件默认关闭，需通过控制台、启停 API 或 `MCP_ENABLED_KUBERNETES=true` 显式启用。

## 调用示例

查找默认 namespace 中的 Deployment：

```json
{
  "name": "k8s_list_workloads",
  "arguments": {
    "kind": "Deployment",
    "labelSelector": "app.kubernetes.io/name=checkout"
  }
}
```

获取工作负载诊断快照：

```json
{
  "name": "k8s_get_workload_snapshot",
  "arguments": {
    "namespace": "apps",
    "kind": "Deployment",
    "name": "checkout"
  }
}
```

反查域名和路径：

```json
{
  "name": "k8s_get_ingress_snapshot",
  "arguments": {
    "host": "checkout.example.com",
    "path": "/api/orders"
  }
}
```

查看上一次已终止容器的日志：

```json
{
  "name": "k8s_get_pod_logs",
  "arguments": {
    "namespace": "apps",
    "pod": "checkout-7d9c8d6f5b-abcde",
    "container": "checkout",
    "previous": true,
    "tailLines": 500
  }
}
```

## Pending 与配置排查

Pod 和工作负载模板摘要包含容器端口、volumeMounts、imagePullPolicy、imagePullSecrets 引用，以及 nodeSelector、affinity、tolerations、topologySpreadConstraints 等调度信息。模板也包含 initContainers；即使尚未创建 Pod，也可检查模板配置。

探针包含 HTTP host/path/port/scheme、TCP host/port、gRPC port/service 和时间参数。HTTP header 保留名称、隐藏值；exec 探针仅标记存在并隐藏命令，避免暴露内嵌凭据。所有信息都是声明配置，不能证明应用实际监听或探针可达。

工作负载快照新增 `sections.resourceQuotas`，独立于关联 Pod 查询；配额读取被 RBAC 拒绝时返回 `partial`，保留其余证据。旧身份需要增加 `resourcequotas` 的只读权限，参考更新后的 RBAC 示例；插件不会应用权限变更。

未调度的 Pod 没有 nodeName，因此快照中的 nodes 仍可能为空；调用 `k8s_list_nodes` 查看候选节点，结合 Pod 调度约束和 Events 分析。allocatable 是可分配总量，不代表当前剩余容量。

新增独立查询示例：

```json
{"name":"k8s_list_nodes","arguments":{"labelSelector":"pool=apps","limit":50}}
{"name":"k8s_list_pvcs","arguments":{"namespace":"apps","limit":50}}
{"name":"k8s_list_resource_quotas","arguments":{"namespace":"apps","limit":50}}
```

列表默认 50 条、最多 200 条；收到 continueToken 后，将其作为下一次调用参数并保持原查询条件。PVC/Quota 跨 namespace 需显式设置 `allNamespaces: true`，不能同时指定 namespace。独立 PVC 查询只返回 PVC 摘要及 PV/StorageClass 引用，不自动读取关联对象。

这三个独立列表不会裁掉页内资源：整页摘要超过 256 KiB 时返回 Tool 错误，不返回部分 items 或下一页 token。按错误提示缩小 limit，保留原 continueToken 和过滤条件重试；首批请求仍省略 continueToken。单个资源摘要也超限时明确报错，不能将其视为资源不存在。

## 安全与数据处理

- Kubernetes RBAC 是唯一授权边界；MCP 的只读 metadata 不是权限控制。
- 客户端封装只暴露读取操作，并在发送前拒绝任何非 GET 请求。
- 插件从不请求 Secret 或 ConfigMap 对象。Pod spec 中只显示引用名称和 key；明文环境变量值统一显示为 `[REDACTED]`。
- ingress-nginx 的 rewrite、协议、超时等已审核 annotation 可以显示 value；snippet、auth 和未知 annotation 只显示 `[PRESENT]`。
- TLS Secret 仅显示名称，不读取内容。
- 日志按原文返回，可能包含敏感业务数据；MCP 中央日志不记录 Tool 输出正文。
- 聚合 snapshot 总预算 20 秒，并发不超过 4；普通 API 请求为 10 秒。结构化响应最大 256 KiB，超限会显式标记截断。
- `forbidden`、`not_found`、`timeout` 等关联查询不会抹掉已经获取的证据，而是形成 `partial` snapshot。

最小权限示例见 [`rbac.example.yaml`](rbac.example.yaml)。该文件只供审查和手工应用，插件不会自动创建或修改 RBAC。

## 兼容性验证

实现只使用 Kubernetes 1.23 已提供的稳定 API。单元测试和本地假 API Server 验证查询、GET-only、分页、脱敏和链路组合；只有在真实 1.23 与较新集群完成 smoke test 后，才能将“设计兼容”提升为“已验证兼容”。
