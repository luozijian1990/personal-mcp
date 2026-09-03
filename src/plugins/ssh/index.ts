import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";

import type { PersonalMcpPlugin } from "../../core/plugin.js";
import type { SshPluginConfig } from "./config.js";
import { loadSshPluginConfig } from "./config.js";
import type { SshExecutor, SshRunResult } from "./ssh-runner.js";
import { runSsh } from "./ssh-runner.js";

const SYSTEM_SNAPSHOT_COMMAND = "id; hostname; date -Is; uname -a; uptime; df -h";

const targetSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:@%+\-]*$/,
    "Use an SSH config alias or a user@host target without spaces",
  )
  .describe("An exact target from SSH_MCP_ALLOWED_TARGETS, preferably an ~/.ssh/config alias");

const timeoutSchema = z
  .number()
  .int()
  .min(5)
  .max(300)
  .default(30)
  .describe("Maximum execution time in seconds (5-300, default 30)");

const maxOutputSchema = z
  .number()
  .int()
  .min(1_000)
  .max(100_000)
  .default(20_000)
  .describe("Maximum combined stdout/stderr characters returned (default 20000)");

const resultSchema = z.object({
  target: z.string(),
  command: z.string(),
  exitCode: z.number().int(),
  signal: z.string().nullable(),
  durationMs: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  outputTruncated: z.boolean(),
});

export interface CreateSshPluginOptions {
  readonly config?: SshPluginConfig;
  readonly executor?: SshExecutor;
}

export function createSshPlugin(
  options: CreateSshPluginOptions = {},
): PersonalMcpPlugin {
  const config = options.config ?? loadSshPluginConfig();
  const executor = options.executor ?? runSsh;

  return {
    id: "ssh",
    displayName: "SSH Remote Operations",
    summary: "通过本机 SSH 配置连接白名单主机，执行系统快照与受控命令。",
    category: {
      id: "remote-operations",
      name: "远程运维",
      description: "连接和诊断远程 Linux/Unix 主机。",
    },
    tools: [
      {
        name: "ssh_get_system_snapshot",
        title: "系统快照",
        risk: "read-only",
      },
      {
        name: "ssh_execute_command",
        title: "执行命令",
        risk: "write-capable",
      },
    ],
    createServer: () => createSshServer(config, executor),
  };
}

function createSshServer(config: SshPluginConfig, executor: SshExecutor): McpServer {
  const server = new McpServer({ name: "ssh-mcp-server", version: "0.1.0" });

  server.registerTool(
    "ssh_get_system_snapshot",
    {
      title: "Get SSH system snapshot",
      description:
        "Connect to one allowlisted SSH target and run a fixed read-only identity, time, kernel, uptime, and disk-space snapshot. It never disables host-key checking and never prompts for a password.",
      inputSchema: z.object({
        target: targetSchema,
        timeoutSeconds: timeoutSchema,
        maxOutputCharacters: maxOutputSchema,
      }),
      outputSchema: resultSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ target, timeoutSeconds, maxOutputCharacters }) => {
      const denied = validateTarget(config, target);
      if (denied !== undefined) return toolError(denied);

      const result = await executor({
        target,
        command: SYSTEM_SNAPSHOT_COMMAND,
        timeoutSeconds,
        maxOutputCharacters,
      });
      return toolResult(result);
    },
  );

  server.registerTool(
    "ssh_execute_command",
    {
      title: "Execute an SSH command",
      description:
        "Execute one command on one allowlisted SSH target. The command may change or destroy remote state. Call only after the user has explicitly authorized the exact target and command. The server must also be started with SSH_MCP_ALLOW_COMMANDS=true.",
      inputSchema: z.object({
        target: targetSchema,
        command: z
          .string()
          .min(1)
          .max(8_192)
          .refine((value) => !value.includes("\0"), "Command must not contain NUL bytes")
          .describe("The exact remote shell command authorized by the user"),
        timeoutSeconds: timeoutSchema,
        maxOutputCharacters: maxOutputSchema,
        acknowledgeRemoteChangeRisk: z
          .literal(true)
          .describe("Must be true to acknowledge that this command can modify remote state"),
      }),
      outputSchema: resultSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ target, command, timeoutSeconds, maxOutputCharacters }) => {
      const denied = validateTarget(config, target);
      if (denied !== undefined) return toolError(denied);
      if (!config.allowCommands) {
        return toolError(
          "Arbitrary SSH commands are disabled. Restart with SSH_MCP_ALLOW_COMMANDS=true only when you want to expose this capability.",
        );
      }

      const result = await executor({
        target,
        command,
        timeoutSeconds,
        maxOutputCharacters,
      });
      return toolResult(result);
    },
  );

  return server;
}

function validateTarget(config: SshPluginConfig, target: string): string | undefined {
  if (config.allowedTargets.size === 0) {
    return "No SSH targets are configured. Set SSH_MCP_ALLOWED_TARGETS to a comma-separated allowlist of SSH aliases or user@host targets.";
  }
  if (!config.allowedTargets.has(target)) {
    return `SSH target is not allowlisted: ${target}`;
  }
  return undefined;
}

function toolResult(result: SshRunResult) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
    isError: result.exitCode !== 0,
  };
}

function toolError(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}
