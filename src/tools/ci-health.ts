import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ciHealth } from "../ci-health.js";

export function registerCiHealthTools(server: McpServer): void {
  server.tool(
    "getCiHealth",
    'How CI is looking right now, with a verdict. `assessment.status` is ok, degraded or down; `assessment.summary` is the one-line answer, and when it is ok that line is the whole story ("Situation normal: 3 builds running, nothing queued"). `assessment.findings` is empty when ok; otherwise each finding names the condition, the evidence and what to do about it: Jenkins unreachable, a label no online node serves (queued builds stuck), quieting down for a restart, agents offline with reasons, executors saturated, a Bitbucket incident, or an unrecognised long wait with Jenkins\'s own queue reasons. Raw data follows: Bitbucket\'s status page, and for Jenkins the queue items (task, minutes waiting, reason, stuck), nodes with executors busy of total, and quiet mode. Call it for "is CI down", "how is Jenkins looking", when a build will not start, or when a build failed for a reason that looks like infrastructure.',
    {},
    async () => {
      const health = await ciHealth();
      return { content: [{ type: "text" as const, text: JSON.stringify(health, null, 2) }] };
    },
  );
}
