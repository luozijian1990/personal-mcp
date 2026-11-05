import net from "node:net";
import tls from "node:tls";
import { createRequire } from "node:module";
import type { ISocketFactory, Logger } from "kafkajs";
import type { KafkaConfig } from "./config.js";
import { parseBroker, validateKafkaConfig } from "./config.js";
import { assertReadApi, describeGroupsV4, factories, flexibleListGroups, QueryError, READ_APIS, type BrokerAddress, type ProtocolRequest, type ReadApi } from "./protocol.js";
const require = createRequire(import.meta.url);
interface Broker {
  versions: Record<number, { minVersion: number; maxVersion: number }>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  lookupRequest(key: number, factory: unknown): (args: object) => ProtocolRequest;
  connectionPool: { send(request: ProtocolRequest): Promise<unknown> };
}
const BrokerImpl = require("kafkajs/src/broker/index.js") as new (options: object) => Broker;
const PoolImpl = require("kafkajs/src/network/connectionPool.js") as new (options: object) => Broker["connectionPool"];
const Encoder = require("kafkajs/src/protocol/encoder.js") as new () => { writeBuffer(buffer: Buffer): unknown };
const silent: Logger = { info() {}, warn() {}, error() {}, debug() {}, namespace: () => silent, setLogLevel() {} };

export interface KafkaReader {
  readonly startedAt: string;
  bootstrap(): Promise<BrokerAddress>;
  read(address: BrokerAddress, api: ReadApi, args?: object): Promise<unknown>;
  versions(address: BrokerAddress): Promise<Record<number, { minVersion: number; maxVersion: number }>>;
  close(): void;
}
export type ReaderFactory = (config: KafkaConfig, signal?: AbortSignal) => KafkaReader;

// Detect oversize frames BEFORE KafkaJS receives their length prefix and buffers the payload.
export function frameGuard(maxBytes: number): (chunk: Buffer) => void {
  let header = Buffer.alloc(0); let remaining = 0;
  return chunk => {
    let at = 0;
    while (at < chunk.length) {
      if (remaining) { const n = Math.min(remaining, chunk.length - at); remaining -= n; at += n; continue; }
      const n = Math.min(4 - header.length, chunk.length - at); header = Buffer.concat([header, chunk.subarray(at, at + n)]); at += n;
      if (header.length < 4) continue;
      const size = header.readInt32BE(); header = Buffer.alloc(0);
      if (size < 4 || size > maxBytes) throw new QueryError("RESPONSE_TOO_LARGE", "Kafka broker response exceeds the configured frame budget; narrow the query or adjust the server limit");
      remaining = size;
    }
  };
}

