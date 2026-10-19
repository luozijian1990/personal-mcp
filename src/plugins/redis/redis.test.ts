import assert from "node:assert/strict";
import test from "node:test";
import net from "node:net";
import { once } from "node:events";
import { assertReadCommand, encodeCommand, parseReply, RedisCommandError, withRedis, type Reply } from "./client.js";
import { loadRedisConfig, validateRedisConfig } from "./config.js";
import { createRedisConfigManager } from "./config-manager.js";
import { bytes, RedisQueries, responseSize } from "./queries.js";
import { REDIS_PLUGIN_DEFINITION } from "./definition.js";
import { startStandalonePlugin } from "../../core/plugin-runtime.js";

const config = loadRedisConfig({});
const b = (v: string) => Buffer.from(v);
function wire(v: Reply): Buffer {
  if (v === null) return b("$-1\r\n");
  if (typeof v === "number") return b(`:${v}\r\n`);
  if (Buffer.isBuffer(v)) return Buffer.concat([b(`$${v.length}\r\n`), v, b("\r\n")]);
  return Buffer.concat([b(`*${v.length}\r\n`), ...v.map(wire)]);
}
test("RESP2 is binary safe, fragmented, bounded and hides backend error text", () => {
  const v = [b("a\r\nb"), Buffer.from([0, 255]), 5, null]; const encoded = wire(v);
  for (let i = 0; i < encoded.length; i++) assert.equal(parseReply(encoded.subarray(0, i), 1024), undefined);
  assert.deepEqual(parseReply(encoded, 1024)?.value, v);
  assert.throws(() => parseReply(b("$99999999\r\n"), 1024), /exceeds/);
  assert.throws(() => parseReply(b("-WRONGPASS secret detail\r\n"), 1024), e => e instanceof Error && !e.message.includes("secret") && e.message.includes("WRONGPASS"));
  assert.equal(bytes(Buffer.from([0xff])).encoding, "base64");
  assert.equal(bytes(Buffer.from("中文"), 1).encoding, "base64");
  assert.deepEqual(parseReply(encodeCommand(["GETRANGE", "x\r\nFLUSHALL", "0", "1"]), 1024)?.value, [b("GETRANGE"), b("x\r\nFLUSHALL"), b("0"), b("1")]);
});
test("read-only gate rejects writes, scripts, mutable subcommands and all generic setup commands", () => {
  for (const cmd of [["SET", "x", "v"], ["DEL", "x"], ["EVAL", "return 1", "0"], ["KEYS", "*"], ["CONFIG", "GET", "*"], ["SLOWLOG", "RESET"], ["SLOWLOG", "GET", "-1"], ["MEMORY", "PURGE"], ["SELECT", "1"], ["AUTH", "secret"], ["GETDEL", "x"], ["MONITOR"], ["FLUSHALL"]]) assert.throws(() => assertReadCommand(cmd), /allowlist/);
  for (const cmd of [["SCAN", "0", "MATCH", "*", "COUNT", "100"], ["MEMORY", "USAGE", "x", "SAMPLES", "5"], ["INFO", "memory"]]) assert.doesNotThrow(() => assertReadCommand(cmd));
});
test("configuration validates limits, preserves/clears secrets and keeps old values on failure", async () => {
  let env: Record<string, string> = { REDIS_PASSWORD: "old-secret" };
  let fail = false;
  const manager = createRedisConfigManager({ environment: () => env, update: async values => { if (fail) throw new Error("store unavailable"); env = { ...env, ...values }; } });
  assert.equal(manager.getSnapshot().secretStates?.REDIS_PASSWORD?.configured, true);
  assert.equal(manager.getSnapshot().values.REDIS_PASSWORD, undefined);
  await manager.update({ values: { REDIS_PASSWORD: "", REDIS_PORT: 26379 } }); assert.equal(env.REDIS_PASSWORD, "old-secret");
  await manager.update({ values: { REDIS_PASSWORD: "new-secret" } }); assert.equal(env.REDIS_PASSWORD, "new-secret");
  const rev = manager.getSnapshot().revision;
  await assert.rejects(manager.update({ values: { REDIS_TIMEOUT_MS: 0 } }));
  await assert.rejects(manager.update({ values: { REDIS_TLS: "false" } }));
  await assert.rejects(manager.update({ values: { UNKNOWN: 1 } }));
  assert.equal(manager.getSnapshot().revision, rev);
  fail = true; await assert.rejects(manager.update({ values: { REDIS_PORT: 1234 } })); assert.equal(env.REDIS_PORT, "26379");
  fail = false; await manager.update({ values: {}, clearSecrets: ["REDIS_PASSWORD"] }); assert.equal(env.REDIS_PASSWORD, "");
  assert.throws(() => validateRedisConfig({ ...config, username: "reader" }), /password/);
  assert.throws(() => validateRedisConfig({ ...config, ca: "pem" }), /TLS/);
});
test("SCAN retains excess COUNT results, binds cursor context, and bounds sparse scans", async () => {
  const q = new RedisQueries({ ...config, scanRounds: 2 }); let count = 0;
  const r = { query: async () => { count++; return [b("0"), [b("a"), b("b"), b("c")]]; } };
  const first = await q.scan(r, 0, { limit: 1 }); assert.equal(first.complete, false); assert.ok(first.nextCursor);
  await assert.rejects(q.scan(r, 1, { limit: 1, cursor: first.nextCursor }), /does not match/);
  const second = await q.scan(r, 0, { limit: 1, cursor: first.nextCursor });
  const third = await q.scan(r, 0, { limit: 1, cursor: second.nextCursor! });
  assert.equal(third.complete, true); assert.equal(count, 1);
  assert.deepEqual([first, second, third].map(v => (v.data.items as { value: string }[])[0]?.value), ["a", "b", "c"]);
  const sparse = await q.scan({ query: async () => [b("123"), []] }, 0, { limit: 1 });
  assert.equal(sparse.complete, false); assert.equal(sparse.data.scanRounds, 2); assert.ok(sparse.nextCursor);
  await assert.rejects(q.scan(r, 0, { limit: 1, cursor: "expired" }), /expired/);
});
test("diagnostic permission errors remain unavailable and slowlog arguments default to hidden", async () => {
  const q = new RedisQueries(config);
  const out = await q.diagnose({ query: async args => { if (args[1] === "memory") throw new RedisCommandError("NOPERM"); return b("# Info\r\nvalue:12\r\n"); } }, 0);
  assert.equal(out.complete, false); assert.match(JSON.stringify(out.data), /NOPERM/);
  const log = await q.slowlog({ query: async () => [[1, 100, 999, [b("SET"), b("private-key"), b("private-value")]]] }, 0, 10);
  assert.doesNotMatch(JSON.stringify(log), /private-/);
  const exposed = await new RedisQueries({ ...config, slowlogArguments: true }).slowlog({ query: async () => [[1, 100, 999, [b("SET"), b("private-key")]]] }, 0, 10);
  assert.match(JSON.stringify(exposed), /private-key/);
});
test("response budget includes text and structured mirrors, binary and escaped text", async () => {
  const c = { ...config, maxResponseBytes: 4096 };
  const out = await new RedisQueries(c).read({ query: async args => args[0] === "TYPE" ? b("string") : args[0] === "STRLEN" ? 10000 : b('"'.repeat(10000)) }, 0, b("x"), { offset: 0, length: 10000, limit: 10 });
  assert.ok(responseSize(out) <= 4096); assert.equal(out.complete, false);
  const value = out.data.value as ReturnType<typeof bytes>;
  assert.equal(value.bytes, 10000);
  assert.ok(value.returnedBytes < 2500, "exercise multiple budget reductions");
  assert.equal(value.truncated, true);
  assert.equal(value.value, '"'.repeat(value.returnedBytes));
  assert.equal(out.data.nextOffset, value.returnedBytes);
});

