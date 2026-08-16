import pino from "pino";
import type { Config } from "./config.js";

export function createLogger(config: Config) {
  return pino({
    level: config.LOG_LEVEL,
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.sign",
        "apiKey",
        "payoutApiKey",
        "credentials.apiKey",
        "credentials.payoutApiKey",
        "*.api_key",
        "*.payout_api_key",
        "*.access_token",
        "*.code",
      ],
      censor: "[REDACTED]",
    },
  }, config.TRANSPORT === "stdio" ? pino.destination({ dest: 2, sync: false }) : undefined);
}

export type Logger = ReturnType<typeof createLogger>;
