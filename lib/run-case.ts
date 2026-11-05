import Anthropic, { NotFoundError } from "@anthropic-ai/sdk";
import { cost, exactMatch, type CaseResult, type Effort, type GraderKind } from "./eval";
import { isRetryable, NO_RETRY, retryAfterMs, withRetry, type RetryOptions } from "./retry";

// ---------------------------------------------------------------------------
// Run one case: call the target model, then grade the output. The queue
// worker calls it once per case.
// ---------------------------------------------------------------------------

export const FALLBACK_MODEL = "claude-opus-5-5";
const JUDGE_MODEL = process.env.EVALBOARD_JUDGE_MODEL ?? "claude-opus-5-5";

// The 5.5 models think by default (adaptive, at each model's default effort),
// and thinking counts toward max_tokens. 4,096 leaves room for it and still
// bounds what one case can cost.
const MAX_TOKENS = 4096;

export interface CaseRequest {
  model: string;
  system: string;
  input: string;
  expected: string;
  grader: GraderKind;
  effort?: Effort | null; // unset: the model's default
}

// Why a case could not be scored. Retryable causes (429, 5xx, a dropped
// connection) may work later; the rest (a refusal, a 400, a timeout, an
// unreadable verdict) would fail the same way again, so the worker records the
// case as errored and moves on. costUsd is what the calls that did answer cost
// before the failure, so an errored case still counts toward the spend cap.
export class CaseError extends Error {
  readonly costUsd: number;

  constructor(
    message: string,
    readonly kind: "model" | "judge" | "refusal",
    readonly attempts: number,
    options?: { cause?: unknown; costUsd?: number },
  ) {
    super(message, options);
    this.name = "CaseError";
    this.costUsd = options?.costUsd ?? 0;
  }

  get retryable(): boolean {
    return isRetryable(this.cause);
  }

  get retryAfterMs(): number | undefined {
    return retryAfterMs(this.cause);
  }
}

export async function runCase(
  client: Anthropic,
  req: CaseRequest,
  retry: RetryOptions = NO_RETRY,
): Promise<{ result: CaseResult; attempts: number }> {
  const tally = { attempts: 0 };
  const call = <T>(fn: () => Promise<T>) => withRetry(fn, retry, tally);

  // --- 1. Run the case on the target model (fallback to Opus 5.5 on 404) ---
  // Latency is the successful call alone: counting backoff waits would make a
  // rate-limited model look slow.
  let modelUsed = req.model;
  let latency_ms = 0;
  const complete = async (model: string) => {
    const started = Date.now();
    const response = await createCompletion(client, model, req.system, req.input, req.effort);
    latency_ms = Date.now() - started;
    return response;
  };
  let response: Anthropic.Message;
  try {
    try {
      response = await call(() => complete(req.model));
    } catch (err) {
      if (!(err instanceof NotFoundError) || req.model === FALLBACK_MODEL) throw err;
      modelUsed = FALLBACK_MODEL;
      response = await call(() => complete(FALLBACK_MODEL));
    }
  } catch (err) {
    throw new CaseError(`Model call failed: ${detail(err)}`, "model", tally.attempts, { cause: err });
  }

  const input_tokens = response.usage.input_tokens;
  const output_tokens = response.usage.output_tokens;
  let cost_usd = cost(modelUsed, input_tokens, output_tokens);

  if (response.stop_reason === "refusal") {
    throw new CaseError("The model declined this case.", "refusal", tally.attempts, { costUsd: cost_usd });
  }
  const output = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  // Thinking counts toward max_tokens, so a long think can leave no answer.
  // That says nothing about whether the model knew the answer: an error, not
  // a fail.
  if (!output && response.stop_reason === "max_tokens") {
    throw new CaseError(`The model used all ${MAX_TOKENS} tokens without answering.`, "model", tally.attempts, {
      costUsd: cost_usd,
    });
  }

  // --- 2. Grade ---
  let pass: boolean;
  let reasoning = "";
  if (req.grader === "exact") {
    pass = exactMatch(output, req.expected);
  } else {
    let verdict: Awaited<ReturnType<typeof judge>>;
    try {
      verdict = await judge(client, { ...req, output }, call);
    } catch (err) {
      throw new CaseError(`Grading failed: ${detail(err)}`, "judge", tally.attempts, {
        cause: err,
        costUsd: cost_usd + (err instanceof VerdictError ? err.costUsd : 0),
      });
    }
    pass = verdict.pass;
    reasoning = verdict.reasoning;
    cost_usd += verdict.cost_usd;
  }

  return {
    result: {
      output,
      pass,
      reasoning,
      latency_ms,
      input_tokens,
      output_tokens,
      cost_usd,
      model_used: modelUsed,
    },
    attempts: tally.attempts,
  };
}

function detail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function createCompletion(
  client: Anthropic,
  model: string,
  system: string,
  input: string,
  effort?: Effort | null,
): Promise<Anthropic.Message> {
  return client.messages.create({
    model,
    max_tokens: MAX_TOKENS,
    system: system || undefined,
    messages: [{ role: "user", content: input }],
    ...(effort && { output_config: { effort } }),
  });
}

// A judge call that answered, and was paid for, but gave no usable verdict.
class VerdictError extends Error {
  constructor(
    message: string,
    readonly costUsd: number,
  ) {
    super(message);
    this.name = "VerdictError";
  }
}

// LLM-as-judge: structured verdict via a strict JSON schema, so the grade
// always parses. The judge sees the task (system prompt), input, expected
// answer, and the model's output — and rules on semantic equivalence. Only the
// API call is retried; an unreadable verdict is not a transient failure.
async function judge(
  client: Anthropic,
  args: { system: string; input: string; expected: string; output: string },
  call: <T>(fn: () => Promise<T>) => Promise<T>,
): Promise<{ pass: boolean; reasoning: string; cost_usd: number }> {
  const response = await call(() =>
    client.messages.create({
      model: JUDGE_MODEL,
      max_tokens: MAX_TOKENS,
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
    }),
  );

  const cost_usd = cost(JUDGE_MODEL, response.usage.input_tokens, response.usage.output_tokens);
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  // A refusal or max_tokens stop can leave the verdict empty or truncated.
  let verdict: { pass: boolean; reasoning: string };
  try {
    verdict = JSON.parse(text);
  } catch {
    throw new VerdictError(`The judge returned an unreadable verdict (stop reason: ${response.stop_reason}).`, cost_usd);
  }
  if (typeof verdict?.pass !== "boolean") {
    throw new VerdictError("The judge's verdict had no pass/fail value.", cost_usd);
  }
  return { pass: verdict.pass, reasoning: verdict.reasoning, cost_usd };
}
