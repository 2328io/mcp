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
});
