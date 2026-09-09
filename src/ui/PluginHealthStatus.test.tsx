import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { PluginHealthState } from "../core/plugin.js";
import {
  PluginHealthBadge,
  PluginHealthDetails,
  pluginHealthPresentation,
} from "./PluginHealthStatus.js";

const PLUGIN_HEALTH_STATES: readonly PluginHealthState[] = [
  "unknown",
  "unconfigured",
  "healthy",
  "degraded",
  "unhealthy",
];

test("Console renders all health states and available observations from metadata", () => {
  assert.deepEqual(PLUGIN_HEALTH_STATES.map((state) => pluginHealthPresentation(state).label), [
    "状态未知",
    "未配置",
    "健康",
    "性能下降",
    "不健康",
  ]);
  const badges = PLUGIN_HEALTH_STATES.map((state) => renderToStaticMarkup(createElement(
    PluginHealthBadge,
    { health: { state } },
  ))).join("\n");
  assert.match(badges, /data-health-state="unknown"/);
  assert.match(badges, /data-health-state="unconfigured"/);
  assert.match(badges, /data-health-state="healthy"/);
  assert.match(badges, /data-health-state="degraded"/);
  assert.match(badges, /data-health-state="unhealthy"/);

  const details = renderToStaticMarkup(createElement(PluginHealthDetails, {
    health: {
      state: "degraded",
      message: "Backend is responding slowly",
      latencyMs: 125.5,
      checkedAt: "2026-09-09T01:02:03.000Z",
    },
  }));
  assert.match(details, /Backend is responding slowly/);
  assert.match(details, /125\.5 ms/);
  assert.match(details, /检查/);
});
