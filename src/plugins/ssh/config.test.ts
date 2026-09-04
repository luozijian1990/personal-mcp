import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";

import { loadSshPluginConfig } from "./config.js";

test("loads and trims the SSH target allowlist", () => {
  const config = loadSshPluginConfig({
    SSH_MCP_ALLOWED_TARGETS: "dev, ops@example.com,dev",
    SSH_MCP_ALLOW_COMMANDS: "true",
    SSH_MCP_USERNAME: " deploy ",
    SSH_MCP_PORTS: "22, 2222,22",
  });

  assert.deepEqual([...config.allowedTargets], ["dev", "ops@example.com"]);
  assert.equal(config.allowCommands, true);
  assert.equal(config.username, "deploy");
  assert.deepEqual(config.ports, [22, 2222]);
});

test("keeps arbitrary commands disabled by default", () => {
  const config = loadSshPluginConfig({});

  assert.equal(config.allowedTargets.size, 0);
  assert.equal(config.allowCommands, false);
  assert.equal(config.username, undefined);
  assert.deepEqual(config.ports, []);
  assert.equal(config.privateKeyPath, undefined);
  assert.equal(config.knownHostsPath, undefined);
});

test("expands home-relative credential paths", () => {
  const config = loadSshPluginConfig({
    SSH_MCP_PRIVATE_KEY_PATH: "~/.ssh/agent_ops_key",
    SSH_MCP_KNOWN_HOSTS_PATH: "~/.ssh/known_hosts.custom",
  });

  assert.equal(config.privateKeyPath, path.join(os.homedir(), ".ssh", "agent_ops_key"));
  assert.equal(config.knownHostsPath, path.join(os.homedir(), ".ssh", "known_hosts.custom"));
});
