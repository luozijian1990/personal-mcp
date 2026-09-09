import assert from "node:assert/strict";
import test from "node:test";

import {
  toolErrorResult,
  toolStructuredResult,
  toolSuccessResult,
  toolTextResult,
} from "./tool-result.js";

test("Tool result helpers preserve text, error, and domain structured result conventions", () => {
  assert.deepEqual(toolSuccessResult([{ type: "text", text: "generic success" }]), {
    content: [{ type: "text", text: "generic success" }],
  });
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

test("structured Tool results reject values outside the MCP JSON object contract", () => {
  assert.throws(
    () => toolStructuredResult(["not", "an", "object"]),
    /must be a JSON object/,
  );
  assert.throws(
    () => toolStructuredResult({ value: undefined }),
    /must be a JSON object/,
  );
  const circular: { self?: object } = {};
  circular.self = circular;
  assert.throws(() => toolStructuredResult(circular), /must be a JSON object/);
});
