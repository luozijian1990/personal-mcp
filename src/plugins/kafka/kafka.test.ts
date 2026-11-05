import assert from "node:assert/strict";
import test from "node:test";
import net from "node:net";
import tls from "node:tls";
import { once } from "node:events";
import { loadKafkaConfig, validateKafkaConfig, parseBroker } from "./config.js";
import { createKafkaConfigManager } from "./config-manager.js";
import { createKafkaReader, frameGuard, type KafkaReader } from "./client.js";
import { assertReadApi, decodeAssignment, describeGroupsV4, flexibleListGroups, QueryError, Reader, safeError, type ReadApi } from "./protocol.js";
import { KafkaQueries, calculateLag } from "./queries.js";
import { createKafkaPlugin, enforceResponse } from "./index.js";
import { KAFKA_PLUGIN_DEFINITION } from "./definition.js";
import { startStandalonePlugin } from "../../core/plugin-runtime.js";
import { lagOutput } from "./output-schemas.js";

const config = loadKafkaConfig({ KAFKA_BROKERS: "127.0.0.1:9092" });
const i16 = (v: number) => { const b = Buffer.alloc(2); b.writeInt16BE(v); return b; };
const i32 = (v: number) => { const b = Buffer.alloc(4); b.writeInt32BE(v); return b; };
const i64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigInt64BE(v); return b; };
const str = (v: string | null) => v === null ? i16(-1) : Buffer.concat([i16(Buffer.byteLength(v)), Buffer.from(v)]);
const bytes = (v: Buffer) => Buffer.concat([i32(v.length), v]);
const arr = (items: Buffer[]) => Buffer.concat([i32(items.length), ...items]);
const uv = (v: number): Buffer => { const result = []; do { let b = v & 127; v = Math.floor(v / 128); if (v) b |= 128; result.push(b); } while (v); return Buffer.from(result); };
const compact = (s: string) => Buffer.concat([uv(Buffer.byteLength(s) + 1), Buffer.from(s)]);
const assignment = (parts = [0], version = 3) => Buffer.concat([i16(version), arr([Buffer.concat([str("orders"), arr(parts.map(i32))])]), i32(-1)]);
const subscription = Buffer.concat([i16(0), arr([str("orders")]), i32(-1)]);

test("configuration lifecycle validates fields, preserves/clears secrets, and rejects invalid updates atomically", async () => {
  let env: Record<string, string> = { KAFKA_BROKERS: "broker.example:9092", KAFKA_SASL_MECHANISM: "plain", KAFKA_USERNAME: "reader", KAFKA_PASSWORD: "old-private" }; let fail = false;
  const manager = createKafkaConfigManager({ environment: () => env, update: async values => { if (fail) throw new Error("persist failure"); env = { ...env, ...values }; } });
  assert.equal(manager.getSnapshot().secretStates?.KAFKA_PASSWORD?.configured, true);
  assert.doesNotMatch(JSON.stringify(manager.getSnapshot()), /old-private/);
  await manager.update({ values: { KAFKA_PASSWORD: "", KAFKA_TIMEOUT_MS: 12000 } }); assert.equal(env.KAFKA_PASSWORD, "old-private");
  await manager.update({ values: { KAFKA_PASSWORD: "new-private" } }); assert.equal(env.KAFKA_PASSWORD, "new-private");
  const revision = manager.getSnapshot().revision;
  for (const values of [{ KAFKA_TIMEOUT_MS: 30001 }, { KAFKA_TLS: "false" }, { KAFKA_BROKERS: "http://host:9092" }, { KAFKA_SASL_MECHANISM: "oauth" }, { UNKNOWN: 1 }, { KAFKA_CA: "bad" }]) await assert.rejects(manager.update({ values }));
  assert.equal(manager.getSnapshot().revision, revision);
  fail = true; await assert.rejects(manager.update({ values: { KAFKA_TIMEOUT_MS: 1000 } })); assert.equal(env.KAFKA_TIMEOUT_MS, "12000");
  fail = false;
  await assert.rejects(manager.update({ values: {}, clearSecrets: ["KAFKA_PASSWORD"] }));
  await manager.update({ values: { KAFKA_SASL_MECHANISM: "none", KAFKA_USERNAME: "" }, clearSecrets: ["KAFKA_PASSWORD"] }); assert.equal(env.KAFKA_PASSWORD, "");
  assert.deepEqual(parseBroker("[::1]:9092"), { host: "::1", port: 9092 });
  for (const mechanism of ["plain", "scram-sha-256", "scram-sha-512"] as const) validateKafkaConfig({ ...config, mechanism, username: "u", password: "p" });
  assert.throws(() => validateKafkaConfig({ ...config, tls: true, ca: "bad" }), /PEM/);
});

