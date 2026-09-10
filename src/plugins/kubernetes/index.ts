import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import type { PersonalMcpPlugin, PersonalMcpPluginMetadata } from "../../core/plugin.js";
import { toolErrorResult, toolStructuredResult } from "../../core/tool-result.js";
import {
  createKubernetesReadClient,
  isNamespace,
  validateKubernetesConfig,
  type KubernetesReadClient,
} from "./client.js";
import { KUBERNETES_CONFIG_FIELDS, loadKubernetesPluginConfig, type KubernetesPluginConfig } from "./config.js";
import {
  KUBERNETES_DEFAULT_LIMIT,
  KUBERNETES_DEFAULT_LOG_LINES,
  KUBERNETES_MAX_LIMIT,
  KUBERNETES_MAX_LOG_BYTES,
  KUBERNETES_MAX_LOG_LINES,
  KUBERNETES_PLUGIN_ID,
} from "./constants.js";
import {
  classifyKubernetesError,
  fitResponse,
  getIngressSnapshot,
  getServiceSnapshot,
  getWorkloadSnapshot,
  listEvents,
  listNamespaces,
  listWorkloads,
} from "./queries.js";
import type { JsonRecord } from "./summaries.js";
import {
  eventListOutputSchema,
  ingressSnapshotOutputSchema,
  namespaceListOutputSchema,
  podLogsOutputSchema,
  serviceSnapshotOutputSchema,
  workloadListOutputSchema,
  workloadSnapshotOutputSchema,
} from "./output-schemas.js";

export const KUBERNETES_PLUGIN_METADATA: PersonalMcpPluginMetadata = {
  id: KUBERNETES_PLUGIN_ID,
  displayName: "Kubernetes",
  summary: "只读查询 Kubernetes 工作负载、事件、日志和 Ingress/Service 依赖链。",
  category: {
    id: "operations",
    name: "运维诊断",
    description: "收集应用故障排查所需的集群证据。",
  },
};

const namespaceSchema = z.string().trim().refine(isNamespace, "namespace must be a valid DNS label of at most 63 characters").describe("Kubernetes namespace；省略时使用已配置的默认 namespace");
const nameSchema = z.string().trim().min(1).max(253).describe("Kubernetes 对象名称");
const selectorSchema = z.string().trim().min(1).max(1_024).optional().describe("Kubernetes label selector，例如 app=api,environment=prod");
const continueSchema = z.string().min(1).max(8_192).optional().describe("上一页返回的 Kubernetes continue token");
const limitSchema = z.number().int().min(1).max(KUBERNETES_MAX_LIMIT).default(KUBERNETES_DEFAULT_LIMIT).describe("返回条数，默认 50，最大 200");
const scopeShape = {
  namespace: namespaceSchema.optional(),
  allNamespaces: z.boolean().default(false).describe("显式查询所有 namespace；与 namespace 互斥，最终由 Kubernetes RBAC 授权"),
};
const workloadKindSchema = z.enum(["Deployment", "StatefulSet", "DaemonSet", "Job", "CronJob", "Pod"]);

const listNamespacesInput = z.object({ limit: limitSchema, continueToken: continueSchema, labelSelector: selectorSchema }).strict();
const listWorkloadsInput = z.object({ ...scopeShape, kind: workloadKindSchema, labelSelector: selectorSchema, limit: limitSchema, continueToken: continueSchema }).strict().superRefine(validateScope);
const workloadSnapshotInput = z.object({ namespace: namespaceSchema.optional(), kind: workloadKindSchema, name: nameSchema }).strict();
const serviceSnapshotInput = z.object({ namespace: namespaceSchema.optional(), name: nameSchema }).strict();
const ingressSnapshotInput = z.object({ namespace: namespaceSchema.optional(), name: nameSchema.optional(), host: z.string().trim().min(1).max(253).optional().describe("要反查的域名；未指定 namespace 时执行 RBAC 控制的全集群查询"), path: z.string().startsWith("/").max(2_048).optional() }).strict().superRefine((value, context) => {
  if ((value.name === undefined) === (value.host === undefined)) context.addIssue({ code: "custom", message: "Provide exactly one of name or host" });
  if (value.path !== undefined && value.host === undefined) context.addIssue({ code: "custom", message: "path requires host" });
});
const listEventsInput = z.object({ ...scopeShape, type: z.enum(["Normal", "Warning"]).optional(), kind: z.string().trim().min(1).max(128).optional(), name: nameSchema.optional(), sinceSeconds: z.number().int().min(1).max(7 * 24 * 60 * 60).optional(), limit: limitSchema, continueToken: continueSchema }).strict().superRefine(validateScope);
const podLogsInput = z.object({ namespace: namespaceSchema.optional(), pod: nameSchema, container: z.string().trim().min(1).max(253), tailLines: z.number().int().min(1).max(KUBERNETES_MAX_LOG_LINES).default(KUBERNETES_DEFAULT_LOG_LINES), sinceSeconds: z.number().int().min(1).max(7 * 24 * 60 * 60).optional(), timestamps: z.boolean().default(true), previous: z.boolean().default(false) }).strict();

