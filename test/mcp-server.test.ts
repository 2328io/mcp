import { describe, expect, mock, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Principal } from "../src/domain.js";
import { createLogger } from "../src/logger.js";
import { createMcpServer } from "../src/mcp/server.js";
import { TokenService } from "../src/security/tokens.js";
import { testConfig } from "./fixtures.js";

describe("MCP wallet tools", () => {
  test("exposes scoped tools and executes a prepared payout without payload mutation", async () => {
    const config = testConfig();
    const principal: Principal = {
      subject: "project:test",
      scopes: new Set(["wallet:read", "market:read", "static-wallet:read", "static-wallet:create", "static-wallet:update", "payout:quote", "payout:create", "convert:quote", "convert:execute"]),
      credentials: { projectId: "project-123", apiKey: "a".repeat(32), payoutApiKey: "b".repeat(32) },
    };
    const requests: { path: string; body: unknown }[] = [];
    const fetchMock = mock(async (urlValue: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(urlValue)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) as unknown : undefined;
      requests.push({ path, body });
      if (path.endsWith("/balance")) return Response.json({ state: 0, result: [{ currency_code: "USDT", balance: "500" }] });
      if (path.endsWith("/payout/calc")) return Response.json({ state: 0, result: { total_fee: "1", merchant_amount: "200" } });
      if (path.endsWith("/convert/price")) return Response.json({ state: 0, result: { from_amount: "10", to_amount: "0.0001" } });
      if (path.endsWith("/convert")) return Response.json({ state: 0, result: { id: 42, status: "completed" } });
      return Response.json({ state: 0, result: { uuid: "00000000-0000-4000-8000-000000000001", status: "pending" } });
    });
    const server = createMcpServer(config, principal, new TokenService(config), createLogger(config), fetchMock as unknown as typeof fetch);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const tools = await client.listTools();
    expect(tools.tools.find((tool) => tool.name === "payout_create")?.annotations?.destructiveHint).toBeTrue();
    expect(tools.tools.find((tool) => tool.name === "convert_execute")?.annotations?.idempotentHint).toBeFalse();
    const toolNames = tools.tools.map((tool) => tool.name);
    for (const name of ["exchange_rates", "market_prices", "static_wallet_create", "static_wallet_transactions", "convert_prepare", "convert_execute"]) {
      expect(toolNames).toContain(name);
    }
    expect(toolNames).not.toContain("invoice_create");
    expect(toolNames).not.toContain("payout_get");
    const resources = await client.listResources();
    expect(resources.resources.map((resource) => resource.uri)).toEqual([
      "wallet2328://safety",
      "wallet2328://capabilities",
    ]);
    const safety = await client.readResource({ uri: "wallet2328://safety" });
    expect(safety.contents[0]).toMatchObject({ mimeType: "text/markdown" });
    expect("text" in safety.contents[0]! ? safety.contents[0].text : "").toContain("Never retry convert_execute automatically");
    const balances = await client.callTool({ name: "wallet_balances", arguments: {} });
    expect(balances.isError).not.toBeTrue();

    const prepared = await client.callTool({
      name: "payout_prepare",
      arguments: { currency: "USDT", network: "TRX-TRC20", amount: "200", to_address: "TNJaddress123456789", fee_option: "deduct" },
    });
    expect(prepared.structuredContent).toBeDefined();
    const firstContent = Array.isArray(prepared.content) ? prepared.content[0] as unknown : undefined;
    const preparationText = typeof firstContent === "object" && firstContent !== null
      && "type" in firstContent && firstContent.type === "text"
      && "text" in firstContent && typeof firstContent.text === "string"
      ? firstContent.text
      : "{}";
    const preparation = JSON.parse(preparationText) as { confirmation_token: string; confirmation: string; payout: { order_id: string } };
    const created = await client.callTool({
      name: "payout_create",
      arguments: { confirmation_token: preparation.confirmation_token, confirmation: preparation.confirmation },
    });
    expect(created.isError).not.toBeTrue();
    expect(requests.at(-1)).toEqual({
      path: "/api/v1/payout",
      body: {
        currency: "USDT",
        network: "TRX-TRC20",
        amount: "200",
        to_address: "TNJaddress123456789",
        fee_option: "deduct",
        order_id: preparation.payout.order_id,
      },
    });

    const rejectedDisable = await client.callTool({
      name: "static_wallet_disable",
      arguments: {
        uuid: "00000000-0000-4000-8000-000000000001",
        confirmation: "DISABLE SOMETHING ELSE",
      },
    });
    expect(rejectedDisable.isError).toBeTrue();
    const disabled = await client.callTool({
      name: "static_wallet_disable",
      arguments: {
        uuid: "00000000-0000-4000-8000-000000000001",
        confirmation: "DISABLE STATIC WALLET 00000000-0000-4000-8000-000000000001",
      },
    });
    expect(disabled.isError).not.toBeTrue();

    const convertPrepared = await client.callTool({
      name: "convert_prepare",
      arguments: { from_currency: "USDT", to_currency: "BTC", amount: "10", amount_type: "from" },
    });
    const convertContent = Array.isArray(convertPrepared.content) ? convertPrepared.content[0] as { type: string; text?: string } : undefined;
    const conversion = JSON.parse(convertContent?.text ?? "{}") as { confirmation_token: string; confirmation: string };
    const converted = await client.callTool({
      name: "convert_execute",
      arguments: { confirmation_token: conversion.confirmation_token, confirmation: conversion.confirmation },
    });
    expect(converted.isError).not.toBeTrue();
    expect(requests.at(-1)).toEqual({
      path: "/api/v1/convert",
      body: { from_currency: "USDT", to_currency: "BTC", amount: "10", amount_type: "from" },
    });

    await client.close();
    await server.close();
  });
});
