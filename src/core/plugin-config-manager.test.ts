import assert from "node:assert/strict";
import test from "node:test";
import { createGenericConfigManager } from "./plugin-config-manager.js";
import {
  type PersonalMcpPlugin,
  type PluginConfigField,
  type PluginConfigValue,
} from "./plugin.js";

const fields: readonly PluginConfigField[] = [{ key: "VALUE", label: "Value", description: "", type: "text", defaultValue: "a" }];
const plugin = (value: string): PersonalMcpPlugin => ({ id: "test", displayName: "Test", summary: value, category: { id: "test", name: "Test", description: "" }, tools: [], createServer: () => ({}) as never });

test("generic config lifecycle serializes updates and replaces runtime after persistence", async () => {
  let env: Record<string, string> = { VALUE: "a" };
  const calls: string[] = [];
  const store = { environment: () => ({ ...env }), update: async (values: Record<string, string>) => { calls.push(values.VALUE ?? ""); await new Promise((resolve) => setTimeout(resolve, 2)); env = { ...env, ...values }; } };
  const manager = createGenericConfigManager({ pluginId: "test", fields, store, load: (e) => ({ value: e.VALUE ?? "" }), values: (c) => ({ VALUE: c.value }), parse: (input) => ({ VALUE: String((input as { VALUE: string }).VALUE) }), environment: (values, base) => ({ ...base, VALUE: String(values.VALUE) }), persist: (values) => ({ VALUE: String(values.VALUE) }), validate: () => undefined, createPlugin: (c) => plugin(c.value) });
  const replaced: string[] = [];
  manager.setRuntimeReplacement?.((p) => replaced.push(p.summary));
  const [first, second] = await Promise.all([manager.update({ VALUE: "b" }), manager.update({ VALUE: "c" })]);
  assert.deepEqual(calls, ["b", "c"]);
  assert.equal(first.snapshot.revision, 1);
  assert.equal(second.snapshot.revision, 2);
  assert.deepEqual(replaced, ["b", "c"]);
  assert.deepEqual(second.changedKeys, ["VALUE"]);
});

test("generic config lifecycle does not publish when persistence fails", async () => {
  let replaced = 0;
  const store = { environment: () => ({ VALUE: "a" }), update: async () => { throw new Error("disk full"); } };
  const manager = createGenericConfigManager({ pluginId: "test", fields, store, load: (e) => ({ value: e.VALUE ?? "" }), values: (c) => ({ VALUE: c.value }), parse: (input) => ({ VALUE: String((input as { VALUE: string }).VALUE) }), environment: (values, base) => ({ ...base, VALUE: String(values.VALUE) }), persist: (values) => ({ VALUE: String(values.VALUE) }), validate: () => undefined, createPlugin: (c) => plugin(c.value) });
  manager.setRuntimeReplacement?.(() => { replaced += 1; });
  await assert.rejects(manager.update({ VALUE: "b" }), /disk full/);
  assert.equal(manager.getSnapshot().revision, 0);
  assert.equal(replaced, 0);
});

test("generic config lifecycle compares multiselect values by content", async () => {
  let environment = { LIST: "a,b" };
  const multiselectFields: readonly PluginConfigField[] = [{
    key: "LIST",
    label: "List",
    description: "Selected values",
    type: "multiselect",
    defaultValue: [],
    options: [
      { value: "a", label: "A" },
      { value: "b", label: "B" },
      { value: "c", label: "C" },
    ],
  }];
  const manager = createGenericConfigManager({
    pluginId: "test",
    fields: multiselectFields,
    store: {
      environment: () => ({ ...environment }),
      update: async (values) => { environment = { ...environment, LIST: values.LIST ?? "" }; },
    },
    load: (env) => ({ list: (env.LIST ?? "").split(",").filter(Boolean) }),
    values: ({ list }) => ({ LIST: [...list] }),
    parse: (input) => ({ LIST: [...(input as { LIST: readonly string[] }).LIST] }),
    environment: (values, base) => ({ ...base, LIST: (values.LIST as readonly string[]).join(",") }),
    persist: (values) => ({ LIST: (values.LIST as readonly string[]).join(",") }),
    validate: () => undefined,
    createPlugin: ({ list }) => plugin(list.join(",")),
  });

  assert.deepEqual((await manager.update({ LIST: ["a", "b"] })).changedKeys, []);
  assert.deepEqual((await manager.update({ LIST: ["a", "c"] })).changedKeys, ["LIST"]);
});

