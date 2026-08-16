import { describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { OAuthHandler } from "../src/http/oauth.js";
import { createLogger } from "../src/logger.js";
import { MemoryReplayStore } from "../src/security/replay-store.js";
import { TokenService } from "../src/security/tokens.js";
import { testConfig } from "./fixtures.js";

function formRequest(url: string, values: Record<string, string>): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(values),
  });
}

describe("OAuth Authorization Code with PKCE", () => {
  test("registers, authorizes, links a project and exchanges a code once", async () => {
    const config = testConfig();
    const tokens = new TokenService(config);
    const store = new MemoryReplayStore();
    const fetchMock = mock(async () => Response.json({ state: 0, result: [] }));
    const oauth = new OAuthHandler(config, tokens, store, createLogger(config), fetchMock as unknown as typeof fetch);

    const registration = await oauth.register(new Request("https://mcp.example.test/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["https://client.example/callback"],
        client_name: "Test MCP client",
        token_endpoint_auth_method: "none",
      }),
    }), "127.0.0.1");
    expect(registration.status).toBe(201);
    const client = await registration.json() as { client_id: string };

    const verifier = "v".repeat(64);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorizationUrl = new URL("https://mcp.example.test/oauth/authorize");
    authorizationUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: "https://client.example/callback",
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "wallet:read payout:quote payout:create",
      resource: "https://mcp.example.test/mcp",
      state: "opaque-client-state",
    }).toString();
    const consent = await oauth.authorizeGet(new Request(authorizationUrl), "127.0.0.1");
    expect(consent.status).toBe(200);
    const page = await consent.text();
    expect(page).toContain('viewBox="0 0 450 144"');
    expect(page).toContain('id="logo-grad-r0"');
    expect(page).toContain("Payout API key");
    expect(page).toContain("Доступ включает операции со средствами");
    expect(page).toContain("Подключаем…");
    const nonce = /<script nonce="([^"]+)">/u.exec(page)?.[1];
    if (!nonce) throw new Error("Authorization page CSP nonce is missing");
    expect(consent.headers.get("content-security-policy")).toContain(`script-src 'nonce-${nonce}'`);
    const requestToken = /name="request_token" value="([^"]+)"/u.exec(page)?.[1];
    expect(requestToken).toBeTruthy();

    const approval = await oauth.authorizePost(formRequest("https://mcp.example.test/oauth/authorize", {
      request_token: requestToken!,
      project_id: "project-123",
      api_key: "a".repeat(32),
      payout_api_key: "b".repeat(32),
      consent: "yes",
    }), "127.0.0.1");
    expect(approval.status).toBe(303);
    const callback = new URL(approval.headers.get("location")!);
    expect(callback.origin).toBe("https://client.example");
    expect(callback.pathname).toBe("/callback");
    expect(callback.searchParams.get("code")).toBeTruthy();
    expect(callback.searchParams.get("state")).toBe("opaque-client-state");

    const tokenValues = {
      grant_type: "authorization_code",
      code: callback.searchParams.get("code")!,
      client_id: client.client_id,
      redirect_uri: "https://client.example/callback",
      code_verifier: verifier,
    };
    const tokenResponse = await oauth.token(formRequest("https://mcp.example.test/oauth/token", tokenValues), "127.0.0.1");
    expect(tokenResponse.status).toBe(200);
    const tokenBody = await tokenResponse.json() as { access_token: string; scope: string };
    expect(tokenBody.scope).toBe("wallet:read payout:quote payout:create");
    expect((await tokens.readAccessToken(tokenBody.access_token)).credentials.projectId).toBe("project-123");

    const replay = await oauth.token(formRequest("https://mcp.example.test/oauth/token", tokenValues), "127.0.0.1");
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: "invalid_grant" });
  });

  test("publishes MCP discovery metadata", () => {
    const config = testConfig();
    const oauth = new OAuthHandler(config, new TokenService(config), new MemoryReplayStore(), createLogger(config));
    expect(oauth.metadata().status).toBe(200);
    expect(oauth.resourceMetadata().status).toBe(200);
  });

  test("does not ask for a payout key when payout scopes are absent", async () => {
    const config = testConfig();
    const tokens = new TokenService(config);
    const oauth = new OAuthHandler(config, tokens, new MemoryReplayStore(), createLogger(config));
    const clientId = await tokens.issueClient({ redirectUris: ["https://client.example/callback"], clientName: "Read only" });
    const url = new URL("https://mcp.example.test/oauth/authorize");
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: "https://client.example/callback",
      code_challenge: "x".repeat(43),
      code_challenge_method: "S256",
      scope: "wallet:read",
    }).toString();
    const response = await oauth.authorizeGet(new Request(url), "127.0.0.1");
    const page = await response.text();
    expect(page).not.toContain("Payout API key");
    expect(page).not.toContain("запрошены права на движение средств");
  });
});
