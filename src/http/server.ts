import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isIP } from "node:net";
import type { Config } from "../config.js";
import { publicMcpUrl } from "../config.js";
import type { Principal } from "../domain.js";
import type { Logger } from "../logger.js";
import { createMcpServer } from "../mcp/server.js";
import type { ReplayStore } from "../security/replay-store.js";
import type { TokenService } from "../security/tokens.js";
import { OAuthHandler } from "./oauth.js";
import { json } from "./responses.js";

function clientIp(config: Config, server: Bun.Server<undefined>, request: Request): string {
  if (config.TRUST_PROXY) {
    const cloudflare = request.headers.get("cf-connecting-ip")?.trim();
    if (cloudflare && isIP(cloudflare)) return cloudflare;
    const forwarded = request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim();
    if (forwarded && isIP(forwarded)) return forwarded;
  }
  return server.requestIP(request)?.address ?? "unknown";
}

function bearer(request: Request): string | undefined {
  const value = request.headers.get("authorization");
  if (!value || value.length > 8_200) return undefined;
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/u.exec(value);
  return match?.[1];
}

export function startHttpServer(
  config: Config,
  tokens: TokenService,
  store: ReplayStore,
  logger: Logger,
): Bun.Server<undefined> {
  const oauth = new OAuthHandler(config, tokens, store, logger);
  const publicUrl = new URL(config.PUBLIC_BASE_URL);
  const allowedOrigins = new Set([
    publicUrl.origin,
    ...config.ALLOWED_ORIGINS.split(",").map((value) => value.trim()).filter(Boolean),
  ]);
  const metadataUrl = new URL("/.well-known/oauth-protected-resource", config.PUBLIC_BASE_URL).toString();

  const server = Bun.serve({
    hostname: config.HOST,
    port: config.PORT,
    maxRequestBodySize: 1_048_576,
    idleTimeout: 30,
    async fetch(request, bunServer) {
      const url = new URL(request.url);
      const ip = clientIp(config, bunServer, request);

      if (url.pathname === "/healthz") return json({ status: "ok" });
      if (url.pathname === "/readyz") {
        return await store.ready() ? json({ status: "ready" }) : json({ status: "not_ready" }, 503);
      }
      if (url.pathname === "/.well-known/oauth-authorization-server") return oauth.metadata();
      if (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname === `/.well-known/oauth-protected-resource${config.MCP_PATH}`) return oauth.resourceMetadata();
      if (url.pathname === "/oauth/register" && request.method === "POST") return oauth.register(request, ip);
      if (url.pathname === "/oauth/authorize" && request.method === "GET") return oauth.authorizeGet(request, ip);
      if (url.pathname === "/oauth/authorize" && request.method === "POST") return oauth.authorizePost(request, ip);
      if (url.pathname === "/oauth/token" && request.method === "POST") return oauth.token(request, ip);

      if (url.pathname !== config.MCP_PATH) return json({ error: "not_found" }, 404);
      const origin = request.headers.get("origin");
      if (origin && !allowedOrigins.has(origin)) return json({ error: "forbidden_origin" }, 403);
      const accessToken = bearer(request);
      if (!accessToken) {
        return json({ error: "unauthorized" }, 401, {
          "www-authenticate": `Bearer resource_metadata="${metadataUrl}"`,
        });
      }

      let principal: Principal;
      try {
        principal = await tokens.readAccessToken(accessToken);
      } catch (error) {
        logger.warn({ error: error instanceof Error ? error.message : "unknown", ip }, "MCP authorization failed");
        return json({ error: "invalid_token" }, 401, {
          "www-authenticate": `Bearer error="invalid_token", resource_metadata="${metadataUrl}"`,
        });
      }

      const requestCount = await store.increment("rate:mcp", `${principal.subject}:${ip}`, 60);
      if (requestCount > config.MCP_RATE_LIMIT_PER_MINUTE) {
        return json({ error: "rate_limit_exceeded" }, 429, { "retry-after": "60" });
      }
      const transport = new WebStandardStreamableHTTPServerTransport({
        enableJsonResponse: true,
        enableDnsRebindingProtection: true,
        allowedHosts: [publicUrl.host],
        allowedOrigins: [...allowedOrigins],
      });
      const mcp = createMcpServer(config, principal, tokens, logger);
      try {
        await mcp.connect(transport);
        return await transport.handleRequest(request);
      } catch (error) {
        logger.error({ error: error instanceof Error ? error.message : "unknown", ip }, "MCP request failed");
        return json({ error: "mcp_request_failed" }, 500);
      } finally {
        await mcp.close().catch((error: unknown) => {
          logger.warn({ error: error instanceof Error ? error.message : "unknown" }, "MCP request cleanup failed");
        });
      }
    },
    error(error) {
      logger.error({ error: error.message }, "Unhandled HTTP error");
      return json({ error: "internal_error" }, 500);
    },
  });

  logger.info({ address: server.url.toString(), resource: publicMcpUrl(config) }, "2328 MCP server started");
  return server;
}
