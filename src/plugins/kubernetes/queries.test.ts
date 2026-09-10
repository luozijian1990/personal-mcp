import assert from "node:assert/strict";
import test from "node:test";
import type {
  V1Deployment,
  V1EndpointSlice,
  V1Ingress,
  V1Pod,
  V1ReplicaSet,
  V1Service,
} from "@kubernetes/client-node";

import type { KubernetesReadClient } from "./client.js";
import { getIngressSnapshot, getWorkloadSnapshot, listWorkloads } from "./queries.js";

test("workload snapshot follows owner UIDs, redacts literals and preserves partial RBAC evidence", async () => {
  const deployment = { metadata: { name: "api", namespace: "apps", uid: "dep-1" }, spec: { replicas: 2, template: { metadata: {}, spec: { containers: [{ name: "api", image: "api:1", env: [{ name: "PASSWORD", value: "hidden" }] }] } } }, status: { replicas: 2, readyReplicas: 1 } } as V1Deployment;
  const replicaSet = { metadata: { name: "api-rs", namespace: "apps", uid: "rs-1", ownerReferences: [{ apiVersion: "apps/v1", kind: "Deployment", name: "api", uid: "dep-1", controller: true }] } } as V1ReplicaSet;
  const pod = { metadata: { name: "api-pod", namespace: "apps", uid: "pod-1", labels: { app: "api" }, ownerReferences: [{ apiVersion: "apps/v1", kind: "ReplicaSet", name: "api-rs", uid: "rs-1", controller: true }] }, spec: { nodeName: "node-1", containers: [{ name: "api", image: "api:1", env: [{ name: "PASSWORD", value: "hidden" }] }] }, status: { phase: "Running", containerStatuses: [{ name: "api", image: "api:1", imageID: "image", ready: false, restartCount: 3 }] } } as V1Pod;
  const service = { metadata: { name: "api", namespace: "apps" }, spec: { selector: { app: "api" }, ports: [{ port: 80 }] } } as V1Service;
  const endpointSlice = { metadata: { name: "api-slice", namespace: "apps" }, addressType: "IPv4", endpoints: [{ addresses: ["10.0.0.8"] }] } as V1EndpointSlice;
  const client = fakeClient({
    getWorkload: async () => deployment,
    listReplicaSets: async () => ({ items: [replicaSet], continueToken: "controllers-next" }),
    listPods: async () => ({ items: [pod], continueToken: "pods-next" }),
    listEvents: async () => { throw Object.assign(new Error("server details"), { code: 403 }); },
    listServices: async () => ({ items: [service], continueToken: "services-next" }),
    listEndpointSlices: async () => ({ items: [endpointSlice], continueToken: "endpoints-next" }),
  });

  const result = await getWorkloadSnapshot(client, "default", { namespace: "apps", kind: "Deployment", name: "api" });
  const text = JSON.stringify(result);
  assert.equal(result.status, "partial");
  assert.match(text, /api-pod/);
  assert.match(text, /api-rs/);
  assert.match(text, /10\.0\.0\.8/);
  assert.match(text, /pods-next/);
  assert.match(text, /services-next/);
  assert.match(text, /endpoints-next/);
  const sections = result.sections as Record<string, { status?: string }>;
  assert.equal(sections.controllers?.status, "truncated");
  assert.equal(sections.pods?.status, "truncated");
  assert.equal(sections.endpointSlices?.status, "truncated");
  assert.match(text, /Kubernetes RBAC denied/);
  assert.match(text, /\[REDACTED\]/);
  assert.doesNotMatch(text, /"value":"hidden"/);
});

