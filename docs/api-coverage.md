# 2328 API coverage

This matrix is checked against the live documentation index at `https://doc.2328.io/llms.txt` and the current merchant API routes. It distinguishes an intentionally safe agent interface from raw upstream capabilities.

| Upstream operation | Authentication | MCP tool | Notes |
|---|---|---|---|
| `GET /balance` | Regular key | `wallet_balances` | Available, locked and USD balances |
| `GET /directions` | Regular key | `payment_directions` | Dynamic source of truth for networks, limits and availability |
| `GET /exchange-rates` | Public | `exchange_rates` | Reference data only; not a guaranteed execution price |
| `GET /prices` | Public | `market_prices` | No project/sign headers are sent |
| `POST /payment` | Regular key | `invoice_create` | Idempotent by `order_id`; supports direction, redirects, fee split, markup and TTL |
| `POST /payment/info` | Regular key | `invoice_get` | Lookup by UUID or merchant order ID |
| `POST /payment/list` | Regular key | `invoice_list` | Agent page size capped at 100 to bound context/output |
| `POST /static-wallet` | Regular key | `static_wallet_create` | Idempotent by project/order/currency/network tuple |
| `POST /static-wallet/info` | Regular key | `static_wallet_get` | Lookup by UUID or blockchain address |
| `POST /static-wallet/list` | Regular key | `static_wallet_list` | Upstream-compatible filters, page size capped at 100 |
| `POST /static-wallet/transactions` | Regular key | `static_wallet_transactions` | Reconciliation data, page size capped at 500 |
| `POST /static-wallet/enable` | Regular key | `static_wallet_enable` | Preserves wallet identity/address |
| `POST /static-wallet/disable` | Regular key | `static_wallet_disable` | Destructive annotation plus exact wallet confirmation |
| `POST /payout/calc` | Payout key | `payout_prepare` | Read-only quote; creates an immutable connection-bound preparation |
| `POST /payout` | Payout key | `payout_create` | Requires the preparation and exact confirmation; stable `order_id` makes retries idempotent |
| `GET /payout/status/{uuid}` | Payout key | `payout_get` | Authoritative payout status |
| `POST /convert/price` | Regular key | `convert_prepare` | Indicative quote and short-lived preparation |
| `POST /convert` | Regular key | `convert_execute` | Money-moving; never retried automatically after an ambiguous response |

## Deliberate boundaries

- Webhooks are sent by 2328 to merchant-owned callback URLs. The MCP is not a webhook receiver and never claims that a browser return URL proves settlement.
- `from_currency` auto-convert payouts are not exposed to agents yet. The current upstream calculator rejects that mode, so there is no authoritative read-only debit/fee quote for the confirmation step.
- The server does not synthesize invoice payment instructions, conversion outcomes or target amounts from public rates. It returns authoritative upstream values.
- Tools outside the OAuth principal's approved scopes are omitted from `tools/list`, not merely rejected after selection.
