import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { startStandalonePlugin } from "../../core/plugin-runtime.js";
import { JAEGER_PLUGIN_DEFINITION } from "./definition.js";
import { queryRange } from "./time.js";
import { jaegerBaseUrl } from "./config.js";

const traceID = "1234567890abcdef1234567890abcdef";
const tag = (key: string, value: string | number | boolean) => ({ key, type: typeof value, value });
const base = { traceID, spanID: "1111111111111111", operationName: "GET /ok", processID: "p1", startTime: 1789110000000000, duration: 5_000_000, references: [], tags: [], logs: [] };
const fixture = { traceID, processes: { p1: { serviceName: "entry", tags: [tag("host.name", "demo")] }, p2: { serviceName: "db", tags: [] } }, warnings: ["fixture warning"], spans: [
  { ...base, logs: [{ timestamp: base.startTime, fields: [tag("event", "ordinary successful request")] }] },
  { ...base, spanID: "2222222222222222", processID: "p2", startTime: base.startTime + 1000, duration: 1500, references: [{ refType: "CHILD_OF", traceID, spanID: base.spanID }, { refType: "FOLLOWS_FROM", traceID: "eeeeeeeeeeeeeeee", spanID: "3333333333333333" }], tags: [tag("http.response.status_code", 503)], logs: [{ timestamp: base.startTime + 2000, fields: [tag("exception.message", "PRIVATE_STACK_MARKER"), tag("exception.stacktrace", "frame1\nframe2")] }] },
] };

test("time ranges reject invalid dates and preserve microseconds without minute rounding", () => {
  const now = Date.parse("2026-09-11T07:00:01.123Z");
  assert.deepEqual(queryRange("now-30m", "now", now), { start: String((now - 1800000) * 1000), end: String(now * 1000) });
  assert.deepEqual(queryRange("2026-09-11T15:00:01.123+08:00", "2026-09-11T07:00:01.123Z"), { start: String(now * 1000), end: String(now * 1000) });
  for (const value of ["2026-02-30T00:00:00Z", "2026-09-11", "2026-09-11T24:00:00Z", "now-999999999999999999d"]) assert.throws(() => queryRange(value, "now"));
  assert.throws(() => queryRange("now", "now-1s"));
  for (const url of ["ftp://host", "https://user:secret@host", "https://host/?x=1", "https://host/#x"]) assert.throws(() => jaegerBaseUrl(url));
});

