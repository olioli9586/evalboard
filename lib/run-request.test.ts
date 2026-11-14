import { describe, expect, it } from "vitest";
import { parseCreateRuns } from "./run-request";

const base = {
  name: "Support ticket triage",
  source: "sample",
  grader: "exact",
  cases: [
    { input: "I was charged twice.", expected: "billing" },
    { input: "The export button crashes.", expected: "bug" },
  ],
  models: ["claude-haiku-4-5", "claude-sonnet-4-6"],
  prompts: [{ system: "Classify the ticket." }],
};

function error(body: unknown, maxCases = 20): string {
  const r = parseCreateRuns(body, maxCases);
  return "error" in r ? r.error : "";
}

describe("parseCreateRuns", () => {
  it("accepts a valid request and keeps only known fields", () => {
    const r = parseCreateRuns(
      {
        ...base,
        name: "  Triage  ",
        cases: [{ input: "a", expected: "b", extra: 1 }],
        prompts: [{ system: "A", label: "v1", junk: true }, { system: "B" }],
        unknown: "ignored",
      },
      20,
    );
    expect(r).toEqual({
      name: "Triage",
      source: "sample",
      grader: "exact",
      cases: [{ input: "a", expected: "b" }],
      models: ["claude-haiku-4-5", "claude-sonnet-4-6"],
      prompts: [
        { system: "A", label: "v1" },
        { system: "B", label: undefined },
      ],
      effort: null,
    });
  });

  it("allows an empty system prompt", () => {
    expect(error({ ...base, prompts: [{ system: "" }] })).toBe("");
  });

  it("rejects bodies that are not objects", () => {
    for (const body of [null, 42, "x", [base]]) expect(error(body)).toMatch(/Invalid JSON/);
  });

  it("rejects a bad name, source or grader", () => {
    expect(error({ ...base, name: "" })).toMatch(/name/);
    expect(error({ ...base, name: "x".repeat(201) })).toMatch(/name/);
    expect(error({ ...base, source: "import" })).toMatch(/source/);
    expect(error({ ...base, grader: "fuzzy" })).toMatch(/grader/);
    expect(error({ ...base, grader: undefined })).toMatch(/grader/);
  });

  it("enforces the case limit it is given", () => {
    const cases = Array.from({ length: 21 }, (_, i) => ({ input: `q${i}`, expected: "a" }));
    expect(error({ ...base, cases })).toMatch(/At most 20 cases/);
    expect(error({ ...base, cases }, 1000)).toBe("");
  });

  it("rejects empty, mistyped or oversized cases", () => {
    expect(error({ ...base, cases: [] })).toMatch(/non-empty/);
    expect(error({ ...base, cases: "a | b" })).toMatch(/non-empty/);
    for (const c of [
      null,
      { input: "", expected: "b" },
      { input: "a", expected: "  " },
      { input: 5, expected: "b" },
      { input: "a" },
      { input: "x".repeat(4001), expected: "b" },
      { input: "a", expected: "x".repeat(4001) },
    ]) {
      expect(error({ ...base, cases: [c] })).toMatch(/Each case/);
    }
  });

  it("rejects unknown, duplicate, missing or too many models", () => {
    expect(error({ ...base, models: ["gpt-4"] })).toMatch(/Unknown model/);
    expect(error({ ...base, models: [7] })).toMatch(/Unknown model/);
    expect(error({ ...base, models: ["claude-haiku-4-5", "claude-haiku-4-5"] })).toMatch(/only once/);
    expect(error({ ...base, models: [] })).toMatch(/1-3 models/);
    expect(error({ ...base, models: "claude-haiku-4-5" })).toMatch(/1-3 models/);
    const four = ["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-8", "claude-haiku-4-5"];
    expect(error({ ...base, models: four })).toMatch(/1-3 models/);
  });

  it("rejects bad prompt lists", () => {
    expect(error({ ...base, prompts: [] })).toMatch(/1-2 system prompts/);
    expect(error({ ...base, prompts: [{ system: "a" }, { system: "b" }, { system: "c" }] })).toMatch(/1-2/);
    expect(error({ ...base, prompts: [{ system: 3 }] })).toMatch(/system string/);
    expect(error({ ...base, prompts: [{}] })).toMatch(/system string/);
    expect(error({ ...base, prompts: [{ system: "x".repeat(4001) }] })).toMatch(/system string/);
    expect(error({ ...base, prompts: [{ system: "a", label: 1 }] })).toMatch(/labels/);
    expect(error({ ...base, prompts: [{ system: "a", label: "x".repeat(51) }] })).toMatch(/labels/);
  });

  it("takes one effort level for the launch, if every model accepts it", () => {
    const five = { ...base, models: ["claude-haiku-5-5", "claude-opus-5-5"] };
    expect(parseCreateRuns({ ...five, effort: "low" }, 20)).toMatchObject({ effort: "low" });
    expect(parseCreateRuns({ ...five, effort: null }, 20)).toMatchObject({ effort: null });
    expect(error({ ...five, effort: "extreme" })).toMatch(/effort must be one of low, medium, high, xhigh, max/);
    expect(error({ ...five, effort: 1 })).toMatch(/effort must be/);
    expect(error({ ...base, effort: "low" })).toMatch(/claude-haiku-4-5 doesn't take effort "low"/);
    expect(error({ ...five, models: ["claude-sonnet-4-6"], effort: "xhigh" })).toMatch(/claude-sonnet-4-6 doesn't take effort "xhigh"/);
    expect(parseCreateRuns({ ...five, models: ["claude-sonnet-4-6"], effort: "max" }, 20)).toMatchObject({ effort: "max" });
  });

  it("accepts a custom endpoint only when the server has it configured", () => {
    const configured = ["endpoint:tunebench-modernbert"];
    const withEndpoint = { ...base, models: ["claude-haiku-5-5", "endpoint:tunebench-modernbert"] };
    expect(parseCreateRuns(withEndpoint, 20, configured)).toMatchObject({
      models: ["claude-haiku-5-5", "endpoint:tunebench-modernbert"],
    });
    expect(error(withEndpoint)).toMatch(/Unknown model: endpoint:tunebench-modernbert/);
    const other = (m: string) => {
      const r = parseCreateRuns({ ...base, models: [m] }, 20, configured);
      return "error" in r ? r.error : "";
    };
    // A request names an endpoint; it can never bring its own URL.
    for (const m of ["endpoint:other", "endpoint:", "endpoint:https://evil.test/predict", "https://evil.test/predict"]) {
      expect(other(m)).toMatch(/Unknown model/);
    }
    expect(parseCreateRuns({ ...base, models: [...configured, ...configured] }, 20, configured)).toEqual({
      error: "Each model may appear only once.",
    });
  });

  it("takes no effort level for an endpoint model", () => {
    const r = parseCreateRuns({ ...base, models: ["endpoint:t"], effort: "low" }, 20, ["endpoint:t"]);
    expect(r).toEqual({ error: 'endpoint:t doesn\'t take effort "low".' });
    expect(parseCreateRuns({ ...base, models: ["endpoint:t"], effort: null }, 20, ["endpoint:t"])).toMatchObject({ effort: null });
  });
});
