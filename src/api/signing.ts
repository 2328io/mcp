import { createHmac } from "node:crypto";

export function signBody(body: string, key: string): string {
  const encoded = Buffer.from(body, "utf8").toString("base64");
  return createHmac("sha256", key).update(encoded).digest("hex");
}

export function stableJson(value: unknown): string {
  return JSON.stringify(value);
}
