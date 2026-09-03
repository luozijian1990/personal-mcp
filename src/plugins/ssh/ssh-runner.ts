import { execFile } from "node:child_process";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PROCESS_OUTPUT_LIMIT_BYTES = 1_048_576;

export interface SshRunRequest {
  readonly target: string;
  readonly command: string;
  readonly timeoutSeconds: number;
  readonly maxOutputCharacters: number;
}

export interface SshRunResult {
  readonly target: string;
  readonly command: string;
  readonly exitCode: number;
  readonly signal: string | null;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly outputTruncated: boolean;
}

export type SshExecutor = (request: SshRunRequest) => Promise<SshRunResult>;

export async function runSsh(request: SshRunRequest): Promise<SshRunResult> {
  const startedAt = performance.now();
  const args = [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=5",
    "-o",
    "ServerAliveCountMax=2",
    "-o",
    "LogLevel=ERROR",
    "--",
    request.target,
    request.command,
  ];

  try {
    const { stdout, stderr } = await execFileAsync("ssh", args, {
      encoding: "utf8",
      timeout: request.timeoutSeconds * 1_000,
      maxBuffer: PROCESS_OUTPUT_LIMIT_BYTES,
    });
    return makeResult(request, stdout, stderr, 0, null, startedAt);
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & {
      code?: number | string;
      signal?: string;
      stdout?: string;
      stderr?: string;
    };
    const exitCode = typeof failure.code === "number" ? failure.code : 255;
    return makeResult(
      request,
      failure.stdout ?? "",
      failure.stderr ?? failure.message,
      exitCode,
      failure.signal ?? null,
      startedAt,
    );
  }
}

function makeResult(
  request: SshRunRequest,
  stdout: string,
  stderr: string,
  exitCode: number,
  signal: string | null,
  startedAt: number,
): SshRunResult {
  const combinedLength = stdout.length + stderr.length;
  const outputTruncated = combinedLength > request.maxOutputCharacters;
  let remaining = request.maxOutputCharacters;
  const limitedStdout = stdout.slice(0, remaining);
  remaining -= limitedStdout.length;
  const limitedStderr = stderr.slice(0, remaining);

  return {
    target: request.target,
    command: request.command,
    exitCode,
    signal,
    durationMs: Math.round(performance.now() - startedAt),
    stdout: limitedStdout,
    stderr: limitedStderr,
    outputTruncated,
  };
}
