import { createGenericConfigManager } from "../../core/plugin-config-manager.js";
import type { RuntimeConfigStore } from "../../core/runtime-config.js";
import { KAFKA_CONFIG_FIELDS, loadKafkaConfig, kafkaConfigValues, validateKafkaConfig } from "./config.js";
import { createKafkaPlugin } from "./index.js";

export function createKafkaConfigManager(store: RuntimeConfigStore) {
  return createGenericConfigManager({
    pluginId: "kafka", fields: KAFKA_CONFIG_FIELDS, store, load: loadKafkaConfig, values: kafkaConfigValues,
    parse: (input, current) => {
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Expected Kafka configuration object");
      const raw = "values" in input ? input.values : input;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Expected values object");
      const next = { ...current };
      for (const [key, value] of Object.entries(raw)) {
        const field = KAFKA_CONFIG_FIELDS.find(f => f.key === key);
        if (!field) throw new Error(`Unknown Kafka configuration field: ${key}`);
        if (field.type === "boolean" ? typeof value !== "boolean" : field.type === "number" ? typeof value !== "number" && typeof value !== "string" : typeof value !== "string") throw new Error(`Invalid type for ${key}`);
        next[key] = value;
      }
      return next;
    },
    environment: (values, base) => ({ ...base, ...Object.fromEntries(Object.entries(values).map(([k, v]) => [k, String(v)])) }),
    persist: values => Object.fromEntries(Object.entries(values).map(([k, v]) => [k, String(v)])),
    validate: validateKafkaConfig, createPlugin: config => createKafkaPlugin({ config }),
  });
}
