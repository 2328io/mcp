import { randomBytes } from "node:crypto";

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) throw new Error("REDIS_URL is required for the hosted smoke test");

const port = Number(process.env.HOSTED_SMOKE_PORT ?? 39_128);
const origin = `http://127.0.0.1:${String(port)}`;
const child = Bun.spawn([process.execPath, "run", "dist/index.js", "--serve"], {
  env: {
    ...process.env,
    NODE_ENV: "development",
    TRANSPORT: "http",
    HOST: "127.0.0.1",
    PORT: String(port),
    PUBLIC_BASE_URL: origin,
    REDIS_URL: redisUrl,
    TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64url"),
    LOG_LEVEL: "silent",
  },
  stdout: "pipe",
  stderr: "pipe",
});

async function waitForReady(): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${origin}/readyz`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok && (await response.json() as { status?: string }).status === "ready") return;
    } catch {
      // Startup and dependency retries are expected during this bounded window.
    }
    await Bun.sleep(250);
  }
  throw new Error("Hosted MCP did not become ready");
}

try {
  await waitForReady();
  const health = await fetch(`${origin}/healthz`);
  if (!health.ok || (await health.json() as { status?: string }).status !== "ok") {
    throw new Error("Hosted health check failed");
  }

  const metadata = await fetch(`${origin}/.well-known/oauth-protected-resource`);
  const metadataBody = await metadata.json() as { resource?: string };
  if (!metadata.ok || metadataBody.resource !== `${origin}/mcp`) {
    throw new Error("OAuth protected-resource metadata is invalid");
  }

  const registration = await fetch(`${origin}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: ["http://127.0.0.1/callback"],
      client_name: "hosted-smoke",
      token_endpoint_auth_method: "none",
    }),
  });
  const registrationBody = await registration.json() as { client_id?: string };
  if (registration.status !== 201 || !registrationBody.client_id) {
    throw new Error("OAuth dynamic registration failed");
  }
  if (!registration.headers.has("content-security-policy")) {
    throw new Error("Hosted security headers are missing");
  }

  console.log("Hosted smoke passed: health, readiness, discovery, Redis rate state, OAuth registration");
} finally {
  child.kill("SIGTERM");
  await Promise.race([child.exited, Bun.sleep(3_000)]);
}
