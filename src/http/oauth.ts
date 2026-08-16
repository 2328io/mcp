import type { Config } from "../config.js";
import { randomBytes } from "node:crypto";
import { publicMcpUrl } from "../config.js";
import { SCOPES, parseScopes } from "../domain.js";
import type { Logger } from "../logger.js";
import { Payments2328Client } from "../api/client.js";
import type { ReplayStore } from "../security/replay-store.js";
import type { TokenService } from "../security/tokens.js";
import { BRAND_LOGO } from "./brand.js";
import { json, oauthError, readForm, SECURITY_HEADERS } from "./responses.js";

const SCOPE_DESCRIPTIONS: Record<string, string> = {
  "wallet:read": "Балансы и направления",
  "market:read": "Курсы и цены",
  "invoice:read": "Счета и их статусы",
  "invoice:create": "Создание счетов",
  "static-wallet:read": "Постоянные кошельки и поступления",
  "static-wallet:create": "Создание постоянных кошельков",
  "static-wallet:update": "Управление постоянными кошельками",
  "payout:read": "Статусы выплат",
  "payout:quote": "Расчёт суммы и комиссии выплаты",
  "payout:create": "Отправка средств на блокчейн-адрес",
  "convert:quote": "Расчёт конвертации",
  "convert:execute": "Конвертация средств",
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

function redirectWith(
  urlValue: string,
  values: Record<string, string | undefined>,
  status: 302 | 303 = 302,
): Response {
  const url = new URL(urlValue);
  for (const [key, value] of Object.entries(values)) if (value !== undefined) url.searchParams.set(key, value);
  return Response.redirect(url, status);
}

function authorizationPage(requestToken: string, scopes: readonly string[], error?: string): Response {
  const nonce = randomBytes(18).toString("base64");
  const moneyMoving = new Set(["payout:create", "convert:execute"]);
  const scopeItems = scopes.map((scope) => `<li class="permission${moneyMoving.has(scope) ? " permission--money" : ""}"><span class="permission-mark" aria-hidden="true">✓</span><span>${Bun.escapeHTML(SCOPE_DESCRIPTIONS[scope] ?? scope)}</span></li>`).join("");
  const errorBlock = error ? `<div class="error" role="alert">${Bun.escapeHTML(error)}</div>` : "";
  const payoutField = scopes.some((scope) => scope.startsWith("payout:"))
    ? '<div class="field"><label for="payout_api_key">Payout API key <span>(отдельный ключ)</span></label><input id="payout_api_key" name="payout_api_key" type="password" required minlength="16" maxlength="512" autocomplete="off"></div>'
    : "";
  const moneyWarning = scopes.some((scope) => moneyMoving.has(scope))
    ? '<div class="notice"><span class="notice-mark" aria-hidden="true">!</span><p>Доступ включает операции со средствами. Каждая выплата требует отдельного подтверждения.</p></div>'
    : "";
  const body = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Подключить 2328</title><style>
:root{color-scheme:dark;--foreground:220 16% 97%;--bg:#121214;--surface:#19191c;--surface-soft:#202024;--text:#f7f7f8;--muted:#a3a3ad;--border:#323238;--accent:#f4512f;--accent-soft:#ffaf6e;--danger:#ff7864;--shadow:0 32px 100px rgba(0,0,0,.42)}*{box-sizing:border-box}html{min-height:100%;background:var(--bg)}body{min-height:100vh;margin:0;color:var(--text);background:radial-gradient(circle at 50% 18%,rgba(241,73,43,.11),transparent 34rem),var(--bg);font-family:Geist,"Segoe UI",sans-serif;font-size:15px;line-height:1.5;-webkit-font-smoothing:antialiased}body:before{content:"";position:fixed;inset:0;pointer-events:none;background:linear-gradient(rgba(255,255,255,.018) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.018) 1px,transparent 1px);background-size:48px 48px;mask-image:linear-gradient(to bottom,black,transparent 65%)}.shell{position:relative;width:min(100% - 32px,640px);margin:0 auto;padding:56px 0}.brand{display:block;width:100px;margin:0 0 26px;color:var(--text);text-decoration:none}.brand-logo{display:block;width:100%;height:auto}.card{overflow:hidden;border:1px solid var(--border);border-radius:20px;background:rgba(25,25,28,.94);box-shadow:var(--shadow);backdrop-filter:blur(16px)}.card-accent{height:3px;background:linear-gradient(90deg,var(--accent-soft),var(--accent) 55%,transparent)}.content{padding:34px}h1{margin:0;font-size:32px;font-weight:520;line-height:1.08;letter-spacing:-1.4px}.lead{margin:10px 0 28px;color:var(--muted);font-size:16px}.section{padding-top:24px;border-top:1px solid var(--border)}.section-title{margin:0 0 14px;color:var(--muted);font-size:12px;font-weight:650;letter-spacing:.09em;text-transform:uppercase}.permissions{display:grid;gap:8px;margin:0;padding:0;list-style:none}.permission{display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border-radius:10px;background:var(--surface-soft);color:#d9d9de}.permission-mark{display:grid;flex:0 0 18px;height:18px;margin-top:2px;place-items:center;border-radius:50%;background:rgba(241,73,43,.15);color:var(--accent-soft);font-size:11px;font-weight:800}.permission--money{color:var(--text)}.permission--money .permission-mark{background:var(--accent);color:white}.notice{display:flex;gap:11px;margin:14px 0 0;padding:12px 13px;border:1px solid rgba(241,73,43,.42);border-radius:11px;background:rgba(241,73,43,.08);color:#f4c8bf}.notice p{margin:0}.notice-mark{display:grid;flex:0 0 20px;height:20px;place-items:center;border-radius:50%;background:var(--accent);color:white;font-size:12px;font-weight:800}.form{display:grid;gap:17px;margin-top:26px}.field{display:grid;gap:7px}.field label{font-size:13px;font-weight:600}.field label span{color:var(--muted);font-weight:400}input{width:100%;height:48px;padding:0 14px;border:1px solid var(--border);border-radius:10px;outline:0;background:#111113;color:var(--text);font:inherit;transition:border-color .18s ease,box-shadow .18s ease,background .18s ease}input:hover{border-color:#4b4b53}input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(241,73,43,.16);background:#141416}.consent{display:flex;align-items:flex-start;gap:10px;color:#d9d9de;cursor:pointer}.consent input{flex:0 0 18px;width:18px;height:18px;margin-top:2px;accent-color:var(--accent)}button{display:flex;width:100%;height:50px;align-items:center;justify-content:center;gap:9px;border:0;border-radius:10px;background:var(--accent);color:white;font:inherit;font-weight:650;cursor:pointer;transition:transform .18s ease,background .18s ease,box-shadow .18s ease}button:hover{background:#ff5a36;box-shadow:0 12px 30px rgba(241,73,43,.22);transform:translateY(-1px)}button:active{transform:translateY(0)}button:focus-visible{outline:3px solid rgba(255,175,110,.38);outline-offset:2px}button:disabled{background:#343439;color:#8d8d95;box-shadow:none;cursor:wait;transform:none}.button-arrow{font-size:19px;font-weight:400}.submit-status{margin:0;text-align:center;color:var(--muted);font-size:13px}.error{margin:18px 0 0;padding:12px 13px;border:1px solid rgba(255,120,100,.5);border-radius:10px;background:rgba(255,120,100,.08);color:#ffc0b6}.foot{margin:18px 0 0;text-align:center;color:#6f6f78;font-size:12px}@media(max-width:560px){.shell{width:min(100% - 20px,640px);padding:20px 0 28px}.brand{width:94px;margin:0 0 18px}.card{border-radius:16px}.content{padding:24px 20px}h1{font-size:28px}.lead{margin-bottom:24px}.permission{padding:9px 10px}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}}
</style></head>
<body><main class="shell"><a class="brand" href="https://2328.io">${BRAND_LOGO}</a><section class="card"><div class="card-accent"></div><div class="content"><h1>Подключить 2328</h1><p class="lead">Подтвердите доступ к проекту для MCP-клиента.</p>${errorBlock}
<div class="section"><p class="section-title">Доступ</p><ul class="permissions">${scopeItems}</ul>${moneyWarning}</div>
<form class="form" method="post" autocomplete="off"><input type="hidden" name="request_token" value="${Bun.escapeHTML(requestToken)}">
<div class="field"><label for="project_id">Project UUID</label><input id="project_id" name="project_id" required minlength="8" maxlength="128" spellcheck="false" autocapitalize="none" autocomplete="off"></div>
<div class="field"><label for="api_key">API key</label><input id="api_key" name="api_key" type="password" required minlength="16" maxlength="512" autocomplete="off"></div>
${payoutField}
<label class="consent"><input type="checkbox" name="consent" value="yes" required><span>Разрешить этот доступ</span></label>
<button type="submit"><span>Подключить</span><span class="button-arrow" aria-hidden="true">→</span></button><p id="submit-status" class="submit-status" role="status" aria-live="polite" hidden>Проверяем доступ…</p></form></div></section><p class="foot">2328 MCP</p></main>
<script nonce="${nonce}">const form=document.querySelector("form");const button=form?.querySelector('button[type="submit"]');const status=document.querySelector("#submit-status");form?.addEventListener("submit",()=>{if(button instanceof HTMLButtonElement){button.disabled=true;button.textContent="Подключаем…";button.setAttribute("aria-busy","true")}if(status instanceof HTMLElement)status.hidden=false});</script></body></html>`;
  return new Response(body, {
    status: error ? 400 : 200,
    headers: {
      ...SECURITY_HEADERS,
      "content-security-policy": `${SECURITY_HEADERS["content-security-policy"]}; script-src 'nonce-${nonce}'`,
      "content-type": "text/html; charset=utf-8",
    },
  });
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
        return redirectWith(authorization.redirectUri, { error: "access_denied", state: authorization.state }, 303);
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
      return redirectWith(authorization.redirectUri, { code, state: authorization.state }, 303);
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
