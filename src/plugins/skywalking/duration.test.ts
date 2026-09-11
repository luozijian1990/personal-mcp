import assert from "node:assert/strict";
import test from "node:test";
import { buildDuration } from "./duration.js";

const info = { timezone: "+0000", currentTimestamp: Date.parse("2026-09-11T07:00:00Z") };
test("OAP minute duration preserves date separators and resolves relative time", () => {
  assert.deepEqual(buildDuration("now-30m", "now", info), { start: "2026-09-11 0630", end: "2026-09-11 0700", step: "MINUTE" });
});
test("OAP timezone is independent of the MCP host timezone", () => {
  assert.deepEqual(buildDuration("2026-09-10T23:30:00Z", "2026-09-11T08:00:00+08:00", { ...info, timezone: "+0800" }), { start: "2026-09-11 0730", end: "2026-09-11 0800", step: "MINUTE" });
});
test("invalid and reversed ranges fail before querying OAP", () => {
  assert.throws(() => buildDuration("yesterday", "now", info));
  assert.throws(() => buildDuration("now", "now-30m", info));
  assert.throws(() => buildDuration("now", "now", { ...info, timezone: "bad" }));
});

test("impossible calendar dates and overflowing clock fields are rejected", () => {
  for (const value of ["2026-02-30T00:00:00Z", "2025-02-29T00:00:00+08:00", "2026-04-31T00:00:00Z", "2026-01-01T24:00:00Z", "2026-01-01T00:60:00Z"]) {
    assert.throws(() => buildDuration(value, "now", info), /Invalid time/);
  }
  assert.deepEqual(buildDuration("2024-02-29T23:30:00-01:00", "2024-03-01T00:45:00Z", info), { start: "2024-03-01 0030", end: "2024-03-01 0045", step: "MINUTE" });
});
