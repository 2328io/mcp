import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { Payments2328Client } from "../api/client.js";
import type { Config } from "../config.js";
import type { ConvertInput, PayoutInput, Principal } from "../domain.js";
import { AuthorizationError, UpstreamError, requireScope } from "../domain.js";
import type { Logger } from "../logger.js";
import type { TokenService } from "../security/tokens.js";
import { VERSION } from "../version.js";

const decimal = z.string()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/u, "Use a positive decimal string without exponent notation")
  .refine((value) => /[1-9]/u.test(value), "Amount must be greater than zero");
const currency = z.string().regex(/^[A-Z]{1,10}$/u);
const network = z.string().regex(/^[A-Za-z0-9 -]{1,50}$/u);
const address = z.string().min(5).max(255).regex(/^[A-Za-z0-9.:+/_-]+$/u);
const memo = z.string().min(1).max(255).refine((value) => {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127 || "<>&\"'`".includes(character)) return false;
  }
  return true;
}).optional();
const hasNoControlCharacters = (value: string): boolean => {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return false;
  }
  return true;
};
const orderId = z.string().min(1).max(128).refine(hasNoControlCharacters, "Control characters are not allowed");
const publicUrl = z.url().refine((value) => ["http:", "https:"].includes(new URL(value).protocol));
const label = z.string().min(1).max(255);
const inviteCode = z.string().min(1).max(255);
const percentage = z.string().regex(/^(?:0|[1-9]\d?)(?:\.\d{1,8})?$|^100(?:\.0{1,8})?$/u);
const markup = z.string().regex(/^-?(?:0|[1-9]\d?)(?:\.\d{1,8})?$|^100(?:\.0{1,8})?$/u)
  .refine((value) => Number(value) >= -99 && Number(value) <= 100, "Use a value from -99 to 100");
const toolOutputSchema = { data: z.unknown() };

class ToolInputError extends Error {}

function result(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: { data },
  };
}

function failure(error: unknown, logger: Logger) {
  if (error instanceof AuthorizationError) {
    return { isError: true, content: [{ type: "text" as const, text: error.message }] };
  }
  if (error instanceof ToolInputError) {
    return { isError: true, content: [{ type: "text" as const, text: error.message }] };
  }
  if (error instanceof UpstreamError) {
    return {
      isError: true,
      content: [{
        type: "text" as const,
        text: JSON.stringify({ error: error.code, message: error.message, details: error.details ?? null }),
      }],
    };
  }
  logger.error({ error: error instanceof Error ? error.message : "unknown" }, "MCP tool failed");
  return { isError: true, content: [{ type: "text" as const, text: "The operation could not be completed" }] };
}

