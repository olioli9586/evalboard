import { NextRequest } from "next/server";
import { getPool, withTransaction } from "@/lib/db";
import { parseImport } from "@/lib/import";
import { clientIp, IMPORTS_PER_DAY, IMPORTS_PER_IP_PER_DAY } from "@/lib/limits";
import { importRun, reserveCases } from "@/lib/store";

export const runtime = "nodejs";

// The one-time move of a browser's v1 history (localStorage) to the server.
// The page calls it on first load and clears the old history once it
// succeeds. Calling it twice with the same history is a no-op that returns
// the same run ids.
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const parsed = parseImport(body);
  if ("error" in parsed) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }
  if (parsed.runs.length === 0) {
    return Response.json({ imported: [], skipped: parsed.skipped });
  }

  const ip = clientIp(req.headers);
  try {
    // All or nothing, quotas included: throwing rolls back the per-IP count
    // when the global one is used up, and a failed import gives both back.
    const imported = await withTransaction(async (tx) => {
      const allowed =
        (await reserveCases(tx, `import:${ip}`, 1, IMPORTS_PER_IP_PER_DAY)) &&
        (await reserveCases(tx, "import:all", 1, IMPORTS_PER_DAY));
      if (!allowed) throw new QuotaExceeded();
      const out = [];
      for (const run of parsed.runs) {
        out.push({ legacyId: run.legacyId, runs: await importRun(tx, run) });
      }
      return out;
    }, getPool());
    return Response.json({ imported, skipped: parsed.skipped });
  } catch (err) {
    if (err instanceof QuotaExceeded) {
      return Response.json({ error: "Too many imports today. Try again tomorrow." }, { status: 429 });
    }
    console.error("[runs] import failed:", err);
    return Response.json({ error: "Could not import the history." }, { status: 500 });
  }
}

class QuotaExceeded extends Error {}
