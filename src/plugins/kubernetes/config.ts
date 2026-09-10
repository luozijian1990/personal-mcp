import type { PluginConfigField } from "../../core/plugin.js";

export const KUBERNETES_CONFIG_FIELDS: readonly PluginConfigField[] = [
  {
    key: "KUBERNETES_KUBECONFIG_PATH",
    label: "Kubeconfig path",
    description: "服务端可读的 kubeconfig 文件绝对路径。不会自动读取 ~/.kube/config 或 KUBECONFIG。",
    type: "path",
    defaultValue: "",
    required: true,
  },
  {
    key: "KUBERNETES_CONTEXT",
    label: "Context",
    description: "此 MCP 实例固定使用的 kubeconfig context；不会使用 current-context。",
    type: "text",
    defaultValue: "",
    required: true,
  },
  {
    key: "KUBERNETES_DEFAULT_NAMESPACE",
    label: "Default namespace",
    description: "Tool 未指定 namespace 时使用的默认 namespace。权限仍完全由 Kubernetes RBAC 决定。",
    type: "text",
    defaultValue: "default",
    required: true,
  },
];

export interface KubernetesPluginConfig {
  readonly kubeconfigPath: string;
  readonly context: string;
  readonly defaultNamespace: string;
}
export function loadKubernetesPluginConfig(
  environment: NodeJS.ProcessEnv = process.env,
): KubernetesPluginConfig {
  return {
    kubeconfigPath: (environment.KUBERNETES_KUBECONFIG_PATH ?? "").trim(),
    context: (environment.KUBERNETES_CONTEXT ?? "").trim(),
    defaultNamespace: (environment.KUBERNETES_DEFAULT_NAMESPACE ?? "default").trim(),
  };
}
