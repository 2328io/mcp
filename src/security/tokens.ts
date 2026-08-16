import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { CompactEncrypt, compactDecrypt } from "jose";
import { z } from "zod";
import type { Config } from "../config.js";
import type { ConvertInput, Credentials, PayoutInput, Principal } from "../domain.js";
import { parseScopes } from "../domain.js";

const baseClaims = z.object({
  typ: z.string(),
  iss: z.string(),
  aud: z.string(),
  iat: z.number().int(),
  exp: z.number().int(),
  jti: z.uuid(),
});

const credentialsSchema = z.object({
  projectId: z.string().min(8),
  apiKey: z.string().min(16),
  payoutApiKey: z.string().min(16).optional(),
});

const clientClaims = baseClaims.extend({
  typ: z.literal("oauth-client"),
  redirectUris: z.array(z.url()).min(1).max(10),
  clientName: z.string().max(100),
});

const authorizationRequestClaims = baseClaims.extend({
  typ: z.literal("authorization-request"),
  clientId: z.string(),
  redirectUri: z.url(),
  codeChallenge: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/u),
  scope: z.string(),
  state: z.string().max(1_024).optional(),
});

const authorizationCodeClaims = authorizationRequestClaims.extend({
  typ: z.literal("authorization-code"),
  credentials: credentialsSchema,
  subject: z.string(),
});

const accessTokenClaims = baseClaims.extend({
  typ: z.literal("access-token"),
  credentials: credentialsSchema,
  sub: z.string(),
  scope: z.string(),
});

const payoutInputSchema = z.object({
  currency: z.string().min(1).max(20),
  network: z.string().min(1).max(50),
  amount: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/u),
  to_address: z.string().min(5).max(255),
  memo: z.string().min(1).max(255).optional(),
  fee_option: z.enum(["deduct", "add"]),
  order_id: z.string().min(1).max(255),
  url_callback: z.url().optional(),
  from_currency: z.literal("USDT").optional(),
}).strict();

const convertInputSchema = z.object({
  from_currency: z.string().min(1).max(20),
  to_currency: z.string().min(1).max(20),
  amount: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/u),
  amount_type: z.enum(["from", "to"]),
}).strict();

const payoutPreparationClaims = baseClaims.extend({
  typ: z.literal("payout-preparation"),
  sub: z.string(),
  credentialFingerprint: z.string(),
  payout: payoutInputSchema,
});

const convertPreparationClaims = baseClaims.extend({
  typ: z.literal("convert-preparation"),
  sub: z.string(),
  credentialFingerprint: z.string(),
  convert: convertInputSchema,
});

type ClientClaims = z.infer<typeof clientClaims>;
type AuthorizationRequestClaims = z.infer<typeof authorizationRequestClaims>;
type AuthorizationCodeClaims = z.infer<typeof authorizationCodeClaims>;

export class TokenService {
  private readonly key: Uint8Array;
  private readonly issuer: string;
  private readonly audience: string;

  public constructor(private readonly config: Config) {
    this.key = config.TOKEN_ENCRYPTION_KEY
      ? Buffer.from(config.TOKEN_ENCRYPTION_KEY, "base64url")
      : randomBytes(32);
    this.issuer = config.PUBLIC_BASE_URL.replace(/\/$/u, "");
    this.audience = new URL(config.MCP_PATH, config.PUBLIC_BASE_URL).toString();
  }

  public issueClient(input: { redirectUris: string[]; clientName: string }): Promise<string> {
    return this.encrypt(this.claims("oauth-client", 365 * 24 * 60 * 60, {
      redirectUris: input.redirectUris,
      clientName: input.clientName,
    }));
  }

  public async readClient(token: string): Promise<ClientClaims> {
    return clientClaims.parse(await this.decrypt(token, "oauth-client"));
  }

  public issueAuthorizationRequest(input: {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    scope: string;
    state?: string;
  }): Promise<string> {
    return this.encrypt(this.claims("authorization-request", 600, input));
  }

  public async readAuthorizationRequest(token: string): Promise<AuthorizationRequestClaims> {
    return authorizationRequestClaims.parse(await this.decrypt(token, "authorization-request"));
  }

  public issueAuthorizationCode(
    request: AuthorizationRequestClaims,
    credentials: Credentials,
  ): Promise<string> {
    return this.encrypt(this.claims("authorization-code", this.config.AUTH_CODE_TTL_SECONDS, {
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge,
      scope: request.scope,
      ...(request.state ? { state: request.state } : {}),
      credentials,
      subject: this.subject(credentials.projectId),
    }));
  }

  public async readAuthorizationCode(token: string): Promise<AuthorizationCodeClaims> {
    return authorizationCodeClaims.parse(await this.decrypt(token, "authorization-code"));
  }

