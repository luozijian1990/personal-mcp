import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

import type { SshPluginConfig } from "./config.js";

const PROCESS_OUTPUT_LIMIT_CHARACTERS = 1_048_576;
const CONNECT_TIMEOUT_MS = 10_000;

export interface SshRunRequest {
  readonly target: string;
  readonly command: string;
  readonly timeoutSeconds: number;
  readonly maxOutputCharacters: number;
}

export interface SshRunResult {
  readonly target: string;
  readonly username: string;
  readonly port: number | null;
  readonly attemptedPorts: readonly number[];
  readonly command: string;
  readonly exitCode: number;
  readonly signal: string | null;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly outputTruncated: boolean;
}

export type SshExecutor = (request: SshRunRequest) => Promise<SshRunResult>;

export interface SshPortAttempt {
  readonly connected: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly signal: string | null;
  readonly outputTruncated: boolean;
}

interface SshResultConnection {
  readonly username: string;
  readonly port: number | null;
  readonly attemptedPorts: readonly number[];
}

export interface SshPortSelection {
  readonly port: number | null;
  readonly attemptedPorts: readonly number[];
  readonly attempt?: SshPortAttempt;
  readonly failures: readonly string[];
}

/** Try configured ports in order and execute the command once after SSH connects. */
export async function runSsh(
  request: SshRunRequest,
  config: Partial<Pick<
    SshPluginConfig,
    "username" | "ports" | "privateKeyPath" | "knownHostsPath"
  >> = {},
): Promise<SshRunResult> {
  const startedAt = performance.now();
  const host = targetHost(request.target);
  const username = config.username ?? "";
  const ports = config.ports ?? [];
  const emptyConnection = { username, port: null, attemptedPorts: [] };

  if (host.length === 0) {
    return makeResult(
      request,
      "",
      "SSH target must contain a host",
      255,
      null,
      startedAt,
      false,
      emptyConnection,
    );
  }
  if (request.command.includes("\0")) {
    return makeResult(
      request,
      "",
      "SSH command must not contain NUL bytes",
      255,
      null,
      startedAt,
      false,
      emptyConnection,
    );
  }
  if (
    username.length === 0
    || ports.length === 0
    || config.privateKeyPath === undefined
    || config.knownHostsPath === undefined
  ) {
    return makeResult(
      request,
      "",
      "SSH username, ports, and credential paths must be configured",
      255,
      null,
      startedAt,
      false,
      emptyConnection,
    );
  }

  let privateKey: Buffer;
  let knownHosts: string;
  try {
    [privateKey, knownHosts] = await Promise.all([
      readFile(config.privateKeyPath),
      readFile(config.knownHostsPath, "utf8"),
    ]);
  } catch (error) {
    return makeResult(
      request,
      "",
      `Unable to load SSH credentials or known_hosts: ${errorMessage(error)}`,
      255,
      null,
      startedAt,
      false,
      emptyConnection,
    );
  }

  const selection = await selectSshPort(
    ports,
    (port) => knownHostKeysFor(knownHosts, host, port),
    (port, knownHostKeys) => attemptSshPort(
      request,
      host,
      username,
      port,
      privateKey,
      knownHostKeys,
    ),
  );
  if (selection.port !== null && selection.attempt !== undefined) {
    return makeResult(
      request,
      selection.attempt.stdout,
      selection.attempt.stderr,
      selection.attempt.exitCode,
      selection.attempt.signal,
      startedAt,
      selection.attempt.outputTruncated,
      { username, port: selection.port, attemptedPorts: selection.attemptedPorts },
    );
  }

  return makeResult(
    request,
    "",
    `Unable to connect to ${host} as ${username}; ${selection.failures.join("; ")}`,
    255,
    null,
    startedAt,
    false,
    { username, port: null, attemptedPorts: selection.attemptedPorts },
  );
}

export async function selectSshPort(
  ports: readonly number[],
  readKnownHostKeys: (port: number) => ReadonlySet<string>,
  attemptPort: (
    port: number,
    knownHostKeys: ReadonlySet<string>,
  ) => Promise<SshPortAttempt>,
): Promise<SshPortSelection> {
  const attemptedPorts: number[] = [];
  const failures: string[] = [];
  for (const port of ports) {
    attemptedPorts.push(port);
    const knownHostKeys = readKnownHostKeys(port);
    if (knownHostKeys.size === 0) {
      failures.push(`${port}: no matching known_hosts entry`);
      continue;
    }

    const attempt = await attemptPort(port, knownHostKeys);
    if (attempt.connected) {
      return { port, attemptedPorts, attempt, failures };
    }
    failures.push(`${port}: ${attempt.stderr}`);
  }
  return { port: null, attemptedPorts, failures };
}

