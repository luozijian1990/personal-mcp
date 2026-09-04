import { readFileSync } from "node:fs";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type RuntimeConfigValues = Readonly<Record<string, string>>;

export interface RuntimeConfigStoreOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly filePath?: string;
}

export interface RuntimeConfigStore {
  environment(): NodeJS.ProcessEnv;
  update(values: RuntimeConfigValues): Promise<void>;
}

const DEFAULT_RUNTIME_CONFIG_PATH = path.join(process.cwd(), ".runtime-config.json");

export function createRuntimeConfigStore(
  options: RuntimeConfigStoreOptions = {},
): RuntimeConfigStore {
  const baseEnvironment = { ...(options.environment ?? process.env) };
  const filePath = options.filePath
    ?? baseEnvironment.MCP_RUNTIME_CONFIG_PATH
    ?? DEFAULT_RUNTIME_CONFIG_PATH;
  let persistedValues = readPersistedValues(filePath);
  let writes = Promise.resolve();

  return {
    environment: () => ({ ...baseEnvironment, ...persistedValues }),
    update: async (values) => {
      const write = writes.then(async () => {
        const nextValues = { ...persistedValues, ...values };
        const serialized = `${JSON.stringify(nextValues, null, 2)}\n`;
        await mkdir(path.dirname(filePath), { recursive: true });
        const temporaryPath = `${filePath}.${process.pid}.tmp`;
        await writeFile(temporaryPath, serialized, { encoding: "utf8", mode: 0o600 });
        await chmod(temporaryPath, 0o600);
        await rename(temporaryPath, filePath);
        persistedValues = nextValues;
      });
      writes = write.catch(() => undefined);
      await write;
    },
  };
}

function readPersistedValues(filePath: string): Record<string, string> {
  try {
    const parsed = JSON.parse(requireFile(filePath)) as unknown;
    if (!isRecord(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(([, value]) => typeof value === "string"),
    ) as Record<string, string>;
  } catch {
    return {};
  }
}

function requireFile(filePath: string): string {
  // Runtime configuration is read synchronously during app bootstrap.
  return readFileSync(filePath, "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
