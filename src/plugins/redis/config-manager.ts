import { createGenericConfigManager } from "../../core/plugin-config-manager.js";
import type { RuntimeConfigStore } from "../../core/runtime-config.js";
import { REDIS_CONFIG_FIELDS, loadRedisConfig, redisConfigValues, validateRedisConfig } from "./config.js";
import { createRedisPlugin } from "./index.js";

export function createRedisConfigManager(store: RuntimeConfigStore) {
  return createGenericConfigManager({
    pluginId: "redis", fields: REDIS_CONFIG_FIELDS, store, load: loadRedisConfig, values: redisConfigValues,
    parse: (input, current) => {
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Expected Redis configuration object");
      const raw = "values" in input ? input.values : input;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Expected values object");
      const next = { ...current };
      for (const [key, value] of Object.entries(raw)) {
        const field = REDIS_CONFIG_FIELDS.find(f => f.key === key);
        if (!field) throw new Error(`Unknown Redis configuration field: ${key}`);
        if (field.type === "boolean" ? typeof value !== "boolean" : field.type === "number" ? typeof value !== "number" && typeof value !== "string" : typeof value !== "string") throw new Error(`Invalid type for ${key}`);
        next[key] = value;
      }
      return next;
    },
    environment: (values, base) => ({ ...base, ...Object.fromEntries(Object.entries(values).map(([k, v]) => [k, String(v)])) }),
    persist: values => Object.fromEntries(Object.entries(values).map(([k, v]) => [k, String(v)])),
    validate: validateRedisConfig, createPlugin: config => createRedisPlugin({ config }),
  });
}
