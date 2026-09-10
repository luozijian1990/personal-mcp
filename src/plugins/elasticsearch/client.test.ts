import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";

import { createElasticsearchReadClient, ElasticsearchRequestError, validateIndexExpression } from "./client.js";

test("Elasticsearch client preserves base path, encodes index expressions and sends Basic Auth", async (context) => {
  const requests: Array<{ method: string; url: string; authorization: string | undefined; body: string }> = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    requests.push({
      method: request.method ?? "",
      url: request.url ?? "",
      authorization: typeof request.headers.authorization === "string" ? request.headers.authorization : undefined,
      body,
    });
    response.setHeader("content-type", "application/json");
    if (request.url?.includes("_cat/indices")) response.end("[]");
    else response.end(JSON.stringify({ took: 1, timed_out: false, hits: { total: { value: 0, relation: "eq" }, hits: [] } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server did not bind");
  const client = createElasticsearchReadClient(config(`http://127.0.0.1:${address.port}/proxy/es`, {
    username: "reader", password: "secret",
  }));

  await client.listIndices("logs-*,metrics-*" );
  await client.search({ index: "logs-*", body: { query: { match_all: {} }, size: 1 } });
  assert.equal(requests[0]?.method, "GET");
  assert.match(requests[0]?.url ?? "", /^\/proxy\/es\/_cat\/indices\/logs-\*%2Cmetrics-\*/u);
  assert.equal(requests[0]?.authorization, `Basic ${Buffer.from("reader:secret").toString("base64")}`);
  assert.equal(requests[1]?.method, "POST");
  assert.match(requests[1]?.body ?? "", /match_all/u);
});

test("Elasticsearch client rejects unsafe index expressions", () => {
  assert.throws(() => validateIndexExpression(""), /must not be empty/);
  assert.throws(() => validateIndexExpression("logs-*/_delete_by_query"), /forbidden/);
  assert.throws(() => validateIndexExpression("logs-*?pretty=true"), /forbidden/);
  assert.doesNotThrow(() => validateIndexExpression("<logs-{now/d}>"));
  assert.doesNotThrow(() => validateIndexExpression("<elastic\\{ON\\}-{now/M}>"));
  assert.throws(() => validateIndexExpression("<logs-{now/d}>/../_cluster"), /forbidden/);
  assert.throws(() => validateIndexExpression("logs\\..\\_cluster"), /forbidden/);
});

test("Elasticsearch client reports HTTP errors without leaking the configured password", async (context) => {
  const username = "reader";
  const password = "secret-value";
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  const server = createServer((_request, response) => {
    response.statusCode = 403;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ error: { type: "security_exception", reason: `denied ${password}; Authorization: ${authorization}` } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server did not bind");
  const client = createElasticsearchReadClient(config(`http://127.0.0.1:${address.port}`, {
    username, password,
  }));
  await assert.rejects(client.getRoot(), (error: unknown) => {
    assert.ok(error instanceof ElasticsearchRequestError);
    assert.equal(error.status, 403);
    assert.equal(error.errorType, "security_exception");
    assert.doesNotMatch(error.message, /secret-value/u);
    assert.doesNotMatch(error.message, new RegExp(authorization.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
    assert.doesNotMatch(error.message, new RegExp(Buffer.from(`${username}:${password}`).toString("base64"), "u"));
    return true;
  });
});

test("Elasticsearch client URL-encodes valid date-math index expressions", async (context) => {
  let observedUrl = "";
  const server = createServer((request, response) => {
    observedUrl = request.url ?? "";
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ took: 0, timed_out: false, hits: { total: { value: 0, relation: "eq" }, hits: [] } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server did not bind");
  const client = createElasticsearchReadClient(config(`http://127.0.0.1:${address.port}`));
  await client.search({ index: "<logs-{now/d}>", body: { query: { match_all: {} } } });
  assert.match(observedUrl, /^\/%3Clogs-%7Bnow%2Fd%7D%3E\/_search$/u);
});

test("Elasticsearch client enforces timeout, caller cancellation and backend byte limits", async (context) => {
  const server = createServer((request, response) => {
    if (request.url?.includes("large")) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ value: "x".repeat(300_000) }));
      return;
    }
    setTimeout(() => response.end(JSON.stringify({ version: { number: "7.10.0" } })), 500);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server did not bind");
  const base = `http://127.0.0.1:${address.port}`;
  await assert.rejects(createElasticsearchReadClient(config(base, { requestTimeoutMs: 100 })).getRoot(), /timed out/);
  const controller = new AbortController();
  const cancelled = createElasticsearchReadClient(config(base)).getRoot(controller.signal);
  controller.abort();
  await assert.rejects(cancelled, /cancelled/);
  await assert.rejects(
    createElasticsearchReadClient(config(`${base}/large`, { maxResponseBytes: 16_384 })).getRoot(),
    /exceeds the 262144 byte safety limit/,
  );
});

function config(url: string, overrides: Partial<ReturnType<typeof baseConfig>> = {}) {
  return { ...baseConfig(), url, ...overrides };
}

function baseConfig() {
  return { url: "", username: "", password: "", requestTimeoutMs: 1_000, maxHits: 100, maxResponseBytes: 1024 * 1024 };
}
