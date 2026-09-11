import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveWorkspace } from "../git-context.js";
import { lookupUsers, getCurrentUser } from "../users.js";

export function registerUserTools(server: McpServer): void {
  server.tool(
    "findUsers",
    "Resolve one or more names to workspace members the way every other tool does. For each name: `resolved`, the single member the server picks (a whole name beats a whole word, beats a word starting with the name, beats a substring; 'stan' is Stanley, not Tristan), or null when the strongest matches tie; and `candidates`, every match with its `match` strength. Not a required first step: author, reviewer and reviewers parameters take names directly and resolve them identically. Use this to see who a name would pick, or to show the candidates after a tool reported a tie.",
    {
      workspace: z.string().optional().describe("Bitbucket workspace (auto-detected from git remote if omitted)"),
      names: z.union([z.string(), z.array(z.string())]).describe("One name or several, e.g. 'stan' or ['barb', 'becky', 'simone']"),
    },
    async ({ workspace, names }) => {
      const lookups = await lookupUsers(resolveWorkspace(workspace), Array.isArray(names) ? names : [names]);
      return { content: [{ type: "text" as const, text: JSON.stringify(lookups, null, 2) }] };
    },
  );

  server.tool(
    "getCurrentUser",
    "Get the Bitbucket user the server is authenticated as (uuid, display name, nickname)",
    {},
    async () => {
      const user = await getCurrentUser();
      return { content: [{ type: "text" as const, text: JSON.stringify(user, null, 2) }] };
    },
  );
}
