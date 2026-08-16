import { z } from "zod";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

const booleanString = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const optional = <T extends z.ZodType>(schema: T) => z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
  schema.optional(),
);

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    TRANSPORT: z.enum(["http", "stdio"]).default("http"),
    HOST: z.string().default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    PUBLIC_BASE_URL: z.url().default("http://127.0.0.1:3000"),
    MCP_PATH: z.string().regex(/^\/[A-Za-z0-9/_-]*$/u).default("/mcp"),
    API_BASE_URL: z.url().default("https://api.2328.io/api/v1"),
    API_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(8_000),
    MCP_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(10).max(6_000).default(600),
    ALLOWED_ORIGINS: z.string().default(""),
    TRUST_PROXY: booleanString,
    REDIS_URL: optional(z.url()),
    REDIS_PASSWORD_FILE: optional(z.string().min(1).max(4_096)),
    TOKEN_ENCRYPTION_KEY: optional(z.string()),
    TOKEN_ENCRYPTION_KEY_FILE: optional(z.string().min(1).max(4_096)),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(300).max(3_600).default(900),
    REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().min(3_600).max(90 * 24 * 60 * 60).default(30 * 24 * 60 * 60),
    AUTH_CODE_TTL_SECONDS: z.coerce.number().int().min(30).max(300).default(120),
    PREPARATION_TTL_SECONDS: z.coerce.number().int().min(30).max(600).default(300),
    CONVERT_PREPARATION_TTL_SECONDS: z.coerce.number().int().min(15).max(120).default(60),
    PROJECT_ID: optional(z.string().min(8)),
    API_KEY: optional(z.string().min(16)),
    PAYOUT_API_KEY: optional(z.string().min(16)),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  })
  .superRefine((env, context) => {
    const productionHttp = env.TRANSPORT === "http" && env.NODE_ENV === "production";
    const publicUrl = new URL(env.PUBLIC_BASE_URL);
    const apiUrl = new URL(env.API_BASE_URL);
    if (publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash || publicUrl.username || publicUrl.password) {
      context.addIssue({ code: "custom", path: ["PUBLIC_BASE_URL"], message: "PUBLIC_BASE_URL must be an origin without path, query, credentials or fragment" });
    }
    if (apiUrl.search || apiUrl.hash || apiUrl.username || apiUrl.password) {
      context.addIssue({ code: "custom", path: ["API_BASE_URL"], message: "API_BASE_URL must not contain query, credentials or fragment" });
    }
    if (productionHttp && !env.PUBLIC_BASE_URL.startsWith("https://")) {
      context.addIssue({ code: "custom", path: ["PUBLIC_BASE_URL"], message: "HTTPS is required in production" });
    }
    if (env.TRANSPORT === "http" && !env.REDIS_URL) {
      context.addIssue({ code: "custom", path: ["REDIS_URL"], message: "Redis is required for HTTP OAuth replay protection" });
    }
    if (env.TOKEN_ENCRYPTION_KEY && env.TOKEN_ENCRYPTION_KEY_FILE) {
      context.addIssue({ code: "custom", path: ["TOKEN_ENCRYPTION_KEY_FILE"], message: "Set TOKEN_ENCRYPTION_KEY or TOKEN_ENCRYPTION_KEY_FILE, not both" });
    }
    if (env.TRANSPORT === "http" && !env.TOKEN_ENCRYPTION_KEY && !env.TOKEN_ENCRYPTION_KEY_FILE) {
      context.addIssue({ code: "custom", path: ["TOKEN_ENCRYPTION_KEY"], message: "A 32-byte base64url key is required for HTTP OAuth" });
    }
    if (env.REDIS_PASSWORD_FILE && !env.REDIS_URL) {
      context.addIssue({ code: "custom", path: ["REDIS_PASSWORD_FILE"], message: "REDIS_PASSWORD_FILE requires REDIS_URL" });
    }
    if (env.TRANSPORT === "stdio" && (!env.PROJECT_ID || !env.API_KEY)) {
      context.addIssue({ code: "custom", message: "PROJECT_ID and API_KEY are required for stdio" });
    }
  });

export type Config = z.infer<typeof schema>;

function readSecretFile(path: string, name: string): string {
  if (!isAbsolute(path)) throw new Error(`${name} must be an absolute path`);
  const metadata = statSync(path);
  if (!metadata.isFile() || metadata.size > 4_096) throw new Error(`${name} must reference a regular file no larger than 4096 bytes`);
  const value = readFileSync(path, "utf8").trim();
  if (!value) throw new Error(`${name} is empty`);
  return value;
}

export function loadConfig(input: NodeJS.ProcessEnv = process.env): Config {
  let config = schema.parse(input);
  if (config.TOKEN_ENCRYPTION_KEY_FILE) {
    config = {
      ...config,
      TOKEN_ENCRYPTION_KEY: readSecretFile(config.TOKEN_ENCRYPTION_KEY_FILE, "TOKEN_ENCRYPTION_KEY_FILE"),
    };
  }
  if (config.REDIS_PASSWORD_FILE && config.REDIS_URL) {
    const redisUrl = new URL(config.REDIS_URL);
    if (redisUrl.password) throw new Error("REDIS_URL must not contain a password when REDIS_PASSWORD_FILE is set");
    redisUrl.password = readSecretFile(config.REDIS_PASSWORD_FILE, "REDIS_PASSWORD_FILE");
    config = { ...config, REDIS_URL: redisUrl.toString() };
  }
  const apiUrl = new URL(config.API_BASE_URL);
  if (config.NODE_ENV === "production" && apiUrl.protocol !== "https:") {
    throw new Error("API_BASE_URL must use HTTPS in production");
  }
  if (config.TOKEN_ENCRYPTION_KEY) {
    const bytes = Buffer.from(config.TOKEN_ENCRYPTION_KEY, "base64url");
    if (bytes.length !== 32) {
      throw new Error("TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes");
    }
  }
  return config;
}

export function publicMcpUrl(config: Config): string {
  return new URL(config.MCP_PATH, config.PUBLIC_BASE_URL).toString();
}
