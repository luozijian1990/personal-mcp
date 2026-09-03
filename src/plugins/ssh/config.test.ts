import assert from "node:assert/strict";
import test from "node:test";

import { loadSshPluginConfig } from "./config.js";

test("loads and trims the SSH target allowlist", () => {
  const config = loadSshPluginConfig({
    SSH_MCP_ALLOWED_TARGETS: "dev, ops@example.com,dev",
    SSH_MCP_ALLOW_COMMANDS: "true",
  });

  assert.deepEqual([...config.allowedTargets], ["dev", "ops@example.com"]);
  assert.equal(config.allowCommands, true);
});

test("keeps arbitrary commands disabled by default", () => {
  const config = loadSshPluginConfig({});

  assert.equal(config.allowedTargets.size, 0);
  assert.equal(config.allowCommands, false);
});
