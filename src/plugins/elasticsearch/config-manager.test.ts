import assert from "node:assert/strict";
import test from "node:test";

import { runtimeProfileConfigKey } from "../../core/plugin-profile.js";
import { initializePluginCatalog } from "../../core/plugin-catalog.js";
import type { RuntimeConfigValues } from "../../core/runtime-config.js";
import { createElasticsearchConfigManager } from "./config-manager.js";
import { validateElasticsearchConfig, validateElasticsearchUrl } from "./config.js";
import { createElasticsearchProfileDefinition, ELASTICSEARCH_PLUGIN_DEFINITION } from "./definition.js";

test("Elasticsearch configuration validates URL, credentials and limits", () => {
  assert.doesNotThrow(() => validateElasticsearchUrl("https://example.com/es"));
  assert.throws(() => validateElasticsearchUrl("ftp://example.com"), /http or https/);
  assert.throws(() => validateElasticsearchUrl("https://user:secret@example.com"), /embedded credentials/);
  assert.throws(() => validateElasticsearchUrl("https://example.com?token=secret"), /query string or fragment/);
  assert.throws(() => validateElasticsearchConfig(config({ username: "reader", password: "" })), /configured together/);
  assert.throws(() => validateElasticsearchConfig(config({ requestTimeoutMs: 99 })), /between 100 and 120000/);
  assert.throws(() => validateElasticsearchConfig(config({ maxHits: 1_001 })), /between 1 and 1000/);
  assert.throws(() => validateElasticsearchConfig(config({ maxResponseBytes: 1_000 })), /between 16384 and 4194304/);
});

test("Elasticsearch password uses Framework Secret retention, replacement and clear semantics", async () => {
  let environment: Record<string, string> = {
    ELASTICSEARCH_MCP_URL: "https://old.example.com",
    ELASTICSEARCH_MCP_USERNAME: "reader",
    ELASTICSEARCH_MCP_PASSWORD: "old-secret",
    ELASTICSEARCH_MCP_REQUEST_TIMEOUT: "10000",
    ELASTICSEARCH_MCP_MAX_HITS: "100",
    ELASTICSEARCH_MCP_MAX_RESPONSE_BYTES: "1048576",
  };
  const writes: Record<string, string>[] = [];
  const manager = createElasticsearchConfigManager({
    environment: () => ({ ...environment }),
    update: async (values) => {
      writes.push({ ...values });
      environment = { ...environment, ...values };
    },
  });
  const initial = manager.getSnapshot();
  assert.equal(Object.hasOwn(initial.values, "ELASTICSEARCH_MCP_PASSWORD"), false);
  assert.deepEqual(initial.secretStates, { ELASTICSEARCH_MCP_PASSWORD: { configured: true } });

  await manager.update({ values: { ELASTICSEARCH_MCP_URL: "https://new.example.com", ELASTICSEARCH_MCP_PASSWORD: "" } });
  assert.equal(writes[0]?.ELASTICSEARCH_MCP_PASSWORD, "old-secret");
  await manager.update({ values: { ELASTICSEARCH_MCP_PASSWORD: "new-secret" } });
  assert.equal(writes[1]?.ELASTICSEARCH_MCP_PASSWORD, "new-secret");
  const cleared = await manager.update({
    values: { ELASTICSEARCH_MCP_USERNAME: "" },
    clearSecrets: ["ELASTICSEARCH_MCP_PASSWORD"],
  });
  assert.equal(writes[2]?.ELASTICSEARCH_MCP_PASSWORD, "");
  assert.deepEqual(cleared.snapshot.secretStates, { ELASTICSEARCH_MCP_PASSWORD: { configured: false } });
});

test("named Elasticsearch Profile values do not inherit default credentials", () => {
  const environment = {
    ELASTICSEARCH_MCP_URL: "https://default.example.com",
    ELASTICSEARCH_MCP_USERNAME: "default-user",
    ELASTICSEARCH_MCP_PASSWORD: "default-secret",
    [runtimeProfileConfigKey("elasticsearch", "prod", "ELASTICSEARCH_MCP_URL")]: "https://prod.example.com",
  };
  const store = { environment: () => environment, update: async () => undefined };
  const defaultManager = createElasticsearchConfigManager(store);
  const prodManager = createElasticsearchConfigManager(store, "prod");
  assert.equal(defaultManager.getSnapshot().values.ELASTICSEARCH_MCP_URL, "https://default.example.com");
  assert.equal(prodManager.getSnapshot().values.ELASTICSEARCH_MCP_URL, "https://prod.example.com");
  assert.equal(prodManager.getSnapshot().values.ELASTICSEARCH_MCP_USERNAME, "");
  assert.deepEqual(prodManager.getSnapshot().secretStates, { ELASTICSEARCH_MCP_PASSWORD: { configured: false } });
});

test("Elasticsearch Profile definitions create isolated default, prod and uat managers", () => {
  const values: Record<string, string> = {
    ELASTICSEARCH_MCP_URL: "https://default.example.com",
    ELASTICSEARCH_MCP_REQUEST_TIMEOUT: "10000",
    ELASTICSEARCH_MCP_MAX_HITS: "100",
    ELASTICSEARCH_MCP_MAX_RESPONSE_BYTES: "1048576",
  };
  for (const profileId of ["prod", "uat"]) {
    values[runtimeProfileConfigKey("elasticsearch", profileId, "ELASTICSEARCH_MCP_URL")] = `https://${profileId}.example.com`;
    values[runtimeProfileConfigKey("elasticsearch", profileId, "ELASTICSEARCH_MCP_REQUEST_TIMEOUT")] = "10000";
    values[runtimeProfileConfigKey("elasticsearch", profileId, "ELASTICSEARCH_MCP_MAX_HITS")] = "100";
    values[runtimeProfileConfigKey("elasticsearch", profileId, "ELASTICSEARCH_MCP_MAX_RESPONSE_BYTES")] = "1048576";
  }
  const store = {
    environment: () => ({ ...values }),
    update: async (next: RuntimeConfigValues) => { Object.assign(values, next); },
  };
  const catalog = initializePluginCatalog(
    store,
    [ELASTICSEARCH_PLUGIN_DEFINITION],
    [createElasticsearchProfileDefinition("prod"), createElasticsearchProfileDefinition("uat")],
  );
  assert.deepEqual(catalog.profiles.map(({ profileId }) => profileId), ["default", "prod", "uat"]);
  assert.deepEqual(catalog.configManagers.map((manager) => ({
    profileId: manager.profileId,
    url: manager.getSnapshot().values.ELASTICSEARCH_MCP_URL,
  })), [
    { profileId: "default", url: "https://default.example.com" },
    { profileId: "prod", url: "https://prod.example.com" },
    { profileId: "uat", url: "https://uat.example.com" },
  ]);
});

function config(overrides: Partial<ReturnType<typeof baseConfig>> = {}) {
  return { ...baseConfig(), ...overrides };
}

function baseConfig() {
  return {
    url: "https://example.com",
    username: "",
    password: "",
    requestTimeoutMs: 10_000,
    maxHits: 100,
    maxResponseBytes: 1024 * 1024,
  };
}
