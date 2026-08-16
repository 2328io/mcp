import { describe, expect, test } from "bun:test";
import { loadConfig, publicMcpUrl } from "../src/config.js";

describe("configuration", () => {
  test("rejects an HTTP deployment without Redis and encryption", () => {
    expect(() => loadConfig({ TRANSPORT: "http" })).toThrow();
  });

  test("rejects insecure production endpoints", () => {
    expect(() => loadConfig({
      NODE_ENV: "production",
      TRANSPORT: "http",
      PUBLIC_BASE_URL: "http://mcp.example.test",
      API_BASE_URL: "https://api.example.test/api/v1",
      REDIS_URL: "redis://localhost:6379",
      TOKEN_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64url"),
    })).toThrow("HTTPS");
  });

  test("accepts local stdio credentials", () => {
    const config = loadConfig({
      TRANSPORT: "stdio",
      PROJECT_ID: "project-123",
      API_KEY: "a".repeat(32),
      PUBLIC_BASE_URL: "http://127.0.0.1:3000",
    });
    expect(config.TRANSPORT).toBe("stdio");
    expect(publicMcpUrl(config)).toBe("http://127.0.0.1:3000/mcp");
  });

  test("normalizes blank optional values from env files", () => {
    const config = loadConfig({
      TRANSPORT: "http",
      REDIS_URL: "redis://localhost:6379",
      TOKEN_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64url"),
      PROJECT_ID: "",
      API_KEY: "  ",
      PAYOUT_API_KEY: "",
    });
    expect(config.PROJECT_ID).toBeUndefined();
    expect(config.API_KEY).toBeUndefined();
    expect(config.PAYOUT_API_KEY).toBeUndefined();
  });

  test("requires a 32-byte encryption key", () => {
    expect(() => loadConfig({
      TRANSPORT: "http",
      REDIS_URL: "redis://localhost:6379",
      TOKEN_ENCRYPTION_KEY: Buffer.alloc(16).toString("base64url"),
    })).toThrow("32 bytes");
  });
});
