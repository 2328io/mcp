import { describe, expect, test } from "bun:test";
import { MemoryReplayStore } from "../src/security/replay-store.js";

describe("replay protection", () => {
  test("consumes a token id once", async () => {
    const store = new MemoryReplayStore();
    expect(await store.consume("code", "id", 60)).toBeTrue();
    expect(await store.consume("code", "id", 60)).toBeFalse();
  });

  test("counts requests in a window", async () => {
    const store = new MemoryReplayStore();
    expect(await store.increment("rate", "ip", 60)).toBe(1);
    expect(await store.increment("rate", "ip", 60)).toBe(2);
    store.close();
  });

  test("rotates refresh families and revokes the family on reuse", async () => {
    const store = new MemoryReplayStore();
    expect(await store.initializeRefreshFamily("family", "token-1", 60)).toBeTrue();
    expect(await store.initializeRefreshFamily("family", "other", 60)).toBeFalse();
    expect(await store.rotateRefreshFamily("family", "token-1", "token-2", 60)).toBe("rotated");
    expect(await store.rotateRefreshFamily("family", "token-1", "token-3", 60)).toBe("reused");
    expect(await store.rotateRefreshFamily("family", "token-2", "token-3", 60)).toBe("revoked");
  });
});
