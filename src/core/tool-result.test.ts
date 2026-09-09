import assert from "node:assert/strict";
import test from "node:test";

import { toolErrorResult, toolStructuredResult, toolTextResult } from "./tool-result.js";

test("Tool result helpers preserve text, error, and domain structured result conventions", () => {
  assert.deepEqual(toolTextResult("ok"), {
    content: [{ type: "text", text: "ok" }],
  });
  assert.deepEqual(toolErrorResult(new Error("offline"), { prefix: "Query failed: " }), {
    content: [{ type: "text", text: "Query failed: offline" }],
    isError: true,
  });

  const domainResult = { status: "success", data: [{ value: 1 }] };
  assert.deepEqual(toolStructuredResult(domainResult), {
    content: [{ type: "text", text: JSON.stringify(domainResult, null, 2) }],
    structuredContent: domainResult,
    isError: false,
  });
  assert.equal(toolStructuredResult(domainResult, { isError: true }).isError, true);
});
