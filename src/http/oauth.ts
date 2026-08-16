import type { Config } from "../config.js";
import { publicMcpUrl } from "../config.js";
import { SCOPES, parseScopes } from "../domain.js";
import type { Logger } from "../logger.js";
import { Payments2328Client } from "../api/client.js";
import type { ReplayStore } from "../security/replay-store.js";
import type { TokenService } from "../security/tokens.js";
import { json, oauthError, readForm, SECURITY_HEADERS } from "./responses.js";

const SCOPE_DESCRIPTIONS: Record<string, string> = {
  "wallet:read": "Просмотр балансов и доступных направлений",
  "market:read": "Просмотр публичных курсов и цен",
  "invoice:read": "Просмотр счетов и их статусов",
  "invoice:create": "Создание новых счетов",
  "static-wallet:read": "Просмотр постоянных кошельков и поступлений",
  "static-wallet:create": "Создание постоянных кошельков",
  "static-wallet:update": "Включение и отключение постоянных кошельков",
  "payout:read": "Просмотр статуса выплат",
  "payout:quote": "Расчёт суммы и комиссии выплаты без отправки",
  "payout:create": "Отправка средств на блокчейн-адрес",
  "convert:quote": "Расчёт конвертации без движения средств",
  "convert:execute": "Конвертация средств на балансе",
};

function validRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return !url.username && !url.password && !url.hash;
    return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

function redirectWith(urlValue: string, values: Record<string, string | undefined>): Response {
  const url = new URL(urlValue);
  for (const [key, value] of Object.entries(values)) if (value !== undefined) url.searchParams.set(key, value);
  return Response.redirect(url, 302);
}

