import type { McpConfigManager, PluginConfigValue } from "../../core/plugin.js";
import { createGenericConfigManager } from "../../core/plugin-config-manager.js";
import type { RuntimeConfigStore } from "../../core/runtime-config.js";
import { createMysqlPlugin } from "./index.js";
import { loadMysqlPluginConfig, MYSQL_CONFIG_FIELDS, validateMysqlConfig } from "./config.js";

export function createMysqlConfigManager(store: RuntimeConfigStore): McpConfigManager {
  return createGenericConfigManager({
    pluginId: "mysql", fields: MYSQL_CONFIG_FIELDS, store, load: loadMysqlPluginConfig,
    values: (config) => ({ MYSQL_HOST: config.host, MYSQL_PORT: String(config.port), MYSQL_USER: config.user, MYSQL_PASSWORD: config.password, MYSQL_DATABASE: config.database }),
    parse: (input, current) => {
      const raw = (isRecord(input) && isRecord(input.values) ? input.values : input) as Record<string, PluginConfigValue>;
      const keys = new Set(MYSQL_CONFIG_FIELDS.map((field) => field.key));
      const unknown = Object.keys(raw).filter((key) => !keys.has(key));
      if (unknown.length > 0) throw new Error(`Unknown MySQL configuration field: ${unknown.join(", ")}`);
      return { ...current, ...raw } as Record<string, string | boolean>;
    },
    environment: (values, base) => ({ ...base, ...Object.fromEntries(Object.entries(values).map(([key, value]) => [key, String(value)])) }),
    persist: (values) => ({ MYSQL_HOST: String(values.MYSQL_HOST), MYSQL_PORT: String(values.MYSQL_PORT), MYSQL_USER: String(values.MYSQL_USER), MYSQL_PASSWORD: String(values.MYSQL_PASSWORD ?? ""), MYSQL_DATABASE: String(values.MYSQL_DATABASE) }),
    validate: validateMysqlConfig,
    createPlugin: (config) => createMysqlPlugin({ config }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
