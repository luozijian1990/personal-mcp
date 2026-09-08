import assert from "node:assert/strict";
import test from "node:test";

import { McpRegistry } from "./mcp-registry.js";
import { createSshPlugin } from "../plugins/ssh/index.js";

function sshPlugin(summary?: string) {
  const plugin = createSshPlugin({
    config: { allowedTargets: new Set(), allowCommands: false, ports: [] },
  });
  return summary === undefined ? plugin : { ...plugin, summary };
}

test("registry atomically replaces a plugin while preserving its mount path", () => {
  const initial = sshPlugin("initial");
  const replacement = sshPlugin("replacement");
  const registry = new McpRegistry([{ path: "/ssh/mcp", plugin: initial }]);

  registry.replace("ssh", replacement);

  assert.equal(registry.get("ssh")?.path, "/ssh/mcp");
  assert.equal(registry.get("ssh")?.plugin, replacement);
  assert.equal(initial.summary, "initial");
});

test("registry enforces plugin ids and canonical MCP paths", () => {
  assert.throws(
    () => new McpRegistry([{ path: "/mcp/ssh", plugin: sshPlugin() }]),
    /expected \/ssh\/mcp/,
  );
  const registry = new McpRegistry([{ path: "/ssh/mcp", plugin: sshPlugin() }]);
  assert.throws(
    () => registry.replace("missing", sshPlugin()),
    /unknown MCP plugin/,
  );
});

test("registry rejects duplicate plugin ids and mount paths", () => {
  const first = sshPlugin("first");
  const second = sshPlugin("second");
  assert.throws(
    () => new McpRegistry([{ path: "/ssh/mcp", plugin: first }, { path: "/ssh/mcp", plugin: second }]),
    /Duplicate MCP plugin id: ssh/,
  );
  assert.throws(
    () => new McpRegistry([
      { path: "/ssh/mcp", plugin: first },
      { path: "/ssh/mcp", plugin: { ...second, id: "other" } },
    ]),
    /Duplicate MCP mount path: \/ssh\/mcp/,
  );
});
