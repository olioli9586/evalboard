import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function freshLimiter(limit?: string) {
  vi.resetModules();
  if (limit === undefined) vi.stubEnv("DEMO_DAILY_CASE_LIMIT", undefined as unknown as string);
  else vi.stubEnv("DEMO_DAILY_CASE_LIMIT", limit);
  return (await import("./rate-limit")).checkRateLimit;
}

describe("checkRateLimit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-10T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("allows exactly the configured number of cases per IP per day", async () => {
    const check = await freshLimiter("3");
    expect([check("1.1.1.1"), check("1.1.1.1"), check("1.1.1.1")]).toEqual([true, true, true]);
    expect(check("1.1.1.1")).toBe(false);
    expect(check("1.1.1.1")).toBe(false);
  });

  it("tracks IPs independently", async () => {
    const check = await freshLimiter("1");
    expect(check("a")).toBe(true);
    expect(check("a")).toBe(false);
    expect(check("b")).toBe(true);
  });

  it("resets on the next UTC day", async () => {
    const check = await freshLimiter("1");
    expect(check("a")).toBe(true);
    expect(check("a")).toBe(false);
    vi.setSystemTime(new Date("2026-03-11T00:00:01Z"));
    expect(check("a")).toBe(true);
  });

  it("defaults to 60 cases a day", async () => {
    const check = await freshLimiter();
    for (let i = 0; i < 60; i++) expect(check("a")).toBe(true);
    expect(check("a")).toBe(false);
  });

  it("falls back to the default when the limit is not a number", async () => {
    for (const raw of ["abc", "", "  ", "-5"]) {
      const check = await freshLimiter(raw);
      for (let i = 0; i < 60; i++) expect(check("a")).toBe(true);
      expect(check("a")).toBe(false);
    }
  });

  it("honours a limit of 0 as a full stop", async () => {
    const check = await freshLimiter("0");
    expect(check("a")).toBe(false);
  });
});