export function createKubernetesPlugin(options: { readonly config?: KubernetesPluginConfig; readonly client?: KubernetesReadClient } = {}): PersonalMcpPlugin {
  const config = options.config ?? loadKubernetesPluginConfig();
  let cachedClient = options.client;
  const client = (): KubernetesReadClient => {
    if (!config.kubeconfigPath || !config.context || !config.defaultNamespace) throw new Error("Kubernetes MCP is not configured. Set kubeconfig path, context and default namespace.");
    cachedClient ??= createKubernetesReadClient(config);
    return cachedClient;
  };
  return {
    ...KUBERNETES_PLUGIN_METADATA,
    tools: [
      toolMeta("k8s_list_namespaces", "列出 Namespace"),
      toolMeta("k8s_list_workloads", "列出工作负载"),
      toolMeta("k8s_get_workload_snapshot", "获取工作负载诊断快照"),
      toolMeta("k8s_get_service_snapshot", "获取 Service 后端快照"),
      toolMeta("k8s_get_ingress_snapshot", "查询 Ingress 域名路由"),
      toolMeta("k8s_list_events", "列出 Kubernetes Events"),
      toolMeta("k8s_get_pod_logs", "读取单容器日志", "none"),
    ],
    config: { fields: KUBERNETES_CONFIG_FIELDS },
    checkHealth: async (signal) => {
      if (!config.kubeconfigPath || !config.context || !config.defaultNamespace) return { state: "unconfigured" };
      try {
        await validateKubernetesConfig(config);
        const started = Date.now();
        const version = await client().getVersion(signal);
        return { state: "healthy", message: `Kubernetes ${version.gitVersion ?? "version unknown"}`, latencyMs: Date.now() - started };
      } catch (error) {
        const classified = classifyKubernetesError(error);
        if (classified.status === "forbidden") return { state: "degraded", message: classified.message };
        return { state: "unhealthy", message: classified.message };
      }
    },
    createServer: () => createServer(config, client),
  };
}

