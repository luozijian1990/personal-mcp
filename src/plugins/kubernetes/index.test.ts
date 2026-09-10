import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import { createHttpApp } from "../../core/http-app.js";
import { startHttpServer } from "../../core/start-http-server.js";
import type { KubernetesReadClient } from "./client.js";
import { createKubernetesPlugin } from "./index.js";

test("Kubernetes MCP lists the seven read-only tools and returns bounded structured logs", async (context) => {
  const calls: unknown[] = [];
  const client = fakeClient({
    getPodLogs: async (input) => {
      calls.push(input);
      return "line one\nline two\n";
    },
  });
  const plugin = createKubernetesPlugin({
    config: { kubeconfigPath: "/explicit/config", context: "readonly", defaultNamespace: "apps" },
    client,
  });
  const app = createHttpApp({ host: "127.0.0.1", serviceName: "kubernetes-test", mounts: [{ path: "/kubernetes/mcp", plugin }], logger: { info: () => undefined, error: () => undefined } });
  const runtime = await startHttpServer(app, "127.0.0.1", 0);
  context.after(async () => { runtime.server.close(); await once(runtime.server, "close"); });

  const listed = await mcpCall(runtime.url, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  for (const name of ["k8s_list_namespaces", "k8s_list_workloads", "k8s_get_workload_snapshot", "k8s_get_service_snapshot", "k8s_get_ingress_snapshot", "k8s_list_events", "k8s_get_pod_logs"]) assert.match(listed, new RegExp(name));
  assert.equal((listed.match(/readOnlyHint/g) ?? []).length, 7);
  assert.match(listed, /continueToken/);
  assert.match(listed, /endpointSlices/);
  assert.match(listed, /backendServices/);
  assert.match(listed, /tailLines/);

  const logs = await mcpCall(runtime.url, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "k8s_get_pod_logs", arguments: { pod: "api-1", container: "api" } } });
  assert.match(logs, /line one/);
  assert.match(logs, /structuredContent/);
  assert.deepEqual(calls, [{ name: "api-1", namespace: "apps", container: "api", limitBytes: 102400, previous: false, tailLines: 200, timestamps: true }]);
});

async function mcpCall(base: URL, payload: object): Promise<string> {
  const response = await fetch(new URL("/kubernetes/mcp", base), {
    method: "POST",
    headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal(response.status, 200);
  return await response.text();
}

function fakeClient(overrides: Partial<KubernetesReadClient>): KubernetesReadClient {
  const emptyPage = async () => ({ items: [] });
  const empty = async () => [];
  const missing = async () => { throw Object.assign(new Error("not found"), { code: 404 }); };
  return {
    getVersion: async () => ({ major: "1", minor: "23", gitVersion: "v1.23.17", gitCommit: "test", gitTreeState: "clean", buildDate: "", goVersion: "", compiler: "", platform: "" }),
    getApiVersions: async () => ({}), listNamespaces: emptyPage, listWorkloads: emptyPage,
    getWorkload: missing, listPods: emptyPage, listReplicaSets: emptyPage, listJobs: emptyPage,
    getNode: missing, getPersistentVolumeClaim: missing, getPersistentVolume: missing,
    getStorageClass: missing, listServices: emptyPage, getService: missing,
    listEndpointSlices: emptyPage, listIngresses: emptyPage, getIngress: missing,
    listEvents: emptyPage, listHpas: emptyPage, listPdbs: emptyPage, listNetworkPolicies: emptyPage,
    getPodLogs: async () => "", ...overrides,
  } as KubernetesReadClient;
}
