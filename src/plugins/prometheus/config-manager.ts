import { createPrometheusPlugin } from "./index.js";
import {
  PROMETHEUS_CONFIG_FIELDS,
  type PrometheusPluginConfig,
  loadPrometheusPluginConfig,
} from "./config.js";
import type { McpConfigManager, PluginConfigValue } from "../../core/plugin.js";
import { createGenericConfigManager } from "../../core/plugin-config-manager.js";
import type { RuntimeConfigStore } from "../../core/runtime-config.js";

const CONFIG_KEYS = new Set(PROMETHEUS_CONFIG_FIELDS.map((field) => field.key));

export function createPrometheusConfigManager(store: RuntimeConfigStore): McpConfigManager {
  return createGenericConfigManager({ pluginId: "prometheus", fields: PROMETHEUS_CONFIG_FIELDS, store,
    load: loadPrometheusPluginConfig,
    values: (config) => ({ PROMETHEUS_MCP_URL: config.url, PROMETHEUS_MCP_QUERY_TIMEOUT: String(config.queryTimeoutSeconds) }),
    parse: (input, current) => validateValues({ ...current, ...parseInput(input) }),
    environment: (values, base) => ({ ...base, ...Object.fromEntries(Object.entries(values).map(([key, value]) => [key, String(value)])) }),
    persist: (values) => ({ PROMETHEUS_MCP_URL: String(values.PROMETHEUS_MCP_URL), PROMETHEUS_MCP_QUERY_TIMEOUT: String(values.PROMETHEUS_MCP_QUERY_TIMEOUT) }),
    validate: validateConfig,
    createPlugin: (config) => createPrometheusPlugin({ config }),
  });
}

function parseInput(input: unknown): Record<string, PluginConfigValue> {
  const values = isRecord(input) && isRecord(input.values) ? input.values : input;
  if (!isRecord(values)) throw new Error("Configuration body must be an object");
  const normalized: Record<string, PluginConfigValue> = { ...values } as Record<string, PluginConfigValue>;
  const aliases: Readonly<Record<string, string>> = {
    PROMETHEUS_URL: "PROMETHEUS_MCP_URL",
    PROMETHEUS_QUERY_TIMEOUT: "PROMETHEUS_MCP_QUERY_TIMEOUT",
    PROMETHEUS_MCP_QUERY_TIMEOUT_SECONDS: "PROMETHEUS_MCP_QUERY_TIMEOUT",
    PROMETHEUS_QUERY_TIMEOUT_SECONDS: "PROMETHEUS_MCP_QUERY_TIMEOUT",
  };
  for (const [alias, canonical] of Object.entries(aliases)) {
    if (normalized[canonical] === undefined && normalized[alias] !== undefined) {
      normalized[canonical] = normalized[alias];
    }
    delete normalized[alias];
  }
  const unknownKeys = Object.keys(normalized).filter((key) => !CONFIG_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(`Unknown Prometheus configuration field: ${unknownKeys.join(", ")}`);
  }
  return normalized;
}

function validateValues(values: Record<string, PluginConfigValue>): {
  PROMETHEUS_MCP_URL: string;
  PROMETHEUS_MCP_QUERY_TIMEOUT: string;
} {
  const url = requireString(values, "PROMETHEUS_MCP_URL");
  validateUrl(url);
  const timeoutValue = requireString(values, "PROMETHEUS_MCP_QUERY_TIMEOUT");
  if (!/^\d+$/.test(timeoutValue)) {
    throw new Error("PROMETHEUS_MCP_QUERY_TIMEOUT must be an integer number of seconds");
  }
  const timeout = Number(timeoutValue);
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 300) {
    throw new Error("PROMETHEUS_MCP_QUERY_TIMEOUT must be between 1 and 300 seconds");
  }
  return {
    PROMETHEUS_MCP_URL: url,
    PROMETHEUS_MCP_QUERY_TIMEOUT: String(timeout),
  };
}

function validateConfig(config: PrometheusPluginConfig): void {
  if (config.url.trim().length === 0) throw new Error("PROMETHEUS_MCP_URL must be configured");
  validateUrl(config.url);
  if (!Number.isSafeInteger(config.queryTimeoutSeconds)
    || config.queryTimeoutSeconds < 1
    || config.queryTimeoutSeconds > 300) {
    throw new Error("PROMETHEUS_MCP_QUERY_TIMEOUT must be between 1 and 300 seconds");
  }
}

function validateUrl(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("PROMETHEUS_MCP_URL must be a valid HTTP or HTTPS URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("PROMETHEUS_MCP_URL must use http or https");
  }
  if (parsed.search.length > 0 || parsed.hash.length > 0) {
    throw new Error("PROMETHEUS_MCP_URL must not contain a query string or fragment");
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new Error("PROMETHEUS_MCP_URL must not contain embedded credentials");
  }
}

function requireString(values: Record<string, PluginConfigValue>, key: string): string {
  const value = values[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
