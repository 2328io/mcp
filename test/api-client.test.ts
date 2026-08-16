import { describe, expect, mock, test } from "bun:test";
import { Payments2328Client } from "../src/api/client.js";
import { signBody } from "../src/api/signing.js";
import { createLogger } from "../src/logger.js";
import { testConfig } from "./fixtures.js";

const credentials = { projectId: "project-123", apiKey: "a".repeat(32), payoutApiKey: "b".repeat(32) };

describe("2328 API client", () => {
  test("uses the ordinary key for balances and signs an empty body", async () => {
    const fetchMock = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({
        project: credentials.projectId,
        sign: signBody("", credentials.apiKey),
      });
      expect(init?.body).toBeUndefined();
      return Response.json({ state: 0, result: [{ currency_code: "USDT", balance: "10" }] });
    });
    const client = new Payments2328Client(testConfig(), credentials, createLogger(testConfig()), fetchMock as unknown as typeof fetch);
    expect(await client.balances()).toEqual([{ currency_code: "USDT", balance: "10" }]);
  });

  test("uses the payout key and exact JSON for payout quotes", async () => {
    const payload = { currency: "USDT", network: "TRX-TRC20", amount: "200", to_address: "TNJaddress123", fee_option: "deduct" as const };
    const body = JSON.stringify(payload);
    const fetchMock = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.body).toBe(body);
      expect(init?.headers).toMatchObject({ sign: signBody(body, credentials.payoutApiKey) });
      return Response.json({ state: 0, result: { total_fee: "1" } });
    });
    const client = new Payments2328Client(testConfig(), credentials, createLogger(testConfig()), fetchMock as unknown as typeof fetch);
    expect(await client.quotePayout(payload)).toEqual({ total_fee: "1" });
  });

  test("does not send project credentials to public market endpoints", async () => {
    const fetchMock = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).not.toHaveProperty("project");
      expect(init?.headers).not.toHaveProperty("sign");
      return Response.json([{ from: "BTC", to: "USDT", price: "100000" }]);
    });
    const client = new Payments2328Client(testConfig(), credentials, createLogger(testConfig()), fetchMock as unknown as typeof fetch);
    expect(await client.prices()).toEqual([{ from: "BTC", to: "USDT", price: "100000" }]);
  });

  test("maps the remaining API operations to their contract paths", async () => {
    const paths: string[] = [];
    const fetchMock = mock(async (urlValue: string | URL | Request) => {
      paths.push(new URL(String(urlValue)).pathname);
      return Response.json({ state: 0, result: { ok: true } });
    });
    const client = new Payments2328Client(testConfig(), credentials, createLogger(testConfig()), fetchMock as unknown as typeof fetch);
    await client.directions();
    await client.createInvoice({ amount: "10", currency: "USD", order_id: "order-1", url_callback: "https://merchant.example/webhook" });
    await client.invoice({ order_id: "order-1" });
    await client.invoices({ page: 1 });
    await client.createPayout({ currency: "USDT", network: "TRX-TRC20", amount: "5", to_address: "TNJaddress123", fee_option: "deduct", order_id: "payout-1" });
    await client.payout("00000000-0000-4000-8000-000000000000");
    await client.exchangeRates();
    await client.prices();
    await client.createStaticWallet({ currency: "USDT", network: "TRX-TRC20", order_id: "customer-1", url_callback: "https://merchant.example/static" });
    await client.staticWallet({ address: "TNJaddress123" });
    await client.staticWallets({ page: 1 });
    await client.staticWalletTransactions({ uuid: "00000000-0000-4000-8000-000000000000" });
    await client.disableStaticWallet("00000000-0000-4000-8000-000000000000");
    await client.enableStaticWallet("00000000-0000-4000-8000-000000000000");
    await client.quoteConvert({ from_currency: "USDT", to_currency: "BTC", amount: "10", amount_type: "from" });
    await client.executeConvert({ from_currency: "USDT", to_currency: "BTC", amount: "10", amount_type: "from" });
    expect(paths).toEqual([
      "/api/v1/directions",
      "/api/v1/payment",
      "/api/v1/payment/info",
      "/api/v1/payment/list",
      "/api/v1/payout",
      "/api/v1/payout/status/00000000-0000-4000-8000-000000000000",
      "/api/v1/exchange-rates",
      "/api/v1/prices",
      "/api/v1/static-wallet",
      "/api/v1/static-wallet/info",
      "/api/v1/static-wallet/list",
      "/api/v1/static-wallet/transactions",
      "/api/v1/static-wallet/disable",
      "/api/v1/static-wallet/enable",
      "/api/v1/convert/price",
      "/api/v1/convert",
    ]);
  });

  test("never retries a conversion execution after an ambiguous network failure", async () => {
    let calls = 0;
    const fetchMock = mock(async () => {
      calls += 1;
      throw new TypeError("connection reset");
    });
    const client = new Payments2328Client(testConfig(), credentials, createLogger(testConfig()), fetchMock as unknown as typeof fetch);
    await expect(client.executeConvert({ from_currency: "USDT", to_currency: "BTC", amount: "10", amount_type: "from" }))
      .rejects.toEqual(expect.objectContaining({ code: "UPSTREAM_UNAVAILABLE" }));
    expect(calls).toBe(1);
  });

  test("returns structured upstream errors", async () => {
    const fetchMock = mock(async () => Response.json({ state: 1, error_code: "VALIDATION_FAILED", errors: { amount: ["too low"] } }, { status: 422 }));
    const client = new Payments2328Client(testConfig(), credentials, createLogger(testConfig()), fetchMock as unknown as typeof fetch);
    await expect(client.balances()).rejects.toEqual(expect.objectContaining({
      status: 422,
      code: "VALIDATION_FAILED",
    }));
  });

  test("rejects malformed and oversized successful responses", async () => {
    const malformed = new Payments2328Client(
      testConfig(),
      credentials,
      createLogger(testConfig()),
      mock(async () => new Response("not-json", { status: 200 })) as unknown as typeof fetch,
    );
    await expect(malformed.balances()).rejects.toEqual(expect.objectContaining({ code: "INVALID_UPSTREAM_RESPONSE" }));

    const oversized = new Payments2328Client(
      testConfig(),
      credentials,
      createLogger(testConfig()),
      mock(async () => new Response("{}", { status: 200, headers: { "content-length": "6000000" } })) as unknown as typeof fetch,
    );
    await expect(oversized.balances()).rejects.toEqual(expect.objectContaining({ code: "UPSTREAM_RESPONSE_TOO_LARGE" }));
  });

  test("does not allow payout calls without a payout key", async () => {
    const client = new Payments2328Client(testConfig(), { projectId: credentials.projectId, apiKey: credentials.apiKey }, createLogger(testConfig()));
    await expect(client.payout("00000000-0000-4000-8000-000000000000")).rejects.toThrow("no payout API key");
  });
});
