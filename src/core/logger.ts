import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  info(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

export interface LoggerOptions {
  readonly serviceName: string;
  readonly filePath?: string;
  readonly writeToConsole?: boolean;
  readonly maxFieldCharacters?: number;
}

const DEFAULT_LOG_FILE = path.join(process.cwd(), "logs", "mcp.log");
const DEFAULT_MAX_FIELD_CHARACTERS = 100_000;

export function createLogger(options: LoggerOptions): Logger {
  const filePath = options.filePath ?? process.env.MCP_LOG_FILE_PATH ?? DEFAULT_LOG_FILE;
  const writeToConsole = options.writeToConsole ?? true;
  const maxFieldCharacters = options.maxFieldCharacters ?? DEFAULT_MAX_FIELD_CHARACTERS;
  let writes = Promise.resolve();

  const log = (level: "info" | "error", event: string, fields: LogFields = {}) => {
    const line = formatLogLine(
      new Date(),
      level,
      options.serviceName,
      event,
      limitFields(fields, maxFieldCharacters),
    );

    if (writeToConsole) {
      const output = level === "error" ? process.stderr : process.stdout;
      output.write(line);
    }
    writes = writes
      .then(async () => {
        await mkdir(path.dirname(filePath), { recursive: true });
        await appendFile(filePath, line, "utf8");
      })
      .catch((error: unknown) => {
        process.stderr.write(formatLogLine(
          new Date(),
          "error",
          options.serviceName,
          "logger.write_failed",
          { error: error instanceof Error ? error.message : String(error) },
        ));
      });
  };

  return {
    info: (event, fields) => log("info", event, fields),
    error: (event, fields) => log("error", event, fields),
  };
}

function formatLogLine(
  timestamp: Date,
  level: "info" | "error",
  service: string,
  event: string,
  fields: LogFields,
): string {
  const prefix = [
    formatTimestamp(timestamp),
    level.toUpperCase().padEnd(5),
    service,
    event,
  ].join(" ");
  const suffix = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${formatLogValue(value)}`)
    .join(" ");
  return suffix.length === 0 ? `${prefix}\n` : `${prefix} ${suffix}\n`;
}

function formatTimestamp(value: Date): string {
  const date = [
    value.getFullYear().toString().padStart(4, "0"),
    (value.getMonth() + 1).toString().padStart(2, "0"),
    value.getDate().toString().padStart(2, "0"),
  ].join("-");
  const time = [
    value.getHours().toString().padStart(2, "0"),
    value.getMinutes().toString().padStart(2, "0"),
    value.getSeconds().toString().padStart(2, "0"),
  ].join(":");
  const milliseconds = value.getMilliseconds().toString().padStart(3, "0");
  const offsetMinutes = -value.getTimezoneOffset();
  const offsetSign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffset = Math.abs(offsetMinutes);
  const offsetHours = Math.floor(absoluteOffset / 60).toString().padStart(2, "0");
  const offsetRemainder = (absoluteOffset % 60).toString().padStart(2, "0");
  return `${date} ${time}.${milliseconds} ${offsetSign}${offsetHours}:${offsetRemainder}`;
}

function formatLogValue(value: unknown): string {
  if (value === null) return "null";
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else if (typeof value === "object") {
    text = JSON.stringify(value);
  } else {
    text = String(value);
  }
  if (/^[A-Za-z0-9._:/@+\-]+$/.test(text)) return text;
  return `"${text
    .replaceAll("\\", "\\\\")
    .replaceAll("\"", "\\\"")
    .replaceAll("\r", "\\r")
    .replaceAll("\n", "\\n")
    .replaceAll("\t", "\\t")}"`;
}

function limitFields(fields: LogFields, maxCharacters: number): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [key, limitValue(value, maxCharacters)]),
  );
}

function limitValue(value: unknown, maxCharacters: number, depth = 0): unknown {
  if (typeof value === "string") {
    return value.length > maxCharacters
      ? `${value.slice(0, maxCharacters)}...[truncated]`
      : value;
  }
  if (value === null || typeof value !== "object") return value;
  if (depth >= 5) return "[nested value truncated]";
  if (Array.isArray(value)) {
    return value.map((item) => limitValue(item, maxCharacters, depth + 1));
  }
  if (Buffer.isBuffer(value)) return `<Buffer ${value.length} bytes>`;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, limitValue(item, maxCharacters, depth + 1)]),
  );
}
