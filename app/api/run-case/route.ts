import Anthropic from "@anthropic-ai/sdk";
import { NextRequest } from "next/server";
import { cost, MODELS, type CaseResult, type GraderKind } from "@/lib/eval";
import { checkRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 120;

const FALLBACK_MODEL = "claude-opus-4-8";
const MAX_FIELD_LENGTH = 4000;
const JUDGE_MODEL = process.env.EVALBOARD_JUDGE_MODEL ?? "claude-opus-4-8";

interface RunCaseRequest {
  model: string;
  system: string;
  input: string;
  expected: string;
  grader: GraderKind;
}

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
  const { model, system, input, expected, grader } = parsed;

  const client = new Anthropic();

  // --- 1. Run the case on the target model (fallback to Opus 4.8 on 404) ---
  // Upstream failures become JSON errors so the client can show them on the
  // cell instead of choking on an empty 500 body.
  let modelUsed = model;
  const started = Date.now();
  let response: Anthropic.Message;
  try {
    try {
      response = await createCompletion(client, model, system, input);
    } catch (err) {
      if (!(err instanceof Anthropic.NotFoundError) || model === FALLBACK_MODEL) throw err;
      modelUsed = FALLBACK_MODEL;
      response = await createCompletion(client, FALLBACK_MODEL, system, input);
    }
  } catch (err) {
    return upstreamError("Model call failed", err);
  }
  const latency_ms = Date.now() - started;

  if (response.stop_reason === "refusal") {
    return Response.json({ error: "The model declined this case." }, { status: 422 });
  }
  const output = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  const input_tokens = response.usage.input_tokens;
  const output_tokens = response.usage.output_tokens;
  let cost_usd = cost(modelUsed, input_tokens, output_tokens);

  // --- 2. Grade ---
  let pass: boolean;
  let reasoning = "";
  if (grader === "exact") {
    pass = normalize(output) === normalize(expected);
  } else {
    let verdict: Awaited<ReturnType<typeof judge>>;
    try {
      verdict = await judge(client, { system, input, expected, output });
    } catch (err) {
      return upstreamError("Grading failed", err);
    }
    pass = verdict.pass;
    reasoning = verdict.reasoning;
    cost_usd += verdict.cost_usd;
  }

  const result: CaseResult = {
    output,
    pass,
    reasoning,
    latency_ms,
    input_tokens,
    output_tokens,
    cost_usd,
    model_used: modelUsed,
  };
  return Response.json(result);
}

// Validate the untrusted body field by field: a wrong type would otherwise
// slip past the length checks, and an unknown grader would silently fall
// through to the (paid) judge.
function parseRequest(body: unknown): RunCaseRequest | { error: string } {
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

function upstreamError(what: string, err: unknown): Response {
  console.error(`[run-case] ${what}:`, err);
  const detail = err instanceof Error ? err.message : String(err);
  return Response.json({ error: `${what}: ${detail}` }, { status: 502 });
}

function createCompletion(
  client: Anthropic,
  model: string,
  system: string,
  input: string,
): Promise<Anthropic.Message> {
  return client.messages.create({
    model,
    max_tokens: 1024,
    system: system || undefined,
    messages: [{ role: "user", content: input }],
  });
}

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/[.!]$/, "");
}

// LLM-as-judge: structured verdict via a strict JSON schema, so the grade
// always parses. The judge sees the task (system prompt), input, expected
// answer, and the model's output — and rules on semantic equivalence.
async function judge(
  client: Anthropic,
  args: { system: string; input: string; expected: string; output: string },
): Promise<{ pass: boolean; reasoning: string; cost_usd: number }> {
  const response = await client.messages.create({
    model: JUDGE_MODEL,
    max_tokens: 1024,
    system:
      "You are a strict but fair evaluation judge. Decide whether a model's output is an acceptable answer, using the expected answer as the reference. Semantic equivalence passes; missing the core point, wrong facts, or ignoring the task instructions fail.",
    messages: [
      {
        role: "user",
        content: `<task_instructions>\n${args.system}\n</task_instructions>\n\n<input>\n${args.input}\n</input>\n\n<expected_answer>\n${args.expected}\n</expected_answer>\n\n<model_output>\n${args.output}\n</model_output>\n\nJudge the model output.`,
      },
    ],
    output_config: {
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: {
            reasoning: { type: "string", description: "One or two sentences explaining the verdict" },
            pass: { type: "boolean" },
          },
          required: ["reasoning", "pass"],
          additionalProperties: false,
        },
      },
    },
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  // A refusal or max_tokens stop can leave the verdict empty or truncated.
  let verdict: { pass: boolean; reasoning: string };
  try {
    verdict = JSON.parse(text);
  } catch {
    throw new Error(`The judge returned an unreadable verdict (stop reason: ${response.stop_reason}).`);
  }
  if (typeof verdict?.pass !== "boolean") {
    throw new Error("The judge's verdict had no pass/fail value.");
  }
  return {
    pass: verdict.pass,
    reasoning: verdict.reasoning,
    cost_usd: cost(JUDGE_MODEL, response.usage.input_tokens, response.usage.output_tokens),
  };
}
