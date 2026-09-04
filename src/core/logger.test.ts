import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createLogger } from "./logger.js";

test("logger appends one-line key-value output and truncates long fields", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "personal-mcp-logger-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "mcp.log");
  const logger = createLogger({
    serviceName: "test-service",
    filePath,
    writeToConsole: false,
    maxFieldCharacters: 5,
  });

  logger.info("mcp.request", { input: "123456789" });

  const content = await waitForFile(filePath);
  assert.match(
    content,
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} [+-]\d{2}:\d{2} INFO  test-service mcp\.request input="12345\.\.\.\[truncated\]"\n$/,
  );
});

async function waitForFile(filePath: string): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      return await readFile(filePath, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for log file: ${filePath}`);
}
