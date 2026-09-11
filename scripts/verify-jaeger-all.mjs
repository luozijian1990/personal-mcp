// Run verify-jaeger-demo.mjs first to refresh the four real trace samples.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
const endpoint = process.env.JAEGER_TEST_MCP_URL ?? 'http://127.0.0.1:3107/jaeger/mcp';
const backend = process.env.JAEGER_MCP_URL ?? 'http://127.0.0.1:16686';
const samples = JSON.parse(await readFile('.scratch/jaeger-mcp/live-verification.json', 'utf8'));
const cases = [];
let rpcCount = 0;
async function rpc(method, params) {
  rpcCount++;
  const r = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: rpcCount, method, params }), signal: AbortSignal.timeout(20000) });
  assert.equal(r.status, 200);
  const text = await r.text();
  const message = JSON.parse(text.startsWith('{') ? text : text.split('\n').find(line => line.startsWith('data: ')).slice(6));
  assert.equal(message.error, undefined, JSON.stringify(message.error)); return message.result;
}
async function call(name, args = {}) { const result = await rpc('tools/call', { name: 'jaeger_' + name, arguments: args }); assert.equal(result.isError, false, JSON.stringify(result)); return result.structuredContent; }
async function raw(path, params = {}) { const r = await fetch(`${backend}/api/${path}?${new URLSearchParams(params)}`, { signal: AbortSignal.timeout(10000) }); assert.equal(r.status, 200); return (await r.json()).data ?? []; }
async function check(name, fn) { try { await fn(); cases.push({ name, status: 'passed' }); } catch (error) { cases.push({ name, status: 'failed', error: error.message }); } }
await check('MCP initialize, ping and five tool schemas', async () => {
  const init = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'jaeger-full-verifier', version: '1.0' } });
  assert.ok(init.protocolVersion); await rpc('ping', {});
  const list = await rpc('tools/list', {}); assert.equal(list.tools.length, 5);
  for (const tool of list.tools) { assert.ok(tool.inputSchema); assert.ok(tool.outputSchema); assert.equal(tool.annotations.readOnlyHint, true); }
});
await check('services: default, all pages, terminal offset and raw parity', async () => {
  const expected = (await raw('services')).sort(); const all = await call('list_services'); assert.deepEqual(all.services, expected);
  const collected = []; let offset = 0;
  do { const page = await call('list_services', { offset, limit: 1 }); collected.push(...page.services); offset = page.nextOffset; } while (offset !== null);
  assert.deepEqual(collected, expected); assert.deepEqual((await call('list_services', { offset: expected.length })).services, []);
});
for (const serviceName of ['service-a', 'service-b', 'service-c', 'service-d', 'traefik', 'nonexistent-test-service']) await check(`operations: ${serviceName} full pagination and raw parity`, async () => {
  const expected = (await raw(`services/${encodeURIComponent(serviceName)}/operations`)).sort();
  const actual = []; let offset = 0;
  do { const page = await call('list_operations', { serviceName, offset, limit: 2 }); actual.push(...page.operations); offset = page.nextOffset; } while (offset !== null);
  assert.deepEqual(actual, expected);
});
const end = new Date().toISOString(), start = new Date(Date.parse(end) - 3600000).toISOString();
const operation = (await call('list_operations', { serviceName: 'service-a' })).operations[0];
for (const extra of [{}, { operationName: operation }, { tags: { error: 'true' } }, { minDurationMs: 3000 }, { maxDurationMs: 1000 }, { minDurationMs: 0.001, maxDurationMs: 86400000 }, { tags: { 'nonexistent.test.tag': 'none' } }]) await check(`search raw parity ${JSON.stringify(extra)}`, async () => {
  const result = await call('query_traces', { serviceName: 'service-a', start, end, limit: 100, ...extra });
  const params = { service: 'service-a', start: String(Date.parse(start) * 1000), end: String(Date.parse(end) * 1000), limit: '100', tags: JSON.stringify(extra.tags ?? {}) };
  if (extra.operationName) params.operation = extra.operationName;
  if (extra.minDurationMs !== undefined) params.minDuration = `${extra.minDurationMs}ms`;
  if (extra.maxDurationMs !== undefined) params.maxDuration = `${extra.maxDurationMs}ms`;
  const expected = await raw('traces', params);
  assert.deepEqual(result.traces.map(t => t.traceId).sort(), expected.map(t => t.traceID).sort());
  assert.equal(result.returnedCount, expected.length); assert.equal(result.limitReached, expected.length >= 100);
});
await check('search limit and relative time', async () => { const result = await call('query_traces', { serviceName: 'service-a', limit: 1 }); assert.equal(result.returnedCount, 1); assert.equal(result.limitReached, true); });
for (const sample of samples.scenarios) await check(`trace ${sample.path}: full paging, raw evidence, filters and uppercase ID`, async () => {
  const traceId = sample.traceId;
  const trace = (await raw(`traces/${traceId}`))[0]; assert.ok(trace);
  const spans = []; let offset = 0;
  do { const page = await call('get_trace', { traceId, offset, limit: 3 }); assert.equal(page.totalSpans, trace.spans.length); spans.push(...page.spans); offset = page.nextOffset; } while (offset !== null);
  assert.equal(new Set(spans.map(s => s.spanID)).size, trace.spans.length);
  for (const span of spans) { const original = trace.spans.find(s => s.spanID === span.spanID); assert.deepEqual(span.tags, original.tags); assert.deepEqual(span.logs, original.logs); assert.deepEqual(span.references, original.references); assert.deepEqual(span.process, trace.processes[original.processID]); assert.equal(span.durationMs, original.duration / 1000); }
  const errors = await call('get_trace', { traceId, errorsOnly: true }); assert.deepEqual(errors.spans.map(s => s.spanID), spans.filter(s => s.isError).map(s => s.spanID));
  for (const serviceName of sample.services) { const filtered = await call('get_trace', { traceId, serviceName }); assert.deepEqual(filtered.spans.map(s => s.spanID), spans.filter(s => s.serviceName === serviceName).map(s => s.spanID)); }
  assert.equal((await call('get_trace', { traceId: traceId.toUpperCase() })).totalSpans, spans.length);
  assert.equal((await call('get_trace', { traceId, serviceName: 'nonexistent-test-service' })).matchedSpans, 0);
  assert.deepEqual((await call('get_trace', { traceId, offset: spans.length })).spans, []);
});
await check('topology: all pages, raw counts, filtered union and empty filter', async () => {
  const expected = (await raw('dependencies', { endTs: String(Date.parse(end)), lookback: '3600000' })).map(e => ({ source: e.parent, target: e.child, callCount: e.callCount })).sort((a,b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target));
  const edges = []; let offset = 0;
  do { const page = await call('query_service_topology', { start, end, offset, limit: 1 }); edges.push(...page.edges); assert.deepEqual(page.nodes.map(n => n.id), [...new Set(page.edges.flatMap(e => [e.source,e.target]))].sort()); offset = page.nextOffset; } while (offset !== null);
  assert.deepEqual(edges, expected);
  const filtered = await call('query_service_topology', { start, end, serviceNames: ['service-c', 'service-d', 'service-c'] }); assert.deepEqual(filtered.edges, expected.filter(e => ['service-c','service-d'].includes(e.source) || ['service-c','service-d'].includes(e.target)));
  assert.deepEqual((await call('query_service_topology', { serviceNames: ['nonexistent-test-service'] })).edges, []);
});
const invalid = [
 ['list_services',{limit:0}],['list_services',{limit:101}],['list_services',{offset:-1}],
 ['list_operations',{}],['list_operations',{serviceName:''}],['list_operations',{serviceName:'service-a',offset:0.5}],
 ['query_traces',{}],['query_traces',{serviceName:'service-a',start:'2026-02-30T00:00:00Z'}],['query_traces',{serviceName:'service-a',start:'now',end:'now-1h'}],
 ['query_traces',{serviceName:'service-a',minDurationMs:0.0000001}],['query_traces',{serviceName:'service-a',maxDurationMs:0.0011}],['query_traces',{serviceName:'service-a',minDurationMs:2,maxDurationMs:1}],['query_traces',{serviceName:'service-a',tags:{error:true}}],
 ['get_trace',{traceId:'../services'}],['get_trace',{traceId:'0'.repeat(32)}],['get_trace',{traceId:samples.scenarios[0].traceId,limit:101}],
 ['query_service_topology',{start:'now',end:'now'}],['query_service_topology',{limit:501}],['query_service_topology',{serviceNames:['']}],
];
for (const [name,args] of invalid) await check(`reject ${name} ${JSON.stringify(args)}`, async()=>{const r=await rpc('tools/call',{name:'jaeger_'+name,arguments:args});assert.equal(r.isError,true);});
await check('missing trace is a tool error on this real backend',async()=>{const r=await rpc('tools/call',{name:'jaeger_get_trace',arguments:{traceId:'f'.repeat(32)}});assert.equal(r.isError,true);assert.match(JSON.stringify(r),/404/);});
await check('health and configuration metadata',async()=>{
 const origin=new URL(endpoint).origin;
 assert.equal((await fetch(origin+'/health')).status,200);
 assert.equal((await fetch(origin+'/api/health/check',{method:'POST'})).status,200);
 const status=await(await fetch(origin+'/api/status')).json();const plugin=status.endpoints.find(p=>p.id==='jaeger');assert.equal(plugin.enabled,true);assert.equal(plugin.health.state,'healthy');assert.equal(plugin.tools.length,5);assert.ok(plugin.tools.every(t=>t.risk==='read-only'&&t.logging.input==='metadata'&&t.logging.output==='metadata'));
 const config=await(await fetch(origin+'/api/config/jaeger')).json();assert.ok(!Object.hasOwn(config.values??{},'JAEGER_MCP_PASSWORD'));
});
const report={testedAt:new Date().toISOString(),endpoint,backend,rpcCount,passed:cases.filter(c=>c.status==='passed').length,failed:cases.filter(c=>c.status==='failed').length,cases};
await writeFile('.scratch/jaeger-mcp/full-live-verification.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
if(report.failed)process.exitCode=1;
