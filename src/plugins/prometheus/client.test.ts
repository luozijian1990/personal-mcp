import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";

import { queryPrometheus, queryPrometheusRange } from "./client.js";

test("Prometheus client calls instant and range query endpoints", async (context) => {
  const requests: Array<{ path: string; query: Record<string, string> }> = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams) });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      status: "success",
      data: { resultType: "vector", result: [{ metric: { job: "prometheus" }, value: [1, "1"] }] },
    }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address();
  assert.equal(typeof address, "object");
  if (address === null || typeof address === "string") throw new Error("server did not bind");
  const config = { url: `http://127.0.0.1:${address.port}`, queryTimeoutSeconds: 5 };

  const instant = await queryPrometheus(config, { query: "up", time: 123 });
  const range = await queryPrometheusRange(config, {
    query: "rate(http_requests_total[5m])",
    start: 100,
    end: 200,
    step: "15s",
  });
  assert.equal(instant.status, "success");
  assert.equal(range.status, "success");
  assert.deepEqual(requests, [
    { path: "/api/v1/query", query: { query: "up", time: "123" } },
    {
      path: "/api/v1/query_range",
      query: { query: "rate(http_requests_total[5m])", start: "100", end: "200", step: "15s" },
    },
  ]);
});

test("Prometheus client reports timeout and API errors as structured results", async (context) => {
  const server = createServer((_request, response) => {
    setTimeout(() => response.end(JSON.stringify({
      status: "error",
      errorType: "bad_data",
      error: "invalid PromQL",
    })), 1_500);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address();
  assert.equal(typeof address, "object");
  if (address === null || typeof address === "string") throw new Error("server did not bind");
  const result = await queryPrometheus(
    { url: `http://127.0.0.1:${address.port}`, queryTimeoutSeconds: 1 },
    { query: "bad" },
  );
  assert.equal(result.status, "error");
  assert.equal(result.errorType, "timeout");
});
