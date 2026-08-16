import { RedisClient } from "bun";
import { createHash } from "node:crypto";
import type { ReplayStore } from "./replay-store.js";

export class RedisReplayStore implements ReplayStore {
  private client: RedisClient | undefined;

  public constructor(private readonly url: string) {}

  public async connect(): Promise<void> {
    let cause: unknown;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const client = this.createClient();
      this.client = client;
      try {
        await client.connect();
        if (await this.ready()) return;
        cause = new Error("Redis readiness check failed");
      } catch (error) {
        cause = error;
      }
      client.close();
      if (this.client === client) this.client = undefined;
      if (attempt < 7) await Bun.sleep(Math.min(100 * 2 ** attempt, 2_000));
    }
    throw new Error("Redis connection failed after startup retries", { cause });
  }

  public async consume(namespace: string, id: string, ttlSeconds: number): Promise<boolean> {
    const result: unknown = await this.connectedClient().send("SET", [this.key(namespace, id), "1", "NX", "EX", String(ttlSeconds)]);
    return result === "OK";
  }

  public async increment(namespace: string, id: string, ttlSeconds: number): Promise<number> {
    const key = this.key(namespace, id);
    const result: unknown = await this.connectedClient().send("EVAL", [
      "local value = redis.call('INCR', KEYS[1]); if value == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]); end; return value",
      "1",
      key,
      String(ttlSeconds),
    ]);
    const count = Number(result);
    if (!Number.isSafeInteger(count) || count < 1) throw new Error("Redis returned an invalid rate counter");
    return count;
  }

  public async ready(): Promise<boolean> {
    try {
      return await this.connectedClient().send("PING", []) === "PONG";
    } catch {
      return false;
    }
  }

  public close(): void {
    this.client?.close();
    this.client = undefined;
  }

  private createClient(): RedisClient {
    return new RedisClient(this.url, {
      connectionTimeout: 3_000,
      idleTimeout: 0,
      enableOfflineQueue: false,
      maxRetries: 10,
    });
  }

  private connectedClient(): RedisClient {
    if (!this.client) throw new Error("Redis is not connected");
    return this.client;
  }

  private key(namespace: string, id: string): string {
    return `mcp2328:${namespace}:${createHash("sha256").update(id).digest("base64url")}`;
  }
}
