import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createRuntimeConfigStore } from "./runtime-config.js";

test("runtime config persists UI values and loads them over startup defaults", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "personal-mcp-config-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "runtime.json");
  const store = createRuntimeConfigStore({
    environment: { SSH_MCP_ALLOWED_TARGETS: "startup-host" },
    filePath,
  });

  await Promise.all([
    store.update({ SSH_MCP_ALLOWED_TARGETS: "ui-host" }),
    store.update({ SSH_MCP_ALLOW_COMMANDS: "true" }),
  ]);

  assert.equal(store.environment().SSH_MCP_ALLOWED_TARGETS, "ui-host");
  assert.equal(store.environment().SSH_MCP_ALLOW_COMMANDS, "true");
  assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), {
    SSH_MCP_ALLOWED_TARGETS: "ui-host",
    SSH_MCP_ALLOW_COMMANDS: "true",
  });

  const reloaded = createRuntimeConfigStore({
    environment: { SSH_MCP_ALLOWED_TARGETS: "new-startup-host" },
    filePath,
  });
  assert.equal(reloaded.environment().SSH_MCP_ALLOWED_TARGETS, "ui-host");
});

