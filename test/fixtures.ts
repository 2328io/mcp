import type { Config } from "../src/config.js";

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    NODE_ENV: "test",
    TRANSPORT: "http",
    HOST: "127.0.0.1",
    PORT: 3000,
    PUBLIC_BASE_URL: "https://mcp.example.test",
    MCP_PATH: "/mcp",
    API_BASE_URL: "https://api.example.test/api/v1",
    API_TIMEOUT_MS: 1_000,
    MCP_RATE_LIMIT_PER_MINUTE: 600,
    ALLOWED_ORIGINS: "",
    TRUST_PROXY: false,
    REDIS_URL: "redis://localhost:6379",
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64url"),
    ACCESS_TOKEN_TTL_SECONDS: 900,
    REFRESH_TOKEN_TTL_SECONDS: 2_592_000,
    AUTH_CODE_TTL_SECONDS: 120,
    PREPARATION_TTL_SECONDS: 300,
    CONVERT_PREPARATION_TTL_SECONDS: 60,
    LOG_LEVEL: "silent",
    ...overrides,
  };
}
