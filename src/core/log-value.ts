export function limitLogValue(value: unknown, maxCharacters: number): unknown {
  if (typeof value === "string") {
    return truncateText(value, maxCharacters);
  }
  if (value === null || typeof value !== "object") return value;
  if (Buffer.isBuffer(value)) return `<Buffer ${value.length} bytes>`;

  const normalized = normalizeLogValue(value);
  let serialized: string;
  try {
    serialized = JSON.stringify(normalized);
  } catch {
    return "[unserializable value]";
  }
  return serialized.length > maxCharacters
    ? `${serialized.slice(0, maxCharacters)}...[truncated]`
    : normalized;
}

function normalizeLogValue(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== "object") return value;
  if (depth >= 5) return "[nested value truncated]";
  if (Buffer.isBuffer(value)) return `<Buffer ${value.length} bytes>`;
  if (Array.isArray(value)) {
    return value.map((item) => normalizeLogValue(item, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, normalizeLogValue(item, depth + 1)]),
  );
}

function truncateText(value: string, maxCharacters: number): string {
  return value.length > maxCharacters
    ? `${value.slice(0, maxCharacters)}...[truncated]`
    : value;
}
