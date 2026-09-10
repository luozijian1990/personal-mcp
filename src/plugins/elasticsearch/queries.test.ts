import assert from "node:assert/strict";
import test from "node:test";

import { toolStructuredResult } from "../../core/tool-result.js";
import type { ElasticsearchReadClient, JsonRecord } from "./client.js";
import type { ElasticsearchPluginConfig } from "./config.js";
import {
  explainAllocation,
  getCapabilities,
  getFieldCaps,
  getMapping,
  listIndices,
  listShards,
  sampleDocuments,
  search,
} from "./queries.js";

test("capabilities accept Elasticsearch 7 and explicitly disable ES|QL", async () => {
  const supported = await getCapabilities(fakeClient({
    getRoot: async () => ({ version: { number: "7.10.0", build_flavor: "default" }, tagline: "You Know, for Search" }),
  }));
  assert.deepEqual(supported, {
    version: "7.10.0",
    distribution: "elasticsearch",
    supported: true,
    queryDsl: true,
    esql: false,
    message: "Elasticsearch 7 is supported; ES|QL is unavailable in Elasticsearch 7.",
  });
  const unsupported = await getCapabilities(fakeClient({
    getRoot: async () => ({ version: { number: "8.19.0" } }),
  }));
  assert.equal(unsupported.supported, false);
});

test("index and shard lists are filtered, normalized and bounded", async () => {
  const client = fakeClient({
    listIndices: async () => [
      { index: "logs-b", health: "yellow", status: "open", pri: "2", rep: "1", "docs.count": "20", "store.size": "200" },
      { index: "logs-a", health: "green", status: "open", pri: "1", rep: "1", "docs.count": "10", "store.size": "100" },
    ],
    listShards: async () => [
      { index: "logs-a", shard: "0", prirep: "p", state: "STARTED", node: "node-a", docs: "10", store: "100", "unassigned.reason": null },
      { index: "logs-a", shard: "0", prirep: "r", state: "UNASSIGNED", node: null, docs: null, store: null, "unassigned.reason": "NODE_LEFT" },
    ],
  });
  const indices = await listIndices(client, config(), { health: "green", limit: 50 });
  assert.equal(indices.count, 1);
  assert.equal((indices.indices as JsonRecord[])[0]?.index, "logs-a");
  const shards = await listShards(client, config(), { state: "UNASSIGNED", limit: 50 });
  assert.deepEqual((shards.shards as JsonRecord[])[0], {
    index: "logs-a", shard: 0, primary: false, state: "UNASSIGNED", node: null,
    docs: null, storeBytes: null, unassignedReason: "NODE_LEFT",
  });
});

test("item-list truncation metadata remains inside the serialized Tool result budget", async () => {
  const maximumBytes = 16_384;
  const client = fakeClient({
    listIndices: async () => Array.from({ length: 100 }, (_, index) => ({
      index: `logs-${String(index).padStart(3, "0")}-${"x".repeat(180)}`,
      health: "green", status: "open", pri: "1", rep: "1", "docs.count": "1", "store.size": "100",
    })),
  });
  const result = await listIndices(client, config({ maxResponseBytes: maximumBytes }), { limit: 100 });
  assert.equal(result.status, "truncated");
  assert.ok(Buffer.byteLength(JSON.stringify(toolStructuredResult(result)), "utf8") <= maximumBytes);
});

test("allocation explain sends only an exact shard tuple or an empty selector", async () => {
  const calls: JsonRecord[] = [];
  const client = fakeClient({ explainAllocation: async (input) => { calls.push(input); return { index: "logs", shard: 0, primary: false, current_state: "unassigned", can_allocate: "no" }; } });
  const result = await explainAllocation(client, config(), { index: "logs", shard: 0, primary: false });
  assert.equal(result.can_allocate, "no");
  await explainAllocation(client, config(), {});
  assert.deepEqual(calls, [{ index: "logs", shard: 0, primary: false }, {}]);
});

test("allocation explain fits the complete serialized Tool result", async () => {
  const maximumBytes = 16_384;
  const client = fakeClient({ explainAllocation: async () => ({
    index: "logs", shard: 0, primary: false, current_state: "unassigned", can_allocate: "no",
    node_allocation_decisions: Array.from({ length: 50 }, (_, index) => ({ node_id: String(index), explanation: "x".repeat(1_000) })),
  }) });
  const result = await explainAllocation(client, config({ maxResponseBytes: maximumBytes }), {});
  assert.equal(Object.hasOwn(result, "node_allocation_decisions"), false);
  assert.ok(Buffer.byteLength(JSON.stringify(toolStructuredResult(result)), "utf8") <= maximumBytes);
});

test("Elasticsearch 7 typeless and typed mappings flatten nested and multi-fields", async () => {
  const client = fakeClient({
    getMapping: async () => ({
      "logs-1": { mappings: { properties: {
        message: { type: "text", fields: { keyword: { type: "keyword" } } },
        user: { properties: { id: { type: "keyword" } } },
      } } },
      "legacy-1": { mappings: { _doc: { properties: { timestamp: { type: "date" } } } } },
    }),
  });
  const result = await getMapping(client, config(), { index: "*", maxFields: 20 });
  assert.deepEqual((result.fields as JsonRecord[]).map((field) => field.field), ["timestamp", "message", "message.keyword", "user", "user.id"]);
});