test("only fixed read APIs are accepted; offsets remain int64 exact and unknowns are not zero", () => {
  for (const name of ["Produce", "OffsetCommit", "JoinGroup", "CreateTopics", "DeleteTopics", "AlterConfigs", "__proto__"]) assert.throws(() => assertReadApi(name), /allowlist/);
  assertReadApi("OffsetFetch");
  assert.deepEqual(calculateLag("0", "9007199254741003", "9007199254740993"), { lag: "10", status: "ok" });
  assert.deepEqual(calculateLag("10", "20", null), { lag: null, status: "no_committed_offset" });
  assert.deepEqual(calculateLag("10", "20", "5"), { lag: "15", status: "offset_before_start" });
  assert.deepEqual(calculateLag("10", "20", "30"), { lag: "-10", status: "offset_after_end" });
  assert.equal(calculateLag("30", "20", "10").status, "inconsistent_snapshot");
  assert.equal(calculateLag(null, "20", "10").lag, null);
  assert.doesNotMatch(JSON.stringify(safeError(Object.assign(new Error("private password"), { type: "SASL_AUTHENTICATION_FAILED" }))), /private password/);
  assert.throws(() => enforceResponse({ ...config, maxResponseBytes: 4096 }, { data: '"'.repeat(5000) }), /budget/);
});

test("bounded assignment and flexible protocol decoders accept supported versions and reject malformed bytes", async () => {
  for (const version of [0, 1, 2, 3]) assert.deepEqual(decodeAssignment(assignment([0, 2], version)), [{ topic: "orders", partitions: [0, 2] }]);
  assert.throws(() => decodeAssignment(assignment([0], 4)), /versions/);
  assert.throws(() => decodeAssignment(Buffer.concat([i16(0), i32(2147483647)])), /Malformed/);
  const body = Buffer.concat([Buffer.from([0]), i32(0), i16(0), uv(2), compact("g"), compact("consumer"), compact("Stable"), compact("classic"), Buffer.from([1, 4, 2, 10, 20, 0])]);
  const result = await flexibleListGroups(5).response.decode(body) as { groups: { groupType: string }[] };
  assert.equal(result.groups[0]?.groupType, "classic");
  await assert.rejects(flexibleListGroups(5).response.decode(body.subarray(0, -1)), /Malformed/);
  const guard = frameGuard(16); guard(i32(8).subarray(0, 2)); guard(Buffer.concat([i32(8).subarray(2), Buffer.alloc(8)]));
  assert.throws(() => guard(i32(17)), /budget/);
});

function fakeReader(overrides: Partial<Record<ReadApi, (args: Record<string, unknown>) => unknown>> = {}, modern = false) {
  const calls: { api: ReadApi; args: Record<string, unknown> }[] = [];
  const broker = { nodeId: 1, host: "broker.example", port: 9092, rack: "r1" };
  const metadata = { clusterId: "fixture", controllerId: 1, brokers: [broker], topicMetadata: [{ topic: "orders", isInternal: false, topicErrorCode: 0, partitionMetadata: [0, 1, 2].map(partitionId => ({ partitionId, partitionErrorCode: 0, leader: 1, replicas: [1, 2], isr: [1], offlineReplicas: [2] })) }] };
  const reader: KafkaReader = {
    startedAt: new Date().toISOString(), close() {}, bootstrap: async () => broker,
    versions: async () => ({ 16: { minVersion: 0, maxVersion: modern ? 5 : 4 } }),
    read: async (_b, api, args = {}) => {
      const a = args as Record<string, unknown>; calls.push({ api, args: a }); if (overrides[api]) return overrides[api]!(a);
      switch (api) {
        case "Metadata": return metadata;
        case "FindCoordinator": return { errorCode: 0, coordinator: broker };
        case "ListGroups": return { errorCode: 0, groups: [{ groupId: "g", protocolType: "consumer", groupType: "classic", groupState: "Stable" }] };
        case "DescribeGroups": return { groups: [{ errorCode: 0, groupId: "g", state: "Stable", protocolType: "consumer", protocol: "range", members: [{ memberId: "m", groupInstanceId: "static-1", clientId: "c", clientHost: "h", memberMetadata: subscription, memberAssignment: assignment() }] }] };
        case "OffsetFetch": return { errorCode: 0, responses: [{ topic: "orders", partitions: [{ partition: 0, offset: "9007199254740993", errorCode: 0 }, { partition: 1, offset: "-1", errorCode: 0 }] }] };
        case "ListOffsets": {
          const topics = a.topics as { topic: string; partitions: { partition: number; timestamp: number }[] }[];
          return { responses: topics.map(t => ({ topic: t.topic, partitions: t.partitions.map(p => ({ partition: p.partition, errorCode: p.partition === 2 ? 29 : 0, offset: p.timestamp === -2 ? "0" : "9007199254741003" })) })) };
        }
        case "DescribeConfigs": return { resources: [{ errorCode: 0, resourceName: "orders", configEntries: [{ configName: "secret", configValue: "must-never-appear", isSensitive: true, readOnly: false, configSource: 1 }] }] };
      }
    },
  };
  return { reader, calls, metadata };
}
async function queries(reader: KafkaReader, c = config) { const q = new KafkaQueries(c, reader); await q.initialize(); return q; }

