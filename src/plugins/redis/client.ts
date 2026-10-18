import net from "node:net";
import tls from "node:tls";
import type { RedisConfig } from "./config.js";

export type Reply = Buffer | number | null | Reply[];
export type Command = readonly (string | Buffer)[];
export interface RedisReader { query(args: Command): Promise<Reply>; }
export class RedisCommandError extends Error {
  constructor(readonly code: string) { super(`Redis command failed (${code})`); }
}

/** Second gate behind typed tools. AUTH/SELECT are private connection setup only. */
export function assertReadCommand(args: Command): void {
  const name = String(args[0]);
  const arities: Record<string, number> = { PING: 1, TYPE: 2, PTTL: 2, STRLEN: 2, HLEN: 2, LLEN: 2, SCARD: 2, ZCARD: 2, GETRANGE: 4, LRANGE: 4 };
  if (name in arities && args.length === arities[name]) return;
  if (name === "ZRANGE" && args.length === 5 && args[4] === "WITHSCORES") return;
  if (name === "SCAN" && args.length === 6 && args[2] === "MATCH" && args[4] === "COUNT") return;
  if ((name === "HSCAN" || name === "SSCAN") && args.length === 5 && args[3] === "COUNT") return;
  if (name === "MEMORY" && args.length === 5 && args[1] === "USAGE" && args[3] === "SAMPLES" && args[4] === "5") return;
  if (name === "SLOWLOG" && args.length === 3 && args[1] === "GET" && /^\d+$/.test(String(args[2])) && Number(args[2]) >= 1 && Number(args[2]) <= 1000) return;
  if (name === "INFO" && args.length === 2 && ["server", "clients", "memory", "stats", "persistence", "replication", "keyspace"].includes(String(args[1]))) return;
  throw new Error("Redis command is outside the read-only allowlist");
}

export function encodeCommand(args: Command): Buffer {
  const parts: Buffer[] = [Buffer.from(`*${args.length}\r\n`)];
  for (const arg of args) { const b = Buffer.isBuffer(arg) ? arg : Buffer.from(arg); parts.push(Buffer.from(`$${b.length}\r\n`), b, Buffer.from("\r\n")); }
  return Buffer.concat(parts);
}

/** RESP2 parser: bytes are never decoded as text until the domain layer. */
export function parseReply(data: Buffer, maxBytes: number, offset = 0, depth = 0): { value: Reply; end: number } | undefined {
  if (depth > 16) throw new Error("Redis reply nesting exceeded limit");
  const end = data.indexOf("\r\n", offset);
  if (end < 0) return undefined;
  const prefix = data[offset];
  const line = data.subarray(offset + 1, end).toString("utf8");
  let pos = end + 2;
  if (prefix === 43) return { value: data.subarray(offset + 1, end), end: pos };
  if (prefix === 45) throw new RedisCommandError(/^[A-Z]+/.exec(line)?.[0] ?? "ERR");
  if (![58, 36, 42].includes(prefix ?? -1) || !/^-?\d+$/.test(line)) throw new Error("Invalid Redis RESP2 response");
  const n = Number(line);
  if (!Number.isSafeInteger(n)) throw new Error("Redis integer exceeds safe range");
  if (prefix === 58) return { value: n, end: pos };
  if (n === -1) return { value: null, end: pos };
  if (n < 0 || n > maxBytes) throw new Error("Redis backend reply exceeds byte limit; narrow the query");
  if (prefix === 36) {
    if (pos + n + 2 > data.length) return undefined;
    if (data[pos + n] !== 13 || data[pos + n + 1] !== 10) throw new Error("Invalid Redis bulk terminator");
    return { value: data.subarray(pos, pos + n), end: pos + n + 2 };
  }
  if (n > 100000) throw new Error("Redis reply has too many elements");
  const values: Reply[] = [];
  for (let i = 0; i < n; i++) {
    const child = parseReply(data, maxBytes, pos, depth + 1);
    if (!child) return undefined;
    values.push(child.value); pos = child.end;
  }
  return { value: values, end: pos };
}

/** One connection per tool: DB selection cannot leak between concurrent calls. No retries. */
export async function withRedis<T>(c: RedisConfig, db: number, signal: AbortSignal | undefined, action: (reader: RedisReader) => Promise<T>): Promise<T> {
  if (signal?.aborted) throw new Error("Redis call cancelled");
  const socket = c.tls
    ? tls.connect({ host: c.host, port: c.port, rejectUnauthorized: true, ...(!net.isIP(c.host) ? { servername: c.host } : {}), ...(c.ca ? { ca: c.ca } : {}), checkServerIdentity: (_host, cert) => tls.checkServerIdentity(c.host, cert) })
    : net.createConnection({ host: c.host, port: c.port });
  let failure: Error | undefined;
  let rejectPending: ((e: Error) => void) | undefined;
  const fail = (e: Error) => { failure ??= e; rejectPending?.(failure); socket.destroy(); };
  const aborted = () => fail(new Error("Redis call cancelled"));
  const timer = setTimeout(() => fail(new Error("Redis tool deadline exceeded")), c.timeoutMs);
  const connectTimer = setTimeout(() => fail(new Error("Redis connection timeout")), c.connectTimeoutMs);
  socket.on("error", (e: NodeJS.ErrnoException) => fail(new Error(`Redis connection failed (${e.code ?? "TLS_OR_NETWORK_ERROR"})`)));
  socket.on("close", () => fail(new Error("Redis connection closed")));
  signal?.addEventListener("abort", aborted, { once: true });
  const raw = async (args: Command): Promise<Reply> => {
    if (failure) throw failure;
    return new Promise((resolve, reject) => {
      let data = Buffer.alloc(0);
      const maxBytes = c.maxResponseBytes * 4;
      const cleanup = () => { socket.off("data", onData); rejectPending = undefined; };
      rejectPending = e => { cleanup(); reject(e); };
      const onData = (chunk: Buffer) => {
        try {
          if (data.length + chunk.length > maxBytes) throw new Error("Redis backend reply exceeds byte limit; narrow the query");
          data = Buffer.concat([data, chunk]);
          const result = parseReply(data, maxBytes);
          if (result) {
            if (result.end !== data.length) throw new Error("Unexpected extra Redis response");
            cleanup(); resolve(result.value);
          }
        } catch (e) {
          cleanup(); reject(e);
          // Command errors leave RESP synchronized; framing/size errors do not.
          if (!(e instanceof RedisCommandError)) fail(e instanceof Error ? e : new Error("Invalid Redis response"));
        }
      };
      socket.on("data", onData);
      socket.write(encodeCommand(args));
    });
  };
  try {
    await new Promise<void>((resolve, reject) => {
      rejectPending = reject;
      socket.once(c.tls ? "secureConnect" : "connect", () => { rejectPending = undefined; clearTimeout(connectTimer); resolve(); });
      if (signal?.aborted) aborted();
    });
    if (c.password) await raw(c.username ? ["AUTH", c.username, c.password] : ["AUTH", c.password]);
    // SELECT is connection-local, never a tool-accessible command.
    await raw(["SELECT", String(db)]);
    return await action({ query: args => { assertReadCommand(args); return raw(args); } });
  } finally {
    clearTimeout(timer); clearTimeout(connectTimer); signal?.removeEventListener("abort", aborted); socket.destroy();
  }
}
