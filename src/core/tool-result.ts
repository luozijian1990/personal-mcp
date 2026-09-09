import type { CallToolResult, JSONObject } from "@modelcontextprotocol/server";

/** Return any successful MCP content blocks. Absence of `isError` is the protocol success form. */
export function toolSuccessResult(content: CallToolResult["content"]): CallToolResult {
  return { content };
}

/** Return a successful plain-text Tool result. */
export function toolTextResult(text: string): CallToolResult {
  return toolSuccessResult([{ type: "text", text }]);
}

/** Return a failed Tool result while preserving a domain-specific error prefix when supplied. */
export function toolErrorResult(
  error: unknown,
  options: { readonly prefix?: string } = {},
): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: `${options.prefix ?? ""}${message}` }],
    isError: true,
  };
}

/** Return domain data both as structured content and readable JSON text. */
export function toolStructuredResult<Value extends object>(
  value: Value,
  options: { readonly isError?: boolean } = {},
): CallToolResult {
  assertJsonObject(value);
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
    isError: options.isError ?? false,
  };
}

function assertJsonObject(value: object): asserts value is JSONObject {
  if (!isJsonObject(value, new Set())) {
    throw new TypeError("Structured Tool result must be a JSON object");
  }
}

function isJsonObject(value: object, ancestors: Set<object>): value is JSONObject {
  if (Array.isArray(value) || ancestors.has(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) return false;
  try {
    ancestors.add(value);
    return keys.every((key) => isJsonValue(
      (value as Readonly<Record<string, unknown>>)[String(key)],
      ancestors,
    ));
  } catch {
    return false;
  } finally {
    ancestors.delete(value);
  }
}

function isJsonValue(value: unknown, ancestors: Set<object>): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    if (ancestors.has(value)) return false;
    ancestors.add(value);
    const valid = value.every((item) => isJsonValue(item, ancestors));
    ancestors.delete(value);
    return valid;
  }
  return typeof value === "object" && isJsonObject(value, ancestors);
}