export function createMcpServer(
  config: Config,
  principal: Principal,
  tokens: TokenService,
  logger: Logger,
  fetchImplementation: typeof fetch = fetch,
): McpServer {
  const server = new McpServer({ name: "2328 Wallet", version: VERSION }, {
    instructions: "Read wallet2328://safety before money-moving operations. Always use prepare then explicit user confirmation for payouts and conversions. Never treat a browser return URL or an ambiguous timeout as proof of settlement.",
  });
  const api = new Payments2328Client(config, principal.credentials, logger, fetchImplementation);
  server.registerResource("wallet-safety", "wallet2328://safety", {
    title: "2328 wallet safety rules",
    description: "Non-negotiable settlement, confirmation and retry rules for account operations.",
    mimeType: "text/markdown",
  }, (uri) => ({ contents: [{
    uri: uri.toString(),
    mimeType: "text/markdown",
    text: `# 2328 wallet safety

- Treat 2328 API responses and verified webhooks as authoritative. A browser return URL never proves payment.
- Preserve monetary values as decimal strings; never recalculate settlement amounts with floating point or public market rates.
- Call payout_prepare or convert_prepare first, show every returned amount/fee/network/destination, then obtain explicit user approval for the matching execute tool.
- Never retry convert_execute automatically after a timeout. Execution may have completed even when the HTTP response was lost.
- Reuse payout order_id for reconciliation and idempotency. Do not create a second payout merely because a response was ambiguous.
- Disabling a static wallet does not reverse or reject an on-chain transfer already sent to its address.
`,
  }] }));
  server.registerResource("wallet-capabilities", "wallet2328://capabilities", {
    title: "Approved 2328 wallet capabilities",
    description: "Scopes granted to this connection and the canonical documentation location.",
    mimeType: "text/markdown",
  }, (uri) => ({ contents: [{
    uri: uri.toString(),
    mimeType: "text/markdown",
    text: `# Approved scopes\n\n${[...principal.scopes].sort().map((scope) => `- \`${scope}\``).join("\n")}\n\nCanonical API documentation: https://doc.2328.io/llms.txt\n`,
  }] }));
  const registerTypedTool = server.registerTool.bind(server) as unknown as <T extends z.ZodRawShape>(
    name: string,
    definition: {
      title?: string;
      description?: string;
      inputSchema: T;
      outputSchema?: typeof toolOutputSchema;
      annotations?: ToolAnnotations;
    },
    handler: (input: z.infer<z.ZodObject<T>>) => Promise<ReturnType<typeof result> | ReturnType<typeof failure>>,
  ) => void;

  const tool = <T extends z.ZodRawShape>(
    name: string,
    definition: {
      title?: string;
      description?: string;
      inputSchema: T;
      annotations?: ToolAnnotations;
    },
    scope: Parameters<typeof requireScope>[1],
    handler: (input: z.infer<z.ZodObject<T>>) => Promise<unknown>,
  ) => {
    if (!principal.scopes.has(scope)) return;
    registerTypedTool(name, { ...definition, outputSchema: toolOutputSchema }, async (input) => {
      try {
        requireScope(principal, scope);
        return result(await handler(input));
      } catch (error) {
        return failure(error, logger);
      }
    });
  };

  const zeroArgumentTool = (
    name: string,
    definition: { title?: string; description?: string; annotations?: ToolAnnotations },
    scope: Parameters<typeof requireScope>[1],
    handler: () => Promise<unknown>,
  ) => {
    if (!principal.scopes.has(scope)) return;
    server.registerTool(name, { ...definition, outputSchema: toolOutputSchema }, async () => {
      try {
        requireScope(principal, scope);
        return result(await handler());
      } catch (error) {
        return failure(error, logger);
      }
    });
  };

  zeroArgumentTool("wallet_balances", {
    title: "Get wallet balances",
    description: "Return available, locked and USD-equivalent balances for the connected 2328 account.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, "wallet:read", async () => api.balances());

  zeroArgumentTool("payment_directions", {
    title: "Get supported payment directions",
    description: "Return currently available currency/network directions and their deposit or payout limits.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, "wallet:read", async () => api.directions());

  zeroArgumentTool("exchange_rates", {
    title: "Get reference exchange rates",
    description: "Return public 2328 reference exchange rates. Do not use these rates to invent invoice or settlement amounts.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, "market:read", async () => api.exchangeRates());

  zeroArgumentTool("market_prices", {
    title: "Get public market prices",
    description: "Return current public market prices exposed by 2328.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, "market:read", async () => api.prices());

  tool("invoice_get", {
    title: "Get an invoice",
    description: "Look up an invoice by its 2328 UUID or merchant order ID.",
    inputSchema: {
      uuid: z.uuid().optional(),
      order_id: orderId.optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, "invoice:read", async (input) => {
    if (!input.uuid && !input.order_id) throw new ToolInputError("uuid or order_id is required");
    return api.invoice({ ...(input.uuid ? { uuid: input.uuid } : {}), ...(input.order_id ? { order_id: input.order_id } : {}) });
  });

  tool("invoice_list", {
    title: "List invoices",
    description: "List invoices for the connected project with bounded pagination and optional status/date filters.",
    inputSchema: {
      status: z.enum(["pending", "check", "paid", "underpaid", "underpaid_check", "overpaid", "cancel"]).optional(),
      date_from: z.iso.date().optional(),
      date_to: z.iso.date().optional(),
      page: z.number().int().min(1).default(1),
      per_page: z.number().int().min(1).max(100).default(20),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, "invoice:read", async (input) => api.invoices(input));

  tool("invoice_create", {
    title: "Create a payment invoice",
    description: "Create an idempotent 2328 payment invoice. Reusing order_id returns the existing active invoice.",
    inputSchema: {
      amount: decimal,
      currency,
      order_id: orderId,
      description: z.string().max(200).optional(),
      network: network.optional(),
      to_currency: currency.optional(),
      url_callback: publicUrl,
      url_return: publicUrl.optional(),
      url_success: publicUrl.optional(),
      invite_code: inviteCode.optional(),
      fee_split: percentage.optional(),
      price_markup: markup.optional(),
      ttl_seconds: z.number().int().min(300).max(86_400).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, "invoice:create", async (input) => api.createInvoice({
    amount: input.amount,
    currency: input.currency,
    order_id: input.order_id,
    url_callback: input.url_callback,
    ...(input.description ? { description: input.description } : {}),
    ...(input.network ? { network: input.network } : {}),
    ...(input.to_currency ? { to_currency: input.to_currency } : {}),
    ...(input.url_return ? { url_return: input.url_return } : {}),
    ...(input.url_success ? { url_success: input.url_success } : {}),
    ...(input.invite_code ? { invite_code: input.invite_code } : {}),
    ...(input.fee_split ? { fee_split: input.fee_split } : {}),
    ...(input.price_markup ? { price_markup: input.price_markup } : {}),
    ...(input.ttl_seconds ? { ttl_seconds: input.ttl_seconds } : {}),
  }));

  tool("static_wallet_get", {
    title: "Get a static wallet",
    description: "Look up a permanent deposit wallet by its 2328 UUID or blockchain address.",
    inputSchema: { uuid: z.uuid().optional(), address: address.optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, "static-wallet:read", async (input) => {
    if (!input.uuid && !input.address) throw new ToolInputError("uuid or address is required");
    return api.staticWallet({
      ...(input.uuid ? { uuid: input.uuid } : {}),
      ...(input.address ? { address: input.address } : {}),
    });
  });

  tool("static_wallet_list", {
    title: "List static wallets",
    description: "List permanent deposit wallets with optional filters and bounded pagination.",
    inputSchema: {
      status: z.enum(["active", "inactive"]).optional(),
      currency: currency.optional(),
      network: network.optional(),
      order_id: orderId.optional(),
      page: z.number().int().min(1).default(1),
      per_page: z.number().int().min(1).max(100).default(20),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, "static-wallet:read", async (input) => api.staticWallets(input));

  tool("static_wallet_transactions", {
    title: "List static wallet deposits",
    description: "Return deposits received by a static wallet. Reconcile by transaction ID; a wallet itself is never simply paid.",
    inputSchema: {
      uuid: z.uuid(),
      date_from: z.iso.date().optional(),
      date_to: z.iso.date().optional(),
      page: z.number().int().min(1).default(1),
      per_page: z.number().int().min(1).max(500).default(20),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, "static-wallet:read", async (input) => api.staticWalletTransactions(input));

  tool("static_wallet_create", {
    title: "Create a static wallet",
    description: "Create or return the permanent deposit wallet identified by project, order_id, currency and network.",
    inputSchema: {
      currency,
      network,
      order_id: z.string().min(1).max(255).refine(hasNoControlCharacters, "Control characters are not allowed"),
      url_callback: publicUrl,
      label: label.optional(),
      invite_code: inviteCode.optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, "static-wallet:create", async (input) => api.createStaticWallet({
    currency: input.currency,
    network: input.network,
    order_id: input.order_id,
    url_callback: input.url_callback,
    ...(input.label ? { label: input.label } : {}),
    ...(input.invite_code ? { invite_code: input.invite_code } : {}),
  }));

  tool("static_wallet_disable", {
    title: "Disable a static wallet",
    description: "Stop treating a permanent address as an active deposit target. This does not erase its history or reverse blockchain transfers.",
    inputSchema: {
      uuid: z.uuid(),
      confirmation: z.string().min(10).max(128),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, "static-wallet:update", async ({ uuid, confirmation }) => {
    if (confirmation !== `DISABLE STATIC WALLET ${uuid}`) {
      throw new ToolInputError("Confirmation does not match the static wallet being disabled");
    }
    return api.disableStaticWallet(uuid);
  });

  tool("static_wallet_enable", {
    title: "Enable a static wallet",
    description: "Reactivate an existing permanent deposit wallet without changing its address.",
    inputSchema: { uuid: z.uuid() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, "static-wallet:update", async ({ uuid }) => api.enableStaticWallet(uuid));

  tool("payout_get", {
    title: "Get payout status",
    description: "Return the current status and transaction details of a payout owned by the connected account.",
    inputSchema: { uuid: z.uuid() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, "payout:read", async ({ uuid }) => api.payout(uuid));

  tool("payout_prepare", {
    title: "Prepare a payout",
    description: "Validate a payout, calculate fees and return a short-lived confirmation token. This never moves funds.",
    inputSchema: {
      currency,
      network,
      amount: decimal,
      to_address: address,
      memo,
      fee_option: z.enum(["deduct", "add"]).default("deduct"),
      order_id: orderId.optional(),
      url_callback: publicUrl.optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, "payout:quote", async (input) => {
    const payout: PayoutInput = {
      currency: input.currency,
      network: input.network,
      amount: input.amount,
      to_address: input.to_address,
      fee_option: input.fee_option,
      order_id: input.order_id ?? `mcp-${randomUUID()}`,
      ...(input.memo ? { memo: input.memo } : {}),
      ...(input.url_callback ? { url_callback: input.url_callback } : {}),
    };
    const quote = await api.quotePayout({
      currency: payout.currency,
      network: payout.network,
      amount: payout.amount,
      to_address: payout.to_address,
      ...(payout.memo ? { memo: payout.memo } : {}),
      fee_option: payout.fee_option,
    });
    const confirmation = `CONFIRM PAYOUT ${payout.amount} ${payout.currency} ON ${payout.network} TO ${payout.to_address} FEE ${payout.fee_option}`;
    return {
      quote,
      payout,
      confirmation,
      confirmation_token: await tokens.issuePayoutPreparation(principal, payout),
      expires_in_seconds: config.PREPARATION_TTL_SECONDS,
      warning: "Show the exact amount, asset, network, destination, fee and debit to the user before calling payout_create.",
    };
  });

  tool("payout_create", {
    title: "Confirm and create a payout",
    description: "Move funds using an unmodified short-lived payout preparation. The MCP client must obtain explicit user approval immediately before calling this tool.",
    inputSchema: {
      confirmation_token: z.string().min(100).max(8_192),
      confirmation: z.string().min(10).max(512),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, "payout:create", async ({ confirmation_token, confirmation }) => {
    const payout = await tokens.readPayoutPreparation(confirmation_token, principal);
    const expected = `CONFIRM PAYOUT ${payout.amount} ${payout.currency} ON ${payout.network} TO ${payout.to_address} FEE ${payout.fee_option}`;
    if (confirmation !== expected) throw new ToolInputError("Confirmation does not match the prepared payout");
    return api.createPayout(payout);
  });

  tool("convert_prepare", {
    title: "Prepare a balance conversion",
    description: "Get an indicative conversion quote and a short-lived confirmation token. This does not move funds.",
    inputSchema: {
      from_currency: currency,
      to_currency: currency,
      amount: decimal,
      amount_type: z.enum(["from", "to"]),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, "convert:quote", async (input) => {
    if (input.from_currency === input.to_currency) {
      throw new ToolInputError("from_currency and to_currency must differ");
    }
    const convert: ConvertInput = input;
    const quote = await api.quoteConvert(convert);
    const side = convert.amount_type === "from" ? "SPEND" : "RECEIVE";
    const confirmation = `CONFIRM CONVERT ${side} ${convert.amount} ${convert.amount_type === "from" ? convert.from_currency : convert.to_currency} FROM ${convert.from_currency} TO ${convert.to_currency}`;
    return {
      quote,
      convert,
      confirmation,
      confirmation_token: await tokens.issueConvertPreparation(principal, convert),
      expires_in_seconds: config.CONVERT_PREPARATION_TTL_SECONDS,
      warning: "The quote is indicative. Execution uses the current market price and may differ. Show the debit, credit, currencies and rate before confirmation.",
    };
  });

  tool("convert_execute", {
    title: "Confirm and execute a balance conversion",
    description: "Immediately debit and credit the merchant balance using an unmodified short-lived preparation. Never retry this tool blindly after a timeout.",
    inputSchema: {
      confirmation_token: z.string().min(100).max(8_192),
      confirmation: z.string().min(10).max(512),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, "convert:execute", async ({ confirmation_token, confirmation }) => {
    const convert = await tokens.readConvertPreparation(confirmation_token, principal);
    const side = convert.amount_type === "from" ? "SPEND" : "RECEIVE";
    const expected = `CONFIRM CONVERT ${side} ${convert.amount} ${convert.amount_type === "from" ? convert.from_currency : convert.to_currency} FROM ${convert.from_currency} TO ${convert.to_currency}`;
    if (confirmation !== expected) throw new ToolInputError("Confirmation does not match the prepared conversion");
    return api.executeConvert(convert);
  });

  return server;
}
