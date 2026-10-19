import { randomUUID } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { toolStructuredResult } from "../../core/tool-result.js";
import type { RedisConfig } from "./config.js";
import { RedisCommandError, type RedisReader, type Reply } from "./client.js";

export interface Bytes { encoding: "utf8" | "base64"; value: string; bytes: number; returnedBytes: number; truncated: boolean; }
export function bytes(value: Reply, max = Infinity): Bytes {
  if (!Buffer.isBuffer(value)) throw new Error("Expected Redis byte string");
  const b = value.subarray(0, max);
  const encoding = isUtf8(b) ? "utf8" : "base64";
  return { encoding, value: b.toString(encoding), bytes: value.length, returnedBytes: b.length, truncated: b.length !== value.length };
}
function str(v: Reply): string { if (!Buffer.isBuffer(v)) throw new Error("Expected Redis text"); return v.toString("utf8"); }
function int(v: Reply): number { if (typeof v !== "number") throw new Error("Expected Redis integer"); return v; }
function arr(v: Reply): Reply[] { if (!Array.isArray(v)) throw new Error("Expected Redis array"); return v; }
export interface Result { db: number; data: Record<string, unknown>; complete: boolean; nextCursor: string | null; notes: string[]; }
const notes = ["Live observations, not an atomic snapshot. Concurrent writes/expiry may change results; SCAN may return duplicates."];
const result = (db: number, data: Record<string, unknown>, complete = true, nextCursor: string | null = null): Result => ({ db, data, complete, nextCursor, notes: [...notes] });
export function responseSize(value: object): number { return Buffer.byteLength(JSON.stringify(toolStructuredResult(value))); }
export function enforceResponse(c: RedisConfig, value: Result): Result {
  if (responseSize(value) > c.maxResponseBytes) throw new Error("Redis MCP response exceeds byte limit; reduce limit/length or raise the configured response limit");
  return value;
}
export function keyBytes(key: string, encoding: "utf8" | "base64"): Buffer {
  const b = Buffer.from(key, encoding);
  if (encoding === "base64" && b.toString("base64") !== key) throw new Error("Key must use canonical Base64");
  return b;
}
interface ScanState { context: string; redisCursor: string; pending: unknown[]; started: boolean; }
interface Cached { state: ScanState; expires: number; size: number; }
/** Bounded, expiring opaque cursors retain SCAN overflow instead of dropping it. */
export class RedisQueries {
  private cursors = new Map<string, Cached>();
  constructor(private readonly c: RedisConfig) {}
  private save(state: ScanState): string {
    const now = Date.now();
    for (const [key, v] of this.cursors) if (v.expires < now) this.cursors.delete(key);
    const size = Buffer.byteLength(JSON.stringify(state));
    if (size > 8 * 1024 * 1024) throw new Error("Redis scan continuation exceeds memory budget; narrow query");
    while (this.cursors.size >= 64 || [...this.cursors.values()].reduce((a, v) => a + v.size, size) > 8 * 1024 * 1024) {
      const first = this.cursors.keys().next().value;
      if (!first) break;
      this.cursors.delete(first);
    }
    const id = randomUUID(); this.cursors.set(id, { state, size, expires: now + 300000 }); return id;
  }
  async scan(r: RedisReader, db: number, options: { cursor?: string | undefined; limit: number; pattern?: string | undefined; key?: Buffer | undefined; kind?: string | undefined }): Promise<Result> {
    const { key, kind, pattern = "*" } = options;
    const context = JSON.stringify([db, key?.toString("base64"), kind, pattern]);
    let state: ScanState = { context, redisCursor: "0", pending: [], started: false };
    if (options.cursor) {
      const found = this.cursors.get(options.cursor);
      if (!found || found.expires < Date.now()) throw new Error("Redis cursor expired or evicted; restart scan without cursor");
      if (found.state.context !== context) throw new Error("Redis cursor does not match DB/key/type/pattern");
      state = { ...found.state, pending: [...found.state.pending] };
    }
    const items: unknown[] = [];
    let rounds = 0;
    const make = (complete: boolean, nextCursor: string | null) => {
      const out = result(db, { type: kind ?? "keys", items, scanRounds: rounds }, complete, nextCursor);
      if (kind === "hash") out.notes.push("Hash values are bounded previews; truncated values require a larger configured preview limit.");
      return out;
    };
    const template = () => make(false, "00000000-0000-0000-0000-000000000000");
    outer: while (true) {
      while (state.pending.length) {
        if (items.length >= options.limit) break outer;
        const item = state.pending[0]; items.push(item);
        if (responseSize(template()) > this.c.maxResponseBytes - 128) {
          items.pop();
          if (!items.length) throw new Error("One Redis item exceeds response limit; increase configured limit");
          break outer;
        }
        state.pending.shift();
      }
      if (state.started && state.redisCursor === "0") break;
      if (rounds >= this.c.scanRounds || items.length >= options.limit) break;
      const reply = arr(await r.query(key
        ? [kind === "hash" ? "HSCAN" : "SSCAN", key, state.redisCursor, "COUNT", "100"]
        : ["SCAN", state.redisCursor, "MATCH", pattern, "COUNT", "100"]));
      const cursor = str(reply[0] ?? null);
      if (!/^\d+$/.test(cursor)) throw new Error("Invalid Redis scan cursor");
      const values = arr(reply[1] ?? null);
      state.redisCursor = cursor; state.started = true; rounds++;
      if (kind === "hash") {
        if (values.length % 2) throw new Error("Invalid Redis hash scan pairs");
        for (let i = 0; i < values.length; i += 2) state.pending.push({ field: bytes(values[i]!), value: bytes(values[i + 1]!, this.c.maxValueBytes) });
      } else state.pending = values.map(v => bytes(v));
    }
    const complete = state.started && state.redisCursor === "0" && !state.pending.length;
    const nextCursor = complete ? null : this.save(state);
    return enforceResponse(this.c, make(complete, nextCursor));
  }
  async inspect(r: RedisReader, db: number, key: Buffer): Promise<Result> {
    const type = str(await r.query(["TYPE", key]));
    const ttlMs = int(await r.query(["PTTL", key]));
    let memory: Record<string, unknown>;
    try { memory = { status: "available", bytes: await r.query(["MEMORY", "USAGE", key, "SAMPLES", "5"]), samples: 5 }; }
    catch (e) { memory = { status: "unavailable", error: message(e) }; }
    return result(db, { type, ttlMs, exists: type !== "none", memory }, memory.status === "available");
  }
  async read(r: RedisReader, db: number, key: Buffer, o: { offset: number; length: number; limit: number; cursor?: string | undefined }): Promise<Result> {
    const type = str(await r.query(["TYPE", key]));
    if (type === "none") return result(db, { type, exists: false });
    if (!["string", "hash", "set", "list", "zset"].includes(type)) throw new Error(`Unsupported Redis type: ${type}`);
    if (o.cursor && type !== "hash" && type !== "set") throw new Error("Cursor applies only to Hash/Set; use offset for String/List/Sorted Set");
    if (type === "hash" || type === "set") {
      if (o.offset !== 0) throw new Error("Hash/Set use cursor, not offset");
      return this.scan(r, db, { ...o, key, kind: type });
    }
    if (type === "string") {
      const totalBytes = int(await r.query(["STRLEN", key]));
      const original = await r.query(["GETRANGE", key, String(o.offset), String(o.offset + o.length - 1)]);
      let value = bytes(original);
      const make = () => {
        const out = result(db, { type, exists: true, totalBytes, offset: o.offset, value, nextOffset: o.offset + value.returnedBytes < totalBytes ? o.offset + value.returnedBytes : null }, o.offset + value.returnedBytes >= totalBytes);
        out.notes.push("String offsets and lengths are bytes; a UTF-8 boundary fragment is returned as Base64.");
        return out;
      };
      while (responseSize(make()) > this.c.maxResponseBytes && value.returnedBytes > 1) value = bytes(original, Math.floor(value.returnedBytes / 2));
      const out = make();
      return enforceResponse(this.c, out);
    }
    const total = int(await r.query([type === "list" ? "LLEN" : "ZCARD", key]));
    const values = arr(await r.query(type === "list" ? ["LRANGE", key, String(o.offset), String(o.offset + o.limit - 1)] : ["ZRANGE", key, String(o.offset), String(o.offset + o.limit - 1), "WITHSCORES"]));
    const items: unknown[] = [];
    const make = () => {
      const out = result(db, { type, total, offset: o.offset, items, nextOffset: o.offset + items.length < total ? o.offset + items.length : null }, o.offset + items.length >= total);
      out.notes.push("List values are bounded previews; truncated values require a larger configured preview limit. Sorted Set order is ascending score.");
      return out;
    };
    for (let i = 0; i < values.length; i += type === "list" ? 1 : 2) {
      items.push(type === "list" ? bytes(values[i]!, this.c.maxValueBytes) : { member: bytes(values[i]!), score: str(values[i + 1] ?? null) });
      if (responseSize(make()) > this.c.maxResponseBytes) { items.pop(); if (!items.length) throw new Error("One Redis item exceeds response limit"); break; }
    }
    const out = make();
    return enforceResponse(this.c, out);
  }
  async diagnose(r: RedisReader, db: number): Promise<Result> {
    const sections: Record<string, unknown> = {};
    let complete = true;
    for (const section of ["server", "clients", "memory", "stats", "persistence", "replication", "keyspace"]) {
      try {
        const fields = Object.fromEntries(str(await r.query(["INFO", section])).split("\r\n").filter(l => l && !l.startsWith("#") && l.includes(":")).map(l => { const i = l.indexOf(":"); return [l.slice(0, i), l.slice(i + 1)]; }));
        if (!Object.keys(fields).length) { sections[section] = { status: "unavailable", error: "Empty or unsupported INFO section" }; complete = false; }
        else sections[section] = { status: "available", fields };
      } catch (e) { sections[section] = { status: "unavailable", error: message(e) }; complete = false; }
      if (responseSize(result(db, { sections }, complete)) > this.c.maxResponseBytes - 512) { sections[section] = { status: "unavailable", error: "Section exceeds response budget" }; complete = false; }
    }
    const out = result(db, { sections }, complete);
    out.notes.push("INFO describes this endpoint/node, not cluster-wide health. Counters are cumulative; no instantaneous hit rate is inferred.");
    return enforceResponse(this.c, out);
  }
  async slowlog(r: RedisReader, db: number, limit: number): Promise<Result> {
    const rows = arr(await r.query(["SLOWLOG", "GET", String(limit)]));
    const entries: unknown[] = [];
    let clipped = false;
    for (const row of rows) {
      const fields = arr(row), args = arr(fields[3] ?? null);
      entries.push({ id: int(fields[0] ?? null), unixSeconds: int(fields[1] ?? null), durationUs: int(fields[2] ?? null), command: bytes(args[0] ?? Buffer.alloc(0), 128), arguments: this.c.slowlogArguments ? args.slice(1).map(v => bytes(v, Math.min(1024, this.c.maxValueBytes))) : null });
      if (responseSize(result(db, { entries, argumentsIncluded: this.c.slowlogArguments, limit }, false)) > this.c.maxResponseBytes - 512) { entries.pop(); clipped = true; break; }
    }
    const out = result(db, { entries, argumentsIncluded: this.c.slowlogArguments, limit, responseTruncated: clipped }, false);
    out.notes.push("Newest bounded slowlog window only; not the full history. Redis itself may truncate arguments. No reset or consume operation is exposed.");
    return enforceResponse(this.c, out);
  }
}
function message(e: unknown): string { return e instanceof RedisCommandError ? e.message : e instanceof Error ? e.message : "Redis query failed"; }
