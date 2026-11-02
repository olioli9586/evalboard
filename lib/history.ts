import { isUuid } from "./uuid";

// The runs this browser launched or imported, newest first, as a list of run
// ids in localStorage. The runs themselves live on the server; the list only
// says which ones are yours, because there is no public list of everyone's
// runs to pick them from.

const KEY = "evalboard-history";
export const MAX_HISTORY = 100; // also the most ids GET /api/runs?ids= takes

// v1 kept whole run summaries under this key. They are sent to
// /api/runs/import once, then removed.
const LEGACY_KEY = "evalboard-runs";

function read(key: string): unknown {
  if (typeof window === "undefined") return null;
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null");
  } catch {
    return null;
  }
}

// Storage can be full or unavailable (private browsing); the list is a
// convenience, so keep going with the in-memory copy rather than throw.
function persist(ids: string[]): string[] {
  try {
    localStorage.setItem(KEY, JSON.stringify(ids));
  } catch {
    // ignore
  }
  return ids;
}

export function loadHistory(): string[] {
  const parsed = read(KEY);
  // Valid JSON of the wrong shape (e.g. "null") would otherwise crash the page,
  // and one bad id would make the server reject the whole list.
  return Array.isArray(parsed) ? parsed.filter(isUuid) : [];
}

export function addToHistory(ids: string[]): string[] {
  return persist([...new Set([...ids, ...loadHistory()])].slice(0, MAX_HISTORY));
}

export function removeFromHistory(id: string): string[] {
  return persist(loadHistory().filter((x) => x !== id));
}

// Drops ids the server said it doesn't know (for example after a database
// reset). Only those: ids added since the request went out stay.
export function forgetRuns(ids: string[]): string[] {
  const gone = new Set(ids);
  return persist(loadHistory().filter((id) => !gone.has(id)));
}

// The raw v1 entries; the server validates them.
export function loadLegacyRuns(): unknown[] {
  const parsed = read(LEGACY_KEY);
  return Array.isArray(parsed) ? parsed : [];
}

export function clearLegacyRuns(): void {
  try {
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    // ignore
  }
}