async function mockBackend(context: { after: (fn: () => unknown) => void }, handler: (args: Buffer[]) => Buffer | undefined) {
  const sockets = new Set<net.Socket>();
  const backend = net.createServer(socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); let pending = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => { pending = Buffer.concat([pending, chunk]); const parsed = parseReply(pending, 65536); if (!parsed) return; pending = pending.subarray(parsed.end); const response = handler(parsed.value as Buffer[]); if (response) socket.write(response); });
  });
  backend.listen(0, "127.0.0.1"); await once(backend, "listening");
  context.after(async () => { for (const s of sockets) s.destroy(); await new Promise<void>(r => backend.close(() => r())); });
  const addr = backend.address(); assert.ok(addr && typeof addr !== "string"); return addr.port;
}
test("deadline and cancellation close connections; raw oversized reply fails before allocation", async context => {
  const port = await mockBackend(context, args => args[0]?.toString() === "SELECT" ? b("+OK\r\n") : undefined);
  const c = { ...config, host: "127.0.0.1", port, timeoutMs: 30 };
  await assert.rejects(withRedis(c, 0, undefined, r => r.query(["PING"])), /deadline/);
  const controller = new AbortController();
  const call = withRedis({ ...c, timeoutMs: 1000 }, 0, controller.signal, r => r.query(["PING"]));
  setTimeout(() => controller.abort(), 20); await assert.rejects(call, /cancelled/);
  const hugePort = await mockBackend(context, () => b("$99999999\r\n"));
  await assert.rejects(withRedis({ ...c, port: hugePort }, 0, undefined, r => r.query(["PING"])), /exceeds/);
});
test("standalone MCP lists five readonly tools; validates before backend and logs no business content", async context => {
  const commands: string[][] = [];
  const maxResponseBytes = 65536;
  const longKeys = [b("a".repeat(9000)), Buffer.alloc(7000, 255)];
  const port = await mockBackend(context, args => {
    const parts = args.map(v => v.toString()); commands.push(parts);
    if (parts[0] === "SELECT") return b("+OK\r\n");
    if (parts[0] === "SCAN") return wire([b("0"), longKeys]);
    if (parts[0] === "TYPE") {
      if (args[1]!.length > 1000) assert.ok(longKeys.some(key => key.equals(args[1]!)), "preserve exact key bytes");
      return wire(b("string"));
    }
    if (parts[0] === "PTTL") return wire(-1);
    if (parts[0] === "MEMORY") return wire(123);
    if (parts[0] === "STRLEN") return wire(14);
    if (parts[0] === "GETRANGE") return wire(b("PRIVATE_MARKER"));
    return b("+PONG\r\n");
  });
  const logs: unknown[] = [];
  const runtime = await startStandalonePlugin(REDIS_PLUGIN_DEFINITION, { port: 0, store: { environment: () => ({ REDIS_HOST: "127.0.0.1", REDIS_PORT: String(port), REDIS_MAX_RESPONSE_BYTES: String(maxResponseBytes), MCP_ENABLED_REDIS: "true" }), update: async () => {} }, logger: { info(_e, f) { logs.push(f); }, error(_e, f) { logs.push(f); } } });
  context.after(async () => { runtime.server.closeAllConnections(); await new Promise<void>(r => runtime.server.close(() => r())); });
  async function rpc(method: string, params: object) {
    const response = await fetch(new URL("/redis/mcp", runtime.url), { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const text = await response.text(); return JSON.parse(text.startsWith("{") ? text : text.split("\n").find(l => l.startsWith("data: "))!.slice(6));
  }
  const list = await rpc("tools/list", {}); assert.equal(list.result.tools.length, 5);
  assert.ok(list.result.tools.every((t: { annotations: { readOnlyHint: boolean }; outputSchema: unknown }) => t.annotations.readOnlyHint && t.outputSchema));
  const call = await rpc("tools/call", { name: "redis_read_key", arguments: { db: 2, key: "private-key" } });
  assert.equal(call.result.isError, false); assert.equal(call.result.structuredContent.db, 2);
  assert.ok(commands.some(c => c[0] === "SELECT" && c[1] === "2"));
  const scanned = await rpc("tools/call", { name: "redis_scan_keys", arguments: {} });
  assert.equal(scanned.result.isError, false);
  assert.equal(scanned.result.structuredContent.data.items.length, longKeys.length);
  for (const [i, item] of scanned.result.structuredContent.data.items.entries()) {
    assert.deepEqual(Buffer.from(item.value, item.encoding), longKeys[i]);
    for (const name of ["redis_read_key", "redis_inspect_key"]) {
      const response = await rpc("tools/call", { name, arguments: { key: item.value, keyEncoding: item.encoding } });
      assert.equal(response.result.isError, false, `${name} accepts scanned ${item.encoding} key`);
      assert.equal(response.result.structuredContent.data.exists, true);
    }
  }
  const before = commands.length;
  const oversized = await rpc("tools/call", { name: "redis_read_key", arguments: { key: "a".repeat(maxResponseBytes + 1) } });
  assert.equal(oversized.result.isError, true); assert.equal(commands.length, before);
  const invalid = await rpc("tools/call", { name: "redis_read_key", arguments: { key: "x", length: 999999 } }); assert.equal(invalid.result.isError, true); assert.equal(commands.length, before);
  const injection = await rpc("tools/call", { name: "redis_read_key", arguments: { key: "x", command: "FLUSHALL" } }); assert.equal(injection.result.isError, true);
  const unknown = await rpc("tools/call", { name: "redis_execute", arguments: { command: "SET x y" } }); assert.ok(unknown.error || unknown.result.isError);
  assert.doesNotMatch(JSON.stringify(logs), /PRIVATE_MARKER|private-key/);
});

test("TLS verifies trust and hostname, custom CA works; auth errors never expose credentials", async context => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const tls = await import("node:tls");
  const dir = mkdtempSync(join(tmpdir(), "redis-mcp-tls-"));
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"), "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"], { stdio: "ignore" });
  const ca = readFileSync(join(dir, "cert.pem"), "utf8");
  const sockets = new Set<net.Socket>();
  const backend = tls.createServer({ key: readFileSync(join(dir, "key.pem")), cert: ca }, socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => {});
    socket.on("data", () => socket.write("+OK\r\n"));
  });
  backend.on("tlsClientError", () => {});
  backend.listen(0, "127.0.0.1"); await once(backend, "listening");
  context.after(async () => { for (const s of sockets) s.destroy(); await new Promise<void>(r => backend.close(() => r())); });
  const address = backend.address(); assert.ok(address && typeof address !== "string");
  const c = { ...config, host: "localhost", port: address.port, tls: true, ca };
  assert.equal((await withRedis(c, 0, undefined, r => r.query(["PING"])))?.toString(), "OK");
  await assert.rejects(withRedis({ ...c, ca: "" }, 0, undefined, r => r.query(["PING"])), /connection failed/);
  await assert.rejects(withRedis({ ...c, host: "127.0.0.1" }, 0, undefined, r => r.query(["PING"])), /connection failed/);
  const port = await mockBackend(context, args => {
    assert.equal(args[0]?.toString(), "AUTH"); assert.equal(args[1]?.toString(), "reader"); assert.equal(args[2]?.toString(), "not-for-logs");
    return b("-WRONGPASS not-for-logs\r\n");
  });
  await assert.rejects(withRedis({ ...config, host: "127.0.0.1", port, username: "reader", password: "not-for-logs" }, 0, undefined, r => r.query(["PING"])), e => e instanceof Error && e.message.includes("WRONGPASS") && !e.message.includes("not-for-logs"));
});