function createServer(config: KubernetesPluginConfig, getClient: () => KubernetesReadClient): McpServer {
  const server = new McpServer({ name: `${KUBERNETES_PLUGIN_ID}-mcp-server`, version: "0.1.0" });
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

  server.registerTool("k8s_list_namespaces", {
    title: "List Kubernetes namespaces",
    description: "List bounded Namespace summaries with Kubernetes cursor pagination. This never changes cluster state.",
    inputSchema: listNamespacesInput,
    outputSchema: namespaceListOutputSchema,
    annotations,
  }, async (input) => result(() => listNamespaces(getClient(), input)));

  server.registerTool("k8s_list_workloads", {
    title: "List Kubernetes workloads",
    description: "List bounded summaries for one workload kind in a namespace or, only when explicitly requested, across all namespaces. Use this to find the exact kind/name before requesting a snapshot.",
    inputSchema: listWorkloadsInput,
    outputSchema: workloadListOutputSchema,
    annotations,
  }, async (input) => result(() => listWorkloads(getClient(), config.defaultNamespace, input)));

  server.registerTool("k8s_get_workload_snapshot", {
    title: "Get Kubernetes workload troubleshooting snapshot",
    description: "Collect a safe, bounded troubleshooting snapshot for one exact Deployment, StatefulSet, DaemonSet, Job, CronJob or Pod, including related Pods, Events, Services and available infrastructure evidence. Related RBAC failures return partial sections.",
    inputSchema: workloadSnapshotInput,
    outputSchema: workloadSnapshotOutputSchema,
    annotations,
  }, async (input) => result(() => getWorkloadSnapshot(getClient(), config.defaultNamespace, input)));

  server.registerTool("k8s_get_service_snapshot", {
    title: "Get Kubernetes Service backend snapshot",
    description: "Trace one Service to its declared selector, EndpointSlices, matching Pods and referencing Ingresses. This reports Kubernetes object state and does not run a network probe.",
    inputSchema: serviceSnapshotInput,
    outputSchema: serviceSnapshotOutputSchema,
    annotations,
  }, async (input) => result(() => getServiceSnapshot(getClient(), config.defaultNamespace, input)));

  server.registerTool("k8s_get_ingress_snapshot", {
    title: "Resolve Kubernetes Ingress host and path",
    description: "Find an Ingress by namespace/name or by host with optional path, then trace declared ingress-nginx routing through Services, EndpointSlices and Pods. Host-only lookup is cluster-wide and may be denied by RBAC. It does not prove Controller reload or live reachability.",
    inputSchema: ingressSnapshotInput,
    outputSchema: ingressSnapshotOutputSchema,
    annotations,
  }, async (input) => result(() => getIngressSnapshot(getClient(), config.defaultNamespace, input)));

  server.registerTool("k8s_list_events", {
    title: "List Kubernetes events",
    description: "List bounded Kubernetes Event summaries with optional object, type and recent-time filters. Events are best-effort evidence and may expire from the cluster.",
    inputSchema: listEventsInput,
    outputSchema: eventListOutputSchema,
    annotations,
  }, async (input) => result(() => listEvents(getClient(), config.defaultNamespace, input)));

  server.registerTool("k8s_get_pod_logs", {
    title: "Get bounded Kubernetes Pod logs",
    description: "Read bounded logs for one explicit Pod and container. Supports previous container logs and recent-time filtering. Logs may contain sensitive application data and are never written to central MCP response logs.",
    inputSchema: podLogsInput,
    outputSchema: podLogsOutputSchema,
    annotations,
  }, async (input) => result(async () => {
    const namespace = input.namespace ?? config.defaultNamespace;
    const raw = await getClient().getPodLogs({ name: input.pod, namespace, container: input.container, limitBytes: KUBERNETES_MAX_LOG_BYTES, previous: input.previous, ...(input.sinceSeconds === undefined ? {} : { sinceSeconds: input.sinceSeconds }), tailLines: input.tailLines, timestamps: input.timestamps });
    const bytes = Buffer.from(raw);
    const truncated = bytes.length >= KUBERNETES_MAX_LOG_BYTES;
    const log = truncated ? bytes.subarray(bytes.length - KUBERNETES_MAX_LOG_BYTES).toString("utf8") : raw;
    return fitResponse({ status: "complete", namespace, pod: input.pod, container: input.container, previous: input.previous, tailLines: input.tailLines, truncated, log });
  }));

  return server;
}

function validateScope(value: { namespace?: string | undefined; allNamespaces?: boolean | undefined }, context: z.RefinementCtx): void {
  if (value.namespace !== undefined && value.allNamespaces === true) context.addIssue({ code: "custom", message: "namespace and allNamespaces are mutually exclusive" });
}

function toolMeta(name: string, title: string, output: "metadata" | "none" = "metadata") {
  return { name, title, risk: "read-only" as const, logging: { input: "full" as const, output } };
}

async function result(operation: () => Promise<JsonRecord>) {
  try {
    return toolStructuredResult(await operation());
  } catch (error) {
    const classified = classifyKubernetesError(error);
    return toolErrorResult(new Error(classified.message), { prefix: "Kubernetes query failed: " });
  }
}