test("lag joins metadata, commitments and assignments; partial partition errors never erase healthy evidence", async () => {
  const f = fakeReader(); const q = await queries(f.reader);
  const result = lagOutput.parse(await q.lag({ groupId: "g", isolationLevel: "read_uncommitted" }));
  assert.equal(result.complete, false);
  assert.equal(result.data.partitions.length, 3);
  assert.equal(result.data.partitions[0]?.lag, "10"); assert.equal(result.data.partitions[0]?.consumers[0]?.memberId, "m");
  assert.equal(result.data.partitions[1]?.status, "no_committed_offset"); assert.equal(result.data.partitions[1]?.assignmentStatus, "unassigned");
  assert.equal(result.data.partitions[2]?.status, "query_error");
  assert.equal(result.data.summary.validPartitionsLag, "10"); assert.equal(result.data.summary.fullSelectedScopeLag, null);
  const scoped = fakeReader(); const scopedQ = await queries(scoped.reader);
  const s = lagOutput.parse(await scopedQ.lag({ groupId: "g", topic: "orders", partitions: [0], isolationLevel: "read_committed" }));
  assert.equal(s.data.partitions.length, 1);
  assert.deepEqual(scoped.calls.find(c => c.api === "OffsetFetch")?.args.topics, [{ topic: "orders", partitions: [{ partition: 0 }] }]);
  assert.ok(scoped.calls.filter(c => c.api === "ListOffsets").every(c => c.args.isolationLevel === 1));
});

test("lag oversize scope fails before range queries; unsupported modern group types fail before offsets", async () => {
  const f = fakeReader(); const q = await queries(f.reader, { ...config, maxPartitions: 2 });
  await assert.rejects(q.lag({ groupId: "g", isolationLevel: "read_uncommitted" }), /Selected 3/);
  assert.equal(f.calls.filter(c => c.api === "ListOffsets").length, 0);
  const modern = fakeReader({ ListGroups: () => ({ errorCode: 0, groups: [{ groupId: "g", protocolType: "consumer", groupType: "consumer" }] }) }, true);
  await assert.rejects((await queries(modern.reader)).lag({ groupId: "g", isolationLevel: "read_uncommitted" }), /Only classic/);
  assert.equal(modern.calls.filter(c => c.api === "OffsetFetch").length, 0);
});

test("membership failures retain lag; config failures retain structure; exact topic match and secret protection", async () => {
  const f = fakeReader({ DescribeGroups: () => { throw new QueryError("DENIED", "Denied"); } });
  const result = lagOutput.parse(await (await queries(f.reader)).lag({ groupId: "g", topic: "orders", partitions: [0], isolationLevel: "read_uncommitted" }));
  assert.equal(result.data.partitions[0]?.lag, "10"); assert.equal(result.data.partitions[0]?.assignmentStatus, "unknown"); assert.equal(result.complete, false);
  const denied = fakeReader({ DescribeConfigs: () => ({ resources: [{ errorCode: 29, resourceName: "orders", configEntries: [] }] }) });
  const topic = await (await queries(denied.reader)).describeTopic({ topic: "orders", includeAllConfigs: false });
  assert.equal(topic.complete, false); assert.equal(topic.data.partitions.length, 3); assert.equal(topic.data.configStatus, "unavailable");
  const plain = fakeReader(); const safe = await (await queries(plain.reader)).describeTopic({ topic: "orders", includeAllConfigs: true });
  assert.doesNotMatch(JSON.stringify(safe), /must-never-appear/);
  const wrong = await (await queries(fakeReader().reader)).describeTopic({ topic: "orders-other", includeAllConfigs: true }).catch(e => e);
  assert.ok(wrong instanceof QueryError);
});

