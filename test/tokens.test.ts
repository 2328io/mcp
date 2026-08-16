import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { PayoutInput, Principal } from "../src/domain.js";
import { TokenService } from "../src/security/tokens.js";
import { testConfig } from "./fixtures.js";

const principal: Principal = {
  subject: "project:test",
  scopes: new Set(["wallet:read", "payout:create"]),
  credentials: { projectId: "project-123", apiKey: "a".repeat(32), payoutApiKey: "b".repeat(32) },
};

describe("encrypted OAuth and confirmation tokens", () => {
  test("binds clients to registered redirect URIs", async () => {
    const service = new TokenService(testConfig());
    const token = await service.issueClient({ redirectUris: ["https://client.example/callback"], clientName: "Client" });
    const claims = await service.readClient(token);
    expect(claims.redirectUris).toEqual(["https://client.example/callback"]);
    expect(token).not.toContain("client.example");
  });

  test("issues a scoped access token without exposing credentials", async () => {
    const service = new TokenService(testConfig());
    const clientId = await service.issueClient({ redirectUris: ["https://client.example/cb"], clientName: "Client" });
    const request = await service.issueAuthorizationRequest({
      clientId,
      redirectUri: "https://client.example/cb",
      codeChallenge: "x".repeat(43),
      scope: "wallet:read payout:create",
    });
    const code = await service.issueAuthorizationCode(await service.readAuthorizationRequest(request), principal.credentials);
    const access = await service.issueAccessToken(await service.readAuthorizationCode(code));
    const decoded = await service.readAccessToken(access);
    expect(decoded.credentials).toEqual(principal.credentials);
    expect(decoded.scopes).toEqual(new Set(["wallet:read", "payout:create"]));
    expect(access).not.toContain(principal.credentials.apiKey);
  });

  test("keeps refresh rotation inside one absolute session lifetime", async () => {
    const service = new TokenService(testConfig());
    const clientId = await service.issueClient({ redirectUris: ["https://client.example/cb"], clientName: "Client" });
    const request = await service.issueAuthorizationRequest({
      clientId,
      redirectUri: "https://client.example/cb",
      codeChallenge: "x".repeat(43),
      scope: "wallet:read payout:create",
    });
    const code = await service.issueAuthorizationCode(
      await service.readAuthorizationRequest(request),
      principal.credentials,
      "wallet:read",
    );
    const codeClaims = await service.readAuthorizationCode(code);
    const initial = await service.issueInitialRefreshToken(codeClaims);
    const initialClaims = await service.readRefreshToken(initial.token);
    const rotated = await service.rotateRefreshToken(initialClaims);
    const rotatedClaims = await service.readRefreshToken(rotated.token);
    expect(rotated.familyId).toBe(initial.familyId);
    expect(rotated.tokenId).not.toBe(initial.tokenId);
    expect(rotated.expiresAt).toBe(initial.expiresAt);
    expect(rotatedClaims.scope).toBe("wallet:read");
    expect(rotatedClaims.clientId).toBe(clientId);
  });

  test("rejects scopes outside the authorization request", async () => {
    const service = new TokenService(testConfig());
    const clientId = await service.issueClient({ redirectUris: ["https://client.example/cb"], clientName: "Client" });
    const requestToken = await service.issueAuthorizationRequest({
      clientId,
      redirectUri: "https://client.example/cb",
      codeChallenge: "x".repeat(43),
      scope: "wallet:read",
    });
    const request = await service.readAuthorizationRequest(requestToken);
    await expect(Promise.resolve().then(() => service.issueAuthorizationCode(
      request,
      principal.credentials,
      "wallet:read payout:create",
    ))).rejects.toThrow("subset");
  });

  test("rejects tampered tokens", async () => {
    const service = new TokenService(testConfig());
    const token = await service.issueClient({ redirectUris: ["https://client.example/cb"], clientName: "Client" });
    const parts = token.split(".");
    const ciphertext = parts[3] ?? "";
    parts[3] = `${ciphertext.startsWith("a") ? "b" : "a"}${ciphertext.slice(1)}`;
    await expect(service.readClient(parts.join("."))).rejects.toThrow();
  });

  test("verifies PKCE S256", () => {
    const service = new TokenService(testConfig());
    const verifier = "v".repeat(43);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    expect(service.verifyPkce(verifier, challenge)).toBeTrue();
    expect(service.verifyPkce("z".repeat(43), challenge)).toBeFalse();
  });

  test("binds payout preparations to one connection", async () => {
    const service = new TokenService(testConfig());
    const payout: PayoutInput = {
      currency: "USDT",
      network: "TRX-TRC20",
      amount: "200",
      to_address: "TNJaddress123456789",
      fee_option: "deduct",
      order_id: "mcp-order-1",
    };
    const token = await service.issuePayoutPreparation(principal, payout);
    expect(await service.readPayoutPreparation(token, principal)).toEqual(payout);
    await expect(service.readPayoutPreparation(token, {
      ...principal,
      credentials: { ...principal.credentials, apiKey: "c".repeat(32) },
    })).rejects.toThrow("another connection");
  });

  test("binds conversion preparations to one connection", async () => {
    const tokens = new TokenService(testConfig());
    const convert = { from_currency: "USDT", to_currency: "BTC", amount: "10", amount_type: "from" as const };
    const token = await tokens.issueConvertPreparation(principal, convert);
    expect(await tokens.readConvertPreparation(token, principal)).toEqual(convert);
    await expect(tokens.readConvertPreparation(token, { ...principal, subject: "project:other" })).rejects.toThrow("another connection");
  });
});
