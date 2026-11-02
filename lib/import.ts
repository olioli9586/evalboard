import { MODELS, SAMPLES, type EvalCase, type GraderKind } from "./eval";
import { isUuid } from "./store";

// ---------------------------------------------------------------------------
// The one-time import of v1 history. v1 kept each run in localStorage as a
// summary: per-model pass/fail per case, the case inputs (as caseKey), and no
// outputs or expected answers. This validates that untrusted summary and
// turns it into datasets and runs the server can store.
// ---------------------------------------------------------------------------

export const MAX_IMPORT_RUNS = 20; // v1 kept at most 20 runs
const MAX_CASES = 20; // v1's per-run case cap
const MAX_FIELD_LENGTH = 4000;
// Total text per import, so one request can't store megabytes.
const MAX_IMPORT_CHARS = 100_000;

export interface LegacyImport {
  legacyId: string; // the v1 run's id, kept as runs.imported_from
  at: Date;
  datasetName: string;
  source: "sample" | "import";
  cases: EvalCase[];
  grader: GraderKind;
  system: string;
  models: { model: string; passes: (boolean | null)[] }[];
}

// Invalid entries are skipped rather than failing the whole import: one odd
// entry (an older v1 format, a hand edit) shouldn't strand the rest.
export function parseImport(
  body: unknown,
  now = new Date(),
): { runs: LegacyImport[]; skipped: number } | { error: string } {
  const list = typeof body === "object" && body !== null ? (body as { runs?: unknown }).runs : undefined;
  if (!Array.isArray(list)) return { error: "runs must be a list." };
  if (list.length > MAX_IMPORT_RUNS) return { error: `At most ${MAX_IMPORT_RUNS} runs per import.` };

  const runs: LegacyImport[] = [];
  const seen = new Set<string>();
  let chars = 0;
  for (const entry of list) {
    const run = parseEntry(entry, now);
    if (!run || seen.has(run.legacyId)) continue;
    seen.add(run.legacyId);
    chars += run.system.length + run.cases.reduce((n, c) => n + c.input.length, 0);
    runs.push(run);
  }
  if (chars > MAX_IMPORT_CHARS) return { error: "This history is too large to import." };
  return { runs, skipped: list.length - runs.length };
}

function parseEntry(entry: unknown, now: Date): LegacyImport | null {
  if (typeof entry !== "object" || entry === null) return null;
  const { id, at, dataset, grader, system, caseKey, models } = entry as Record<string, unknown>;
  if (!isUuid(id) || (grader !== "exact" && grader !== "judge")) return null;
  if (typeof system !== "string" || system.length > MAX_FIELD_LENGTH) return null;
  const time = typeof at === "string" ? new Date(at) : null;
  if (!time || Number.isNaN(time.getTime())) return null;

  let inputs: unknown;
  try {
    inputs = typeof caseKey === "string" ? JSON.parse(caseKey) : null;
  } catch {
    return null;
  }
  if (
    !Array.isArray(inputs) ||
    inputs.length === 0 ||
    inputs.length > MAX_CASES ||
    !inputs.every((s) => typeof s === "string" && s.length > 0 && s.length <= MAX_FIELD_LENGTH)
  ) {
    return null;
  }

  if (typeof models !== "object" || models === null || Array.isArray(models)) return null;
  const parsedModels: LegacyImport["models"] = [];
  for (const [model, result] of Object.entries(models)) {
    const passes = (result as { passes?: unknown } | null)?.passes;
    if (
      !MODELS.includes(model) ||
      !Array.isArray(passes) ||
      passes.length !== inputs.length ||
      !passes.every((p) => p === true || p === false || p === null)
    ) {
      return null;
    }
    parsedModels.push({ model, passes });
  }
  if (parsedModels.length === 0) return null;

  // A built-in sample is recognized by its exact inputs, which brings back
  // the expected answers v1 didn't save. The cases then hash to the same
  // dataset as new runs of that sample, so old and new runs can be diffed.
  const sample = SAMPLES.find(
    (s) => s.cases.length === inputs.length && s.cases.every((c, i) => c.input === inputs[i]),
  );
  const name = typeof dataset === "string" && dataset.trim() ? dataset.trim().slice(0, 200) : "Imported run";
  return {
    legacyId: id,
    at: time > now ? now : time,
    datasetName: sample?.name ?? name,
    source: sample ? "sample" : "import",
    cases: sample?.cases ?? inputs.map((input: string) => ({ input, expected: "" })),
    grader,
    system,
    models: parsedModels,
  };
}