interface WireRequest { api: number; version: number; body: Buffer; correlation: number }
async function mockBroker(context: { after: (fn: () => unknown) => void }, handle: (r: WireRequest, port: number) => Buffer | undefined, tlsOptions?: tls.TlsOptions) {
  const sockets = new Set<net.Socket>(); const requests: WireRequest[] = [];
  const listener = (socket: net.Socket) => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => {}); let pending = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 4 && pending.length >= pending.readInt32BE(0) + 4) {
        const n = pending.readInt32BE(0); const frame = pending.subarray(4, n + 4); pending = pending.subarray(n + 4);
        const api = frame.readInt16BE(0); const version = frame.readInt16BE(2); const correlation = frame.readInt32BE(4); const clientLength = frame.readInt16BE(8);
        const r = { api, version, correlation, body: frame.subarray(10 + clientLength) }; requests.push(r);
        const response = handle(r, (backend.address() as net.AddressInfo).port);
        if (response) { const payload = Buffer.concat([i32(correlation), response]); socket.write(Buffer.concat([i32(payload.length), payload])); }
      }
    });
  };
  const backend = tlsOptions ? tls.createServer(tlsOptions, listener) : net.createServer(listener);
  backend.on("tlsClientError", () => {});
  backend.listen(0, "127.0.0.1"); await once(backend, "listening");
  context.after(async () => { for (const s of sockets) s.destroy(); await new Promise<void>(resolve => backend.close(() => resolve())); });
  return { port: (backend.address() as net.AddressInfo).port, requests, sockets };
}
const versions = (modern = true) => Buffer.concat([i16(0), arr([[2, 3], [3, 6], [9, 4], [10, 2], [15, 4], [16, modern ? 5 : 4], [18, 2], [32, 2]].map(([key, max]) => Buffer.concat([i16(key!), i16(0), i16(max!)]))), i32(0)]);
function wireHandler(r: WireRequest, port: number): Buffer {
  if (r.api === 18) return versions();
  if (r.api === 3) {
    assert.equal(r.body.at(-1), 0, "metadata MUST disable automatic topic creation");
    const all = r.body.readInt32BE(0) === -1; const selected = r.body.readInt32BE(0) > 0;
    const topic = (name: string, internal: boolean) => Buffer.concat([i16(0), str(name), Buffer.from([Number(internal)]), arr([Buffer.concat([i16(0), i32(0), i32(1), arr([i32(1)]), arr([i32(1)]), arr([])])])]);
    return Buffer.concat([i32(0), arr([Buffer.concat([i32(1), str("127.0.0.1"), i32(port), str("rack-a")])]), str("wire-fixture"), i32(1), arr(all ? [topic("orders", false), topic("__internal", true)] : selected ? [topic("orders", false)] : [])]);
  }
  if (r.api === 10) return Buffer.concat([i32(0), i16(0), str(null), i32(1), str("127.0.0.1"), i32(port)]);
  if (r.api === 16) {
    assert.deepEqual(r.body, Buffer.from([0, 1, 1, 0]));
    return Buffer.concat([Buffer.from([0]), i32(0), i16(0), uv(2), compact("g"), compact("consumer"), compact("Stable"), compact("classic"), Buffer.from([0, 0])]);
  }
  if (r.api === 15) {
    assert.equal(r.version, 4);
    return Buffer.concat([i32(0), arr([Buffer.concat([i16(0), str("g"), str("Stable"), str("consumer"), str("range"), arr([Buffer.concat([str("m"), str("static-1"), str("c"), str("h"), bytes(subscription), bytes(assignment())])]), i32(-2147483648)])])]);
  }
  if (r.api === 9) return Buffer.concat([i32(0), arr([Buffer.concat([str("orders"), arr([Buffer.concat([i32(0), i64(9007199254740993n), str(null), i16(0)])])])]), i16(0)]);
  if (r.api === 2) {
    // replicaId, isolationLevel, topics, topic, partitions, partition, timestamp
    const d = new Reader(r.body); d.i32(); d.bytes(1); assert.equal(d.i32(), 1); assert.equal(d.string(), "orders"); assert.equal(d.i32(), 1); assert.equal(d.i32(), 0); const timestamp = d.bytes(8).readBigInt64BE();
    return Buffer.concat([i32(0), arr([Buffer.concat([str("orders"), arr([Buffer.concat([i32(0), i16(0), i64(-1n), i64(timestamp === -2n ? 0n : 9007199254741003n)])])])])]);
  }
  if (r.api === 32) {
    const entry = Buffer.concat([str("retention.ms"), str("604800000"), Buffer.from([0, 5, 0]), arr([])]);
    const resource = Buffer.concat([i16(0), str(null), Buffer.from([2]), str("orders"), arr([entry])]);
    return Buffer.concat([i32(0), arr([resource])]);
  }
  throw new Error(`Unexpected non-read request ${r.api}`);
}

