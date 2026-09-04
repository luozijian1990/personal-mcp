import assert from "node:assert/strict";
import test from "node:test";

import {
  knownHostKeysFor,
  runSsh,
  selectSshPort,
  targetHost,
  type SshPortAttempt,
} from "./ssh-runner.js";

test("targetHost strips a legacy username and IPv6 brackets", () => {
  assert.equal(targetHost("ops@example.com"), "example.com");
  assert.equal(targetHost("[2001:db8::1]"), "2001:db8::1");
  assert.equal(targetHost("agent-ops@[2001:db8::1]"), "2001:db8::1");
});

test("knownHostKeysFor matches a configured nonstandard SSH port", () => {
  const content = [
    "example.com ssh-ed25519 key-on-port-22",
    "[example.com]:2222 ssh-ed25519 key-on-port-2222",
    "[other.example.com]:2222 ssh-ed25519 other-key",
  ].join("\n");

  assert.deepEqual([...knownHostKeysFor(content, "example.com", 2222)], [
    "key-on-port-2222",
  ]);
});

test("runSsh does not fall back to a machine-specific credential path", async () => {
  const result = await runSsh({
    target: "example.com",
    command: "id",
    timeoutSeconds: 5,
    maxOutputCharacters: 1_000,
  });

  assert.equal(result.exitCode, 255);
  assert.equal(result.stderr, "SSH username, ports, and credential paths must be configured");
  assert.equal(result.port, null);
  assert.deepEqual(result.attemptedPorts, []);
});

test("selectSshPort tries configured ports in order and stops after connecting", async () => {
  const calls: number[] = [];
  const failedAttempt: SshPortAttempt = {
    connected: false,
    stdout: "",
    stderr: "connection refused",
    exitCode: 255,
    signal: null,
    outputTruncated: false,
  };
  const connectedAttempt: SshPortAttempt = {
    connected: true,
    stdout: "",
    stderr: "remote command failed",
    exitCode: 9,
    signal: null,
    outputTruncated: false,
  };

  const result = await selectSshPort(
    [22, 2222, 2200, 2022],
    (port) => port === 22 ? new Set() : new Set([`key-${port}`]),
    async (port) => {
      calls.push(port);
      return port === 2200 ? connectedAttempt : failedAttempt;
    },
  );

  assert.deepEqual(result.attemptedPorts, [22, 2222, 2200]);
  assert.deepEqual(calls, [2222, 2200]);
  assert.equal(result.port, 2200);
  assert.equal(result.attempt?.exitCode, 9);
});
