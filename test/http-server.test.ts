import { afterEach, describe, expect, test } from "bun:test";
import type { Principal } from "../src/domain.js";
import { startHttpServer } from "../src/http/server.js";
import { createLogger } from "../src/logger.js";
import { MemoryReplayStore } from "../src/security/replay-store.js";
import { TokenService } from "../src/security/tokens.js";
import { testConfig } from "./fixtures.js";

const runningServers: Bun.Server<undefined>[] = [];

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map(async (server) => server.stop(true)));
});

async function availablePort(): Promise<number> {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("probe") });
  const port = probe.port;
  await probe.stop(true);
  if (port === undefined) throw new Error("Bun did not allocate a test port");
  return port;
}

async function accessToken(tokens: TokenService, principal: Principal): Promise<string> {
  const clientId = await tokens.issueClient({ redirectUris: ["https://client.example/callback"], clientName: "Test" });
  const requestToken = await tokens.issueAuthorizationRequest({
    clientId,
    redirectUri: "https://client.example/callback",
    codeChallenge: "x".repeat(43),
    scope: [...principal.scopes].join(" "),
  });
  const code = await tokens.issueAuthorizationCode(await tokens.readAuthorizationRequest(requestToken), principal.credentials);
  return tokens.issueAccessToken(await tokens.readAuthorizationCode(code));
}

describe("hosted MCP HTTP boundary", () => {
  test("reports dependency readiness independently from liveness", async () => {
    const port = await availablePort();
    const baseUrl = `http://127.0.0.1:${String(port)}`;
    const config = testConfig({ PORT: port, PUBLIC_BASE_URL: baseUrl });
    const store = new MemoryReplayStore();
    store.ready = () => Promise.resolve(false);
    const server = startHttpServer(config, new TokenService(config), store, createLogger(config));
    runningServers.push(server);
    expect((await fetch(`${baseUrl}/healthz`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/readyz`)).status).toBe(503);
  });

  test("rate limits authenticated requests by principal and IP", async () => {
    const port = await availablePort();
    const baseUrl = `http://127.0.0.1:${String(port)}`;
    const config = testConfig({ PORT: port, PUBLIC_BASE_URL: baseUrl, MCP_RATE_LIMIT_PER_MINUTE: 1 });
    const tokens = new TokenService(config);
    const principal: Principal = {
      subject: "project:test",
      scopes: new Set(["wallet:read"]),
      credentials: { projectId: "project-123", apiKey: "a".repeat(32) },
    };
    const token = await accessToken(tokens, principal);
    const store = new MemoryReplayStore();
    const server = startHttpServer(config, tokens, store, createLogger(config));
    runningServers.push(server);
    const request = () => fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        origin: baseUrl,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });

    const first = await request();
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ jsonrpc: "2.0", id: 1, result: {} });
    const limited = await request();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
  });

  test("rejects oversized bearer headers before token processing", async () => {
    const port = await availablePort();
    const baseUrl = `http://127.0.0.1:${String(port)}`;
    const config = testConfig({ PORT: port, PUBLIC_BASE_URL: baseUrl });
    const tokens = new TokenService(config);
    const server = startHttpServer(config, tokens, new MemoryReplayStore(), createLogger(config));
    runningServers.push(server);
    const response = await fetch(`${baseUrl}/mcp`, { headers: { authorization: `Bearer ${"a".repeat(8_201)}` } });
    expect(response.status).toBe(401);
  });
});
