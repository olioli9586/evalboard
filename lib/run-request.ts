import { EFFORTS, MODELS, supportsEffort, type Effort, type EvalCase, type GraderKind } from "./eval";

// ---------------------------------------------------------------------------
// Validation for POST /api/runs. One request launches one dataset against
// every model x prompt pair; each pair becomes its own run.
// ---------------------------------------------------------------------------

export const MAX_FIELD_LENGTH = 4000;
export const MAX_MODELS = 3;
export const MAX_PROMPTS = 2; // prompt A/B
const MAX_NAME_LENGTH = 200;
const MAX_LABEL_LENGTH = 50;

export interface CreateRunsRequest {
  name: string;
  source: "sample" | "custom" | "csv";
  grader: GraderKind;
  cases: EvalCase[];
  models: string[];
  prompts: { system: string; label?: string }[];
  effort: Effort | null; // one level for every run in the launch; null = each model's default
}

// Checked field by field: the body is untrusted, and a wrong type would
// otherwise slip past the length checks. endpointModels are the configured
// custom endpoints as `endpoint:<name>` (lib/endpoints.ts): a request picks
// one by name, and any other name is an unknown model.
export function parseCreateRuns(
  body: unknown,
  maxCases: number,
  endpointModels: string[] = [],
): CreateRunsRequest | { error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { error: "Invalid JSON body." };
  }
  const { name, source, grader, cases, models, prompts, effort } = body as Record<string, unknown>;

  if (typeof name !== "string" || !name.trim() || name.length > MAX_NAME_LENGTH) {
    return { error: `name must be 1-${MAX_NAME_LENGTH} characters.` };
  }
  if (source !== "sample" && source !== "custom" && source !== "csv") {
    return { error: 'source must be "sample", "custom" or "csv".' };
  }
  if (grader !== "exact" && grader !== "judge") {
    return { error: 'grader must be "exact" or "judge".' };
  }

  if (!Array.isArray(cases) || cases.length === 0) {
    return { error: "cases must be a non-empty array." };
  }
  if (cases.length > maxCases) {
    return { error: `At most ${maxCases} cases per run.` };
  }
  for (const c of cases) {
    const { input, expected } = (c ?? {}) as Record<string, unknown>;
    if (
      typeof input !== "string" ||
      typeof expected !== "string" ||
      !input.trim() ||
      !expected.trim() ||
      input.length > MAX_FIELD_LENGTH ||
      expected.length > MAX_FIELD_LENGTH
    ) {
      return { error: `Each case needs an input and an expected answer of 1-${MAX_FIELD_LENGTH} characters.` };
    }
  }

  if (!Array.isArray(models) || models.length === 0 || models.length > MAX_MODELS) {
    return { error: `models must list 1-${MAX_MODELS} models.` };
  }
  for (const m of models) {
    if (typeof m !== "string" || !(MODELS.includes(m) || endpointModels.includes(m))) {
      return { error: `Unknown model: ${String(m)}` };
    }
  }
  if (new Set(models).size !== models.length) {
    return { error: "Each model may appear only once." };
  }

  if (!Array.isArray(prompts) || prompts.length === 0 || prompts.length > MAX_PROMPTS) {
    return { error: `prompts must list 1-${MAX_PROMPTS} system prompts.` };
  }
  for (const p of prompts) {
    const { system, label } = (p ?? {}) as Record<string, unknown>;
    if (typeof system !== "string" || system.length > MAX_FIELD_LENGTH) {
      return { error: `Each prompt needs a system string of at most ${MAX_FIELD_LENGTH} characters.` };
    }
    if (label !== undefined && (typeof label !== "string" || label.length > MAX_LABEL_LENGTH)) {
      return { error: `Prompt labels are at most ${MAX_LABEL_LENGTH} characters.` };
    }
  }

  if (effort !== undefined && effort !== null) {
    if (!EFFORTS.includes(effort as Effort)) {
      return { error: `effort must be one of ${EFFORTS.join(", ")}.` };
    }
    const unsupported = (models as string[]).find((m) => !supportsEffort(m, effort as Effort));
    if (unsupported) return { error: `${unsupported} doesn't take effort "${effort}".` };
  }

  return {
    name: name.trim(),
    source,
    grader,
    // Copy only the known fields, so nothing extra reaches the database.
    cases: cases.map((c: EvalCase) => ({ input: c.input, expected: c.expected })),
    models: models as string[],
    prompts: prompts.map((p: { system: string; label?: string }) => ({ system: p.system, label: p.label })),
    effort: (effort as Effort | null | undefined) ?? null,
  };
}
