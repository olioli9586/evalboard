import Anthropic from "@anthropic-ai/sdk";
import { NextRequest } from "next/server";
import { cost, MODELS, type CaseResult, type GraderKind } from "@/lib/eval";
import { checkRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 120;

const FALLBACK_MODEL = "claude-opus-4-8";
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

  let body: RunCaseRequest;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { model, system, input, expected, grader } = body;
  if (!MODELS.includes(model)) {
    return Response.json({ error: `Unknown model: ${model}` }, { status: 400 });
  }
  if (!input || input.length > 4000 || (system?.length ?? 0) > 4000) {
    return Response.json({ error: "Input/system missing or too long." }, { status: 400 });
  }

  const client = new Anthropic();

  // --- 1. Run the case on the target model (fallback to Opus 4.8 on 404) ---
  let modelUsed = model;
  const started = Date.now();
  let response: Anthropic.Message;
  try {
    response = await createCompletion(client, model, system, input);
  } catch (err) {
    if (err instanceof Anthropic.NotFoundError && model !== FALLBACK_MODEL) {
      modelUsed = FALLBACK_MODEL;
      response = await createCompletion(client, FALLBACK_MODEL, system, input);
    } else {
      throw err;
    }
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
    const verdict = await judge(client, { system, input, expected, output });
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
  const verdict = JSON.parse(text) as { pass: boolean; reasoning: string };
  return {
    pass: verdict.pass,
    reasoning: verdict.reasoning,
    cost_usd: cost(JUDGE_MODEL, response.usage.input_tokens, response.usage.output_tokens),
  };
}
