// ---------------------------------------------------------------------------
// EvalBoard core types + reference data
//
// An "eval" here is: a dataset of cases (input + expected), run against one or
// more models under a system prompt, each output scored by a grader — either
// exact string match or an LLM judge with a structured verdict.
// ---------------------------------------------------------------------------

export interface EvalCase {
  input: string;
  expected: string;
}

export type GraderKind = "exact" | "judge";

export interface CaseResult {
  output: string;
  pass: boolean;
  reasoning: string; // judge's explanation ("" for exact match)
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  model_used: string; // may differ from requested if fallback kicked in
}

// $ per million tokens (input, output)
export const PRICES: Record<string, { in: number; out: number }> = {
  "claude-opus-4-8": { in: 5, out: 25 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-haiku-4-5": { in: 1, out: 5 },
};

export const MODELS = Object.keys(PRICES);

export function cost(model: string, inTok: number, outTok: number): number {
  const p = PRICES[model] ?? PRICES["claude-opus-4-8"];
  return (inTok * p.in + outTok * p.out) / 1_000_000;
}

// Exact-match grading, normalized for case, surrounding whitespace, and
// trailing punctuation: "Billing." and "billing" are the same answer.
export function normalizeAnswer(s: string): string {
  return s.trim().toLowerCase().replace(/[.!?]+$/, "").trimEnd();
}

export function exactMatch(output: string, expected: string): boolean {
  return normalizeAnswer(output) === normalizeAnswer(expected);
}

export interface SampleDataset {
  name: string;
  description: string;
  system: string;
  grader: GraderKind;
  cases: EvalCase[];
}

export const SAMPLES: SampleDataset[] = [
  {
    name: "Support ticket triage",
    description: "Classify tickets into billing / bug / feature_request / account. Exact match.",
    system:
      "Classify the support ticket into exactly one category. Reply with only one word: billing, bug, feature_request, or account.",
    grader: "exact",
    cases: [
      { input: "I was charged twice this month, please refund one payment.", expected: "billing" },
      { input: "The export button crashes the app every time I click it.", expected: "bug" },
      { input: "It would be great if dark mode were available on mobile.", expected: "feature_request" },
      { input: "I can't log in after changing my email address.", expected: "account" },
      { input: "My invoice shows the old pricing plan but I upgraded last week.", expected: "billing" },
      { input: "Search results are empty even though I know matching records exist.", expected: "bug" },
      { input: "Can you add CSV import? We migrate data from spreadsheets weekly.", expected: "feature_request" },
      { input: "Please delete my account and all associated data permanently.", expected: "account" },
    ],
  },
  {
    name: "Meeting-note action items",
    description: "Extract the single most important action item. LLM judge scores semantic match.",
    system:
      "Extract the single most important action item from the meeting note. Reply with one short imperative sentence.",
    grader: "judge",
    cases: [
      {
        input:
          "Team sync: Q3 numbers look fine. Sarah flagged that the vendor contract expires Friday and nobody has started the renewal. Also discussed the offsite location.",
        expected: "Start the vendor contract renewal before Friday.",
      },
      {
        input:
          "Standup: deploy went out clean. Mike mentioned the staging database is at 95% disk and will fill up within days. Lunch order forms due.",
        expected: "Free up or expand staging database disk space.",
      },
      {
        input:
          "Design review: mockups approved with minor color tweaks. Legal needs the new privacy policy live before the EU launch on the 15th.",
        expected: "Publish the new privacy policy before the EU launch on the 15th.",
      },
      {
        input:
          "1:1 notes: discussed career goals. Manager to intro Dana to the platform team lead this week re: transfer.",
        expected: "Manager introduces Dana to the platform team lead this week.",
      },
      {
        input:
          "Incident retro: root cause was the expired TLS cert. Action: add certificate expiry monitoring so this never repeats. Postmortem doc shared.",
        expected: "Add certificate expiry monitoring.",
      },
    ],
  },
];
