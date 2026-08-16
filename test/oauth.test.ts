import { describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { OAuthHandler } from "../src/http/oauth.js";
import { createLogger } from "../src/logger.js";
import { MemoryReplayStore } from "../src/security/replay-store.js";
import { TokenService } from "../src/security/tokens.js";
import { testConfig } from "./fixtures.js";

function formRequest(url: string, values: Record<string, string> | URLSearchParams): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: values instanceof URLSearchParams ? values : new URLSearchParams(values),
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
    expect(page).toContain("Каждая операция требует отдельного подтверждения");
    expect(page).toContain('value="wallet:read" checked');
    expect(page).toContain('value="payout:quote"');
    expect(page).not.toContain('value="payout:quote" checked');
    expect(page).toContain('value="payout:create"');
    expect(page).not.toContain('value="payout:create" checked');
    expect(page).toContain('id="payout-field" hidden');
    expect(page.indexOf("<form")).toBeLessThan(page.indexOf('name="scope"'));
    expect(page).toContain("Подключаем…");
    const nonce = /<script nonce="([^"]+)">/u.exec(page)?.[1];
    if (!nonce) throw new Error("Authorization page CSP nonce is missing");
    const contentSecurityPolicy = consent.headers.get("content-security-policy");
    expect(contentSecurityPolicy).toContain("form-action 'self' https://client.example");
    expect(contentSecurityPolicy).toContain(`script-src 'nonce-${nonce}'`);
    expect(page).toContain('action="/oauth/authorize"');
    const requestToken = /name="request_token" value="([^"]+)"/u.exec(page)?.[1];
    expect(requestToken).toBeTruthy();

    const approvalValues = new URLSearchParams({
      request_token: requestToken!,
      project_id: "project-123",
      api_key: "a".repeat(32),
      payout_api_key: "b".repeat(32),
      decision: "approve",
    });
    approvalValues.append("scope", "wallet:read");
    approvalValues.append("scope", "payout:quote");
    approvalValues.append("scope", "payout:create");
    const approval = await oauth.authorizePost(formRequest("https://mcp.example.test/oauth/authorize", approvalValues), "127.0.0.1");
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
    const tokenBody = await tokenResponse.json() as { access_token: string; refresh_token: string; scope: string; refresh_token_expires_in: number };
    expect(tokenBody.scope).toBe("wallet:read payout:quote payout:create");
    expect(tokenBody.refresh_token).toBeTruthy();
    expect(tokenBody.refresh_token_expires_in).toBeGreaterThan(0);
    expect((await tokens.readAccessToken(tokenBody.access_token)).credentials.projectId).toBe("project-123");

    const replay = await oauth.token(formRequest("https://mcp.example.test/oauth/token", tokenValues), "127.0.0.1");
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: "invalid_grant" });

    const refreshValues = {
      grant_type: "refresh_token",
      refresh_token: tokenBody.refresh_token,
      client_id: client.client_id,
      resource: "https://mcp.example.test/mcp",
    };
    const wrongClient = await oauth.token(formRequest("https://mcp.example.test/oauth/token", {
      ...refreshValues,
      client_id: "wrong-client",
    }), "127.0.0.1");
    expect(wrongClient.status).toBe(400);
    expect(await wrongClient.json()).toMatchObject({ error: "invalid_grant" });
    const rotatedResponse = await oauth.token(formRequest("https://mcp.example.test/oauth/token", refreshValues), "127.0.0.1");
    expect(rotatedResponse.status).toBe(200);
    const rotated = await rotatedResponse.json() as { access_token: string; refresh_token: string; scope: string };
    expect(rotated.refresh_token).not.toBe(tokenBody.refresh_token);
    expect(rotated.scope).toBe(tokenBody.scope);
    expect((await tokens.readAccessToken(rotated.access_token)).scopes).toEqual(new Set(["wallet:read", "payout:quote", "payout:create"]));

    const reused = await oauth.token(formRequest("https://mcp.example.test/oauth/token", refreshValues), "127.0.0.1");
    expect(reused.status).toBe(400);
    expect(await reused.json()).toMatchObject({ error: "invalid_grant" });
    const revokedNewest = await oauth.token(formRequest("https://mcp.example.test/oauth/token", {
      ...refreshValues,
      refresh_token: rotated.refresh_token,
    }), "127.0.0.1");
    expect(revokedNewest.status).toBe(400);
    expect(await revokedNewest.json()).toMatchObject({ error: "invalid_grant" });
  });

  test("publishes MCP discovery metadata", async () => {
    const config = testConfig();
    const oauth = new OAuthHandler(config, new TokenService(config), new MemoryReplayStore(), createLogger(config));
    expect(oauth.metadata().status).toBe(200);
    expect(oauth.resourceMetadata().status).toBe(200);
    expect(await oauth.metadata().json()).toMatchObject({
      grant_types_supported: ["authorization_code", "refresh_token"],
    });
  });

  test("allows only the registered loopback callback origin in form-action", async () => {
    const config = testConfig();
    const tokens = new TokenService(config);
    const oauth = new OAuthHandler(config, tokens, new MemoryReplayStore(), createLogger(config));
    const redirectUri = "http://127.0.0.1:52207/callback/random-path";
    const clientId = await tokens.issueClient({ redirectUris: [redirectUri], clientName: "Codex CLI" });
    const url = new URL("https://mcp.example.test/oauth/authorize");
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: "x".repeat(43),
      code_challenge_method: "S256",
      scope: "wallet:read",
    }).toString();

    const response = await oauth.authorizeGet(new Request(url), "127.0.0.1");
    expect(response.headers.get("content-security-policy")).toContain("form-action 'self' http://127.0.0.1:52207");
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

  test("allows granting a safe subset without a payout key", async () => {
    const config = testConfig();
    const tokens = new TokenService(config);
    const fetchMock = mock(async () => Response.json({ state: 0, result: [] }));
    const oauth = new OAuthHandler(config, tokens, new MemoryReplayStore(), createLogger(config), fetchMock as unknown as typeof fetch);
    const redirectUri = "https://client.example/callback";
    const clientId = await tokens.issueClient({ redirectUris: [redirectUri], clientName: "Scoped client" });
    const authorizationToken = await tokens.issueAuthorizationRequest({
      clientId,
      redirectUri,
      codeChallenge: "x".repeat(43),
      scope: "wallet:read payout:create convert:execute",
    });
    const values = new URLSearchParams({
      request_token: authorizationToken,
      project_id: "project-123",
      api_key: "a".repeat(32),
      decision: "approve",
    });
    values.append("scope", "wallet:read");
    const response = await oauth.authorizePost(formRequest("https://mcp.example.test/oauth/authorize", values), "127.0.0.1");
    expect(response.status).toBe(303);
    const code = new URL(response.headers.get("location")!).searchParams.get("code")!;
    expect((await tokens.readAuthorizationCode(code)).scope).toBe("wallet:read");
  });

  test("rejects a scope that the client did not request", async () => {
    const config = testConfig();
    const tokens = new TokenService(config);
    const oauth = new OAuthHandler(config, tokens, new MemoryReplayStore(), createLogger(config));
    const redirectUri = "https://client.example/callback";
    const clientId = await tokens.issueClient({ redirectUris: [redirectUri], clientName: "Scoped client" });
    const authorizationToken = await tokens.issueAuthorizationRequest({
      clientId,
      redirectUri,
      codeChallenge: "x".repeat(43),
      scope: "wallet:read",
    });
    const values = new URLSearchParams({
      request_token: authorizationToken,
      project_id: "project-123",
      api_key: "a".repeat(32),
      decision: "approve",
    });
    values.append("scope", "payout:create");
    const response = await oauth.authorizePost(formRequest("https://mcp.example.test/oauth/authorize", values), "127.0.0.1");
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Выбран недоступный уровень доступа");
  });

  test("returns access_denied when the user cancels", async () => {
    const config = testConfig();
    const tokens = new TokenService(config);
    const oauth = new OAuthHandler(config, tokens, new MemoryReplayStore(), createLogger(config));
    const redirectUri = "https://client.example/callback";
    const clientId = await tokens.issueClient({ redirectUris: [redirectUri], clientName: "Cancelable client" });
    const authorizationToken = await tokens.issueAuthorizationRequest({
      clientId,
      redirectUri,
      codeChallenge: "x".repeat(43),
      scope: "wallet:read",
      state: "cancel-state",
    });
    const response = await oauth.authorizePost(formRequest("https://mcp.example.test/oauth/authorize", {
      request_token: authorizationToken,
      decision: "deny",
    }), "127.0.0.1");
    expect(response.status).toBe(303);
    const callback = new URL(response.headers.get("location")!);
    expect(callback.searchParams.get("error")).toBe("access_denied");
    expect(callback.searchParams.get("state")).toBe("cancel-state");
  });
});
