import type { McpConfigManager } from "../../core/plugin.js";
import { createGenericConfigManager } from "../../core/plugin-config-manager.js";
import type { RuntimeConfigStore } from "../../core/runtime-config.js";
import { SKYWALKING_CONFIG_FIELDS, loadSkyWalkingPluginConfig, graphqlUrl } from "./config.js";
import { createSkyWalkingPlugin } from "./index.js";

const configKeys = new Set(SKYWALKING_CONFIG_FIELDS.map(field => field.key));

export function createSkyWalkingConfigManager(store: RuntimeConfigStore): McpConfigManager {
  return createGenericConfigManager({
    pluginId: "skywalking", fields: SKYWALKING_CONFIG_FIELDS, store,
    load: loadSkyWalkingPluginConfig,
    values: config => ({
      SKYWALKING_MCP_URL: config.url,
      SKYWALKING_MCP_USERNAME: config.username,
      SKYWALKING_MCP_PASSWORD: config.password,
    }),
    parse: (input, current) => configValues({ ...current, ...readInput(input) }),
    environment: (values, base) => ({ ...base, ...configValues(values) }),
    persist: values => configValues(values),
    validate: config => {
      if (!config.url) throw new Error("SKYWALKING_MCP_URL must be configured");
      graphqlUrl(config.url);
    },
    createPlugin: createSkyWalkingPlugin,
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
    throw new Error("Unknown SkyWalking configuration field");
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
    SKYWALKING_MCP_URL: requiredString("SKYWALKING_MCP_URL").trim(),
    SKYWALKING_MCP_USERNAME: requiredString("SKYWALKING_MCP_USERNAME").trim(),
    SKYWALKING_MCP_PASSWORD: requiredString("SKYWALKING_MCP_PASSWORD"),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
