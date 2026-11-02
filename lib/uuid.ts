const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Postgres rejects a malformed uuid with an error, so ids from a URL, a queue
// message or localStorage are checked before they reach a query. Kept apart
// from lib/store.ts so browser code can use it.
export function isUuid(s: unknown): s is string {
  return typeof s === "string" && UUID.test(s);
}
