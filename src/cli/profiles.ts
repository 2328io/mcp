import { chmod, mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import type { Credentials } from "../domain.js";

const SERVICE = "io.2328.cli";
const profileName = z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/u);
const profileSchema = z.object({
  name: profileName,
  projectId: z.string().min(8),
  apiBaseUrl: z.url(),
  hasPayoutKey: z.boolean(),
  createdAt: z.string(),
});
const storeSchema = z.object({
  version: z.literal(1),
  currentProfile: profileName.optional(),
  profiles: z.array(profileSchema),
});
const secretSchema = z.object({
  apiKey: z.string().min(16),
  payoutApiKey: z.string().min(16).optional(),
});

export type Profile = z.infer<typeof profileSchema>;
type ProfileStoreData = z.infer<typeof storeSchema>;

export interface SecretStore {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<boolean>;
}

export class SystemSecretStore implements SecretStore {
  public get(name: string): Promise<string | null> {
    return Bun.secrets.get({ service: SERVICE, name });
  }

  public set(name: string, value: string): Promise<void> {
    return Bun.secrets.set({ service: SERVICE, name, value });
  }

  public delete(name: string): Promise<boolean> {
    return Bun.secrets.delete({ service: SERVICE, name });
  }
}

export interface ResolvedProfile {
  name: string;
  apiBaseUrl: string;
  credentials: Credentials;
  source: "environment" | "profile";
}

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === "win32" && env.APPDATA) return join(env.APPDATA, "2328", "config.json");
  const base = env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "2328", "config.json");
}

export class ProfileStore {
  public constructor(
    private readonly path = defaultConfigPath(),
    private readonly secrets: SecretStore = new SystemSecretStore(),
  ) {}

  public async list(): Promise<{ currentProfile?: string; profiles: Profile[] }> {
    const data = await this.read();
    return {
      ...(data.currentProfile ? { currentProfile: data.currentProfile } : {}),
      profiles: data.profiles,
    };
  }

  public async save(
    input: { name: string; projectId: string; apiBaseUrl: string },
    credentials: { apiKey: string; payoutApiKey?: string },
  ): Promise<Profile> {
    const parsedName = profileName.parse(input.name);
    const parsedSecrets = secretSchema.parse(credentials);
    const data = await this.read();
    const existing = data.profiles.find((profile) => profile.name === parsedName);
    const profile = profileSchema.parse({
      name: parsedName,
      projectId: input.projectId,
      apiBaseUrl: input.apiBaseUrl,
      hasPayoutKey: Boolean(parsedSecrets.payoutApiKey),
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    });

    const previousSecret = await this.secrets.get(parsedName);
    await this.secrets.set(parsedName, JSON.stringify(parsedSecrets));
    data.profiles = [...data.profiles.filter((candidate) => candidate.name !== parsedName), profile]
      .sort((left, right) => left.name.localeCompare(right.name));
    data.currentProfile = parsedName;
    try {
      await this.write(data);
    } catch (error) {
      if (previousSecret === null) await this.secrets.delete(parsedName);
      else await this.secrets.set(parsedName, previousSecret);
      throw error;
    }
    return profile;
  }

  public async use(name: string): Promise<void> {
    const parsedName = profileName.parse(name);
    const data = await this.read();
    if (!data.profiles.some((profile) => profile.name === parsedName)) throw new Error(`Profile '${parsedName}' does not exist`);
    data.currentProfile = parsedName;
    await this.write(data);
  }

  public async remove(name: string): Promise<void> {
    const parsedName = profileName.parse(name);
    const data = await this.read();
    data.profiles = data.profiles.filter((profile) => profile.name !== parsedName);
    if (data.currentProfile === parsedName) data.currentProfile = data.profiles[0]?.name;
    await this.write(data);
    await this.secrets.delete(parsedName);
  }

  public async resolve(env: NodeJS.ProcessEnv = process.env, requestedProfile?: string): Promise<ResolvedProfile | null> {
    if (env.PROJECT_ID && env.API_KEY) {
      return {
        name: "environment",
        apiBaseUrl: env.API_BASE_URL ?? "https://api.2328.io/api/v1",
        credentials: {
          projectId: env.PROJECT_ID,
          apiKey: env.API_KEY,
          ...(env.PAYOUT_API_KEY ? { payoutApiKey: env.PAYOUT_API_KEY } : {}),
        },
        source: "environment",
      };
    }

    const data = await this.read();
    const selected = requestedProfile ?? env.P2328_PROFILE ?? data.currentProfile;
    if (!selected) return null;
    const profile = data.profiles.find((candidate) => candidate.name === selected);
    if (!profile) throw new Error(`Profile '${selected}' does not exist`);
    let rawSecret: string | null;
    try {
      rawSecret = await this.secrets.get(profile.name);
    } catch (error) {
      throw new Error(`Cannot access the operating system credential store: ${error instanceof Error ? error.message : "unknown error"}`);
    }
    if (!rawSecret) throw new Error(`Credentials for profile '${profile.name}' are missing from the operating system credential store`);
    const secret = secretSchema.parse(JSON.parse(rawSecret));
    return {
      name: profile.name,
      apiBaseUrl: profile.apiBaseUrl,
      credentials: {
        projectId: profile.projectId,
        apiKey: secret.apiKey,
        ...(secret.payoutApiKey ? { payoutApiKey: secret.payoutApiKey } : {}),
      },
      source: "profile",
    };
  }

  private async read(): Promise<ProfileStoreData> {
    try {
      return storeSchema.parse(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return { version: 1, profiles: [] };
      }
      throw new Error(`Cannot read 2328 CLI configuration: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  private async write(data: ProfileStoreData): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${String(process.pid)}.tmp`;
    await Bun.write(temporaryPath, `${JSON.stringify(storeSchema.parse(data), null, 2)}\n`);
    if (process.platform !== "win32") await chmod(temporaryPath, 0o600);
    try {
      await rename(temporaryPath, this.path);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }
}