test("workload snapshot keeps the target when related Pod discovery is forbidden", async () => {
  const deployment = { metadata: { name: "api", namespace: "apps", uid: "dep-1" }, spec: { template: { metadata: {}, spec: { containers: [{ name: "api" }] } } } } as V1Deployment;
  const client = fakeClient({
    getWorkload: async () => deployment,
    listPods: async () => { throw Object.assign(new Error("denied"), { code: 403 }); },
  });

  const result = await getWorkloadSnapshot(client, "default", { namespace: "apps", kind: "Deployment", name: "api" });
  const text = JSON.stringify(result);
  assert.equal(result.status, "partial");
  assert.match(text, /"workload":\{"status":"ok"/);
  assert.match(text, /"pods":\{"status":"forbidden"/);
});

test("Ingress host/path lookup traces Service and EndpointSlice while hiding risky annotations", async () => {
  const ingress = { metadata: { name: "api", namespace: "apps", annotations: { "nginx.ingress.kubernetes.io/rewrite-target": "/$1", "nginx.ingress.kubernetes.io/server-snippet": "secret config" } }, spec: { ingressClassName: "nginx", rules: [{ host: "api.example.com", http: { paths: [{ path: "/v1", pathType: "Prefix", backend: { service: { name: "api", port: { number: 80 } } } }] } }] } } as V1Ingress;
  const service = { metadata: { name: "api", namespace: "apps" }, spec: { selector: { app: "api" }, ports: [{ port: 80 }] } } as V1Service;
  const pod = { metadata: { name: "api-1", namespace: "apps", labels: { app: "api" } }, spec: { containers: [{ name: "api", image: "api:1" }] } } as V1Pod;
  const endpointSlice = { metadata: { name: "api-abc", namespace: "apps" }, addressType: "IPv4", endpoints: [{ addresses: ["10.0.0.1"], conditions: { ready: true }, targetRef: { kind: "Pod", namespace: "apps", name: "api-1" } }], ports: [{ port: 8080 }] } as V1EndpointSlice;
  const client = fakeClient({ listIngresses: async () => ({ items: [ingress] }), getService: async () => service, listPods: async () => ({ items: [pod] }), listEndpointSlices: async () => ({ items: [endpointSlice] }) });

  const result = await getIngressSnapshot(client, "default", { host: "api.example.com", path: "/v1/users" });
  const text = JSON.stringify(result);
  assert.equal(result.status, "complete");
  assert.match(text, /api\.example\.com/);
  assert.match(text, /10\.0\.0\.1/);
  assert.match(text, /\/\$1/);
  assert.doesNotMatch(text, /secret config/);
});

test("Ingress snapshot propagates a partial backend Service snapshot", async () => {
  const ingress = { metadata: { name: "api", namespace: "apps" }, spec: { rules: [{ host: "api.example.com", http: { paths: [{ path: "/", pathType: "Prefix", backend: { service: { name: "api", port: { number: 80 } } } }] } }] } } as V1Ingress;
  const service = { metadata: { name: "api", namespace: "apps" }, spec: { selector: { app: "api" }, ports: [{ port: 80 }] } } as V1Service;
  const client = fakeClient({
    listIngresses: async () => ({ items: [ingress] }),
    getService: async () => service,
    listEndpointSlices: async () => { throw Object.assign(new Error("denied"), { code: 403 }); },
  });

  const result = await getIngressSnapshot(client, "default", { host: "api.example.com" });
  assert.equal(result.status, "partial");
  assert.match(JSON.stringify(result), /"status":"partial","data":/);
});

test("Ingress host lookup does not claim not-found when the scan has another page", async () => {
  const client = fakeClient({ listIngresses: async () => ({ items: [], continueToken: "ingress-next" }) });
  const result = await getIngressSnapshot(client, "default", { host: "missing.example.com" });
  assert.equal(result.status, "partial");
  assert.match(JSON.stringify(result), /ingress-next/);
  assert.deepEqual(result.matches, []);
});

test("Ingress route ordering prefers Exact and treats ingress-nginx regex paths as candidates", async () => {
  const exactIngress = { metadata: { name: "api", namespace: "apps" }, spec: { rules: [{ host: "api.example.com", http: { paths: [
    { path: "/api", pathType: "Prefix", backend: { service: { name: "prefix", port: { number: 80 } } } },
    { path: "/api", pathType: "Exact", backend: { service: { name: "exact", port: { number: 80 } } } },
  ] } }] } } as V1Ingress;
  const exactClient = fakeClient({ listIngresses: async () => ({ items: [exactIngress] }), getService: async (_namespace, name) => ({ metadata: { name, namespace: "apps" }, spec: {} } as V1Service) });
  const exact = await getIngressSnapshot(exactClient, "default", { host: "api.example.com", path: "/api" }) as { matches?: Array<{ routeMatches?: Array<{ pathType?: string }> }> };
  assert.deepEqual(exact.matches?.[0]?.routeMatches?.map(({ pathType }) => pathType), ["Exact", "Prefix"]);

  const regexIngress = { metadata: { name: "regex", namespace: "apps", annotations: { "nginx.ingress.kubernetes.io/use-regex": "true" } }, spec: { rules: [{ host: "api.example.com", http: { paths: [{ path: "/api/(.*)", pathType: "Prefix", backend: { service: { name: "regex", port: { number: 80 } } } }] } }] } } as V1Ingress;
  const regexClient = fakeClient({ listIngresses: async () => ({ items: [regexIngress] }), getService: async () => ({ metadata: { name: "regex", namespace: "apps" }, spec: {} } as V1Service) });
  const regex = JSON.stringify(await getIngressSnapshot(regexClient, "default", { host: "api.example.com", path: "/api/users" }));
  assert.match(regex, /"match":"candidate"/);
});

test("Ingress snapshots enforce one shared four-request concurrency budget", async () => {
  const ingress = { metadata: { name: "routes", namespace: "apps" }, spec: { rules: [{ host: "api.example.com", http: { paths: ["one", "two", "three", "four"].map((name) => ({ path: `/${name}`, pathType: "Prefix", backend: { service: { name, port: { number: 80 } } } })) } }] } } as V1Ingress;
  const base = fakeClient({
    listIngresses: async () => ({ items: [ingress] }),
    getService: async (_namespace, name) => ({ metadata: { name, namespace: "apps" }, spec: { selector: { app: name }, ports: [{ port: 80 }] } } as V1Service),
  });
  let active = 0;
  let maximum = 0;
  const tracked = new Proxy(base, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        try { return await Reflect.apply(value, target, args) as unknown; } finally { active -= 1; }
      };
    },
  }) as KubernetesReadClient;

  await getIngressSnapshot(tracked, "default", { host: "api.example.com" });
  assert.ok(maximum <= 4, `observed ${maximum} concurrent requests`);
});

