import type { McpConfigManager } from "../../core/plugin.js";
import { createGenericConfigManager } from "../../core/plugin-config-manager.js";
import type { RuntimeConfigStore } from "../../core/runtime-config.js";
import { JAEGER_CONFIG_FIELDS, loadJaegerPluginConfig, jaegerBaseUrl } from "./config.js";
import { createJaegerPlugin } from "./index.js";

const configKeys = new Set(JAEGER_CONFIG_FIELDS.map(field => field.key));

export function createJaegerConfigManager(store: RuntimeConfigStore): McpConfigManager {
  return createGenericConfigManager({
    pluginId: "jaeger", fields: JAEGER_CONFIG_FIELDS, store,
    load: loadJaegerPluginConfig,
    values: config => ({
      JAEGER_MCP_URL: config.url,
      JAEGER_MCP_USERNAME: config.username,
      JAEGER_MCP_PASSWORD: config.password,
    }),
    parse: (input, current) => configValues({ ...current, ...readInput(input) }),
    environment: (values, base) => ({ ...base, ...configValues(values) }),
    persist: values => configValues(values),
    validate: config => {
      if (!config.url) throw new Error("JAEGER_MCP_URL must be configured");
      jaegerBaseUrl(config.url);
    },
    createPlugin: createJaegerPlugin,
  });
}

function readInput(input: unknown): Record<string, unknown> {
  if (!isRecord(input)) throw new Error("Configuration body must be an object");
  let values = input;
  if (Object.hasOwn(input, "values")) {
    if (Object.keys(input).some(key => key !== "values" && key !== "clearSecrets")) {
      throw new Error("Unknown configuration request field");
    }
    if (!isRecord(input.values)) throw new Error("Configuration values must be an object");
    values = input.values;
  }
  if (Object.keys(values).some(key => !configKeys.has(key))) {
    throw new Error("Unknown Jaeger configuration field");
  }
  return values;
}

/** Explicit mapping also bounds environment overlays and persistence to this Plugin. */
function configValues(values: Readonly<Record<string, unknown>>): Record<string, string> {
  const requiredString = (key: string): string => {
    const value = values[key];
    if (typeof value !== "string") throw new Error(`${key} must be a string`);
    return value;
  };
  return {
    JAEGER_MCP_URL: requiredString("JAEGER_MCP_URL").trim(),
    JAEGER_MCP_USERNAME: requiredString("JAEGER_MCP_USERNAME").trim(),
    JAEGER_MCP_PASSWORD: requiredString("JAEGER_MCP_PASSWORD"),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
