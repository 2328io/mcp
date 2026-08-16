import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProfileStore, type SecretStore } from "../src/cli/profiles.js";

class MemorySecrets implements SecretStore {
  public readonly values = new Map<string, string>();

  public async get(name: string): Promise<string | null> {
    return this.values.get(name) ?? null;
  }

  public async set(name: string, value: string): Promise<void> {
    this.values.set(name, value);
  }

  public async delete(name: string): Promise<boolean> {
    return this.values.delete(name);
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("local CLI profiles", () => {
  test("keeps API keys out of the metadata file and resolves them from secure storage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "2328-cli-test-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "config.json");
    const secrets = new MemorySecrets();
    const store = new ProfileStore(path, secrets);

    await store.save(
      { name: "merchant", projectId: "project-123", apiBaseUrl: "https://api.2328.io/api/v1" },
      { apiKey: "a".repeat(32), payoutApiKey: "b".repeat(32) },
    );

    const rawConfig = await readFile(path, "utf8");
    expect(rawConfig).not.toContain("a".repeat(32));
    expect(rawConfig).not.toContain("b".repeat(32));
    expect(await store.resolve({})).toEqual({
      name: "merchant",
      apiBaseUrl: "https://api.2328.io/api/v1",
      source: "profile",
      credentials: { projectId: "project-123", apiKey: "a".repeat(32), payoutApiKey: "b".repeat(32) },
    });

    await store.remove("merchant");
    expect(await store.resolve({})).toBeNull();
    expect(secrets.values.has("merchant")).toBeFalse();
  });

  test("prefers explicit environment credentials without persisting them", async () => {
    const directory = await mkdtemp(join(tmpdir(), "2328-cli-test-"));
    temporaryDirectories.push(directory);
    const store = new ProfileStore(join(directory, "config.json"), new MemorySecrets());
    expect(await store.resolve({
      PROJECT_ID: "environment-project",
      API_KEY: "c".repeat(32),
      PAYOUT_API_KEY: "d".repeat(32),
    })).toEqual({
      name: "environment",
      apiBaseUrl: "https://api.2328.io/api/v1",
      source: "environment",
      credentials: {
        projectId: "environment-project",
        apiKey: "c".repeat(32),
        payoutApiKey: "d".repeat(32),
      },
    });
  });
});
