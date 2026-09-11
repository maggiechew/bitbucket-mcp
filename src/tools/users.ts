import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveWorkspace } from "../git-context.js";
import { findUsers, getCurrentUser } from "../users.js";

export function registerUserTools(server: McpServer): void {
  server.tool(
    "findUser",
    "Find workspace members by a name fragment (display name or nickname, case-insensitive). Returns every match with its uuid; pass the uuid to other tools as author.",
    {
      workspace: z.string().optional().describe("Bitbucket workspace (auto-detected from git remote if omitted)"),
      query: z.string().describe("Name fragment to search for, e.g. 'stan'"),
    },
    async ({ workspace, query }) => {
      const matches = await findUsers(resolveWorkspace(workspace), query);
      const text = matches.length === 0
        ? `No workspace members match "${query}".`
        : JSON.stringify(matches, null, 2);
      return { content: [{ type: "text" as const, text }] };
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