export function createKafkaReader(config: KafkaConfig, signal?: AbortSignal): KafkaReader {
  validateKafkaConfig(config);
  if (!config.brokers.length) throw new QueryError("UNCONFIGURED", "Configure KAFKA_BROKERS before querying Kafka");
  const startedAt = new Date().toISOString(); const sockets = new Set<net.Socket>();
  const brokers = new Map<string, Broker>(); let stopped: QueryError | undefined;
  let active = 0; const queued: (() => void)[] = [];
  let rejectStopped!: (e: QueryError) => void;
  const stopping = new Promise<never>((_, reject) => { rejectStopped = reject; });
  void stopping.catch(() => {});
  const stop = (error: QueryError) => {
    if (stopped) return; stopped = error;
    for (const socket of sockets) socket.destroy(error);
    rejectStopped(error); while (queued.length) queued.shift()!();
  };
  const abort = () => stop(new QueryError("CANCELLED", "Kafka call cancelled"));
  const timer = setTimeout(() => stop(new QueryError("DEADLINE_EXCEEDED", "Kafka call exceeded its total time budget", true)), config.timeoutMs);
  signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
  const socketFactory: ISocketFactory = ({ host, port, ssl, onConnect }) => {
    if (stopped) throw stopped;
    const logicalAddress = `${net.isIP(host) === 6 ? `[${host}]` : host}:${port}`;
    const mapped = config.addressMap[logicalAddress];
    const destination = mapped ? parseBroker(mapped) : { host, port };
    // Routing changes only the TCP destination. TLS still authenticates the advertised broker.
    const socket = ssl ? tls.connect({ ...ssl, ...destination, ...(net.isIP(host) ? {} : { servername: host }), rejectUnauthorized: true,
      checkServerIdentity: (_hostname, cert) => tls.checkServerIdentity(host, cert),
    }, onConnect) : net.connect(destination, onConnect);
    sockets.add(socket); socket.once("close", () => sockets.delete(socket)); socket.setKeepAlive(true);
    const guard = frameGuard(config.maxBrokerResponseBytes);
    // Intercept emit to reject an oversize chunk before *any* KafkaJS data listener sees it.
    const emit = socket.emit.bind(socket);
    socket.emit = ((event: string | symbol, ...args: unknown[]) => {
      if (event === "data") { try { guard(args[0] as Buffer); } catch (e) { stop(e as QueryError); return false; } }
      return emit(event, ...args);
    }) as typeof socket.emit;
    return socket;
  };
  const limited = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= config.concurrency) await Promise.race([new Promise<void>(resolve => queued.push(resolve)), stopping]);
    if (stopped) throw stopped;
    active++;
    try { return await Promise.race([fn(), stopping]); }
    finally { active--; queued.shift()?.(); }
  };
  const getBroker = async (address: BrokerAddress) => {
    if (stopped) throw stopped;
    const key = `${address.host}:${address.port}`;
    let broker = brokers.get(key);
    if (!broker) {
      const pool = new PoolImpl({ host: address.host, port: address.port, logger: silent, socketFactory, clientId: config.clientId,
        ssl: config.tls ? { rejectUnauthorized: true, ...(config.ca ? { ca: config.ca } : {}) } : null,
        sasl: config.mechanism === "none" ? null : { mechanism: config.mechanism, username: config.username, password: config.password },
        connectionTimeout: Math.min(3000, config.timeoutMs), requestTimeout: config.timeoutMs, enforceRequestTimeout: true, maxInFlightRequests: config.concurrency });
      broker = new BrokerImpl({ connectionPool: pool, nodeId: address.nodeId, logger: silent, authenticationTimeout: config.timeoutMs, allowAutoTopicCreation: false });
      brokers.set(key, broker);
    }
    await broker.connect(); if (stopped) throw stopped; return broker;
  };
  const reader: KafkaReader = {
    startedAt,
    bootstrap: async () => {
      let last: unknown;
      for (const address of config.brokers) {
        const broker = { nodeId: -1, ...parseBroker(address) };
        try { await limited(() => getBroker(broker)); return broker; } catch (e) { last = e; if (stopped) throw stopped; }
      }
      throw last;
    },
    versions: address => limited(async () => (await getBroker(address)).versions),
    read: (address, api, args = {}) => limited(async () => {
      assertReadApi(api);
      const broker = await getBroker(address);
      let request: ProtocolRequest;
      const max = broker.versions[16]?.maxVersion ?? 0;
      if (api === "ListGroups" && max >= 4) request = flexibleListGroups(max >= 5 ? 5 : 4);
      else if (api === "DescribeGroups" && (broker.versions[15]?.maxVersion ?? 0) >= 4) request = describeGroupsV4((args as { groupIds: string[] }).groupIds);
      else {
        const factory = api === "FindCoordinator" ? (factories as unknown as Record<string, unknown>).GroupCoordinator : factories[api];
        request = broker.lookupRequest(READ_APIS[api], factory)({ ...args, ...(api === "Metadata" ? { allowAutoTopicCreation: false } : {}) });
        // Cluster-only metadata must encode zero topics, not KafkaJS's [] => null/all.
        if (api === "Metadata" && !("topics" in args)) {
          if (request.request.apiVersion < 4) throw new QueryError("UNSUPPORTED_VERSION", "Kafka Metadata v4 or higher is required");
          request.request.encode = async () => new Encoder().writeBuffer(Buffer.from([0, 0, 0, 0, 0]));
        }
        // Preserve partition/resource failures instead of KafkaJS throwing away every successful item.
        request = { ...request, response: { ...request.response, parse: async data => data } };
      }
      return broker.connectionPool.send(request);
    }),
    close: () => {
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      stop(new QueryError("CLOSED", "Kafka query session closed"));
      for (const broker of brokers.values()) void broker.disconnect().catch(() => {});
    },
  };
  return reader;
}
