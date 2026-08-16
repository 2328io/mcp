# 2328 Wallet CLI and MCP Server

An installable Bun CLI and MCP interface for a 2328 merchant account. Running `2328` opens an interactive terminal menu; `2328 --mcp` exposes the same account to a local MCP client over stdio; `2328 --serve` starts the hosted OAuth-enabled Streamable HTTP service.

The implementation follows the live [2328 API documentation](https://doc.2328.io/llms.txt). Decimal amounts remain strings from input to the upstream API.

## Capabilities

| Area | MCP tools |
|---|---|
| Account | `wallet_balances`, `payment_directions` |
| Market | `exchange_rates`, `market_prices` |
| Payments | `invoice_get`, `invoice_list`, `invoice_create` |
| Static wallets | `static_wallet_get`, `static_wallet_list`, `static_wallet_transactions`, `static_wallet_create`, `static_wallet_enable`, `static_wallet_disable` |
| Payouts | `payout_get`, `payout_prepare`, `payout_create` |
| Convert | `convert_prepare`, `convert_execute` |

Payout and conversion execution are split into prepare/confirm calls. The preparation is encrypted, bound to one connection and short-lived. A client must show the quote and obtain the exact confirmation string before execution.

The MCP also publishes `wallet2328://safety` and `wallet2328://capabilities` resources so an agent can retrieve settlement rules and the scopes actually approved for its connection.

## Install the CLI

Requirements: Bun 1.3 or newer and a 2328 project ID/API key. The payout API key is separate and optional.

From the package registry after publication:

```bash
bun install --global @2328/mcp-server
2328
```

From this checkout:

```bash
bun install --frozen-lockfile
bun run build
chmod +x dist/index.js # Linux/macOS
bun link
2328
```

The first interactive launch verifies the ordinary API key with the balance endpoint. API keys are stored in Windows Credential Manager, macOS Keychain or Linux Secret Service through `Bun.secrets`; the config file contains only profile metadata. On a headless system without a credential store, provide `PROJECT_ID`, `API_KEY` and optionally `PAYOUT_API_KEY` through the process environment.

## Local MCP

Configure a profile interactively once with `2328`, then point the MCP client at:

```json
{
  "command": "2328",
  "args": ["--mcp"]
}
```

For a named profile:

```json
{
  "command": "2328",
  "args": ["--mcp", "--profile", "merchant-production"]
}
```

Environment-only configuration is also supported:

```json
{
  "command": "2328",
  "args": ["--mcp"],
  "env": {
    "PROJECT_ID": "...",
    "API_KEY": "...",
    "PAYOUT_API_KEY": "..."
  }
}
```

If the payout key is absent, payout scopes are omitted from the local principal. Protocol frames are written only to stdout; diagnostics use stderr.

## Hosted Streamable HTTP

The hosted mode uses OAuth Authorization Code with PKCE, short-lived encrypted access tokens and rotating refresh tokens. Ordinary read-only scopes are selected by default; payout, management and money-moving scopes require separate selection.

The production endpoint is `https://mcp.2328.io/mcp`. The dedicated-server deployment terminates TLS in Caddy and keeps both the MCP application and Redis off the public host network.

Production deployment:

```bash
cp .env.production.example .env.production
# Set ACME_EMAIL in .env.production.
sh deploy/init-secrets.sh

docker compose --env-file .env.production -f compose.production.yaml config
docker compose --env-file .env.production -f compose.production.yaml build --pull
docker compose --env-file .env.production -f compose.production.yaml up -d
```

Create an `A` record for `mcp.2328.io` before starting Caddy and allow inbound TCP `80/443` plus UDP `443`. Do not expose ports `3000` or `6379`. See [operations](docs/operations.md) for verification, upgrades and secret handling.

For local hosted-mode development:

```bash
cp .env.example .env
bun -e "console.log(crypto.getRandomValues(new Uint8Array(32)).toBase64({alphabet:'base64url',omitPadding:true}))"
# Put the value in TOKEN_ENCRYPTION_KEY and configure the public HTTPS origin.
docker compose up --build -d
```

Connect an OAuth-capable MCP client to `https://mcp.example.com/mcp`. Users link a project using project keys; the service never asks for the 2328 account password. The compose port is loopback-only so a reverse proxy or ingress must own public TLS.

## ChatGPT and Codex plugin

The installable plugin package is in [`plugins/2328-wallet`](plugins/2328-wallet). It contains the validated manifest, hosted MCP configuration and official 2328 mark. ChatGPT additionally requires the hosted MCP connection to be registered in Developer mode; after registration, add its generated `plugin_asdk_app...` mapping as described in the plugin README.

## Commands

```text
2328                              interactive terminal account menu
2328 --mcp [--profile NAME]       local MCP over stdio
2328 --serve                      hosted OAuth MCP service
2328 --help
2328 --version
```

## Development and verification

```bash
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun test
bun run build
bun run verify:package
bun run verify:tui
# With a reachable Redis instance:
bun run verify:hosted
bun audit
```

Read [API coverage](docs/api-coverage.md), [architecture](docs/architecture.md), [security](docs/security.md) and [operations](docs/operations.md) before a public deployment.

## License

Licensed under the [Apache License 2.0](LICENSE).
