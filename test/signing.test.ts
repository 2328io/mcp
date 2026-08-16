import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { signBody, stableJson } from "../src/api/signing.js";

describe("2328 request signing", () => {
  test("signs the exact UTF-8 body after base64 encoding", () => {
    const body = stableJson({ amount: "200.00", currency: "USDT", note: "тест" });
    const expected = createHmac("sha256", "secret-key")
      .update(Buffer.from(body).toString("base64"))
      .digest("hex");
    expect(signBody(body, "secret-key")).toBe(expected);
  });

  test("GET requests sign an empty body", () => {
    expect(signBody("", "secret-key")).toHaveLength(64);
    expect(stableJson({ b: 2, a: 1 })).toBe('{"b":2,"a":1}');
  });
});
