# Operations

## Production topology

The supported single-server production layout for `mcp.2328.io` is:

```text
Internet -> Caddy :443 -> MCP :3000 -> Redis :6379
```

Only Caddy publishes host ports. The MCP application is reachable from the `edge` Docker network, while Redis is isolated on the internal `state` network. Caddy removes untrusted `CF-Connecting-IP` input and supplies the canonical `X-Forwarded-For` value used by the application rate limiter.

The host needs:

- Ubuntu 24.04 amd64 or arm64;
- Docker Engine with the Compose and Buildx plugins;
- a public IPv4 address and an `A` record for `mcp.2328.io`;
- inbound TCP `80/443`, UDP `443`, and a separately restricted SSH port;
- outbound HTTPS access to the 2328 API, container registries and ACME certificate authorities.

Do not publish Docker ports `3000` or `6379`. Docker-published ports can bypass uncomplicated host firewall rules, so validate the resulting `iptables`/`DOCKER-USER` policy as well as the cloud firewall.

## First deployment

Deploy a reviewed release commit rather than an unpinned branch:

```bash
git clone https://github.com/2328io/mcp.git /opt/2328-mcp
cd /opt/2328-mcp
git checkout <release-tag-or-commit>

cp .env.production.example .env.production
chmod 600 .env.production
# Set a monitored ACME contact address in .env.production.

sh deploy/init-secrets.sh
```

Back up `secrets/token_encryption_key` to the production secrets manager before starting the service. Do not copy the Redis password or token key into tickets, chat, shell arguments or Git.

Validate and start the stack:

```bash
docker compose --env-file .env.production -f compose.production.yaml config
docker compose --env-file .env.production -f compose.production.yaml build --pull
docker compose --env-file .env.production -f compose.production.yaml up -d
docker compose --env-file .env.production -f compose.production.yaml ps
```

Caddy obtains and renews the public certificate automatically after DNS resolves to the server. If a CDN is added later, explicitly configure its trusted address ranges and origin firewall before accepting its client-IP header.

## Public verification

```bash
curl -fsS https://mcp.2328.io/healthz
curl -fsS https://mcp.2328.io/readyz
curl -fsS https://mcp.2328.io/.well-known/oauth-authorization-server
curl -fsS https://mcp.2328.io/.well-known/oauth-protected-resource
curl -i https://mcp.2328.io/mcp
```

The first two requests must return `200`. The unauthenticated `/mcp` request must return `401` with a `WWW-Authenticate` header pointing to the protected-resource metadata. Complete one end-to-end OAuth connection from a supported MCP client before announcing the endpoint publicly.

## Upgrade and rollback

Run the full repository verification in CI, then deploy a pinned release:

```bash
cd /opt/2328-mcp
git fetch --tags --prune
git checkout <new-release-tag-or-commit>
docker compose --env-file .env.production -f compose.production.yaml build --pull
docker compose --env-file .env.production -f compose.production.yaml up -d
```

Verify readiness and OAuth discovery after every update. Roll back by checking out the previous reviewed release and rebuilding. Do not rotate `TOKEN_ENCRYPTION_KEY` during an ordinary application rollback: all instances serving traffic must use the same key.

The Bun, Caddy and Redis base images are pinned by multi-architecture digest. Update each version and digest together in a reviewed dependency change; do not replace the digest with a floating tag during deployment.

## Backup boundary

Persist and back up:

- the token encryption key in the secrets manager;
- the Redis AOF volume according to the accepted replay-state recovery point;
- Caddy's `/data` volume or, at minimum, allow it to obtain fresh certificates during recovery;
- the exact deployed Git commit and non-secret `.env.production` values.

The hosted service does not persist user project/API keys. Never add `PROJECT_ID`, `API_KEY` or `PAYOUT_API_KEY` to the production server configuration.

## Health

- `GET /healthz`: process is serving requests.
- `GET /readyz`: Redis is reachable. Returns `503` when replay/rate-limit state cannot be accessed; HTTP startup retries transient Redis connection failures with bounded exponential backoff and then fails closed.

Do not expose Redis publicly. The MCP application is safe to restart at any time; active access tokens remain valid on another instance sharing the encryption key.

## Metrics and logs

Logs are JSON and redact authorization headers, signatures, tokens and known credential field names. Ship stdout to the platform log collector. In stdio mode logs go to stderr so they cannot corrupt MCP protocol frames.

Recommended external metrics:

- request duration and status by route, excluding query strings;
- tool duration/error counts by tool name;
- upstream latency and status code;
- OAuth authorization/token failures;
- Redis latency and connection failures.

Never label metrics with project UUIDs, addresses, order IDs or tokens.

`MCP_RATE_LIMIT_PER_MINUTE` defaults to 600 per authenticated principal/IP pair. Keep an edge limit as a second layer. The Convert API has a tighter upstream limit and may return `429` before the general MCP budget is exhausted.

## Key rotation

1. Stop new traffic to old instances.
2. Deploy all new instances with a new encryption key.
3. Remove old instances.

This revokes outstanding authorization requests, codes, access tokens and payout preparations. Users reconnect through OAuth. Project keys are rotated in 2328 independently.

## Failure behavior

- Redis unavailable: remote startup retries briefly and then fails closed; a running instance reports not-ready and OAuth operations fail.
- 2328 timeout: tool returns `UPSTREAM_TIMEOUT`; no fabricated state is returned.
- Ambiguous payout response: query by payout UUID/order ID before attempting another business operation. The prepared `order_id` is stable.
- Ambiguous conversion response: do not retry automatically. Reconcile merchant balances/conversion history in 2328 before deciding the next action.
- Invalid/expired token: `/mcp` returns 401 with protected-resource metadata for reauthorization.

## Local CLI support

- `2328 --mcp` reserves stdout for JSON-RPC frames. Capture diagnostics from stderr only.
- On Linux, a running Secret Service implementation is required for stored profiles. Use environment credentials in minimal/headless containers.
- Removing the local metadata file does not remove OS credential entries. Use the CLI profile workflow or the operating-system credential manager when retiring credentials.
