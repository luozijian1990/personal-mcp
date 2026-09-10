import { toolStructuredResult } from "../../core/tool-result.js";
import { isRecord, type JsonRecord } from "./client.js";

/** Fits item-based results to the serialized MCP CallToolResult budget. */
export function fitItems(
  base: JsonRecord,
  key: string,
  allItems: readonly JsonRecord[],
  maximumBytes: number,
  preTruncated: boolean,
): JsonRecord {
  const originalCount = Number(base.totalCount ?? base.matchedFields ?? allItems.length);
  const build = (count: number): JsonRecord => {
    const truncated = preTruncated || count < allItems.length;
    return {
      status: truncated ? "truncated" : "complete",
      ...base,
      count,
      [key]: allItems.slice(0, count),
      ...(truncated ? {
        truncation: {
          omittedItems: Math.max(0, originalCount - count),
          message: "Result was truncated; use a narrower filter or smaller limit.",
        },
      } : {}),
    };
  };
  return requireFittingPrefix(allItems.length, build, maximumBytes);
}

/** Fits hits and aggregations to the serialized MCP CallToolResult budget. */
export function fitSearchResult(value: JsonRecord, maximumBytes: number): JsonRecord {
  const originalHits = Array.isArray(value.hits)
    ? value.hits.filter((entry): entry is JsonRecord => isRecord(entry))
    : [];
  const originalAggregations = value.aggregations;
  const { aggregations: _removedAggregations, ...base } = value;
  const build = (count: number, aggregations: unknown): JsonRecord => {
    const aggregationsOmitted = originalAggregations !== undefined && aggregations === undefined;
    const truncated = count < originalHits.length || aggregationsOmitted;
    return {
      ...base,
      status: truncated ? "truncated" : "complete",
      hits: originalHits.slice(0, count),
      ...(aggregations === undefined ? {} : { aggregations }),
      ...(truncated ? {
        truncation: {
          omittedHits: originalHits.length - count,
          aggregationsOmitted,
          message: "Result was truncated; reduce size, filter _source, or narrow aggregations.",
        },
      } : {}),
    };
  };

  const withAggregations = largestFittingPrefix(
    originalHits.length,
    (count) => build(count, originalAggregations),
    maximumBytes,
  );
  if (withAggregations !== undefined) return withAggregations;
  return requireFittingPrefix(
    originalHits.length,
    (count) => build(count, undefined),
    maximumBytes,
  );
}

/** Removes nominated diagnostic sections until the serialized Tool result fits. */
export function fitObject(
  value: JsonRecord,
  maximumBytes: number,
  removableKeys: readonly string[],
): JsonRecord {
  if (serializedToolResultBytes(value) <= maximumBytes) return value;
  const result = { ...value };
  const omitted: string[] = [];
  for (const key of removableKeys) {
    if (!Object.hasOwn(result, key)) continue;
    delete result[key];
    omitted.push(key);
    const candidate = {
      ...result,
      truncation: { omittedFields: [...omitted], message: "Large diagnostic sections were omitted." },
    };
    if (serializedToolResultBytes(candidate) <= maximumBytes) return candidate;
  }
  throw new Error(`result exceeds the ${maximumBytes} byte serialized Tool result limit`);
}

export function serializedToolResultBytes(value: JsonRecord): number {
  return Buffer.byteLength(JSON.stringify(toolStructuredResult(value)), "utf8");
}

function requireFittingPrefix(
  itemCount: number,
  build: (count: number) => JsonRecord,
  maximumBytes: number,
): JsonRecord {
  const result = largestFittingPrefix(itemCount, build, maximumBytes);
  if (result === undefined) {
    throw new Error(`result metadata exceeds the ${maximumBytes} byte serialized Tool result limit`);
  }
  return result;
}

function largestFittingPrefix(
  itemCount: number,
  build: (count: number) => JsonRecord,
  maximumBytes: number,
): JsonRecord | undefined {
  const complete = build(itemCount);
  if (serializedToolResultBytes(complete) <= maximumBytes) return complete;
  let lower = 0;
  let upper = itemCount - 1;
  let best: JsonRecord | undefined;
  while (lower <= upper) {
    const middle = Math.floor((lower + upper) / 2);
    const candidate = build(middle);
    if (serializedToolResultBytes(candidate) <= maximumBytes) {
      best = candidate;
      lower = middle + 1;
    } else {
      upper = middle - 1;
    }
  }
  return best;
}
