import Anthropic from "@anthropic-ai/sdk";
import { NextRequest } from "next/server";
import { MODELS } from "@/lib/eval";
import { checkRateLimit } from "@/lib/rate-limit";
import { CaseError, runCase, type CaseRequest } from "@/lib/run-case";

export const runtime = "nodejs";
export const maxDuration = 120;

const MAX_FIELD_LENGTH = 4000;

export async function POST(req: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json({ error: "ANTHROPIC_API_KEY is not configured." }, { status: 500 });
  }

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (!checkRateLimit(ip)) {
    return Response.json({ error: "Daily demo budget reached for your IP." }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const parsed = parseRequest(body);
  if ("error" in parsed) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }

  // The SDK's own retries (2 by default) stay on here; the v2 worker turns
  // them off and uses lib/retry.ts instead.
  try {
    const { result } = await runCase(new Anthropic(), parsed);
    return Response.json(result);
  } catch (err) {
    // Upstream failures become JSON errors so the client can show them on the
    // cell instead of choking on an empty 500 body.
    if (err instanceof CaseError && err.kind === "refusal") {
      return Response.json({ error: err.message }, { status: 422 });
    }
    console.error("[run-case]", err);
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 502 });
  }
}

// Validate the untrusted body field by field: a wrong type would otherwise
// slip past the length checks, and an unknown grader would silently fall
// through to the (paid) judge.
function parseRequest(body: unknown): CaseRequest | { error: string } {
  if (typeof body !== "object" || body === null) return { error: "Invalid JSON body." };
  const { model, system = "", input, expected, grader } = body as Record<string, unknown>;
  if (typeof model !== "string" || !MODELS.includes(model)) {
    return { error: `Unknown model: ${String(model)}` };
  }
  if (grader !== "exact" && grader !== "judge") {
    return { error: 'grader must be "exact" or "judge".' };
  }
  if (
    typeof input !== "string" ||
    typeof expected !== "string" ||
    typeof system !== "string" ||
    !input ||
    input.length > MAX_FIELD_LENGTH ||
    expected.length > MAX_FIELD_LENGTH ||
    system.length > MAX_FIELD_LENGTH
  ) {
    return { error: "Input/expected/system missing or too long." };
  }
  return { model, system, input, expected, grader };
}
