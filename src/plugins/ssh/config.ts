export interface SshPluginConfig {
  readonly allowedTargets: ReadonlySet<string>;
  readonly allowCommands: boolean;
}

export function loadSshPluginConfig(
  environment: NodeJS.ProcessEnv = process.env,
): SshPluginConfig {
  return {
    allowedTargets: new Set(
      (environment.SSH_MCP_ALLOWED_TARGETS ?? "")
        .split(",")
        .map((target) => target.trim())
        .filter(Boolean),
    ),
    allowCommands: environment.SSH_MCP_ALLOW_COMMANDS === "true",
  };
}
