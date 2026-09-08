import assert from "node:assert/strict";
import test from "node:test";
import { createGenericConfigManager } from "./plugin-config-manager.js";
import { type PluginConfigField, type PersonalMcpPlugin } from "./plugin.js";

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
