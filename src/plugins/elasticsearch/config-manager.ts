import type { McpConfigManager, PluginConfigValue } from "../../core/plugin.js";
import { createGenericConfigManager } from "../../core/plugin-config-manager.js";
import type { RuntimeConfigStore } from "../../core/runtime-config.js";
import { createElasticsearchPlugin } from "./index.js";
import {
  ELASTICSEARCH_CONFIG_FIELDS,
  loadElasticsearchPluginConfig,
  validateElasticsearchConfig,
} from "./config.js";
import { ELASTICSEARCH_PLUGIN_ID } from "./constants.js";

const CONFIG_KEYS = new Set(ELASTICSEARCH_CONFIG_FIELDS.map((field) => field.key));

export function createElasticsearchConfigManager(
  store: RuntimeConfigStore,
  profileId?: string,
): McpConfigManager {
  return createGenericConfigManager({
    pluginId: ELASTICSEARCH_PLUGIN_ID,
    ...(profileId === undefined ? {} : { profileId }),
    fields: ELASTICSEARCH_CONFIG_FIELDS,
    store,
    load: loadElasticsearchPluginConfig,
    values: (config) => ({
      ELASTICSEARCH_MCP_URL: config.url,
      ELASTICSEARCH_MCP_USERNAME: config.username,
      ELASTICSEARCH_MCP_PASSWORD: config.password,
      ELASTICSEARCH_MCP_REQUEST_TIMEOUT: config.requestTimeoutMs,
      ELASTICSEARCH_MCP_MAX_HITS: config.maxHits,
      ELASTICSEARCH_MCP_MAX_RESPONSE_BYTES: config.maxResponseBytes,
    }),
    parse: (input, current) => parseValues({ ...current, ...readInput(input) }),
    environment: (values, base) => ({
      ...base,
      ...Object.fromEntries(Object.entries(values).map(([key, value]) => [key, String(value)])),
    }),
    persist: (values) => Object.fromEntries(
      Object.entries(values).map(([key, value]) => [key, String(value)]),
    ),
    validate: validateElasticsearchConfig,
    createPlugin: (config) => createElasticsearchPlugin({ config }),
  });
}

function readInput(input: unknown): Record<string, PluginConfigValue> {
  const value = isRecord(input) && isRecord(input.values) ? input.values : input;
  if (!isRecord(value)) throw new Error("Configuration body must be an object");
  const unknownKeys = Object.keys(value).filter((key) => !CONFIG_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(`Unknown Elasticsearch configuration field: ${unknownKeys.join(", ")}`);
  }
  return value as Record<string, PluginConfigValue>;
}

function parseValues(values: Readonly<Record<string, PluginConfigValue>>): Record<string, PluginConfigValue> {
  return {
    ELASTICSEARCH_MCP_URL: requireString(values, "ELASTICSEARCH_MCP_URL").trim(),
    ELASTICSEARCH_MCP_USERNAME: requireString(values, "ELASTICSEARCH_MCP_USERNAME").trim(),
    ELASTICSEARCH_MCP_PASSWORD: requireString(values, "ELASTICSEARCH_MCP_PASSWORD"),
    ELASTICSEARCH_MCP_REQUEST_TIMEOUT: requireNumber(values, "ELASTICSEARCH_MCP_REQUEST_TIMEOUT"),
    ELASTICSEARCH_MCP_MAX_HITS: requireNumber(values, "ELASTICSEARCH_MCP_MAX_HITS"),
    ELASTICSEARCH_MCP_MAX_RESPONSE_BYTES: requireNumber(values, "ELASTICSEARCH_MCP_MAX_RESPONSE_BYTES"),
  };
}

function requireString(values: Readonly<Record<string, PluginConfigValue>>, key: string): string {
  const value = values[key];
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value;
}

function requireNumber(values: Readonly<Record<string, PluginConfigValue>>, key: string): number {
  const value = values[key];
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed)) throw new Error(`${key} must be an integer`);
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
