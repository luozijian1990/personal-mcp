import assert from "node:assert/strict";
import test from "node:test";
import { McpRegistry } from "./mcp-registry.js";
import { resolvePluginHealth } from "./plugin-health.js";
import type {
  PersonalMcpPlugin,
  PluginHealth,
  PluginHealthState,
} from "./plugin.js";

const PLUGIN_HEALTH_STATES: readonly PluginHealthState[] = [
  "unknown",
  "unconfigured",
  "healthy",
  "degraded",
  "unhealthy",
];

test("a Plugin without a health check remains registered with unknown health", async () => {
  const plugin = testPlugin("optional");
  const registry = new McpRegistry([{ path: "/optional/mcp", plugin }]);

  assert.equal(registry.get("optional")?.plugin, plugin);
  assert.deepEqual(await resolvePluginHealth(plugin), { state: "unknown" });
});

test("Plugin health supports every state and optional observations", async () => {
  for (const state of PLUGIN_HEALTH_STATES) {
    const health = await resolvePluginHealth(testPlugin(state, async () => ({ state })));
    assert.equal(health.state, state);
    assert.equal(typeof health.latencyMs, "number");
    assert.ok(health.checkedAt !== undefined && !Number.isNaN(Date.parse(health.checkedAt)));
  }

  const observed: PluginHealth = {
    state: "degraded",
    message: "Backend is responding slowly",
    latencyMs: 125.5,
    checkedAt: "2026-09-09T01:02:03.000Z",
  };
  assert.deepEqual(
    await resolvePluginHealth(testPlugin("observed", () => observed)),
    observed,
  );

  const healthWithExtraData = await resolvePluginHealth(testPlugin("extra-data", () => ({
    state: "healthy",
    unexpectedSecret: "must-not-reach-status",
  } as PluginHealth & { readonly unexpectedSecret: string })));
  assert.deepEqual(Object.keys(healthWithExtraData).sort(), ["checkedAt", "latencyMs", "state"]);
});

test("health-check failures are contained and do not stop other Plugin checks", async () => {
  const failures: unknown[] = [];
  const [failed, healthy] = await Promise.all([
    resolvePluginHealth(testPlugin("failed", () => { throw new Error("backend unavailable"); }), {
      onFailure: (error) => {
        failures.push(error);
        throw new Error("observer unavailable");
      },
    }),
    resolvePluginHealth(testPlugin("healthy", async () => ({ state: "healthy" }))),
  ]);

  assert.equal(failed.state, "unhealthy");
  assert.equal(failed.message, "Health check failed");
  assert.equal(healthy.state, "healthy");
  assert.equal(failures.length, 1);
});

test("a hanging health check is aborted and cannot hold the Runtime status open", async () => {
  let observedSignal: AbortSignal | undefined;
  const health = await resolvePluginHealth(testPlugin("hanging", (signal) => {
    observedSignal = signal;
    return new Promise(() => undefined);
  }), { timeoutMs: 5 });

  assert.equal(health.state, "unhealthy");
  assert.equal(observedSignal?.aborted, true);
  assert.ok((health.latencyMs ?? 0) >= 0);
  assert.ok(health.checkedAt !== undefined);
});

function testPlugin(
  id: string,
  checkHealth?: (signal: AbortSignal) => PluginHealth | Promise<PluginHealth>,
): PersonalMcpPlugin {
  const plugin: PersonalMcpPlugin = {
    id,
    displayName: id,
    summary: "Health test Plugin",
    category: { id: "test", name: "Test", description: "Test Plugins" },
    tools: [],
    createServer: () => ({}) as never,
    ...(checkHealth === undefined ? {} : { checkHealth }),
  };
  return plugin;
}
