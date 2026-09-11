import assert from "node:assert/strict";
import test from "node:test";
import type { PersonalMcpPlugin } from "../../core/plugin.js";
import type { RuntimeConfigValues } from "../../core/runtime-config.js";
import { createSkyWalkingConfigManager } from "./config-manager.js";

function fixture() {
  const environment: Record<string, string> = { SKYWALKING_MCP_URL: "https://old.example.com", SKYWALKING_MCP_USERNAME: "reader", SKYWALKING_MCP_PASSWORD: "old-secret", MYSQL_MCP_HOST: "mysql-original" };
  const writes: RuntimeConfigValues[] = [];
  const replacements: PersonalMcpPlugin[] = [];
  let fail = false;
  let gate: Promise<void> | undefined;
  const manager = createSkyWalkingConfigManager({ environment: () => ({ ...environment }), update: async values => {
    if (gate) await gate;
    if (fail) throw new Error("Persistence failed old-secret");
    writes.push(values); Object.assign(environment, values);
  } });
  manager.setRuntimeReplacement!(plugin => replacements.push(plugin));
  return { manager, environment, writes, replacements, fail: (value: boolean) => { fail = value; }, gate: (value: Promise<void>) => { gate = value; } };
}

test("SkyWalking rejects foreign keys and malformed values without changing state", async () => {
  const f = fixture(); const before = f.manager.getSnapshot();
  for (const input of [
    { values: { MYSQL_MCP_HOST: "overwrite" } }, { MYSQL_MCP_HOST: "overwrite" },
    { values: { SKYWALKING_MCP_USERNAME: { invalid: true } } },
    { values: { SKYWALKING_MCP_PASSWORD: null } },
    { values: { SKYWALKING_MCP_URL: 123 } },
    { values: { SKYWALKING_MCP_USERNAME: false } },
    { values: [] }, { values: "bad" }, null, [], "bad",
    { values: {}, unexpected: "bad" },
  ]) await assert.rejects(f.manager.update(input));
  assert.deepEqual(f.manager.getSnapshot(), before);
  assert.equal(f.writes.length, 0); assert.equal(f.replacements.length, 0);
  assert.equal(f.environment.MYSQL_MCP_HOST, "mysql-original");
});

test("SkyWalking persists only its keys and retains, replaces and explicitly clears Secrets", async () => {
  const f = fixture();
  assert.equal(Object.hasOwn(f.manager.getSnapshot().values, "SKYWALKING_MCP_PASSWORD"), false);
  assert.deepEqual(f.manager.getSnapshot().secretStates, { SKYWALKING_MCP_PASSWORD: { configured: true } });
  const first = await f.manager.update({ values: { SKYWALKING_MCP_URL: " https://new.example.com " } });
  assert.equal(f.environment.SKYWALKING_MCP_PASSWORD, "old-secret");
  assert.deepEqual(first.changedKeys, ["SKYWALKING_MCP_URL"]);
  assert.equal(first.snapshot.revision, 1);
  assert.equal(first.snapshot.values.SKYWALKING_MCP_URL, "https://new.example.com");
  assert.deepEqual(Object.keys(f.writes[0]!).sort(), ["SKYWALKING_MCP_PASSWORD", "SKYWALKING_MCP_URL", "SKYWALKING_MCP_USERNAME"]);
  await f.manager.update({ SKYWALKING_MCP_PASSWORD: "" });
  assert.equal(f.environment.SKYWALKING_MCP_PASSWORD, "old-secret");
  await f.manager.update({ values: { SKYWALKING_MCP_PASSWORD: " new-secret " } });
  assert.equal(f.environment.SKYWALKING_MCP_PASSWORD, " new-secret ");
  await f.manager.update({ values: {}, clearSecrets: ["SKYWALKING_MCP_PASSWORD"] });
  assert.equal(f.environment.SKYWALKING_MCP_PASSWORD, "");
  assert.equal(f.manager.getSnapshot().secretStates?.SKYWALKING_MCP_PASSWORD?.configured, false);
  assert.equal(f.environment.MYSQL_MCP_HOST, "mysql-original");
});

test("SkyWalking validates before replacement and retains state on persistence failure", async () => {
  const f = fixture(); const before = f.manager.getSnapshot();
  await assert.rejects(f.manager.update({ values: { SKYWALKING_MCP_URL: "ftp://bad.example.com" } }));
  assert.equal(f.writes.length, 0);
  f.fail(true);
  await assert.rejects(f.manager.update({ values: { SKYWALKING_MCP_URL: "https://new.example.com" } }), error => {
    assert.ok(error instanceof Error); assert.doesNotMatch(error.message, /old-secret/); return true;
  });
  assert.deepEqual(f.manager.getSnapshot(), before); assert.equal(f.replacements.length, 0);
  f.fail(false);
  await f.manager.update({ values: { SKYWALKING_MCP_URL: "https://new.example.com" } });
  assert.equal(f.replacements.length, 1);
});

test("SkyWalking reload validates external config without writing and keeps old state on error", async () => {
  const f = fixture();
  f.environment.SKYWALKING_MCP_URL = "https://reload.example.com";
  const reloaded = await f.manager.reload();
  assert.equal(reloaded.snapshot.values.SKYWALKING_MCP_URL, "https://reload.example.com");
  assert.equal(f.writes.length, 0); assert.equal(f.replacements.length, 1);
  f.environment.SKYWALKING_MCP_URL = "ftp://invalid.example.com";
  await assert.rejects(f.manager.reload());
  assert.deepEqual(f.manager.getSnapshot(), reloaded.snapshot); assert.equal(f.replacements.length, 1);
});

test("SkyWalking serializes concurrent updates without exposing unpersisted replacements", async () => {
  const f = fixture(); let release!: () => void;
  f.gate(new Promise<void>(resolve => { release = resolve; }));
  const one = f.manager.update({ values: { SKYWALKING_MCP_URL: "https://first.example.com" } });
  const two = f.manager.update({ values: { SKYWALKING_MCP_USERNAME: "second" } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.replacements.length, 0); assert.equal(f.manager.getSnapshot().revision, 0);
  release();
  const results = await Promise.all([one, two]);
  assert.deepEqual(results.map(r => r.snapshot.revision), [1, 2]);
  assert.equal(f.environment.SKYWALKING_MCP_URL, "https://first.example.com");
  assert.equal(f.environment.SKYWALKING_MCP_USERNAME, "second");
  assert.equal(f.writes.length, 2); assert.equal(f.replacements.length, 2);
});
