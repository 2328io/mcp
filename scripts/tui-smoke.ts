import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { signBody } from "../src/api/signing.js";

const temporaryRoot = await mkdtemp(join(tmpdir(), "2328-tui-smoke-"));
const executable = resolve(import.meta.dir, "../dist/index.js");

function environment(overrides: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries({
      ...process.env,
      APPDATA: temporaryRoot,
      XDG_CONFIG_HOME: temporaryRoot,
      PROJECT_ID: "",
      API_KEY: "",
      PAYOUT_API_KEY: "",
      P2328_PROFILE: "",
      TERM: "xterm-256color",
      LOG_LEVEL: "silent",
      ...overrides,
    }).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

async function waitFor(predicate: () => boolean, output: () => string, timeoutMilliseconds = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`TUI smoke timed out. Output:\n${output()}`);
    await Bun.sleep(25);
  }
}

async function setupCancellationScenario(): Promise<void> {
  let output = "";
  const decoder = new TextDecoder();
  const processHandle = Bun.spawn([process.execPath, executable], {
    env: environment({}),
    terminal: {
      cols: 100,
      rows: 30,
      data(_terminal, data) {
        output += decoder.decode(data, { stream: true });
      },
    },
  });
  try {
    await waitFor(() => output.includes("2328 Wallet CLI") && output.includes("Profile name"), () => output);
    if (!processHandle.terminal) throw new Error("Bun did not attach a pseudo-terminal");
    processHandle.terminal.write("\x03");
    await waitFor(() => output.includes("No profile configured"), () => output);
    const exitCode = await processHandle.exited;
    if (exitCode !== 0) throw new Error(`TUI exited with ${String(exitCode)}. Output:\n${output}`);
    if (!output.includes("\x1b[")) throw new Error("TUI output did not contain terminal presentation sequences");
  } finally {
    if (processHandle.exitCode === null) processHandle.kill();
    processHandle.terminal?.close();
  }
}

async function accountNavigationScenario(): Promise<void> {
  const projectId = "project-smoke";
  const apiKey = "a".repeat(32);
  let balanceRequests = 0;
  const mockApi = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/api/v1/balance") return Response.json({ state: 1 }, { status: 404 });
      if (request.headers.get("project") !== projectId || request.headers.get("sign") !== signBody("", apiKey)) {
        return Response.json({ state: 1, error_code: "bad_signature" }, { status: 401 });
      }
      balanceRequests += 1;
      return Response.json({
        state: 0,
        result: [{ currency_code: "USDT", balance: "125.50", balance_usd: "125.50", locked_balance: "0.00" }],
      });
    },
  });

  let output = "";
  const decoder = new TextDecoder();
  const processHandle = Bun.spawn([process.execPath, executable], {
    env: environment({
      NODE_ENV: "development",
      PROJECT_ID: projectId,
      API_KEY: apiKey,
      API_BASE_URL: new URL("/api/v1", mockApi.url).toString(),
      API_TIMEOUT_MS: "1000",
    }),
    terminal: {
      cols: 110,
      rows: 36,
      data(_terminal, data) {
        output += decoder.decode(data, { stream: true });
      },
    },
  });

  try {
    await waitFor(() => output.includes("Account: environment"), () => output);
    if (!processHandle.terminal) throw new Error("Bun did not attach a pseudo-terminal");
    processHandle.terminal.write("\r");
    await waitFor(
      () => balanceRequests === 1 && output.includes("Balances") && output.includes("125.50")
        && output.split("Account: environment").length >= 3,
      () => output,
    );
    processHandle.terminal.write(`${"\x1b[B".repeat(7)}\r`);
    await waitFor(() => output.includes("Session closed"), () => output);
    const exitCode = await processHandle.exited;
    if (exitCode !== 0) throw new Error(`TUI exited with ${String(exitCode)}. Output:\n${output}`);
  } finally {
    if (processHandle.exitCode === null) processHandle.kill();
    processHandle.terminal?.close();
    await mockApi.stop(true);
  }
}

try {
  await setupCancellationScenario();
  await accountNavigationScenario();
  console.log("TUI smoke passed: real TTY, setup cancellation, signed balance view, keyboard navigation");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
