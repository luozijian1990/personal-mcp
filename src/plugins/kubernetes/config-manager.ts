import type { McpConfigManager, PluginConfigValue } from "../../core/plugin.js";
import { createGenericConfigManager } from "../../core/plugin-config-manager.js";
import type { RuntimeConfigStore } from "../../core/runtime-config.js";
import { createKubernetesReadClient, validateKubernetesConfig } from "./client.js";
import {
  KUBERNETES_CONFIG_FIELDS,
  loadKubernetesPluginConfig,
} from "./config.js";
import { createKubernetesPlugin } from "./index.js";
import { KUBERNETES_PLUGIN_ID } from "./constants.js";

const CONFIG_KEYS = new Set(KUBERNETES_CONFIG_FIELDS.map((field) => field.key));

export function createKubernetesConfigManager(store: RuntimeConfigStore): McpConfigManager {
  return createGenericConfigManager({
    pluginId: KUBERNETES_PLUGIN_ID,
    fields: KUBERNETES_CONFIG_FIELDS,
    store,
    load: loadKubernetesPluginConfig,
    values: (config) => ({
      KUBERNETES_KUBECONFIG_PATH: config.kubeconfigPath,
      KUBERNETES_CONTEXT: config.context,
      KUBERNETES_DEFAULT_NAMESPACE: config.defaultNamespace,
    }),
    parse: (input, current) => parseValues({
      ...current,
      ...(isRecord(input) && isRecord(input.values) ? input.values : isRecord(input) ? input : {}),
    } as Readonly<Record<string, PluginConfigValue>>),
    environment: (values, base) => ({
      ...base,
      KUBERNETES_KUBECONFIG_PATH: String(values.KUBERNETES_KUBECONFIG_PATH),
      KUBERNETES_CONTEXT: String(values.KUBERNETES_CONTEXT),
      KUBERNETES_DEFAULT_NAMESPACE: String(values.KUBERNETES_DEFAULT_NAMESPACE),
    }),
    persist: (values) => ({
      KUBERNETES_KUBECONFIG_PATH: String(values.KUBERNETES_KUBECONFIG_PATH),
      KUBERNETES_CONTEXT: String(values.KUBERNETES_CONTEXT),
      KUBERNETES_DEFAULT_NAMESPACE: String(values.KUBERNETES_DEFAULT_NAMESPACE),
    }),
    validate: validateKubernetesConfig,
    createPlugin: (config) => createKubernetesPlugin({
      config,
      client: createKubernetesReadClient(config),
    }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseValues(values: Readonly<Record<string, PluginConfigValue>>): Record<string, string> {
  const unknownKeys = Object.keys(values).filter((key) => !CONFIG_KEYS.has(key));
  if (unknownKeys.length > 0) throw new Error(`Unknown Kubernetes configuration field: ${unknownKeys.join(", ")}`);
  const parsed: Record<string, string> = {};
  for (const key of [
    "KUBERNETES_KUBECONFIG_PATH",
    "KUBERNETES_CONTEXT",
    "KUBERNETES_DEFAULT_NAMESPACE",
  ]) {
    const value = values[key];
    if (typeof value !== "string") throw new Error(`${key} must be a string`);
    parsed[key] = value;
  }
  return parsed;
}
