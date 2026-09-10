import assert from "node:assert/strict";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createKubernetesConfigManager } from "./config-manager.js";

test("Kubernetes config manager validates and persists an explicit kubeconfig context", async (context) => {
  const kubeconfigPath = path.join(tmpdir(), `.kubernetes-manager-${process.pid}`);
  context.after(() => unlink(kubeconfigPath).catch(() => undefined));
  await writeFile(kubeconfigPath, "apiVersion: v1\nkind: Config\nclusters:\n- name: cluster\n  cluster:\n    server: https://cluster.example.com\nusers:\n- name: reader\n  user: {}\ncontexts:\n- name: readonly\n  context:\n    cluster: cluster\n    user: reader\ncurrent-context: another-context\n");
  let environment: NodeJS.ProcessEnv = {};
  const writes: Record<string, string>[] = [];
  const manager = createKubernetesConfigManager({
    environment: () => ({ ...environment }),
    update: async (values) => {
      writes.push({ ...values });
      environment = { ...environment, ...values };
    },
  });

  const update = await manager.update({ values: {
    KUBERNETES_KUBECONFIG_PATH: kubeconfigPath,
    KUBERNETES_CONTEXT: "readonly",
    KUBERNETES_DEFAULT_NAMESPACE: "apps",
  } });
  assert.deepEqual(update.changedKeys, ["KUBERNETES_KUBECONFIG_PATH", "KUBERNETES_CONTEXT", "KUBERNETES_DEFAULT_NAMESPACE"]);
  assert.equal(writes[0]?.KUBERNETES_CONTEXT, "readonly");
  assert.equal(update.snapshot.values.KUBERNETES_DEFAULT_NAMESPACE, "apps");

  await assert.rejects(manager.update({ values: { KUBERNETES_UNKNOWN: "value" } }), /Unknown Kubernetes configuration field/);
  assert.equal(writes.length, 1);
});
