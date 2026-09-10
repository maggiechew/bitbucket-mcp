#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerPullRequestTools } from "./tools/pull-requests.js";
import { registerCommentTools } from "./tools/comments.js";
import { registerDiffTools } from "./tools/diffs.js";
import { registerPipelineTools } from "./tools/pipelines.js";
import { registerActivityTools } from "./tools/activity.js";

const server = new McpServer({
  name: "bitbucket",
  version: "1.0.0",
});

registerPullRequestTools(server);
registerCommentTools(server);
registerDiffTools(server);
registerPipelineTools(server);
registerActivityTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
