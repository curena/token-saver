import { describe, expect, it } from "vitest";
import { isDenylistedPath, redact } from "../../src/core/redact.js";

describe("redact", () => {
  it("masks an sk- style api key", () => {
    const out = redact("export KEY=sk-ant-api03-AbCdEf0123456789AbCdEf0123456789");
    expect(out).not.toContain("AbCdEf0123456789");
    expect(out).toContain("[REDACTED]");
  });

  it("masks values of env-style assignments", () => {
    expect(redact("DB_PASSWORD=hunter2trustno1")).toBe("DB_PASSWORD=[REDACTED]");
  });

  it("keeps ordinary prose and code untouched", () => {
    const text = "function add(a, b) { return a + b; } // adds two numbers";
    expect(redact(text)).toBe(text);
  });

  it("preserves line count so line ranges stay valid", () => {
    const text = "a\nTOKEN=abcdefghijklmnopqrst\nb";
    expect(redact(text).split("\n")).toHaveLength(3);
  });

  it("flags denylisted paths", () => {
    expect(isDenylistedPath("/home/u/p/.env")).toBe(true);
    expect(isDenylistedPath("/home/u/p/.env.local")).toBe(true);
    expect(isDenylistedPath("/home/u/.ssh/id_rsa")).toBe(true);
    expect(isDenylistedPath("/home/u/p/secrets/keys.json")).toBe(true);
    expect(isDenylistedPath("/home/u/p/src/index.ts")).toBe(false);
  });
});