test("real socket adapter and HTTP MCP expose exactly six readonly tools with correct wire evidence", async context => {
  const backend = await mockBroker(context, wireHandler); const logs: unknown[] = [];
  const runtime = await startStandalonePlugin(KAFKA_PLUGIN_DEFINITION, { port: 0, store: { environment: () => ({ KAFKA_BROKERS: `127.0.0.1:${backend.port}`, MCP_ENABLED_KAFKA: "true" }), update: async () => {} }, logger: { info(_e, f) { logs.push(f); }, error(_e, f) { logs.push(f); } } });
  context.after(async () => { runtime.server.closeAllConnections(); await new Promise<void>(resolve => runtime.server.close(() => resolve())); });
  async function rpc(method: string, params: object) {
    const response = await fetch(new URL("/kafka/mcp", runtime.url), { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const t = await response.text(); return JSON.parse(t.startsWith("{") ? t : t.split("\n").find(l => l.startsWith("data: "))!.slice(6));
  }
  const list = await rpc("tools/list", {}); assert.equal(list.result.tools.length, 6);
  assert.ok(list.result.tools.every((t: { annotations: { readOnlyHint: boolean }; outputSchema: unknown }) => t.annotations.readOnlyHint && t.outputSchema));
  for (const [name, args] of [["kafka_cluster_overview", {}], ["kafka_list_topics", { includeInternal: true }], ["kafka_describe_topic", { topic: "orders" }], ["kafka_list_groups", {}], ["kafka_describe_group", { groupId: "g" }], ["kafka_get_lag", { groupId: "g" }]] as const) {
    const result = (await rpc("tools/call", { name, arguments: args })).result;
    assert.equal(result.isError, false, JSON.stringify(result)); assert.equal(result.structuredContent.clusterId, "wire-fixture");
    const data = result.structuredContent.data;
    if (name === "kafka_cluster_overview") assert.equal(data.brokers[0].rack, "rack-a");
    if (name === "kafka_list_topics") assert.equal(data.topics.find((t: { name: string }) => t.name === "__internal").isInternal, true);
    if (name === "kafka_describe_topic") assert.equal(data.configs[0].source, "DEFAULT_CONFIG");
    if (name === "kafka_describe_group") assert.equal(data.members[0].groupInstanceId, "static-1");
    if (name === "kafka_get_lag") assert.equal(data.partitions[0].lag, "10");
  }
  const before = backend.requests.length;
  for (const args of [{}, { groupId: "g", partitions: [0] }, { groupId: "g", topic: "orders", partitions: [0, 0] }, { groupId: "g", command: "commit" }]) assert.equal((await rpc("tools/call", { name: "kafka_get_lag", arguments: args })).result.isError, true);
  assert.equal(backend.requests.length, before, "invalid inputs cannot touch Kafka");
  const unknown = await rpc("tools/call", { name: "kafka_commit", arguments: {} }); assert.ok(unknown.error || unknown.result.isError);
  assert.ok(backend.requests.every(r => [18, 2, 3, 9, 10, 15, 16, 32].includes(r.api)));
  for (const request of backend.requests.filter(r => r.api === 10)) {
    assert.equal(request.body.readInt16BE(0), 1, "FindCoordinator must encode the exact non-null group ID");
    assert.equal(request.body.subarray(2, 3).toString(), "g");
    assert.equal(request.body[3], 0, "Coordinator type must be GROUP");
  }
  assert.doesNotMatch(JSON.stringify(logs), /9007199254740993|static-1/);
});

test("total deadline and cancellation destroy sockets; stalled and oversized frames cannot hang queries", async context => {
  const backend = await mockBroker(context, r => r.api === 18 ? versions() : undefined);
  const c = { ...config, brokers: [`127.0.0.1:${backend.port}`], timeoutMs: 80 };
  const r = createKafkaReader(c);
  try { const b = await r.bootstrap(); await assert.rejects(r.read(b, "Metadata"), /time budget/); } finally { r.close(); }
  const controller = new AbortController(); const cancelled = createKafkaReader({ ...c, timeoutMs: 1000 }, controller.signal);
  try { const b = await cancelled.bootstrap(); const call = cancelled.read(b, "Metadata"); controller.abort(); await assert.rejects(call, /cancelled/); } finally { cancelled.close(); }
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(backend.sockets.size, 0);
  const oversized = await mockBroker(context, () => Buffer.alloc(8192));
  const huge = createKafkaReader({ ...config, brokers: [`127.0.0.1:${oversized.port}`], maxBrokerResponseBytes: 4096 });
  try { await assert.rejects(huge.bootstrap(), /frame budget/); } finally { huge.close(); }
});

test("unconfigured plugin is healthy neither by default nor by annotation", async () => {
  const plugin = createKafkaPlugin({ config: loadKafkaConfig({}) });
  assert.equal((await plugin.checkHealth!(new AbortController().signal)).state, "unconfigured");
  assert.ok(plugin.tools.every(t => t.risk === "read-only" && !t.requiresConfirmation && t.logging?.output === "metadata"));
  assert.equal(KAFKA_PLUGIN_DEFINITION.defaultPort, 3109);
});

test("TLS trust and hostname validation remain enabled, custom CA and SASL/PLAIN handshake work", async context => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "kafka-mcp-tls-")); context.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"), "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"], { stdio: "ignore" });
  const ca = readFileSync(join(dir, "cert.pem"), "utf8");
  const backend = await mockBroker(context, wireHandler, { key: readFileSync(join(dir, "key.pem")), cert: ca });
  const c = { ...config, brokers: [`localhost:${backend.port}`], tls: true, ca, timeoutMs: 1000 };
  const reader = createKafkaReader(c); try { const b = await reader.bootstrap(); assert.ok(await reader.read(b, "Metadata")); } finally { reader.close(); }
  const routed = createKafkaReader({ ...c, brokers: ["localhost:19092"], addressMap: { "localhost:19092": `127.0.0.1:${backend.port}` } });
  try { await routed.bootstrap(); } finally { routed.close(); }
  for (const invalid of [{ ...c, ca: "" }, { ...c, brokers: [`127.0.0.1:${backend.port}`] }, { ...c, brokers: ["127.0.0.1:19092"], addressMap: { "127.0.0.1:19092": `localhost:${backend.port}` } }]) {
    const r = createKafkaReader(invalid); try { await assert.rejects(r.bootstrap()); } finally { r.close(); }
  }
  let authenticated = false;
  const sasl = await mockBroker(context, (r, port) => {
    if (r.api === 18) return Buffer.concat([i16(0), arr([[3, 6], [17, 1], [18, 2], [36, 1]].map(([key, max]) => Buffer.concat([i16(key!), i16(0), i16(max!)]))), i32(0)]);
    if (r.api === 17) { assert.equal(new Reader(r.body).string(), "PLAIN"); return Buffer.concat([i16(0), arr([str("PLAIN")])]); }
    if (r.api === 36) { const d = new Reader(r.body); assert.equal(d.bytes(d.i32()).toString(), "\0reader\0private-password"); authenticated = true; return Buffer.concat([i16(0), str(null), bytes(Buffer.alloc(0)), i64(0n)]); }
    assert.equal(authenticated, true); return wireHandler(r, port);
  });
  const auth = createKafkaReader({ ...config, brokers: [`127.0.0.1:${sasl.port}`], mechanism: "plain", username: "reader", password: "private-password" });
  try { const b = await auth.bootstrap(); await auth.read(b, "Metadata"); assert.equal(authenticated, true); } finally { auth.close(); }
});

