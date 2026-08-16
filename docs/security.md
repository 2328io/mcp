# Security model

## Trust boundaries

- The MCP client may be controlled by an LLM and is not trusted to preserve user intent.
- The hosted MCP service is trusted with project keys for the lifetime of an encrypted access token.
- Redis is operational infrastructure, not a credential store.
- The 2328 API remains authoritative for balances, limits, address validation, idempotency and payout state.

## Controls

- OAuth protected-resource and authorization-server discovery per RFC 9728/RFC 8414.
- Authorization Code only; PKCE S256 is mandatory; redirect URIs require HTTPS except loopback clients.
- One-time authorization request and code identifiers enforced in Redis.
- A256GCM encrypted opaque tokens with strict issuer, audience, type and expiry checks.
- Least-privilege scopes; payout actions require the separate payout key.
- Two-step payout and conversion flows with immutable short-lived preparations and exact confirmations.
- Conversion execution has no transport-level retry; ambiguous timeouts require reconciliation.
- Monetary values are decimal strings. Exponent notation and floating-point conversion are rejected.
- Strict field sizes, address/network formats, request-size limits and upstream timeouts.
- Redis-backed OAuth limits and an authenticated MCP limit per principal/IP (600 requests per minute by default).
- Origin and Host validation on `/mcp`; production startup rejects non-HTTPS public/upstream URLs.
- Security response headers, no-store caching and secret redaction in structured logs.
- Containers run read-only as a non-root user with all Linux capabilities dropped.

## Secrets

Use a secrets manager for `TOKEN_ENCRYPTION_KEY`, Redis credentials and TLS keys. Do not put 2328 project keys into hosted-server environment variables; users enter them during their own OAuth connection. For local use, the CLI stores keys through the operating system credential store using `Bun.secrets`. Headless MCP hosts may pass keys directly to the child process environment. Profile metadata never contains key values.

Access tokens contain encrypted project keys because the current 2328 API authenticates with long-lived HMAC secrets. They are never persisted by this service. Protect the hosted endpoint with TLS, prevent access-token logging at every proxy layer and keep the default 15-minute TTL.

## Deployment checklist

- Terminate TLS at a trusted proxy and forward only the configured host.
- Use Redis 7.2 or newer with authentication, private networking, persistence and backups appropriate for replay state.
- Set a random 32-byte `TOKEN_ENCRYPTION_KEY`; do not reuse application or JWT secrets.
- Add the MCP egress IP to a project whitelist when 2328 IP allowlisting is enabled.
- Apply edge rate limits in addition to the built-in per-IP limits.
- Keep `TRUST_PROXY=false` unless the application is reachable only through trusted proxies; when enabled, validated `CF-Connecting-IP`/first `X-Forwarded-For` is used for rate limits.
- Alert on OAuth failures, upstream 401/403, payout failures and Redis unavailability without recording payload secrets.
- Rotate user project/payout keys immediately if an MCP access token or client device is suspected compromised.

## Known boundary

The exact confirmation phrase and MCP annotations reduce accidental execution, but a malicious client can ignore UX requirements. Hosted clients must enforce a visible user-approval interaction for `payout_create` and `convert_execute`. A server-side policy service for daily/per-recipient limits can be added later without weakening the existing upstream limits.