test("generic config lifecycle redacts, retains, replaces, and explicitly clears Secrets", async () => {
  const secretFields: readonly PluginConfigField[] = [
    { key: "VALUE", label: "Value", description: "", type: "text", defaultValue: "a" },
    { key: "TOKEN", label: "Token", description: "", type: "password", defaultValue: "", secret: true },
  ];
  let environment: Record<string, string> = { VALUE: "a", TOKEN: "old-secret" };
  const persisted: Record<string, string>[] = [];
  const manager = createGenericConfigManager({
    pluginId: "test",
    fields: secretFields,
    store: {
      environment: () => ({ ...environment }),
      update: async (values) => {
        persisted.push({ ...values });
        environment = { ...environment, ...values };
      },
    },
    load: (env) => ({ value: env.VALUE ?? "", token: env.TOKEN ?? "" }),
    values: (config) => ({ VALUE: config.value, TOKEN: config.token }),
    parse: (input, current) => ({
      ...current,
      ...((input as { values: Record<string, PluginConfigValue> }).values),
    }),
    environment: (values, base) => ({ ...base, VALUE: String(values.VALUE), TOKEN: String(values.TOKEN ?? "") }),
    persist: (values) => ({ VALUE: String(values.VALUE), TOKEN: String(values.TOKEN ?? "") }),
    validate: () => undefined,
    createPlugin: (config) => plugin(config.value),
  });

  assert.deepEqual(manager.getSnapshot().values, { VALUE: "a" });
  assert.deepEqual(manager.getSnapshot().secretStates, { TOKEN: { configured: true } });

  await manager.update({ values: { VALUE: "b" } });
  await manager.update({ values: { VALUE: "c", TOKEN: "" } });
  assert.equal(persisted[0]?.TOKEN, "old-secret");
  assert.equal(persisted[1]?.TOKEN, "old-secret");

  const replaced = await manager.update({ values: { VALUE: "c", TOKEN: "new-secret" } });
  assert.equal(persisted[2]?.TOKEN, "new-secret");
  assert.deepEqual(replaced.changedKeys, ["TOKEN"]);
  assert.equal(Object.hasOwn(replaced.snapshot.values, "TOKEN"), false);
  assert.deepEqual(replaced.snapshot.secretStates, { TOKEN: { configured: true } });

  const cleared = await manager.update({ values: { VALUE: "c", TOKEN: "" }, clearSecrets: ["TOKEN"] });
  assert.equal(persisted[3]?.TOKEN, "");
  assert.deepEqual(cleared.changedKeys, ["TOKEN"]);
  assert.deepEqual(cleared.snapshot.secretStates, { TOKEN: { configured: false } });
});

test("generic config lifecycle removes Secret values from validation errors", async () => {
  const secretFields: readonly PluginConfigField[] = [
    { key: "TOKEN", label: "Token", description: "", type: "password", defaultValue: "", secret: true },
  ];
  const manager = createGenericConfigManager({
    pluginId: "test",
    fields: secretFields,
    store: { environment: () => ({ TOKEN: "old-secret" }), update: async () => undefined },
    load: (env) => ({ token: env.TOKEN ?? "" }),
    values: (config) => ({ TOKEN: config.token }),
    parse: (input, current) => {
      const values = (input as { values: Record<string, PluginConfigValue> }).values;
      return { ...current, ...values, TOKEN: String(values.TOKEN).trim() };
    },
    environment: (values, base) => ({ ...base, TOKEN: String(values.TOKEN ?? "") }),
    persist: (values) => ({ TOKEN: String(values.TOKEN ?? "") }),
    validate: (config) => { throw new Error(`Rejected credential ${config.token}; previous old-secret`); },
    createPlugin: () => plugin("unused"),
  });

  await assert.rejects(
    manager.update({ values: { TOKEN: "  normalized-secret  " } }),
    (error: Error) => {
      assert.equal(error.message, "Rejected credential [REDACTED]; previous [REDACTED]");
      assert.doesNotMatch(error.message, /old-secret|normalized-secret/);
      return true;
    },
  );
  assert.deepEqual(manager.getSnapshot().secretStates, { TOKEN: { configured: true } });
});

