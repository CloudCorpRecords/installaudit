/**
 * installaudit MCP server. Tool: audit_install_scripts.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runCheck, VERSION } from "./core.js";

const server = new McpServer({ name: "installaudit", version: VERSION });

server.tool(
  "audit_install_scripts",
  "Inventory install-time code execution for a repo: every dependency whose lockfile entry carries hasInstallScript, grouped by ecosystem position (direct vs transitive), plus the root package.json lifecycle scripts classified into build, network, shell-out, and other. Verdict CLEAN when nothing runs at install, REVIEW when install scripts exist.",
  {
    path: z.string().describe("Target path to check"),
  },
  async ({ path }) => {
    const report = runCheck(path);
    return { content: [{ type: "text" as const, text: JSON.stringify(report, null, 2) }] };
  },
);

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

void main();
