// Run after npm run build:server. Generates four requests in the local demo.
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { startStandalonePlugin } from '../dist/core/plugin-runtime.js';
import { JAEGER_PLUGIN_DEFINITION } from '../dist/plugins/jaeger/definition.js';

const jaeger = process.env.JAEGER_MCP_URL ?? 'http://127.0.0.1:16686';
const demo = process.env.JAEGER_DEMO_URL ?? 'http://127.0.0.1:18086/service-a';
const environment = { JAEGER_MCP_URL: jaeger, MCP_ENABLED_JAEGER: 'true' };
const runtime = await startStandalonePlugin(JAEGER_PLUGIN_DEFINITION, { port: 0, store: { environment: () => environment, update: async values => Object.assign(environment, values) }, logger: { info() {}, error() {} } });
const report = { testedAt: new Date().toISOString(), backend: jaeger, scenarios: [] };
async function rpc(method, params) {
  const response = await fetch(new URL('/jaeger/mcp', runtime.url), { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20000) });
  const text = await response.text();
  const message = JSON.parse(text.startsWith('{') ? text : text.split('\n').find(line => line.startsWith('data: ')).slice(6));
  assert.equal(message.error, undefined, JSON.stringify(message.error));
  return message.result;
}
async function call(name, args) {
  const result = await rpc('tools/call', { name: `jaeger_${name}`, arguments: args });
  assert.equal(result.isError, false, JSON.stringify(result)); return result.structuredContent;
}
try {
  assert.equal((await rpc('tools/list', {})).tools.length, 5);
  for (const [path, expectedStatus, errorService] of [
    ['/chain/mysql/error', 500, 'service-d'],
    ['/chain/fanout/error', 500, 'service-d'],
    ['/chain/slow/redis', 200, null],
    ['/chain/degrade/ok', 200, 'service-c'],
  ]) {
    const response = await fetch(`${demo}${path}`, { signal: AbortSignal.timeout(20000) });
    await response.text(); assert.equal(response.status, expectedStatus, path);
    const traceId = response.headers.get('x-trace-id'); assert.match(traceId ?? '', /^[a-f0-9]{32}$/);
    let detail;
    const deadline = Date.now() + 45000;
    do {
      const result = await rpc('tools/call', { name: 'jaeger_get_trace', arguments: { traceId, limit: 100 } });
      if (!result.isError && result.structuredContent.found) { detail = result.structuredContent; break; }
      await new Promise(resolve => setTimeout(resolve, 1500));
    } while (Date.now() < deadline);
    assert.ok(detail, `Trace ${traceId} did not arrive within 45s`);
    const all = [...detail.spans];
    while (detail.hasMore) { detail = await call('get_trace', { traceId, offset: detail.nextOffset, limit: 100 }); all.push(...detail.spans); }
    const raw = await (await fetch(`${jaeger}/api/traces/${traceId}`)).json();
    const trace = raw.data[0]; assert.equal(all.length, trace.spans.length);
    for (const span of all) {
      const original = trace.spans.find(s => s.spanID === span.spanID);
      assert.ok(original);
      assert.equal(span.durationMs, original.duration / 1000);
      assert.equal(span.startTimeMs, original.startTime / 1000);
      assert.deepEqual(span.references, original.references);
      assert.deepEqual(span.tags, original.tags);
      assert.deepEqual(span.logs, original.logs);
      assert.deepEqual(span.process, trace.processes[original.processID]);
    }
    const errors = await call('get_trace', { traceId, errorsOnly: true, ...(errorService ? { serviceName: errorService } : {}) });
    if (errorService) assert.ok(errors.matchedSpans > 0, `${path}: no errors in ${errorService}`);
    else {
      assert.equal(errors.matchedSpans, 0);
      assert.ok(all.some(span => span.serviceName === 'service-c' && span.operationName === 'redis synthetic slow operation' && span.durationMs >= 3000));
    }
    const search = await call('query_traces', { serviceName: 'service-a', start: 'now-10m', limit: 100 });
    assert.ok(search.traces.some(t => t.traceId === traceId));
    if (!errorService) {
      const slow = await call('query_traces', { serviceName: 'service-c', start: 'now-10m', minDurationMs: 3000, limit: 100 });
      assert.ok(slow.traces.some(t => t.traceId === traceId));
    }
    const page = await call('get_trace', { traceId, limit: 1 });
    assert.equal(page.spans.length, 1); assert.equal(page.hasMore, true);
    const result = { path, httpStatus: response.status, traceId, totalSpans: all.length, services: [...new Set(all.map(s => s.serviceName))].sort(), matchingErrorSpans: errors.matchedSpans, rawEvidenceMatched: true };
    report.scenarios.push(result); console.log(JSON.stringify(result));
  }
  // A healthy, fresh Jaeger has no service/operation index until traffic arrives.
  // Check discovery after generating all scenarios, allowing index propagation.
  const discoveryDeadline = Date.now() + 45000;
  let discoveryReady = false;
  do {
    const services = await call('list_services', { limit: 100 });
    const operations = await call('list_operations', { serviceName: 'service-a', limit: 100 });
    discoveryReady = ['service-a', 'service-b', 'service-c', 'service-d', 'traefik'].every(name => services.services.includes(name)) && operations.operations.length > 0;
    if (discoveryReady) { report.services = services.services; break; }
    await new Promise(resolve => setTimeout(resolve, 1500));
  } while (Date.now() < discoveryDeadline);
  assert.ok(discoveryReady, 'Service/operation indexes did not become ready within 45s after scenario traffic');
  const topologyEnd = new Date().toISOString();
  const topologyStart = new Date(Date.parse(topologyEnd) - 3600000).toISOString();
  const topology = await call('query_service_topology', { start: topologyStart, end: topologyEnd, limit: 500 });
  assert.equal(topology.hasMore, false);
  const params = new URLSearchParams({ endTs: String(Date.parse(topologyEnd)), lookback: '3600000' });
  const rawDependencies = await (await fetch(`${jaeger}/api/dependencies?${params}`, { signal: AbortSignal.timeout(10000) })).json();
  const rawEdges = (rawDependencies.data ?? []).map(link => ({ source: link.parent, target: link.child, callCount: link.callCount })).sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target));
  assert.deepEqual(topology.edges, rawEdges);
  for (const [source, target] of [['traefik', 'service-a'], ['service-a', 'service-b'], ['service-b', 'service-c'], ['service-b', 'service-d']]) assert.ok(topology.edges.some(edge => edge.source === source && edge.target === target && edge.callCount > 0));
  const filteredTopology = await call('query_service_topology', { start: topologyStart, end: topologyEnd, serviceNames: ['service-b'], limit: 500 });
  assert.deepEqual(filteredTopology.edges, topology.edges.filter(edge => edge.source === 'service-b' || edge.target === 'service-b'));
  report.topology = topology;
  console.log(JSON.stringify({ topology: topology.edges, rawDependenciesMatched: true }));
  report.health = await runtime.catalog.mounts[0].plugin.checkHealth(new AbortController().signal);
  assert.equal(report.health.state, 'healthy');
  await mkdir('.scratch/jaeger-mcp', { recursive: true });
  await writeFile('.scratch/jaeger-mcp/live-verification.json', JSON.stringify(report, null, 2) + '\n');
  console.log('Jaeger demo MCP verification passed');
} finally {
  runtime.server.closeAllConnections(); await new Promise(resolve => runtime.server.close(resolve));
}
