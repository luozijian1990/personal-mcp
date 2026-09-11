import assert from "node:assert/strict";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { createKubernetesReadClient, validateKubernetesConfig } from "./client.js";

test("official Kubernetes client uses the explicit context and sends GET-only requests", async (context) => {
  const methods: string[] = [];
  const urls: string[] = [];
  const server = createServer((request, response) => {
    methods.push(request.method ?? "");
    urls.push(request.url ?? "");
    response.setHeader("content-type", "application/json");
    if (request.url?.startsWith("/version")) {
      response.end(JSON.stringify({ major: "1", minor: "23", gitVersion: "v1.23.17", gitCommit: "test", gitTreeState: "clean", buildDate: "2022-01-01T00:00:00Z", goVersion: "go1.17", compiler: "gc", platform: "darwin/arm64" }));
      return;
    }
    response.end(JSON.stringify({ apiVersion: "v1", kind: "NamespaceList", metadata: { resourceVersion: "1" }, items: [{ metadata: { name: "apps" }, status: { phase: "Active" } }] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server did not bind");
  const kubeconfigPath = path.join(tmpdir(), `.kubeconfig-test-${process.pid}`);
  context.after(async () => { await import("node:fs/promises").then(({ unlink }) => unlink(kubeconfigPath).catch(() => undefined)); });
  await writeFile(kubeconfigPath, `apiVersion: v1\nkind: Config\nclusters:\n- name: test-cluster\n  cluster:\n    server: http://127.0.0.1:${address.port}\n    insecure-skip-tls-verify: true\nusers:\n- name: reader\n  user: {}\ncontexts:\n- name: fixed-context\n  context:\n    cluster: test-cluster\n    user: reader\n    namespace: ignored\ncurrent-context: wrong-context\n`);
  const config = { kubeconfigPath, context: "fixed-context", defaultNamespace: "apps" };

  await validateKubernetesConfig(config);
  const client = createKubernetesReadClient(config);
  assert.equal((await client.getVersion()).gitVersion, "v1.23.17");
  assert.equal((await client.listNamespaces({ limit: 50 })).items[0]?.metadata?.name, "apps");
  await client.listNodes({ limit: 2, continueToken: "next-page", labelSelector: "pool=apps" });
  await client.listPersistentVolumeClaims({ namespace: "apps", limit: 3 });
  await client.listPersistentVolumeClaims({ allNamespaces: true, limit: 3 });
  await client.listResourceQuotas({ namespace: "apps", limit: 4 });
  await client.listResourceQuotas({ allNamespaces: true, limit: 4 });
  assert.deepEqual(methods, Array(7).fill("GET"));
  const parsed = urls.map((url) => new URL(url, "http://localhost"));
  assert.deepEqual(parsed.slice(2).map((url) => url.pathname), [
    "/api/v1/nodes", "/api/v1/namespaces/apps/persistentvolumeclaims",
    "/api/v1/persistentvolumeclaims", "/api/v1/namespaces/apps/resourcequotas", "/api/v1/resourcequotas",
  ]);
  assert.equal(parsed[2]?.searchParams.get("continue"), "next-page");
  assert.equal(parsed[2]?.searchParams.get("labelSelector"), "pool=apps");
  assert.equal(parsed[2]?.searchParams.get("limit"), "2");
});

test("configuration rejects a context that is not present in the explicit kubeconfig", async (context) => {
  const kubeconfigPath = path.join(tmpdir(), `.kubeconfig-missing-context-${process.pid}`);
  context.after(async () => { await import("node:fs/promises").then(({ unlink }) => unlink(kubeconfigPath).catch(() => undefined)); });
  await writeFile(kubeconfigPath, "apiVersion: v1\nkind: Config\nclusters: []\nusers: []\ncontexts: []\ncurrent-context: ''\n");
  await assert.rejects(
    validateKubernetesConfig({ kubeconfigPath, context: "missing", defaultNamespace: "default" }),
    /does not exist/,
  );
});