test("generic Secret retention is applied before plugin parsing", async () => {
  const secretFields: readonly PluginConfigField[] = [
    { key: "TOKEN", label: "Token", description: "", type: "password", defaultValue: "", secret: true },
  ];
  let persistedToken = "old-secret";
  const manager = createGenericConfigManager({
    pluginId: "test",
    fields: secretFields,
    store: {
      environment: () => ({ TOKEN: persistedToken }),
      update: async (values) => { persistedToken = values.TOKEN ?? ""; },
    },
    load: (environment) => ({ token: environment.TOKEN ?? "" }),
    values: (config) => ({ TOKEN: config.token }),
    parse: (input) => {
      const token = (input as { values: { TOKEN?: unknown } }).values.TOKEN;
      if (typeof token !== "string" || token.length === 0) {
        throw new Error("plugin parser requires a non-empty token");
      }
      return { TOKEN: token };
    },
    environment: (values, base) => ({ ...base, TOKEN: String(values.TOKEN ?? "") }),
    persist: (values) => ({ TOKEN: String(values.TOKEN ?? "") }),
    validate: () => undefined,
    createPlugin: () => plugin("retained"),
  });

  await manager.update({ values: { TOKEN: "" } });
  assert.equal(persistedToken, "old-secret");
});

test("generic lifecycle hides Secret normalization when plugin parsing fails", async () => {
  const secretFields: readonly PluginConfigField[] = [
    { key: "TOKEN", label: "Token", description: "", type: "password", defaultValue: "", secret: true },
  ];
  const manager = createGenericConfigManager({
    pluginId: "test",
    fields: secretFields,
    store: { environment: () => ({ TOKEN: "old-secret" }), update: async () => undefined },
    load: (environment) => ({ token: environment.TOKEN ?? "" }),
    values: (config) => ({ TOKEN: config.token }),
    parse: (input) => {
      const normalized = String((input as { values: { TOKEN: unknown } }).values.TOKEN).trim();
      throw new Error(`Parser rejected ${normalized}`);
    },
    environment: (values, base) => ({ ...base, TOKEN: String(values.TOKEN ?? "") }),
    persist: (values) => ({ TOKEN: String(values.TOKEN ?? "") }),
    validate: () => undefined,
    createPlugin: () => plugin("unused"),
  });

  await assert.rejects(
    manager.update({ values: { TOKEN: "  normalized-secret  " } }),
    (error: Error) => {
      assert.equal(error.message, "Invalid configuration for test");
      assert.doesNotMatch(error.message, /normalized-secret/);
      return true;
    },
  );
});

test("Secret redaction replaces overlapping values longest-first", () => {
  const secretFields: readonly PluginConfigField[] = [
    { key: "SHORT", label: "Short", description: "", type: "password", defaultValue: "", secret: true },
    { key: "LONG", label: "Long", description: "", type: "password", defaultValue: "", secret: true },
  ];
  const manager = createGenericConfigManager({
    pluginId: "test",
    fields: secretFields,
    store: { environment: () => ({ SHORT: "secret", LONG: "secret-suffix" }), update: async () => undefined },
    load: (environment) => ({ short: environment.SHORT ?? "", long: environment.LONG ?? "" }),
    values: (config) => ({ SHORT: config.short, LONG: config.long }),
    parse: () => ({}),
    environment: (_values, base) => base,
    validate: () => undefined,
    createPlugin: () => plugin("unused"),
  });

  assert.deepEqual(manager.redactSecrets?.({ value: "secret-suffix secret" }), {
    value: "[REDACTED] [REDACTED]",
  });
});
