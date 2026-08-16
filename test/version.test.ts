import { describe, expect, test } from "bun:test";
import packageMetadata from "../package.json";
import { VERSION } from "../src/version.js";

describe("release metadata", () => {
  test("keeps the CLI/MCP runtime version aligned with the package", () => {
    expect(VERSION).toBe(packageMetadata.version);
  });
});
