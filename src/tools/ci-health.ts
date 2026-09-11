import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ciHealth } from "../ci-health.js";

export function registerCiHealthTools(server: McpServer): void {
  server.tool(
    "getCiHealth",
    "Whether the CI services are up right now: Bitbucket Cloud's status page (overall indicator, degraded components, open incidents) and, when Jenkins is configured, whether Jenkins is reachable, quieting down for a restart, how deep its queue is, and which agents are offline. Call it when a build failed for a reason that looks like infrastructure, when a build will not start, or when asked whether CI is down.",
    {},
    async () => {
      const health = await ciHealth();
      return { content: [{ type: "text" as const, text: JSON.stringify(health, null, 2) }] };
    },
  );
}
