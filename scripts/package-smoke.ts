import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { VERSION } from "../src/version.js";

const repository = resolve(import.meta.dir, "..");
const temporaryRoot = await mkdtemp(join(tmpdir(), "2328-package-smoke-"));

async function run(command: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const processHandle = Bun.spawn(command, {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    processHandle.exited,
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`${command.join(" ")} failed\n${stderr || stdout}`);
  return stdout.trim();
}

try {
  const packDirectory = join(temporaryRoot, "pack");
  const installDirectory = join(temporaryRoot, "install");
  const globalDirectory = join(temporaryRoot, "global");
  const binDirectory = join(temporaryRoot, "bin");
  await Promise.all([
    mkdir(packDirectory),
    mkdir(installDirectory),
    mkdir(globalDirectory),
    mkdir(binDirectory),
  ]);

  await run([process.execPath, "pm", "pack", "--destination", packDirectory, "--quiet"], repository);
  const tarballs = (await readdir(packDirectory)).filter((name) => name.endsWith(".tgz"));
  if (tarballs.length !== 1 || !tarballs[0]) throw new Error("Expected exactly one package tarball");

  const smokeEnvironment = {
    ...process.env,
    BUN_INSTALL_GLOBAL_DIR: globalDirectory,
    BUN_INSTALL_BIN: binDirectory,
  };
  await run([process.execPath, "install", "--global", join(packDirectory, tarballs[0])], installDirectory, smokeEnvironment);
  const executable = join(binDirectory, process.platform === "win32" ? "2328.exe" : "2328");
  const installedVersion = await run([executable, "--version"], installDirectory, smokeEnvironment);
  if (installedVersion !== VERSION) throw new Error(`Installed CLI reported ${installedVersion}, expected ${VERSION}`);

  const mcpEnvironment = Object.fromEntries(
    Object.entries({
      ...smokeEnvironment,
      PROJECT_ID: "project-smoke",
      API_KEY: "a".repeat(32),
      LOG_LEVEL: "silent",
    }).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  const transport = new StdioClientTransport({ command: executable, args: ["--mcp"], env: mcpEnvironment });
  const client = new Client({ name: "package-smoke", version: VERSION });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    if (tools.tools.length !== 15 || names.some((name) => name.startsWith("payout_"))) {
      throw new Error(`Installed MCP exposed an unexpected tool set: ${names.join(", ")}`);
    }
  } finally {
    await client.close();
  }
  console.log(`Package smoke passed: 2328 ${installedVersion}, 15 scoped MCP tools`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
