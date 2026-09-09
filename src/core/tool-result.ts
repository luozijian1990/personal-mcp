import type { CallToolResult } from "@modelcontextprotocol/server";

/** Return a successful plain-text Tool result. */
export function toolTextResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
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
  options: { readonly isError?: boolean; readonly text?: string } = {},
): CallToolResult {
  return {
    content: [{ type: "text", text: options.text ?? JSON.stringify(value, null, 2) }],
    structuredContent: value as CallToolResult["structuredContent"],
    isError: options.isError ?? false,
  };
}
