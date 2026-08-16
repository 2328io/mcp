import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Config } from "./config.js";
import { SCOPES, type Principal } from "./domain.js";
import type { Logger } from "./logger.js";
import { createMcpServer } from "./mcp/server.js";
import type { TokenService } from "./security/tokens.js";

export async function startStdioServer(config: Config, tokens: TokenService, logger: Logger): Promise<void> {
  if (!config.PROJECT_ID || !config.API_KEY) throw new Error("PROJECT_ID and API_KEY are required for stdio");
  const principal: Principal = {
    subject: `local:${config.PROJECT_ID}`,
    scopes: new Set(config.PAYOUT_API_KEY ? SCOPES : SCOPES.filter((scope) => !scope.startsWith("payout:"))),
    credentials: {
      projectId: config.PROJECT_ID,
      apiKey: config.API_KEY,
      ...(config.PAYOUT_API_KEY ? { payoutApiKey: config.PAYOUT_API_KEY } : {}),
    },
  };
  const server = createMcpServer(config, principal, tokens, logger);
  await server.connect(new StdioServerTransport());
  logger.info("2328 MCP stdio server started");
}