test("Jaeger tools execute through standalone Runtime and preserve evidence, filtering, errors and metadata-only logging", async context => {
  let mode = "ok";
  const requests: URL[] = [];
  const backend = createServer((req, res) => {
    assert.equal(req.method, "GET");
    assert.equal(req.headers.authorization, `Basic ${Buffer.from("reader:secret").toString("base64")}`);
    const url = new URL(req.url!, "http://localhost"); requests.push(url);
    res.setHeader("content-type", "application/json");
    if (mode === "http") { res.writeHead(503); res.end("PRIVATE_STACK_MARKER"); return; }
    if (mode === "redirect") { res.writeHead(302, { location: "/elsewhere" }); res.end(); return; }
    if (mode === "json") { res.end("not json"); return; }
    if (mode === "shape") { res.end(JSON.stringify({ data: {} })); return; }
    if (mode === "errors") { res.end(JSON.stringify({ data: [], errors: [{ msg: "PRIVATE_STACK_MARKER" }] })); return; }
    if (mode === "missing") { res.end(JSON.stringify({ data: [], errors: null })); return; }
    let data: unknown;
    if (url.pathname === "/prefix/api/services") data = ["entry", "db"];
    else if (url.pathname === "/prefix/api/services/entry%2Fname/operations") data = ["GET /ok", "GET /error"];
    else if (url.pathname === "/prefix/api/dependencies") data = [
      { parent: "b", child: "c", callCount: 4 },
      { parent: "a", child: "b", callCount: 7 },
      { parent: "c", child: "d", callCount: 1 },
    ];
    else if (url.pathname.startsWith("/prefix/api/traces")) data = [fixture];
    else { res.writeHead(404); res.end(); return; }
    res.end(JSON.stringify({ data, errors: null }));
  });
  backend.listen(0, "127.0.0.1"); await once(backend, "listening");
  const address = backend.address(); assert.ok(address && typeof address !== "string");
  const environment = { JAEGER_MCP_URL: `http://127.0.0.1:${address.port}/prefix/`, JAEGER_MCP_USERNAME: "reader", JAEGER_MCP_PASSWORD: "secret", MCP_ENABLED_JAEGER: "true" };
  const logs: unknown[] = [];
  const runtime = await startStandalonePlugin(JAEGER_PLUGIN_DEFINITION, { port: 0, store: { environment: () => environment, update: async values => { Object.assign(environment, values); } }, logger: { info(_event, fields) { logs.push(fields); }, error(_event, fields) { logs.push(fields); } } });
  context.after(async () => { runtime.server.closeAllConnections(); backend.closeAllConnections(); await Promise.all([new Promise<void>(r => runtime.server.close(() => r())), new Promise<void>(r => backend.close(() => r()))]); });
  async function rpc(method: string, params: object) {
    const res = await fetch(new URL("/jaeger/mcp", runtime.url), { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const text = await res.text();
    const result = JSON.parse(text.startsWith("{") ? text : text.split("\n").find(line => line.startsWith("data: "))!.slice(6));
    assert.equal(result.error, undefined); return result.result;
  }
  const call = (name: string, args: object = {}) => rpc("tools/call", { name: `jaeger_${name}`, arguments: args });
  const listed = await rpc("tools/list", {});
  assert.equal(listed.tools.length, 5); assert.ok(listed.tools.every((t: { outputSchema: unknown }) => t.outputSchema));
  const status = await (await fetch(new URL("/api/status", runtime.url))).json();
  assert.ok(JSON.stringify(status).includes("JAEGER_MCP_URL"));
  assert.doesNotMatch(JSON.stringify(status), /reader:secret/);
  assert.deepEqual((await call("list_services", { limit: 1 })).structuredContent, { services: ["db"], totalServices: 2, offset: 0, hasMore: true, nextOffset: 1 });
  assert.equal((await call("list_operations", { serviceName: "entry/name" })).structuredContent.totalOperations, 2);
  const search = await call("query_traces", { serviceName: "entry", start: "2026-09-11T06:00:00Z", end: "2026-09-11T08:00:00Z", minDurationMs: 1000.5, maxDurationMs: 6000, tags: { error: "true" }, limit: 1 });
  assert.equal(search.isError, false); assert.equal(search.structuredContent.limitReached, true);
  assert.equal(search.structuredContent.traces[0].durationMs, 5000);
  const sent = requests.at(-1)!;
  assert.equal(sent.searchParams.get("start"), String(Date.parse("2026-09-11T06:00:00Z") * 1000));
  assert.equal(sent.searchParams.get("minDuration"), "1000.5ms");
  assert.equal(sent.searchParams.get("tags"), '{"error":"true"}');
  for (const value of [0.001, 0.123, 86_400_000]) {
    const result = await call("query_traces", { serviceName: "entry", minDurationMs: value, maxDurationMs: value });
    assert.equal(result.isError, false);
    assert.equal(requests.at(-1)!.searchParams.get("minDuration"), `${value}ms`);
    assert.equal(requests.at(-1)!.searchParams.get("maxDuration"), `${value}ms`);
  }
  for (const key of ["minDurationMs", "maxDurationMs"]) {
    for (const value of [0.0000001, 0.0005, 0.0011]) {
      const before = requests.length;
      assert.equal((await call("query_traces", { serviceName: "entry", [key]: value })).isError, true);
      assert.equal(requests.length, before, "Unsupported precision must be rejected before reaching Jaeger");
    }
  }
  const first = (await call("get_trace", { traceId: traceID, limit: 1 })).structuredContent;
  assert.equal(first.spans[0].isError, false); assert.equal(first.nextOffset, 1);
  assert.equal(first.spans[0].process.tags[0].key, "host.name");
  const second = (await call("get_trace", { traceId: traceID, offset: 1 })).structuredContent;
  assert.equal(second.spans[0].durationMs, 1.5); assert.equal(second.spans[0].references[1].refType, "FOLLOWS_FROM");
  assert.equal(second.spans[0].logs[0].fields[1].value, "frame1\nframe2");
  assert.deepEqual(second.spans[0].errorEvidence, ["http.response.status_code=503", "exception event"]);
  const errors = (await call("get_trace", { traceId: traceID, errorsOnly: true, serviceName: "db" })).structuredContent;
  assert.equal(errors.totalSpans, 2); assert.equal(errors.matchedSpans, 1);
  assert.equal((await call("get_trace", { traceId: traceID, serviceName: "absent" })).structuredContent.matchedSpans, 0);
  for (const [name, args] of [["get_trace", { traceId: "../services" }], ["get_trace", { traceId: "0".repeat(32) }], ["query_traces", { serviceName: "entry", minDurationMs: 2, maxDurationMs: 1 }], ["query_traces", { serviceName: "entry", start: "2026-02-30T00:00:00Z" }]] as const) assert.equal((await call(name, args)).isError, true);
  assert.equal((await runtime.catalog.mounts[0]!.plugin.checkHealth!(new AbortController().signal)).state, "healthy");
  for (mode of ["http", "redirect", "json", "shape", "errors"]) {
    const result = await call("get_trace", { traceId: traceID }); assert.equal(result.isError, true, mode); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_STACK_MARKER/);
  }
  mode = "ok";
  const topology = await call("query_service_topology", { start: "2026-09-11T06:00:00Z", end: "2026-09-11T07:00:00Z", serviceNames: ["b"], limit: 1 });
  assert.equal(topology.isError, false);
  assert.equal(requests.at(-1)!.searchParams.get("endTs"), String(Date.parse("2026-09-11T07:00:00Z")));
  assert.equal(requests.at(-1)!.searchParams.get("lookback"), "3600000");
  assert.equal(topology.structuredContent.totalEdges, 3);
  assert.equal(topology.structuredContent.matchedEdges, 2);
  assert.deepEqual(topology.structuredContent.edges, [{ source: "a", target: "b", callCount: 7 }]);
  assert.deepEqual(topology.structuredContent.nodes, [{ id: "a", name: "a" }, { id: "b", name: "b" }]);
  assert.equal(topology.structuredContent.nextOffset, 1);
  const next = await call("query_service_topology", { serviceNames: ["b"], limit: 1, offset: 1 });
  assert.deepEqual(next.structuredContent.edges, [{ source: "b", target: "c", callCount: 4 }]);
  assert.equal(next.structuredContent.hasMore, false);
  assert.equal((await call("query_service_topology", {})).structuredContent.edges.length, 3);
  assert.equal((await call("query_service_topology", { serviceNames: ["absent"] })).structuredContent.nodes.length, 0);
  const beforeInvalidTime = requests.length;
  assert.equal((await call("query_service_topology", { start: "now", end: "now" })).isError, true);
  assert.equal(requests.length, beforeInvalidTime);
  for (mode of ["http", "json", "shape", "errors"]) assert.equal((await call("query_service_topology", {})).isError, true);
  mode = "missing";
  assert.equal((await call("get_trace", { traceId: traceID })).structuredContent.found, false);
  assert.deepEqual((await call("query_service_topology", {})).structuredContent.edges, []);
  assert.doesNotMatch(JSON.stringify(logs), /PRIVATE_STACK_MARKER|frame1|reader:secret/);
});
