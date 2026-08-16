#!/usr/bin/env bun
import { ProfileStore } from "./cli/profiles.js";
import { startInteractiveCli } from "./cli/ui.js";
import { loadConfig } from "./config.js";
import { startHttpServer } from "./http/server.js";
import { createLogger } from "./logger.js";
import { RedisReplayStore } from "./security/redis-replay-store.js";
import { TokenService } from "./security/tokens.js";
import { startStdioServer } from "./stdio.js";
import { VERSION } from "./version.js";

function help(): string {
  return `2328 Wallet CLI ${VERSION}

Usage:
  2328                     Open the interactive account menu
  2328 --mcp               Run a local MCP server over stdio
  2328 --mcp --profile NAME
                           Use a named local profile
  2328 --serve             Run the hosted OAuth MCP endpoint
  2328 --help              Show this help
  2328 --version           Show the version

Credential resolution for --mcp:
  PROJECT_ID + API_KEY (+ PAYOUT_API_KEY), then the selected OS-backed profile.
`;
}

function profileArgument(args: string[]): string | undefined {
  const index = args.indexOf("--profile");
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error("--profile requires a profile name");
  return value;
}

async function startMcp(args: string[]): Promise<void> {
  const resolved = await new ProfileStore().resolve(process.env, profileArgument(args));
  if (!resolved) {
    throw new Error("No 2328 credentials found. Run '2328' to add a profile, or set PROJECT_ID and API_KEY.");
  }
  const config = loadConfig({
    ...process.env,
    TRANSPORT: "stdio",
    API_BASE_URL: resolved.apiBaseUrl,
    PROJECT_ID: resolved.credentials.projectId,
    API_KEY: resolved.credentials.apiKey,
    PAYOUT_API_KEY: resolved.credentials.payoutApiKey,
  });
  const logger = createLogger(config);
  await startStdioServer(config, new TokenService(config), logger);
}

async function startHostedServer(): Promise<void> {
  const config = loadConfig({ ...process.env, TRANSPORT: "http" });
  const logger = createLogger(config);
  const tokens = new TokenService(config);

  if (!config.REDIS_URL) throw new Error("REDIS_URL is required for HTTP transport");
  const store = new RedisReplayStore(config.REDIS_URL);
  await store.connect();
  const server = startHttpServer(config, tokens, store, logger);
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down");
    await server.stop(false);
    store.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(help());
    return;
  }
  if (args.includes("--version") || args.includes("-v")) {
    console.log(VERSION);
    return;
  }
  if (args.includes("--mcp") || args.includes("--stdio")) {
    await startMcp(args);
    return;
  }
  if (args.includes("--serve")) {
    await startHostedServer();
    return;
  }
  if (args.length > 0) throw new Error(`Unknown argument: ${args[0] ?? ""}\n\n${help()}`);
  await startInteractiveCli();
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "2328 CLI failed");
  process.exitCode = 1;
}