async function attemptSshPort(
  request: SshRunRequest,
  host: string,
  username: string,
  port: number,
  privateKey: Buffer,
  knownHostKeys: ReadonlySet<string>,
): Promise<SshPortAttempt> {
  try {
    const { Client } = await import("ssh2");
    const connection = new Client();

    return await new Promise<SshPortAttempt>((resolve) => {
      let settled = false;
      let connected = false;
      let stdout = "";
      let stderr = "";
      let captureTruncated = false;
      let timeout: NodeJS.Timeout | undefined;

      const append = (current: string, chunk: Buffer | string): string => {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        if (current.length >= PROCESS_OUTPUT_LIMIT_CHARACTERS) {
          captureTruncated = true;
          return current;
        }
        const remaining = PROCESS_OUTPUT_LIMIT_CHARACTERS - current.length;
        if (text.length > remaining) captureTruncated = true;
        return current + text.slice(0, remaining);
      };

      const closeConnection = () => {
        try {
          connection.end();
        } catch {
          connection.destroy();
        }
      };

      const finish = (
        exitCode: number,
        signal: string | null,
        errorText?: string,
      ) => {
        if (settled) return;
        settled = true;
        if (errorText !== undefined && stderr.length === 0) stderr = errorText;
        if (timeout !== undefined) clearTimeout(timeout);
        closeConnection();
        resolve({
          connected,
          stdout,
          stderr,
          exitCode,
          signal,
          outputTruncated: captureTruncated,
        });
      };

      timeout = setTimeout(() => {
        finish(255, null, `SSH connection timed out after ${CONNECT_TIMEOUT_MS / 1_000} seconds`);
      }, CONNECT_TIMEOUT_MS);

      connection
        .on("ready", () => {
          connected = true;
          if (timeout !== undefined) clearTimeout(timeout);
          timeout = setTimeout(() => {
            finish(
              124,
              "SIGTERM",
              `SSH command timed out after ${request.timeoutSeconds} seconds`,
            );
          }, request.timeoutSeconds * 1_000);
          try {
            connection.exec(request.command, (error, stream) => {
              if (error !== undefined && error !== null) {
                finish(255, null, error.message);
                return;
              }
              if (stream === undefined) {
                finish(255, null, "SSH server did not create a command stream");
                return;
              }

              stream.on("data", (chunk: Buffer | string) => {
                stdout = append(stdout, chunk);
              });
              stream.stderr.on("data", (chunk: Buffer | string) => {
                stderr = append(stderr, chunk);
              });
              stream.on("error", (streamError: Error) => {
                finish(255, null, streamError.message);
              });
              stream.on("close", (code: number | null, signal: string | null) => {
                finish(code ?? 0, signal ?? null);
              });
            });
          } catch (error) {
            finish(255, null, errorMessage(error));
          }
        })
        .on("error", (error: Error) => {
          finish(255, null, error.message);
        })
        .on("close", () => {
          if (!settled) {
            finish(
              255,
              null,
              connected
                ? "SSH connection closed before the command completed"
                : "SSH connection closed before authentication completed",
            );
          }
        });

      try {
        connection.connect({
          host,
          port,
          username,
          privateKey,
          readyTimeout: CONNECT_TIMEOUT_MS,
          keepaliveInterval: 5_000,
          keepaliveCountMax: 2,
          hostVerifier: (key: Buffer) => knownHostKeys.has(key.toString("base64")),
        });
      } catch (error) {
        finish(255, null, errorMessage(error));
      }
    });
  } catch (error) {
    return {
      connected: false,
      stdout: "",
      stderr: errorMessage(error),
      exitCode: 255,
      signal: null,
      outputTruncated: false,
    };
  }
}

/** Convert an optional legacy user@host target to the host used by ssh2. */
export function targetHost(target: string): string {
  const atIndex = target.lastIndexOf("@");
  const host = atIndex >= 0 ? target.slice(atIndex + 1) : target;
  if (host.startsWith("[") && host.endsWith("]")) return host.slice(1, -1);
  return host;
}

export function knownHostKeysFor(
  content: string,
  host: string,
  port: number,
): ReadonlySet<string> {
  const keys = new Set<string>();
  const candidates = port === 22 ? [host, `[${host}]:${port}`] : [`[${host}]:${port}`];
  for (const line of content.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 3 || fields[0]?.startsWith("#") || fields[0]?.includes("|")) continue;
    const hostPatterns = fields[0]?.split(",") ?? [];
    if (!hostPatterns.some((pattern) => candidates.includes(pattern))) continue;
    const key = fields[2];
    if (key !== undefined) keys.add(key);
  }
  return keys;
}

function makeResult(
  request: SshRunRequest,
  stdout: string,
  stderr: string,
  exitCode: number,
  signal: string | null,
  startedAt: number,
  captureTruncated = false,
  connection: SshResultConnection = { username: "", port: null, attemptedPorts: [] },
): SshRunResult {
  const combinedLength = stdout.length + stderr.length;
  const outputTruncated = captureTruncated || combinedLength > request.maxOutputCharacters;
  let remaining = request.maxOutputCharacters;
  const limitedStdout = stdout.slice(0, remaining);
  remaining -= limitedStdout.length;
  const limitedStderr = stderr.slice(0, remaining);

  return {
    target: request.target,
    username: connection.username,
    port: connection.port,
    attemptedPorts: [...connection.attemptedPorts],
    command: request.command,
    exitCode,
    signal,
    durationMs: Math.round(performance.now() - startedAt),
    stdout: limitedStdout,
    stderr: limitedStderr,
    outputTruncated,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
