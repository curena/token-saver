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

  // Known wart, not an endorsement: the entropy pass (Pass 3) deliberately favours
  // recall over precision and has no way to tell a long mixed-case identifier from
  // a real secret. This pins today's behaviour so the tradeoff stays visible;
  // Milestone 2's eval harness is what tunes it, not a guess made here.
  it("currently masks long mixed-case identifiers (known false positive, tuned in Milestone 2)", () => {
    const identifier = "getUserProfileByIdV2EndpointHandler123456";
    expect(redact(`const handler = ${identifier};`)).toBe("const handler = [REDACTED];");
  });

  it("flags denylisted paths", () => {
    expect(isDenylistedPath("/home/u/p/.env")).toBe(true);
    expect(isDenylistedPath("/home/u/p/.env.local")).toBe(true);
    expect(isDenylistedPath("/home/u/.ssh/id_rsa")).toBe(true);
    expect(isDenylistedPath("/home/u/p/secrets/keys.json")).toBe(true);
    expect(isDenylistedPath("/home/u/p/src/index.ts")).toBe(false);
  });

  // A bare directory path (no trailing slash) must match too — callers that enumerate a
  // directory listing (e.g. src/audit/profile.ts's tree) pass exactly this shape.
  it("flags a bare secrets directory path, with no trailing slash, as well as a nested one", () => {
    expect(isDenylistedPath("/p/secrets")).toBe(true);
    expect(isDenylistedPath("/p/secrets/x")).toBe(true);
  });
});
