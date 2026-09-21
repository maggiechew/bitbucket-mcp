#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerPullRequestTools } from "./tools/pull-requests.js";
import { registerCommentTools } from "./tools/comments.js";
import { registerActivityTools } from "./tools/activity.js";
import { registerUserTools } from "./tools/users.js";
import { registerJenkinsTools } from "./tools/jenkins.js";
import { registerCiHealthTools } from "./tools/ci-health.js";
import { jenkinsConfigured } from "./jenkins-client.js";

const server = new McpServer({
  name: "bitbucket",
  version: "1.0.0",
});

registerPullRequestTools(server);
registerCommentTools(server);
registerActivityTools(server);
registerUserTools(server);
registerCiHealthTools(server);
if (jenkinsConfigured()) registerJenkinsTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