function authorizationPage(requestToken: string, scopes: readonly string[], error?: string): Response {
  const moneyMoving = new Set(["payout:create", "convert:execute"]);
  const scopeItems = scopes.map((scope) => `<li${moneyMoving.has(scope) ? ' class="danger"' : ""}><code>${Bun.escapeHTML(scope)}</code><span>${Bun.escapeHTML(SCOPE_DESCRIPTIONS[scope] ?? scope)}</span></li>`).join("");
  const errorBlock = error ? `<p class="error">${Bun.escapeHTML(error)}</p>` : "";
  const payoutField = scopes.some((scope) => scope.startsWith("payout:"))
    ? '<label for="payout_api_key">Payout API key <span class="muted">(отдельный ключ выплат)</span></label><input id="payout_api_key" name="payout_api_key" type="password" minlength="16" maxlength="512">'
    : "";
  const moneyWarning = scopes.some((scope) => moneyMoving.has(scope))
    ? '<p class="warning"><strong>Внимание:</strong> запрошены права на движение средств. MCP-клиент сможет выполнять их только через отдельный шаг подтверждения.</p>'
    : "";
  const body = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Подключить 2328 к MCP</title><style>
body{font:16px system-ui;background:#0d1117;color:#e6edf3;margin:0;padding:32px}main{max-width:620px;margin:auto;background:#161b22;border:1px solid #30363d;border-radius:12px;padding:28px}label{display:block;margin:16px 0 6px}input{box-sizing:border-box;width:100%;padding:11px;border:1px solid #484f58;border-radius:7px;background:#0d1117;color:#e6edf3}button{margin-top:22px;padding:11px 18px;border:0;border-radius:7px;background:#238636;color:white;font-weight:600}.muted{color:#8b949e}.error{color:#ff7b72}.warning{padding:12px;border:1px solid #d29922;border-radius:7px;background:#2d2205}.danger{color:#ffb4a9}li{margin:8px 0}li span{display:block;color:#b1bac4;margin-top:2px}code{color:#79c0ff}</style></head>
<body><main><h1>Подключение аккаунта 2328</h1><p>Укажите ключи проекта из кабинета 2328. Пароль аккаунта этому серверу не передаётся.</p>${errorBlock}
<p>Запрашиваемые права:</p><ul>${scopeItems}</ul>${moneyWarning}
<form method="post" autocomplete="off"><input type="hidden" name="request_token" value="${Bun.escapeHTML(requestToken)}">
<label for="project_id">Project UUID</label><input id="project_id" name="project_id" required minlength="8" maxlength="128" spellcheck="false">
<label for="api_key">API key</label><input id="api_key" name="api_key" type="password" required minlength="16" maxlength="512">
${payoutField}
<label><input style="width:auto" type="checkbox" name="consent" value="yes" required> Разрешаю перечисленные действия этому MCP-клиенту</label>
<button type="submit">Подключить</button></form>
<p class="muted">Ключи шифруются в короткоживущем access token и не сохраняются в базе MCP.</p></main></body></html>`;
  return new Response(body, { status: error ? 400 : 200, headers: { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8" } });
}

export class OAuthHandler {
  private readonly issuer: string;
  private readonly resource: string;

  public constructor(
    private readonly config: Config,
    private readonly tokens: TokenService,
    private readonly store: ReplayStore,
    private readonly logger: Logger,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {
    this.issuer = config.PUBLIC_BASE_URL.replace(/\/$/u, "");
    this.resource = publicMcpUrl(config);
  }

  public metadata(): Response {
    return json({
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/oauth/authorize`,
      token_endpoint: `${this.issuer}/oauth/token`,
      registration_endpoint: `${this.issuer}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: SCOPES,
    });
  }

  public resourceMetadata(): Response {
    return json({
      resource: this.resource,
      authorization_servers: [this.issuer],
      scopes_supported: SCOPES,
      bearer_methods_supported: ["header"],
    });
  }

  public async register(request: Request, ip: string): Promise<Response> {
    if (await this.limited("register", ip, 30, 60)) return oauthError("temporarily_unavailable", "Rate limit exceeded", 429);
    try {
      const input = await request.json() as Record<string, unknown>;
      const rawRedirectUris = input.redirect_uris;
      const redirectUris = Array.isArray(rawRedirectUris)
        ? rawRedirectUris.filter((uri): uri is string => typeof uri === "string")
        : [];
      if (!Array.isArray(rawRedirectUris) || redirectUris.length !== rawRedirectUris.length || redirectUris.length === 0 || redirectUris.length > 10 || redirectUris.some((uri) => !validRedirectUri(uri))) {
        return oauthError("invalid_redirect_uri", "redirect_uris must contain HTTPS or loopback URLs");
      }
      if (input.token_endpoint_auth_method !== undefined && input.token_endpoint_auth_method !== "none") {
        return oauthError("invalid_client_metadata", "Only public clients with token_endpoint_auth_method=none are supported");
      }
      const clientName = typeof input.client_name === "string" ? input.client_name.slice(0, 100) : "MCP client";
      const clientId = await this.tokens.issueClient({ redirectUris, clientName });
      return json({
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1_000),
        redirect_uris: redirectUris,
        client_name: clientName,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code"],
        response_types: ["code"],
      }, 201);
    } catch {
      return oauthError("invalid_client_metadata", "Invalid registration request");
    }
  }

  public async authorizeGet(request: Request, ip: string): Promise<Response> {
    if (await this.limited("authorize", ip, 60, 60)) return oauthError("temporarily_unavailable", "Rate limit exceeded", 429);
    const url = new URL(request.url);
    const clientId = url.searchParams.get("client_id") ?? "";
    const redirectUri = url.searchParams.get("redirect_uri") ?? "";
    const state = url.searchParams.get("state") ?? undefined;
    try {
      const client = await this.tokens.readClient(clientId);
      if (!client.redirectUris.includes(redirectUri)) return oauthError("invalid_request", "redirect_uri is not registered");
      if (url.searchParams.get("response_type") !== "code") return redirectWith(redirectUri, { error: "unsupported_response_type", state });
      if (url.searchParams.get("code_challenge_method") !== "S256") return redirectWith(redirectUri, { error: "invalid_request", error_description: "PKCE S256 is required", state });
      const codeChallenge = url.searchParams.get("code_challenge") ?? "";
      if (!/^[A-Za-z0-9_-]{43,128}$/u.test(codeChallenge)) return redirectWith(redirectUri, { error: "invalid_request", state });
      const requestedResource = url.searchParams.get("resource");
      if (requestedResource && requestedResource !== this.resource) return redirectWith(redirectUri, { error: "invalid_target", state });
      const scopes = parseScopes(url.searchParams.get("scope") ?? "wallet:read");
      const requestToken = await this.tokens.issueAuthorizationRequest({ clientId, redirectUri, codeChallenge, scope: scopes.join(" "), ...(state ? { state } : {}) });
      return authorizationPage(requestToken, scopes);
    } catch {
      return oauthError("invalid_request", "Invalid authorization request");
    }
  }

  public async authorizePost(request: Request, ip: string): Promise<Response> {
    if (await this.limited("authorize-submit", ip, 20, 60)) return oauthError("temporarily_unavailable", "Rate limit exceeded", 429);
    try {
      const form = await readForm(request);
      const authorization = await this.tokens.readAuthorizationRequest(form.get("request_token") ?? "");
      if (form.get("consent") !== "yes") {
        await this.store.consume("authorization-request", authorization.jti, 600);
        return redirectWith(authorization.redirectUri, { error: "access_denied", state: authorization.state });
      }
      const projectId = form.get("project_id")?.trim() ?? "";
      const apiKey = form.get("api_key") ?? "";
      const payoutApiKeyValue = form.get("payout_api_key")?.trim() ?? "";
      if (projectId.length < 8 || projectId.length > 128 || apiKey.length < 16 || apiKey.length > 512 || payoutApiKeyValue.length > 512) {
        return authorizationPage(form.get("request_token") ?? "", parseScopes(authorization.scope), "Проверьте Project UUID и ключи.");
      }
      const scopes = parseScopes(authorization.scope);
      const needsPayoutKey = scopes.some((scope) => scope.startsWith("payout:"));
      if (needsPayoutKey && payoutApiKeyValue.length < 16) {
        return authorizationPage(form.get("request_token") ?? "", scopes, "Для payout scopes нужен отдельный Payout API key.");
      }
      const credentials = { projectId, apiKey, ...(needsPayoutKey ? { payoutApiKey: payoutApiKeyValue } : {}) };
      const api = new Payments2328Client(this.config, credentials, this.logger, this.fetchImplementation);
      await api.balances();
      if (!await this.store.consume("authorization-request", authorization.jti, 600)) return oauthError("invalid_request", "Authorization request was already used");
      const code = await this.tokens.issueAuthorizationCode(authorization, credentials);
      return redirectWith(authorization.redirectUri, { code, state: authorization.state });
    } catch (error) {
      this.logger.warn({ error: error instanceof Error ? error.message : "unknown", ip }, "OAuth account linking failed");
      return oauthError("access_denied", "The 2328 credentials could not be verified", 401);
    }
  }

  public async token(request: Request, ip: string): Promise<Response> {
    if (await this.limited("token", ip, 60, 60)) return oauthError("temporarily_unavailable", "Rate limit exceeded", 429);
    try {
      const form = await readForm(request);
      if (form.get("grant_type") !== "authorization_code") return oauthError("unsupported_grant_type", "Only authorization_code is supported");
      const code = await this.tokens.readAuthorizationCode(form.get("code") ?? "");
      if (form.get("client_id") !== code.clientId || form.get("redirect_uri") !== code.redirectUri) return oauthError("invalid_grant", "Authorization code binding mismatch");
      const requestedResource = form.get("resource");
      if (requestedResource && requestedResource !== this.resource) return oauthError("invalid_target", "Token is not valid for the requested resource");
      const verifier = form.get("code_verifier") ?? "";
      if (verifier.length < 43 || verifier.length > 128 || !this.tokens.verifyPkce(verifier, code.codeChallenge)) return oauthError("invalid_grant", "PKCE verification failed");
      if (!await this.store.consume("authorization-code", code.jti, this.config.AUTH_CODE_TTL_SECONDS)) return oauthError("invalid_grant", "Authorization code was already used");
      return json({
        access_token: await this.tokens.issueAccessToken(code),
        token_type: "Bearer",
        expires_in: this.config.ACCESS_TOKEN_TTL_SECONDS,
        scope: code.scope,
      });
    } catch {
      return oauthError("invalid_grant", "Invalid or expired authorization code");
    }
  }

  private async limited(namespace: string, ip: string, limit: number, seconds: number): Promise<boolean> {
    return await this.store.increment(`rate:${namespace}`, ip, seconds) > limit;
  }
}