  public issueAccessToken(code: AuthorizationCodeClaims): Promise<string> {
    return this.encrypt(this.claims("access-token", this.config.ACCESS_TOKEN_TTL_SECONDS, {
      credentials: code.credentials,
      sub: code.subject,
      scope: code.scope,
    }));
  }

  public async readAccessToken(token: string): Promise<Principal> {
    const claims = accessTokenClaims.parse(await this.decrypt(token, "access-token"));
    return {
      subject: claims.sub,
      scopes: new Set(parseScopes(claims.scope)),
      credentials: {
        projectId: claims.credentials.projectId,
        apiKey: claims.credentials.apiKey,
        ...(claims.credentials.payoutApiKey ? { payoutApiKey: claims.credentials.payoutApiKey } : {}),
      },
    };
  }

  public issuePayoutPreparation(principal: Principal, payout: PayoutInput): Promise<string> {
    return this.encrypt(this.claims("payout-preparation", this.config.PREPARATION_TTL_SECONDS, {
      sub: principal.subject,
      credentialFingerprint: this.fingerprint(principal.credentials),
      payout,
    }));
  }

  public async readPayoutPreparation(
    token: string,
    principal: Principal,
  ): Promise<PayoutInput> {
    const claims = payoutPreparationClaims.parse(await this.decrypt(token, "payout-preparation"));
    if (claims.sub !== principal.subject || claims.credentialFingerprint !== this.fingerprint(principal.credentials)) {
      throw new Error("Payout preparation belongs to another connection");
    }
    return {
      currency: claims.payout.currency,
      network: claims.payout.network,
      amount: claims.payout.amount,
      to_address: claims.payout.to_address,
      fee_option: claims.payout.fee_option,
      order_id: claims.payout.order_id,
      ...(claims.payout.memo ? { memo: claims.payout.memo } : {}),
      ...(claims.payout.url_callback ? { url_callback: claims.payout.url_callback } : {}),
      ...(claims.payout.from_currency ? { from_currency: claims.payout.from_currency } : {}),
    };
  }

  public issueConvertPreparation(principal: Principal, convert: ConvertInput): Promise<string> {
    return this.encrypt(this.claims("convert-preparation", this.config.CONVERT_PREPARATION_TTL_SECONDS, {
      sub: principal.subject,
      credentialFingerprint: this.fingerprint(principal.credentials),
      convert,
    }));
  }

  public async readConvertPreparation(token: string, principal: Principal): Promise<ConvertInput> {
    const claims = convertPreparationClaims.parse(await this.decrypt(token, "convert-preparation"));
    if (claims.sub !== principal.subject || claims.credentialFingerprint !== this.fingerprint(principal.credentials)) {
      throw new Error("Convert preparation belongs to another connection");
    }
    return claims.convert;
  }

  public verifyPkce(verifier: string, expectedChallenge: string): boolean {
    const actual = createHash("sha256").update(verifier).digest("base64url");
    if (actual.length !== expectedChallenge.length) return false;
    return timingSafeEqual(Buffer.from(actual), Buffer.from(expectedChallenge));
  }

  private claims<T extends Record<string, unknown>>(typ: string, ttlSeconds: number, extra: T) {
    const now = Math.floor(Date.now() / 1_000);
    return {
      typ,
      iss: this.issuer,
      aud: this.audience,
      iat: now,
      exp: now + ttlSeconds,
      jti: randomUUID(),
      ...extra,
    };
  }

  private async encrypt(payload: Record<string, unknown>): Promise<string> {
    return new CompactEncrypt(new TextEncoder().encode(JSON.stringify(payload)))
      .setProtectedHeader({ alg: "dir", enc: "A256GCM", typ: String(payload.typ) })
      .encrypt(this.key);
  }

  private async decrypt(token: string, typ: string): Promise<unknown> {
    const { plaintext, protectedHeader } = await compactDecrypt(token, this.key);
    if (protectedHeader.alg !== "dir" || protectedHeader.enc !== "A256GCM" || protectedHeader.typ !== typ) {
      throw new Error("Invalid token header");
    }
    const claims = baseClaims.loose().parse(JSON.parse(new TextDecoder().decode(plaintext)));
    const now = Math.floor(Date.now() / 1_000);
    if (claims.typ !== typ || claims.iss !== this.issuer || claims.aud !== this.audience || claims.exp <= now || claims.iat > now + 30) {
      throw new Error("Invalid or expired token");
    }
    return claims;
  }

  private subject(projectId: string): string {
    return `project:${createHash("sha256").update(projectId).digest("base64url").slice(0, 22)}`;
  }

  private fingerprint(credentials: Credentials): string {
    return createHash("sha256")
      .update(`${credentials.projectId}\0${credentials.apiKey}\0${credentials.payoutApiKey ?? ""}`)
      .digest("base64url");
  }
}
