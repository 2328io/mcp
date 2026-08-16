import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  test("loads production secrets from absolute files", () => {
    const directory = mkdtempSync(join(tmpdir(), "mcp-config-"));
    try {
      const encryptionPath = join(directory, "token-encryption-key");
      const redisPasswordPath = join(directory, "redis-password");
      writeFileSync(encryptionPath, `${Buffer.alloc(32, 7).toString("base64url")}\n`);
      writeFileSync(redisPasswordPath, "redis-password-with-symbols-:@/\n");

      const config = loadConfig({
        NODE_ENV: "production",
        TRANSPORT: "http",
        PUBLIC_BASE_URL: "https://mcp.2328.io",
        API_BASE_URL: "https://api.2328.io/api/v1",
        REDIS_URL: "redis://mcp@redis:6379",
        REDIS_PASSWORD_FILE: redisPasswordPath,
        TOKEN_ENCRYPTION_KEY_FILE: encryptionPath,
      });

      expect(config.TOKEN_ENCRYPTION_KEY).toBe(Buffer.alloc(32, 7).toString("base64url"));
      expect(config.REDIS_URL).toBe("redis://mcp:redis-password-with-symbols-%3A%40%2F@redis:6379");
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("rejects ambiguous or relative secret file configuration", () => {
    expect(() => loadConfig({
      TRANSPORT: "http",
      REDIS_URL: "redis://localhost:6379",
      TOKEN_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64url"),
      TOKEN_ENCRYPTION_KEY_FILE: "/run/secrets/token-encryption-key",
    })).toThrow("not both");

    expect(() => loadConfig({
      TRANSPORT: "http",
      REDIS_URL: "redis://localhost:6379",
      TOKEN_ENCRYPTION_KEY_FILE: "relative-secret",
    })).toThrow("absolute path");
  });
});
