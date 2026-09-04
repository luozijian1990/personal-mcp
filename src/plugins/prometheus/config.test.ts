import assert from "node:assert/strict";
import test from "node:test";

import { loadPrometheusPluginConfig } from "./config.js";

test("loads Prometheus URL and timeout, including common aliases", () => {
  assert.deepEqual(loadPrometheusPluginConfig({
    PROMETHEUS_URL: " http://prometheus:9090 ",
    PROMETHEUS_QUERY_TIMEOUT: "45",
  }), {
    url: "http://prometheus:9090",
    queryTimeoutSeconds: 45,
  });
});

test("preserves invalid timeout values so the config manager can reject them", () => {
  const config = loadPrometheusPluginConfig({
    PROMETHEUS_MCP_URL: "http://prometheus:9090",
    PROMETHEUS_MCP_QUERY_TIMEOUT: "not-a-number",
  });
  assert.equal(Number.isNaN(config.queryTimeoutSeconds), true);
});