test("list filters precede truncation; empty lists and partial broker failures remain distinguishable", async () => {
  const f = fakeReader(); const metadata = { ...f.metadata, brokers: [...f.metadata.brokers, { nodeId: 2, host: "other", port: 9092 }] };
  const original = f.reader.read.bind(f.reader);
  f.reader.read = async (broker, api, args) => {
    if (api === "Metadata") return metadata;
    if (api === "ListGroups" && broker.nodeId === 2) throw new QueryError("BROKER_UNAVAILABLE", "Broker unavailable");
    return original(broker, api, args);
  };
  const out = await (await queries(f.reader)).listGroups({ nameFilter: "g", limit: 1 });
  assert.equal(out.complete, false); assert.equal(out.truncated, false); assert.equal(out.data.returnedCount, 1); assert.ok(out.errors.some(e => e.scope === "broker:2"));
  const noMatch = await (await queries(fakeReader().reader)).listTopics({ nameFilter: "absent", includeInternal: true, limit: 1 });
  assert.equal(noMatch.complete, true); assert.equal(noMatch.data.returnedCount, 0);
  const many = fakeReader({ ListGroups: () => ({ errorCode: 0, groups: ["z-other", "a-match", "b-match"].map(groupId => ({ groupId, protocolType: "consumer" })) }) });
  const page = await (await queries(many.reader)).listGroups({ nameFilter: "match", limit: 1 });
  assert.equal(page.data.groups[0]?.groupId, "a-match"); assert.equal(page.data.matchedVisibleCount, 2); assert.equal(page.truncated, true); assert.equal(page.complete, false);
});

