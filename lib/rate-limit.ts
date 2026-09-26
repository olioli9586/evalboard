// Per-IP daily case budget, in memory. Same deliberate MVP limitation as
// DealScout: per-instance on serverless; production fix is a shared store.

const DEFAULT_DAILY_CASE_LIMIT = 60;

// A blank or non-numeric value falls back to the default; a bare
// Number("abc") would be NaN, and `count >= NaN` never blocks anyone.
function parseLimit(raw: string | undefined): number {
  const n = raw?.trim() ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_DAILY_CASE_LIMIT;
}

const DAILY_CASE_LIMIT = parseLimit(process.env.DEMO_DAILY_CASE_LIMIT);

const usage = new Map<string, number>();
let usageDay = "";

export function checkRateLimit(ip: string): boolean {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== usageDay) {
    // New day: every budget resets, so drop yesterday's entries instead of
    // keeping one per IP forever on a long-lived instance.
    usage.clear();
    usageDay = today;
  }
  const count = usage.get(ip) ?? 0;
  if (count >= DAILY_CASE_LIMIT) return false;
  usage.set(ip, count + 1);
  return true;
}
