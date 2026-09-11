import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("demo verification seeds an empty Jaeger and waits for delayed discovery indexes", { timeout: 20_000 }, async context => {
  const services = ["service-a", "service-b", "service-c", "service-d", "traefik"];
  const traces: object[] = [];
  const requests: string[] = [];
  let discoveryReads = 0;
  const backend = createServer((request, response) => {
    const url = new URL(request.url!, "http://localhost");
    requests.push(url.pathname);
    response.setHeader("content-type", "application/json");
    if (url.pathname.startsWith("/demo/")) {
      const traceID = (traces.length + 1).toString(16).padStart(32, "0");
      const slow = url.pathname.endsWith("/slow/redis");
      const degrade = url.pathname.endsWith("/degrade/ok");
      const processes = Object.fromEntries(services.map((serviceName, i) => [`p${i}`, { serviceName, tags: [] }]));
      const spans = services.map((service, i) => ({
        traceID, spanID: String(i + 1).padStart(16, "0"), processID: `p${i}`,
        operationName: slow && service === "service-c" ? "redis synthetic slow operation" : "GET /demo",
        startTime: 1789110000000000, duration: slow ? 4_000_000 : 1000,
        references: [], logs: [],
        tags: !slow && service === (degrade ? "service-c" : "service-d") ? [{ key: "error", type: "bool", value: true }] : [],
      }));
      traces.push({ traceID, processes, spans });
      response.statusCode = slow || degrade ? 200 : 500;
      response.setHeader("x-trace-id", traceID);
      response.end("{}"); return;
    }
    let data: unknown = [];
    if (url.pathname === "/api/services") {
      discoveryReads++;
      // Initially empty, including the first read after traces have arrived.
      data = traces.length && discoveryReads > 1 ? services : [];
    } else if (url.pathname.endsWith("/operations")) data = traces.length && discoveryReads > 1 ? ["GET /demo"] : [];
    else if (url.pathname === "/api/dependencies") data = [
      { parent: "traefik", child: "service-a", callCount: 4 },
      { parent: "service-a", child: "service-b", callCount: 4 },
      { parent: "service-b", child: "service-c", callCount: 3 },
      { parent: "service-b", child: "service-d", callCount: 4 },
    ];
    else if (url.pathname === "/api/traces") data = traces;
    else if (url.pathname.startsWith("/api/traces/")) data = traces.filter(trace => (trace as { traceID: string }).traceID === url.pathname.split("/").at(-1));
    response.end(JSON.stringify({ data, errors: null }));
  });
  backend.listen(0, "127.0.0.1"); await once(backend, "listening");
  const address = backend.address(); assert.ok(address && typeof address !== "string");
  const workdir = await mkdtemp(join(tmpdir(), "jaeger-cold-start-"));
  context.after(async () => { backend.closeAllConnections(); await new Promise<void>(r => backend.close(() => r())); await rm(workdir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${address.port}`;
  const child = spawn(process.execPath, [resolve("scripts/verify-jaeger-demo.mjs")], {
    cwd: workdir, env: { ...process.env, JAEGER_MCP_URL: origin, JAEGER_DEMO_URL: `${origin}/demo` }, stdio: ["ignore", "pipe", "pipe"],
  });
  context.after(() => { if (child.exitCode === null) child.kill(); });
  let stderr = "";
  child.stderr.on("data", value => { stderr += value; });
  child.stdout.resume();
  const [code] = await once(child, "exit");
  assert.equal(code, 0, stderr);
  assert.ok(requests[0]!.startsWith("/demo/"), "Generate traffic before requiring indexed services");
  assert.equal(traces.length, 4);
  assert.ok(discoveryReads >= 2, "Retry empty discovery after traces arrive");
  const report = JSON.parse(await readFile(join(workdir, ".scratch/jaeger-mcp/live-verification.json"), "utf8"));
  assert.equal(report.scenarios.length, 4);
  assert.deepEqual(report.services, [...services].sort());
});
