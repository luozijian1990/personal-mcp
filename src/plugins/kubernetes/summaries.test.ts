import { ObjectSerializer } from "@kubernetes/client-node/dist/gen/models/ObjectSerializer.js";
import { toolStructuredResult } from "../../core/tool-result.js";
import assert from "node:assert/strict";
import test from "node:test";
import type { V1Ingress, V1Pod } from "@kubernetes/client-node";

import {
  ingressHostMatches,
  ingressPathMatches,
  ingressSummary,
  podSummary,
  workloadSummary,
  nodeSummary,
  resourceQuotaSummary,
} from "./summaries.js";

test("Pod summaries redact literal environment values and expose only Secret/ConfigMap references", () => {
  const pod = {
    metadata: { name: "api-1", namespace: "apps" },
    spec: {
      containers: [{
        name: "api",
        image: "example/api:1",
        env: [
          { name: "PASSWORD", value: "must-not-leak" },
          { name: "TOKEN", valueFrom: { secretKeyRef: { name: "api-secret", key: "token" } } },
          { name: "MODE", valueFrom: { configMapKeyRef: { name: "api-config", key: "mode" } } },
        ],
      }],
      volumes: [
        { name: "secret", secret: { secretName: "volume-secret" } },
        { name: "config", configMap: { name: "volume-config" } },
      ],
    },
  } as V1Pod;

  const text = JSON.stringify(podSummary(pod));
  assert.doesNotMatch(text, /must-not-leak/);
  assert.match(text, /\[REDACTED\]/);
  assert.match(text, /api-secret/);
  assert.match(text, /api-config/);
  assert.match(text, /volume-secret/);
  assert.match(text, /volume-config/);
});

test("Ingress summaries reveal audited ingress-nginx annotations and hide risky values", () => {
  const ingress = {
    metadata: {
      name: "api",
      namespace: "apps",
      annotations: {
        "nginx.ingress.kubernetes.io/rewrite-target": "/$1",
        "nginx.ingress.kubernetes.io/configuration-snippet": "proxy_set_header Authorization secret;",
        "example.com/private": "hidden-value",
      },
    },
    spec: { tls: [{ hosts: ["api.example.com"], secretName: "api-tls" }] },
  } as V1Ingress;

  const text = JSON.stringify(ingressSummary(ingress));
  assert.match(text, /\/\$1/);
  assert.match(text, /api-tls/);
  assert.doesNotMatch(text, /Authorization secret/);
  assert.doesNotMatch(text, /hidden-value/);
  assert.equal((text.match(/\[PRESENT\]/g) ?? []).length, 2);
});

test("Ingress host and path matching follows Kubernetes declaration semantics", () => {
  assert.equal(ingressHostMatches(undefined, "api.example.com"), true);
  assert.equal(ingressHostMatches("API.EXAMPLE.COM.", "api.example.com"), true);
  assert.equal(ingressHostMatches("*.example.com", "api.example.com"), true);
  assert.equal(ingressHostMatches("*.example.com", "deep.api.example.com"), false);
  assert.equal(ingressHostMatches("*.example.com", "example.com"), false);
  assert.equal(ingressPathMatches("/api", "Exact", "/api/health"), "none");
  assert.equal(ingressPathMatches("/api", "Prefix", "/api/health"), "match");
  assert.equal(ingressPathMatches("/api", "Prefix", "/apiv2"), "none");
  assert.equal(ingressPathMatches("/api/(.*)", "ImplementationSpecific", "/api/users"), "candidate");
});

test("Pod and workload templates retain diagnostic targets while hiding probe credentials", () => {
  const spec: NonNullable<V1Pod["spec"]> = {
    imagePullSecrets: [{ name: "registry-reader" }],
    nodeSelector: { pool: "apps" },
    tolerations: [{ key: "dedicated", operator: "Equal", value: "apps", effect: "NoSchedule" }],
    containers: [{
      name: "api",
      ports: [{ name: "http", containerPort: 8080 }],
      volumeMounts: [{ name: "config", mountPath: "/etc/app", subPath: "app.yaml", readOnly: true }],
      readinessProbe: { httpGet: { path: "/ready", port: "http", httpHeaders: [{ name: "Authorization", value: "probe-secret" }] } },
      livenessProbe: { tcpSocket: { port: 8080 }, initialDelaySeconds: 20 },
      startupProbe: { exec: { command: ["sh", "-c", "check --token=exec-secret"] } },
    }],
    initContainers: [{ name: "init", readinessProbe: { grpc: { port: 9000, service: "health" } } }],
  };
  for (const summary of [podSummary({ spec }), workloadSummary("Deployment", { spec: { selector: {}, template: { spec } } })]) {
    const text = JSON.stringify(summary);
    assert.match(text, /registry-reader/);
    assert.match(text, /"containerPort":8080/);
    assert.match(text, /"mountPath":"\/etc\/app"/);
    assert.match(text, /"path":"\/ready","port":"http"/);
    assert.match(text, /"tcpSocket":\{"port":8080\}/);
    assert.match(text, /"grpc":\{"port":9000,"service":"health"\}/);
    assert.match(text, /"nodeSelector":\{"pool":"apps"\}/);
    assert.doesNotMatch(text, /probe-secret|exec-secret/);
  }
});

test("SDK scheduling and quota models produce plain structured MCP results", () => {
  const scheduling = {
    containers: [{ name: "api" }],
    affinity: { nodeAffinity: { requiredDuringSchedulingIgnoredDuringExecution: { nodeSelectorTerms: [{ matchExpressions: [{ key: "pool", operator: "In", values: ["apps"] }] }] } } },
    tolerations: [{ key: "not-ready", operator: "Exists", effect: "NoExecute", tolerationSeconds: 300 }],
    topologySpreadConstraints: [{ maxSkew: 1, topologyKey: "zone", whenUnsatisfiable: "DoNotSchedule", labelSelector: { matchLabels: { app: "api" } } }],
    schedulingGates: [{ name: "example.com/ready" }],
  };
  const fixtures = [
    podSummary(ObjectSerializer.deserialize({ spec: scheduling }, "V1Pod", "")),
    workloadSummary("Deployment", ObjectSerializer.deserialize({ spec: { template: { spec: scheduling } } }, "V1Deployment", "")),
    nodeSummary(ObjectSerializer.deserialize({ spec: { taints: [{ key: "dedicated", effect: "NoExecute", timeAdded: "2026-09-11T00:00:00Z" }] } }, "V1Node", "")),
    resourceQuotaSummary(ObjectSerializer.deserialize({ spec: { scopeSelector: { matchExpressions: [{ scopeName: "PriorityClass", operator: "In", values: ["high"] }] } } }, "V1ResourceQuota", "")),
  ];
  for (const summary of fixtures) {
    assert.doesNotThrow(() => toolStructuredResult(summary));
    assert.deepEqual(summary, JSON.parse(JSON.stringify(summary)));
  }
  assert.match(JSON.stringify(fixtures[0]), /nodeSelectorTerms/);
  assert.match(JSON.stringify(fixtures[0]), /example.com\/ready/);
  assert.match(JSON.stringify(fixtures[2]), /2026-09-11T00:00:00.000Z/);
  assert.match(JSON.stringify(fixtures[3]), /PriorityClass/);
});
