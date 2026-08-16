# Operations

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
