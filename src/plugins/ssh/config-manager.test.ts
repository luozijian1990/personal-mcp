import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { createRuntimeConfigStore } from "../../core/runtime-config.js";
import { createSshConfigManager } from "./config-manager.js";

async function credentialFixture(context: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "personal-mcp-ssh-config-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const privateKeyPath = path.join(directory, "agent_ops_key");
  const knownHostsPath = path.join(directory, "known_hosts");
  const runtimePath = path.join(directory, "runtime.json");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  await Promise.all([
    writeFile(privateKeyPath, privateKey.export({ type: "pkcs1", format: "pem" })),
    writeFile(knownHostsPath, [
      "[test-host]:2222 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest",
      "[second-host]:2200 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAISecond",
      "",
    ].join("\n")),
  ]);
  return { privateKeyPath, knownHostsPath, runtimePath };
}

test("SSH config manager validates, persists, and rebuilds its plugin", async (context) => {
  const fixture = await credentialFixture(context);
  const store = createRuntimeConfigStore({ environment: {}, filePath: fixture.runtimePath });
  const manager = createSshConfigManager(store);

  const update = await manager.update({ values: {
    SSH_MCP_ALLOWED_TARGETS: "test-host, second-host",
    SSH_MCP_USERNAME: "deploy",
    SSH_MCP_PORTS: "2222,2200",
    SSH_MCP_ALLOW_COMMANDS: true,
    SSH_MCP_PRIVATE_KEY_PATH: fixture.privateKeyPath,
    SSH_MCP_KNOWN_HOSTS_PATH: fixture.knownHostsPath,
  } });

  assert.equal(update.plugin.id, "ssh");
  assert.equal(update.snapshot.revision, 1);
  assert.equal(update.snapshot.values.SSH_MCP_ALLOWED_TARGETS, "test-host,second-host");
  assert.deepEqual(new Set(update.changedKeys), new Set([
    "SSH_MCP_ALLOWED_TARGETS",
    "SSH_MCP_USERNAME",
    "SSH_MCP_PORTS",
    "SSH_MCP_ALLOW_COMMANDS",
    "SSH_MCP_PRIVATE_KEY_PATH",
    "SSH_MCP_KNOWN_HOSTS_PATH",
  ]));
  assert.equal(
    (JSON.parse(await readFile(fixture.runtimePath, "utf8")) as Record<string, string>)
      .SSH_MCP_ALLOW_COMMANDS,
    "true",
  );
});

test("SSH config manager rejects unreadable credentials before persistence", async (context) => {
  const fixture = await credentialFixture(context);
  const store = createRuntimeConfigStore({ environment: {}, filePath: fixture.runtimePath });
  const manager = createSshConfigManager(store);

  await assert.rejects(
    manager.update({ values: {
      SSH_MCP_ALLOWED_TARGETS: "test-host",
      SSH_MCP_USERNAME: "deploy",
      SSH_MCP_PORTS: "2222,2200",
      SSH_MCP_ALLOW_COMMANDS: false,
      SSH_MCP_PRIVATE_KEY_PATH: path.join(path.dirname(fixture.privateKeyPath), "missing-key"),
      SSH_MCP_KNOWN_HOSTS_PATH: fixture.knownHostsPath,
    } }),
    /Unable to read SSH credential files/,
  );
  await assert.rejects(readFile(fixture.runtimePath), /ENOENT/);
  assert.equal(manager.getSnapshot().revision, 0);
});

test("SSH config manager requires a host key for every allowed target", async (context) => {
  const fixture = await credentialFixture(context);
  const store = createRuntimeConfigStore({ environment: {}, filePath: fixture.runtimePath });
  const manager = createSshConfigManager(store);

  await assert.rejects(
    manager.update({ values: {
      SSH_MCP_ALLOWED_TARGETS: "unknown-host",
      SSH_MCP_USERNAME: "deploy",
      SSH_MCP_PORTS: "2222,2200",
      SSH_MCP_ALLOW_COMMANDS: false,
      SSH_MCP_PRIVATE_KEY_PATH: fixture.privateKeyPath,
      SSH_MCP_KNOWN_HOSTS_PATH: fixture.knownHostsPath,
    } }),
    /known_hosts has no entry for unknown-host on configured ports: 2222,2200/,
  );
  await assert.rejects(readFile(fixture.runtimePath), /ENOENT/);
});

test("SSH config manager rejects invalid usernames and ports", async (context) => {
  const fixture = await credentialFixture(context);
  const store = createRuntimeConfigStore({ environment: {}, filePath: fixture.runtimePath });
  const manager = createSshConfigManager(store);
  const baseValues = {
    SSH_MCP_ALLOWED_TARGETS: "test-host",
    SSH_MCP_ALLOW_COMMANDS: false,
    SSH_MCP_PRIVATE_KEY_PATH: fixture.privateKeyPath,
    SSH_MCP_KNOWN_HOSTS_PATH: fixture.knownHostsPath,
  };

  await assert.rejects(
    manager.update({ values: {
      ...baseValues,
      SSH_MCP_USERNAME: "user@example.com",
      SSH_MCP_PORTS: "2222",
    } }),
    /valid SSH username/,
  );
  await assert.rejects(
    manager.update({ values: {
      ...baseValues,
      SSH_MCP_USERNAME: "deploy",
      SSH_MCP_PORTS: "22,70000",
    } }),
    /Invalid SSH port: 70000/,
  );
  await assert.rejects(readFile(fixture.runtimePath), /ENOENT/);
});
