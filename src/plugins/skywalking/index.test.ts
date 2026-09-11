import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { createHttpApp } from "../../core/http-app.js";
import { startHttpServer } from "../../core/start-http-server.js";
import { createSkyWalkingPlugin } from "./index.js";

// Emulate the constraints confirmed by introspection of OAP 9.7.0.
test("MCP tools send OAP-compatible selections, durations and trace conditions", async () => {
  const oap = createServer(async (request, response) => {
    try {
      let text = "";
      for await (const chunk of request) text += chunk;
      const { query, variables } = JSON.parse(text);
      let data;
      if (query.includes("getTimeInfo")) data = { getTimeInfo: { timezone: "+0000", currentTimestamp: Date.parse("2026-09-11T07:00:00Z") } };
      else if (query.includes("listServices")) {
        assert.match(query, /listServices\([^)]*\)\s*\{\s*id name\s*\}/);
        data = { listServices: [{ id: "service", name: "Test service" }] };
      } else if (query.includes("findEndpoint")) {
        assert.equal(variables.serviceId, "service");
        data = { findEndpoint: [{ id: "endpoint", name: "GET /test" }] };
      } else if (query.includes("queryTrace(")) {
        assert.match(query, /refs\s*\{\s*traceId parentSegmentId parentSpanId type/);
        assert.match(query, /logs\s*\{ time data \{ key value \}/);
        if (variables.traceId === "backend-error") throw new Error("OAP unavailable");
        const base = {
          traceId: variables.traceId, spanId: 0, parentSpanId: -1, refs: [], serviceCode: "service",
          serviceInstanceName: "instance", startTime: 100, endTime: 150, endpointName: "/test",
          type: "Entry", peer: null, component: null, isError: false, layer: "Http", tags: [], logs: [],
        };
        data = { queryTrace: variables.traceId === "missing" ? null : { spans: [
          { ...base, segmentId: "child", startTime: 110, endTime: 140, serviceCode: "downstream", isError: true,
            refs: [{ traceId: variables.traceId, parentSegmentId: "parent", parentSpanId: 0, type: "CrossProcess" }],
            tags: [{ key: "http.status_code", value: "404" }],
            logs: [{ time: 140, data: [{ key: "stack", value: "PRIVATE_STACK_MARKER\nTest.java:101" }] }] },
          { ...base, segmentId: "parent" },
        ] } };
      } else if (query.includes("version")) data = { version: "9.7.0" };
      else {
        const duration = variables.duration ?? variables.condition?.queryDuration;
        assert.deepEqual(duration, { start: "2026-09-11 0630", end: "2026-09-11 0700", step: "MINUTE" });
        if (query.includes("listInstances")) {
          assert.match(query, /listInstances\([^)]*\)\s*\{\s*id name\s*\}/);
          assert.equal(variables.id, "service");
          data = { listInstances: [{ id: "instance", name: "Test instance" }] };
        } else if (query.includes("queryBasicTraces")) {
          assert.doesNotMatch(query, /\bstate\b|\btotal\b/);
          const c = variables.condition;
          for (const key of Object.keys(c)) assert.ok(["serviceId", "endpointId", "queryDuration", "traceState", "queryOrder", "paging"].includes(key));
          assert.ok(["ALL", "ERROR"].includes(c.traceState));
          assert.equal(c.queryOrder, "BY_START_TIME");
          assert.deepEqual(c.paging, { pageNum: 1, pageSize: 20 });
          if (c.endpointId) assert.equal(c.endpointId, "endpoint");
          data = { queryBasicTraces: { traces: [{ traceIds: ["trace"], duration: 10, isError: c.traceState === "ERROR", segmentId: "segment", start: "1789110000000", endpointNames: ["GET /test"] }] } };
        } else {
          if (variables.serviceIds) assert.deepEqual(variables.serviceIds, ["service"]);
          else assert.match(query, /getGlobalTopology/);
          data = { getServicesTopology: { nodes: [{ id: "service", name: "Test service" }], calls: [] } };
        }
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data }));
    } catch (error) {
      response.end(JSON.stringify({ errors: [{ message: String(error) }] }));
    }
  });
  oap.listen(0, "127.0.0.1");
  await once(oap, "listening");
  const address = oap.address();
  assert.ok(address && typeof address !== "string");
  const plugin = createSkyWalkingPlugin({ url: `http://127.0.0.1:${address.port}`, username: "", password: "" });
  const recordedLogs: unknown[] = [];
  const runtime = await startHttpServer(createHttpApp({ host: "127.0.0.1", serviceName: "test", mounts: [{ path: "/skywalking/mcp", plugin }], logger: { info(_event, fields) { recordedLogs.push(fields); }, error(_event, fields) { recordedLogs.push(fields); } } }), "127.0.0.1", 0);
  async function rpc(method: string, params: object) {
    const response = await fetch(new URL("/skywalking/mcp", runtime.url), { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const text = await response.text();
    const message = JSON.parse(text.split("\n").find(line => line.startsWith("data: "))!.slice(6));
    assert.equal(message.error, undefined);
    return message.result;
  }
  try {
    const listed = await rpc("tools/list", {});
    assert.equal(listed.tools.length, 5);
    assert.ok(listed.tools.every((tool: { outputSchema?: object }) => tool.outputSchema));
    for (const [name, args] of [
      ["list_services", {}], ["list_instances", { serviceId: "service" }],
      ["query_traces", {}], ["query_traces", { view: "full" }],
      ["query_traces", { view: "errors_only" }],
      ["query_traces", { serviceId: "service", endpointName: "GET /test" }],
      ["query_service_topology", {}], ["query_service_topology", { serviceIds: ["service"] }],
    ] as const) {
      const result = await rpc("tools/call", { name: `skywalking_${name}`, arguments: args });
      assert.equal(result.isError, false, JSON.stringify(result));
      assert.ok(result.structuredContent);
    }
    const detail = async (args: object) => rpc("tools/call", { name: "skywalking_get_trace", arguments: args });
    const first = await detail({ traceId: "trace", limit: 1 });
    assert.equal(first.isError, false);
    assert.equal(first.structuredContent.totalSpans, 2);
    assert.equal(first.structuredContent.spans[0].segmentId, "parent");
    assert.equal(first.structuredContent.spans[0].durationMs, 50);
    assert.equal(first.structuredContent.nextOffset, 1);
    const second = await detail({ traceId: "trace", offset: 1, limit: 1 });
    assert.equal(second.structuredContent.hasMore, false);
    assert.equal(second.structuredContent.nextOffset, null);
    assert.equal(second.structuredContent.spans[0].refs[0].parentSegmentId, "parent");
    assert.match(second.structuredContent.spans[0].logs[0].data[0].value, /Test.java:101/);
    const errors = await detail({ traceId: "trace", errorsOnly: true, serviceName: "downstream" });
    assert.equal(errors.structuredContent.matchedSpans, 1);
    assert.equal(errors.structuredContent.spans[0].tags[0].value, "404");
    const filtered = await detail({ traceId: "trace", serviceName: "missing-service" });
    assert.equal(filtered.structuredContent.totalSpans, 2);
    assert.equal(filtered.structuredContent.matchedSpans, 0);
    const empty = await detail({ traceId: "missing" });
    assert.equal(empty.isError, false);
    assert.equal(empty.structuredContent.totalSpans, 0);
    assert.deepEqual(empty.structuredContent.spans, []);
    assert.equal((await detail({ traceId: "backend-error" })).isError, true);
    assert.equal((await detail({ traceId: " " })).isError, true);
    assert.equal((await detail({ traceId: "trace", limit: 101 })).isError, true);
    assert.doesNotMatch(JSON.stringify(recordedLogs), /PRIVATE_STACK_MARKER/);
    const invalid = await rpc("tools/call", { name: "skywalking_query_traces", arguments: { endpointName: "GET /test" } });
    assert.equal(invalid.isError, true);
    assert.equal((await plugin.checkHealth!(new AbortController().signal)).state, "healthy");
  } finally {
    runtime.server.closeAllConnections(); oap.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => runtime.server.close(() => resolve())), new Promise<void>(resolve => oap.close(() => resolve()))]);
  }
});
