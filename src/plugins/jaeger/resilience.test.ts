import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { startStandalonePlugin } from "../../core/plugin-runtime.js";
import { JAEGER_PLUGIN_DEFINITION } from "./definition.js";

const calls = [
  ["list_services", {}], ["list_operations", { serviceName: "service-a" }],
  ["query_traces", { serviceName: "service-a" }], ["get_trace", { traceId: "1234567890abcdef1234567890abcdef" }],
  ["query_service_topology", {}],
] as const;

test("all five tools handle backend faults, size cap, timeout, config HTTP lifecycle and health cancellation", { timeout: 40_000 }, async context => {
  let mode = "ok";
  const backend = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (mode === "timeout") return;
    if (/^\d+$/.test(mode)) { res.writeHead(Number(mode)); res.end("PRIVATE_BACKEND_DETAIL"); return; }
    if (mode === "large") { res.end(' '.repeat(17 * 1024 * 1024)); return; }
    if (mode === "html") { res.end("<html>login</html>"); return; }
    if (mode === "shape") { res.end('{"data":{}}'); return; }
    if (mode === "errors") { res.end('{"data":[],"errors":[{"msg":"PRIVATE_BACKEND_DETAIL"}]}'); return; }
    if (mode === "envelope") { res.end('{}'); return; }
    if (mode === "null") { res.end('{"data":null,"errors":null}'); return; }
    res.end('{"data":[],"errors":null}');
  });
  backend.listen(0, "127.0.0.1"); await once(backend, "listening");
  const address = backend.address(); assert.ok(address && typeof address !== "string");
  const environment = { MCP_ENABLED_JAEGER: "true", JAEGER_MCP_URL: `http://127.0.0.1:${address.port}` };
  const runtime = await startStandalonePlugin(JAEGER_PLUGIN_DEFINITION, { port: 0, store: { environment: () => environment, update: async values => { Object.assign(environment, values); } }, logger: { info() {}, error() {} } });
  context.after(async () => { backend.closeAllConnections(); runtime.server.closeAllConnections(); await Promise.all([new Promise<void>(r => backend.close(() => r())), new Promise<void>(r => runtime.server.close(() => r()))]); });
  async function call(name: string, args: object) {
    const r = await fetch(new URL("/jaeger/mcp", runtime.url), { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: `jaeger_${name}`, arguments: args } }) });
    const body = await r.text();
    if (r.status !== 200) return { status: r.status, body };
    return JSON.parse(body.startsWith("{") ? body : body.split("\n").find(line => line.startsWith("data: "))!.slice(6)).result;
  }
  for (mode of ["401", "403", "404", "500", "html", "shape", "errors", "envelope", "large"]) {
    for (const [name, args] of calls) {
      const result = await call(name, args);
      assert.equal(result.isError, true, `${mode}/${name}`);
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE_BACKEND_DETAIL/);
      if (mode === "large") assert.match(JSON.stringify(result), /16 MiB/);
    }
  }
  for (mode of ["ok", "null"]) for (const [name, args] of calls) assert.equal((await call(name, args)).isError, false, `${mode}/${name}`);
  mode = "timeout";
  const start = Date.now();
  const results = await Promise.all(calls.map(([name, args]) => call(name, args)));
  results.forEach(result => assert.equal(result.isError, true));
  assert.ok(Date.now() - start >= 14000 && Date.now() - start < 22000, "15s timeout enforced");
  const healthStart = Date.now();
  const health = await fetch(new URL("/api/health/check", runtime.url), { method: "POST" });
  assert.equal(health.status, 200);
  assert.ok(Date.now() - healthStart < 8000, "Runtime health timeout cancels backend before tool timeout");
  const status = await (await fetch(new URL("/api/status", runtime.url))).json();
  assert.equal(status.endpoints[0].health.state, "unhealthy");
  mode = "ok";
  const configURL = new URL("/api/config/jaeger", runtime.url);
  const before = await (await fetch(configURL)).json();
  const invalid = await fetch(configURL, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ values: { JAEGER_MCP_URL: "ftp://invalid" } }) });
  assert.equal(invalid.status, 400);
  assert.deepEqual(await (await fetch(configURL)).json(), before);
  const update = await fetch(configURL, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ values: { JAEGER_MCP_PASSWORD: "TEST_ONLY_SECRET" } }) });
  assert.equal(update.status, 200); assert.doesNotMatch(await update.text(), /TEST_ONLY_SECRET/);
  assert.equal((await call("list_services", {})).isError, false);
  const reload = await fetch(new URL("/api/config/jaeger/reload", runtime.url), { method: "POST" }); assert.equal(reload.status, 200);
  const toggle = async (enabled: boolean) => fetch(new URL("/api/plugins/jaeger/enabled", runtime.url), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }) });
  assert.equal((await toggle(false)).status, 200);
  assert.equal((await call("list_services", {})).status, 503);
  assert.equal((await toggle(true)).status, 200);
  assert.equal((await call("list_services", {})).isError, false);
  await fetch(new URL("/api/health/check", runtime.url), { method: "POST" });
  const recovered = await (await fetch(new URL("/api/status", runtime.url))).json();
  assert.equal(recovered.endpoints[0].health.state, "healthy");
  assert.doesNotMatch(JSON.stringify(recovered), /TEST_ONLY_SECRET/);
});