test("field capabilities expose cross-index type conflicts", async () => {
  const client = fakeClient({
    getFieldCaps: async () => ({ fields: {
      status: {
        integer: { searchable: true, aggregatable: true, indices: ["logs-1"] },
        keyword: { searchable: true, aggregatable: true, indices: ["logs-2"] },
      },
    } }),
  });
  const result = await getFieldCaps(client, config(), { index: "logs-*", fields: ["status"], maxFields: 20 });
  assert.equal((result.fields as JsonRecord[])[0]?.conflict, true);
  assert.deepEqual(((result.fields as JsonRecord[])[0]?.types as JsonRecord[]).map((entry) => entry.type), ["integer", "keyword"]);
});

test("sample documents construct a bounded recent query", async () => {
  const requests: Array<{ index: string; body: JsonRecord }> = [];
  const client = fakeClient({ search: async (input) => {
    requests.push(input);
    return { took: 2, timed_out: false, hits: { hits: [{ _index: "logs", _id: "1", _source: { status: 502 } }] } };
  } });
  const result = await sampleDocuments(client, config(), {
    index: "logs-*", size: 5, timeField: "@timestamp", timeRange: { gte: "now-30m" }, source: ["@timestamp", "status"],
  });
  assert.equal((result.hits as JsonRecord[]).length, 1);
  assert.deepEqual(requests[0]?.body, {
    query: { range: { "@timestamp": { gte: "now-30m" } } },
    size: 5,
    track_total_hits: false,
    _source: ["@timestamp", "status"],
    sort: [{ "@timestamp": "desc" }],
    timeout: "10000ms",
  });
  await assert.rejects(
    sampleDocuments(client, config(), { index: "logs-*", size: 1, timeField: "@timestamp" }),
    /provided together/,
  );
});

test("search rejects excess hits and explicitly truncates large sources", async () => {
  const client = fakeClient({ search: async () => ({
    took: 3,
    timed_out: false,
    hits: {
      total: { value: 2, relation: "eq" },
      hits: [
        { _index: "logs", _id: "1", _source: { message: "a".repeat(12_000) } },
        { _index: "logs", _id: "2", _source: { message: "b".repeat(12_000) } },
      ],
    },
    aggregations: { by_status: { buckets: [{ key: 200, doc_count: 10 }] } },
  }) });
  await assert.rejects(search(client, config({ maxHits: 10 }), { index: "logs-*", query: { match_all: {} }, size: 11 }), /exceeds/);
  const result = await search(client, config({ maxResponseBytes: 16_384 }), { index: "logs-*", query: { match_all: {} }, size: 2, aggregations: { by_status: { terms: { field: "status" } } } });
  assert.equal(result.status, "truncated");
  assert.ok((result.hits as JsonRecord[]).length < 2);
  assert.equal((result.truncation as JsonRecord).omittedHits, 2 - (result.hits as JsonRecord[]).length);
});

test("search explicitly omits an aggregation section that exceeds the output budget", async () => {
  const client = fakeClient({ search: async () => ({
    took: 1,
    timed_out: false,
    hits: { total: { value: 0, relation: "eq" }, hits: [] },
    aggregations: { large: { buckets: [{ key: "x".repeat(20_000), doc_count: 1 }] } },
  }) });
  const result = await search(client, config({ maxResponseBytes: 16_384 }), {
    index: "logs-*", query: { match_all: {} }, size: 0, aggregations: { large: { terms: { field: "value" } } },
  });
  assert.equal(result.status, "truncated");
  assert.equal(Object.hasOwn(result, "aggregations"), false);
  assert.equal((result.truncation as JsonRecord).aggregationsOmitted, true);
});

test("search keeps truncation metadata inside the configured serialized Tool result budget", async () => {
  const maximumBytes = 16_384;
  const hits = Array.from({ length: 17 }, (_, index) => ({
    _index: "logs", _id: String(index), _source: { message: "x".repeat(960) },
  }));
  const client = fakeClient({ search: async () => ({
    took: 1, timed_out: false, hits: { total: { value: hits.length, relation: "eq" }, hits },
  }) });
  const result = await search(client, config({ maxResponseBytes: maximumBytes }), {
    index: "logs-*", query: { match_all: {} }, size: hits.length,
  });
  assert.equal(result.status, "truncated");
  assert.ok(Buffer.byteLength(JSON.stringify(toolStructuredResult(result)), "utf8") <= maximumBytes);
});

test("search budgets both structuredContent and rendered text, not only the domain object", async () => {
  const maximumBytes = 16_384;
  const client = fakeClient({ search: async () => ({
    took: 1,
    timed_out: false,
    hits: { total: { value: 1, relation: "eq" }, hits: [{ _index: "logs", _id: "1", _source: { message: "x".repeat(10_000) } }] },
  }) });
  const result = await search(client, config({ maxResponseBytes: maximumBytes }), {
    index: "logs-*", query: { match_all: {} }, size: 1,
  });
  assert.ok(Buffer.byteLength(JSON.stringify(toolStructuredResult(result)), "utf8") <= maximumBytes);
});

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
