import assert from "node:assert/strict";
import test from "node:test";
import type { V1Ingress, V1Pod } from "@kubernetes/client-node";

import {
  ingressHostMatches,
  ingressPathMatches,
  ingressSummary,
  podSummary,
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
