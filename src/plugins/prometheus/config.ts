import type { PluginConfigField } from "../../core/plugin.js";

export const PROMETHEUS_CONFIG_FIELDS: readonly PluginConfigField[] = [
  {
    key: "PROMETHEUS_MCP_URL",
    label: "Prometheus URL",
    description: "Prometheus HTTP 地址，例如 http://127.0.0.1:9090。",
    type: "text",
    defaultValue: "",
    required: true,
    placeholder: "http://127.0.0.1:9090",
  },
  {
    key: "PROMETHEUS_MCP_QUERY_TIMEOUT",
    label: "查询超时（秒）",
    description: "每次 PromQL 查询允许执行的最长时间，范围 1-300 秒。",
    type: "text",
    defaultValue: "30",
    required: true,
  },
];

export interface PrometheusPluginConfig {
  readonly url: string;
  readonly queryTimeoutSeconds: number;
}

export function loadPrometheusPluginConfig(
  environment: NodeJS.ProcessEnv = process.env,
): PrometheusPluginConfig {
  const url = (environment.PROMETHEUS_MCP_URL ?? environment.PROMETHEUS_URL)?.trim() ?? "";
  const timeoutValue = environment.PROMETHEUS_MCP_QUERY_TIMEOUT
    ?? environment.PROMETHEUS_QUERY_TIMEOUT
    ?? environment.PROMETHEUS_MCP_QUERY_TIMEOUT_SECONDS
    ?? environment.PROMETHEUS_QUERY_TIMEOUT_SECONDS;
  const parsedTimeout = timeoutValue === undefined ? 30 : Number(timeoutValue.trim());
  return {
    url,
    queryTimeoutSeconds: parsedTimeout,
  };
}
