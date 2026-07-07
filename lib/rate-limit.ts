// Per-IP daily case budget, in memory. Same deliberate MVP limitation as
// DealScout: per-instance on serverless; production fix is a shared store.

const DAILY_CASE_LIMIT = Number(process.env.DEMO_DAILY_CASE_LIMIT ?? 60);

const usage = new Map<string, { day: string; count: number }>();

export function checkRateLimit(ip: string): boolean {
  const today = new Date().toISOString().slice(0, 10);
  const entry = usage.get(ip);
  if (!entry || entry.day !== today) {
    usage.set(ip, { day: today, count: 1 });
    return true;
  }
  if (entry.count >= DAILY_CASE_LIMIT) return false;
  entry.count++;
  return true;
}