test("metadata omissions and explicit OffsetFetch omissions are errors, never healthy empty/zero evidence", async () => {
  const f = fakeReader(); const original = f.reader.read.bind(f.reader);
  f.reader.read = async (broker, api, args) => api === "Metadata" && args && "topics" in args ? { ...f.metadata, topicMetadata: [] } : original(broker, api, args);
  const omitted = await (await queries(f.reader)).lag({ groupId: "g", isolationLevel: "read_uncommitted" });
  assert.equal(omitted.complete, false); assert.ok(omitted.errors.some(e => e.code === "MISSING_TOPIC"));
  const c = fakeReader({ OffsetFetch: () => ({ errorCode: 0, responses: [] }) });
  const lag = await (await queries(c.reader)).lag({ groupId: "g", topic: "orders", partitions: [0], isolationLevel: "read_uncommitted" });
  assert.equal(lag.data.partitions[0]?.status, "query_error"); assert.equal(lag.data.partitions[0]?.lag, null);
});

test("Kafka 2.8-era ListGroups v4 reports state without requiring new group types", async context => {
  const backend = await mockBroker(context, (r, port) => {
    if (r.api === 18) return versions(false);
    if (r.api === 16) {
      assert.equal(r.version, 4); assert.deepEqual(r.body, Buffer.from([0, 1, 0]));
      return Buffer.concat([Buffer.from([0]), i32(0), i16(0), uv(2), compact("g"), compact("consumer"), compact("Empty"), Buffer.from([0, 0])]);
    }
    return wireHandler(r, port);
  });
  const reader = createKafkaReader({ ...config, brokers: [`127.0.0.1:${backend.port}`] });
  try { const q = await queries(reader); const groups = await q.listGroups({ nameFilter: "", limit: 10 }); assert.equal(groups.data.groups[0]?.state, "Empty"); assert.equal(groups.data.groups[0]?.groupType, "classic"); } finally { reader.close(); }
});

