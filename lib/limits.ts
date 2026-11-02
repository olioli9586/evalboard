import { createHash, timingSafeEqual } from "node:crypto";

// ---------------------------------------------------------------------------
// Spend limits for server-side runs. Env vars are read at call time, not at
// import, so tests can set them per case.
// ---------------------------------------------------------------------------

export const MAX_PUBLIC_CASES = 20; // same cap the v1 browser runner had
export const MAX_ADMIN_CASES = 1000;

// The history import makes no model calls but writes rows, so it is limited
// too. The counters live in usage_daily under their own keys, apart from the
// case budget: "import:<ip>" per IP and "import:all" for everyone.
export const IMPORTS_PER_IP_PER_DAY = 2; // the import runs once; 2 allows a retry
export const IMPORTS_PER_DAY = 100;

// A blank or non-numeric value falls back to the default: NaN would make
// every `spent >= cap` comparison false and switch the limit off.
function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw?.trim() ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// Cases per IP per day (cases x runs), for callers without the admin token.
export function dailyCaseLimit(): number {
  return Math.floor(envNumber("DEMO_DAILY_CASE_LIMIT", 60));
}

// Model + judge spend per day across everyone, admin runs included.
export function dailySpendCapUsd(): number {
  return envNumber("DAILY_SPEND_CAP_USD", 5);
}

export function clientIp(headers: Headers): string {
  return headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

// "admin" for a valid bearer token, "invalid" for a wrong one (or any token
// when none is configured), "public" when no token was sent. Hashing both
// sides first gives timingSafeEqual equal-length inputs.
export function adminAccess(authorization: string | null): "admin" | "public" | "invalid" {
  if (!authorization) return "public";
  const expected = process.env.EVALBOARD_ADMIN_TOKEN;
  const token = authorization.match(/^Bearer (.+)$/)?.[1];
  if (!expected || !token) return "invalid";
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(token), digest(expected)) ? "admin" : "invalid";
}
