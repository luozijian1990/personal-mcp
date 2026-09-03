import type { McpServer } from "@modelcontextprotocol/server";

export interface PersonalMcpPlugin {
  readonly id: string;
  readonly displayName: string;
  readonly summary: string;
  readonly category: {
    readonly id: string;
    readonly name: string;
    readonly description: string;
  };
  readonly tools: readonly {
    readonly name: string;
    readonly title: string;
    readonly risk: "read-only" | "write-capable";
  }[];
  createServer(): McpServer;
}