test("both SCRAM mechanisms verify client proof and server signature over the socket adapter", async context => {
  const { createHash, createHmac, pbkdf2Sync } = await import("node:crypto");
  for (const mechanism of ["scram-sha-256", "scram-sha-512"] as const) {
    const hash = mechanism === "scram-sha-256" ? "sha256" : "sha512"; const length = hash === "sha256" ? 32 : 64;
    const salt = Buffer.from("fixture-salt"); const salted = pbkdf2Sync("fixture-password", salt, 4096, length, hash);
    const hmac = (key: Buffer, value: string) => createHmac(hash, key).update(value).digest();
    let first = ""; let serverFirst = ""; let verified = false;
    const backend = await mockBroker(context, (r, port) => {
      if (r.api === 18) return Buffer.concat([i16(0), arr([[3, 6], [17, 1], [18, 2], [36, 1]].map(([key, max]) => Buffer.concat([i16(key!), i16(0), i16(max!)]))), i32(0)]);
      if (r.api === 17) { assert.equal(new Reader(r.body).string(), mechanism.toUpperCase()); return Buffer.concat([i16(0), arr([str(mechanism.toUpperCase())])]); }
      if (r.api === 36) {
        const d = new Reader(r.body); const payload = d.bytes(d.i32()).toString(); let response: string;
        if (!first) {
          assert.match(payload, /^n,,n=reader,r=/); first = payload.slice(3); const nonce = first.split(",r=")[1]!;
          serverFirst = `r=${nonce}server,s=${salt.toString("base64")},i=4096`; response = serverFirst;
        } else {
          const [withoutProof, proof] = payload.split(",p="); const message = [first, serverFirst, withoutProof].join(",");
          const clientKey = hmac(salted, "Client Key"); const stored = createHash(hash).update(clientKey).digest(); const signature = hmac(stored, message);
          const expected = Buffer.from(clientKey.map((v, i) => v ^ signature[i]!)).toString("base64"); assert.equal(proof, expected);
          response = `v=${hmac(hmac(salted, "Server Key"), message).toString("base64")}`; verified = true;
        }
        return Buffer.concat([i16(0), str(null), bytes(Buffer.from(response)), i64(0n)]);
      }
      assert.equal(verified, true); return wireHandler(r, port);
    });
    const reader = createKafkaReader({ ...config, brokers: [`127.0.0.1:${backend.port}`], mechanism, username: "reader", password: "fixture-password" });
    try { const b = await reader.bootstrap(); await reader.read(b, "Metadata"); assert.equal(verified, true); } finally { reader.close(); }
  }
});

test("address mapping validates and persists, routing advertised brokers and coordinators through the proxy", async context => {
  for (const raw of ['[]', 'null', '{', '{"bad":"host:9092"}', '{"host:9092":1}', '{"host:9092":"http://proxy:9092"}']) assert.throws(() => loadKafkaConfig({ KAFKA_BROKER_ADDRESS_MAP: raw }));
  let env: Record<string,string> = {};
  const manager = createKafkaConfigManager({ environment: () => env, update: async v => { env = { ...env, ...v }; } });
  await manager.update({ values: { KAFKA_BROKER_ADDRESS_MAP: '{"private.invalid:9092":"127.0.0.1:19092"}' } });
  assert.equal(loadKafkaConfig(env).addressMap['private.invalid:9092'], '127.0.0.1:19092');
  const revision = manager.getSnapshot().revision;
  await assert.rejects(manager.update({ values: { KAFKA_BROKER_ADDRESS_MAP: '{"bad":true}' } }));
  assert.equal(manager.getSnapshot().revision, revision);
  const backend = await mockBroker(context, (r, port) => {
    if (r.api === 3) {
      const topics = r.body.readInt32BE(0) === 0 ? [] : [Buffer.concat([i16(0), str('orders'), Buffer.from([0]), arr([Buffer.concat([i16(0), i32(0), i32(1), arr([i32(1)]), arr([i32(1)]), arr([])])])])];
      return Buffer.concat([i32(0),arr([Buffer.concat([i32(1),str('private.invalid'),i32(9092),str(null)])]),str('proxy-fixture'),i32(1),arr(topics)]);
    }
    if (r.api === 10) return Buffer.concat([i32(0),i16(0),str(null),i32(1),str('private.invalid'),i32(9092)]);
    return wireHandler(r,port);
  });
  const mapped = loadKafkaConfig({ KAFKA_BROKERS: `127.0.0.1:${backend.port}`, KAFKA_BROKER_ADDRESS_MAP: JSON.stringify({'private.invalid:9092':`127.0.0.1:${backend.port}`}) });
  const reader = createKafkaReader(mapped);
  try {
    assert.equal((await (await queries(reader,mapped)).listGroups({nameFilter:'',limit:10})).data.groups[0]?.groupId,'g');
    const group = await (await queries(reader,mapped)).describeGroup('g'); assert.equal(group.data.coordinator.host,'private.invalid');
    const lag = await (await queries(reader,mapped)).lag({groupId:'g',isolationLevel:'read_uncommitted'});assert.equal(lag.data.partitions[0]?.lag,'10');assert.equal(lag.complete,true);
  } finally { reader.close(); }
});