test("workload list requires explicit allNamespaces instead of treating an omitted namespace as cluster-wide", async () => {
  let observedNamespace: string | undefined;
  const client = fakeClient({ listWorkloads: async (_kind, options) => { observedNamespace = options.namespace; return { items: [] }; } });
  await listWorkloads(client, "apps", { kind: "Pod", limit: 50 });
  assert.equal(observedNamespace, "apps");
  await assert.rejects(listWorkloads(client, "apps", { kind: "Pod", namespace: "apps", allNamespaces: true, limit: 50 }), /mutually exclusive/);
});

function fakeClient(overrides: Partial<KubernetesReadClient>): KubernetesReadClient {
  const emptyPage = async () => ({ items: [] });
  const empty = async () => [];
  const missing = async () => { throw Object.assign(new Error("not found"), { code: 404 }); };
  return {
    getVersion: async () => ({ major: "1", minor: "23", gitVersion: "v1.23.17", gitCommit: "test", gitTreeState: "clean", buildDate: "", goVersion: "", compiler: "", platform: "" }),
    getApiVersions: async () => ({}),
    listNamespaces: emptyPage,
    listWorkloads: emptyPage,
    getWorkload: missing,
    listPods: emptyPage,
    listReplicaSets: emptyPage,
    listJobs: emptyPage,
    getNode: missing,
    getPersistentVolumeClaim: missing,
    getPersistentVolume: missing,
    getStorageClass: missing,
    listServices: emptyPage,
    getService: missing,
    listEndpointSlices: emptyPage,
    listIngresses: emptyPage,
    getIngress: missing,
    listEvents: emptyPage,
    listHpas: emptyPage,
    listPdbs: emptyPage,
    listNetworkPolicies: emptyPage,
    getPodLogs: async () => "",
    ...overrides,
  } as KubernetesReadClient;
}
