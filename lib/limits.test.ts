import { afterEach, describe, expect, it, vi } from "vitest";
import { adminAccess, clientIp, dailyCaseLimit, dailySpendCapUsd } from "./limits";

afterEach(() => vi.unstubAllEnvs());

describe("limits from env", () => {
  it("uses the defaults when unset, blank or not a number", () => {
    for (const raw of [undefined, "", "  ", "abc", "-1"]) {
      vi.stubEnv("DAILY_SPEND_CAP_USD", raw);
      vi.stubEnv("DEMO_DAILY_CASE_LIMIT", raw);
      expect(dailySpendCapUsd()).toBe(5);
      expect(dailyCaseLimit()).toBe(60);
    }
  });

  it("reads valid values, keeping cents on the spend cap", () => {
    vi.stubEnv("DAILY_SPEND_CAP_USD", "2.5");
    vi.stubEnv("DEMO_DAILY_CASE_LIMIT", "10.9");
    expect(dailySpendCapUsd()).toBe(2.5);
    expect(dailyCaseLimit()).toBe(10);
    vi.stubEnv("DAILY_SPEND_CAP_USD", "0");
    expect(dailySpendCapUsd()).toBe(0);
  });
});

describe("adminAccess", () => {
  it("is public without a token and admin with the right one", () => {
    vi.stubEnv("EVALBOARD_ADMIN_TOKEN", "s3cret");
    expect(adminAccess(null)).toBe("public");
    expect(adminAccess("Bearer s3cret")).toBe("admin");
  });

  it("rejects a wrong or malformed token", () => {
    vi.stubEnv("EVALBOARD_ADMIN_TOKEN", "s3cret");
    for (const h of ["Bearer nope", "Bearer s3cret2", "s3cret", "Basic s3cret", "Bearer "]) {
      expect(adminAccess(h)).toBe("invalid");
    }
  });

  it("rejects every token when none is configured", () => {
    vi.stubEnv("EVALBOARD_ADMIN_TOKEN", "");
    expect(adminAccess("Bearer ")).toBe("invalid");
    expect(adminAccess("Bearer anything")).toBe("invalid");
  });
});

describe("clientIp", () => {
  it("takes the first forwarded address", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "9.9.9.9, 10.0.0.1" }))).toBe("9.9.9.9");
    expect(clientIp(new Headers())).toBe("unknown");
  });
});
