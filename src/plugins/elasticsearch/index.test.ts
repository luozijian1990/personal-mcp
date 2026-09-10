import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import { createHttpApp } from "../../core/http-app.js";
import { startHttpServer } from "../../core/start-http-server.js";
import type { ElasticsearchReadClient, JsonRecord } from "./client.js";
import type { ElasticsearchPluginConfig } from "./config.js";
import { createElasticsearchPlugin } from "./index.js";

test("Elasticsearch MCP lists nine read-only Tools and executes structured search", async (context) => {
  const requests: JsonRecord[] = [];
  const client = fakeClient({ search: async (input) => {
    requests.push(input.body);
    return {
      took: 4,
      timed_out: false,
      hits: { total: { value: 1, relation: "eq" }, hits: [{ _index: "logs-1", _id: "a", _source: { privateMarker: "do-not-log" } }] },
    };
  } });
  const logFields: unknown[] = [];
  const plugin = createElasticsearchPlugin({ config: config(), client });
  const app = createHttpApp({
    host: "127.0.0.1",
    serviceName: "elasticsearch-test",
    mounts: [{ path: "/elasticsearch/mcp", plugin }],
    logger: {
      info: (_event, fields) => { logFields.push(fields); },
      error: (_event, fields) => { logFields.push(fields); },
    },
  });
  const runtime = await startHttpServer(app, "127.0.0.1", 0);
  context.after(async () => { runtime.server.close(); await once(runtime.server, "close"); });

  const listed = await mcpCall(runtime.url, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  for (const name of [
    "elasticsearch_get_capabilities",
    "elasticsearch_cluster_health",
    "elasticsearch_list_indices",
    "elasticsearch_list_shards",
    "elasticsearch_allocation_explain",
    "elasticsearch_get_mapping",
    "elasticsearch_field_caps",
    "elasticsearch_sample_documents",
    "elasticsearch_search",
  ]) assert.match(listed, new RegExp(name));
  assert.equal((listed.match(/readOnlyHint/g) ?? []).length, 9);

  const searched = await mcpCall(runtime.url, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "elasticsearch_search",
      arguments: {
        index: "logs-*",
        query: { term: { privateMarker: "do-not-log" } },
        source: ["privateMarker"],
        size: 1,
      },
    },
  });
  assert.match(searched, /structuredContent/u);
  assert.match(searched, /do-not-log/u);
  assert.equal(requests[0]?.timeout, "10000ms");
  assert.doesNotMatch(JSON.stringify(logFields), /do-not-log/u);

  const mapping = await mcpCall(runtime.url, {
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "elasticsearch_get_mapping", arguments: { index: "logs-*" } },
  });
  assert.match(mapping, /matchedFields/u);
  assert.doesNotMatch(mapping, /"isError":true/u);
  const fieldCaps = await mcpCall(runtime.url, {
    jsonrpc: "2.0", id: 4, method: "tools/call",
    params: { name: "elasticsearch_field_caps", arguments: { index: "logs-*" } },
  });
  assert.match(fieldCaps, /matchedFields/u);
  assert.doesNotMatch(fieldCaps, /"isError":true/u);

  for (const [id, name, args] of [
    [5, "elasticsearch_get_capabilities", {}],
    [6, "elasticsearch_cluster_health", {}],
    [7, "elasticsearch_list_indices", {}],
    [8, "elasticsearch_list_shards", {}],
    [9, "elasticsearch_allocation_explain", {}],
    [10, "elasticsearch_sample_documents", { index: "logs-*", size: 1 }],
  ] as const) {
    const response = await mcpCall(runtime.url, {
      jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args },
    });
    assert.doesNotMatch(response, /"isError":true/u, `${name} should satisfy its output schema`);
  }
});

test("Elasticsearch Health maps version and cluster colors without hiding unsupported versions", async () => {
  for (const [status, expected] of [["green", "healthy"], ["yellow", "degraded"], ["red", "unhealthy"]] as const) {
    const plugin = createElasticsearchPlugin({ config: config(), client: fakeClient({
      getClusterHealth: async () => ({ status }),
    }) });
    assert.equal((await plugin.checkHealth?.(AbortSignal.timeout(1_000)))?.state, expected);
  }
  const unsupported = createElasticsearchPlugin({ config: config(), client: fakeClient({
    getRoot: async () => ({ version: { number: "8.0.0" } }),
  }) });
  const result = await unsupported.checkHealth?.(AbortSignal.timeout(1_000));
  assert.equal(result?.state, "unhealthy");
  assert.match(result?.message ?? "", /Elasticsearch 7 is required/u);
  const unconfigured = createElasticsearchPlugin({ config: config({ url: "" }) });
  assert.equal((await unconfigured.checkHealth?.(AbortSignal.timeout(1_000)))?.state, "unconfigured");
});

async function mcpCall(base: URL, payload: object): Promise<string> {
  const response = await fetch(new URL("/elasticsearch/mcp", base), {
    method: "POST",
    headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal(response.status, 200);
  return await response.text();
}

function fakeClient(overrides: Partial<ElasticsearchReadClient>): ElasticsearchReadClient {
  return {
    getRoot: async () => ({ version: { number: "7.10.0" } }),
    getClusterHealth: async () => ({ status: "green" }),
    listIndices: async () => [],
    listShards: async () => [],
    explainAllocation: async () => ({}),
    getMapping: async () => ({}),
    getFieldCaps: async () => ({ fields: {} }),
    search: async () => ({ took: 0, timed_out: false, hits: { total: { value: 0, relation: "eq" }, hits: [] } }),
    ...overrides,
  };
}

function config(overrides: Partial<ElasticsearchPluginConfig> = {}): ElasticsearchPluginConfig {
  return {
    url: "http://127.0.0.1:9200",
    username: "",
    password: "",
    requestTimeoutMs: 10_000,
    maxHits: 100,
    maxResponseBytes: 1024 * 1024,
    ...overrides,
  };
}
