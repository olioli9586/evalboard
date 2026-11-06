// Builds a TruthfulQA run as a POST /api/runs body, printed to stdout:
//
//   node scripts/truthfulqa.mts [--cases 50] [--seed 1] [--models a,b] [--effort high] > run.json
//
// TruthfulQA (truthfulqa/truthful_qa on Hugging Face, Apache 2.0) is 817
// questions written so that a popular misconception sounds like the answer,
// each with a reference answer. Free-text answers are graded by the LLM judge
// against that reference, which makes it a fair test of the judge: whether an
// answer that differs from the reference is still acceptable takes judgment.
// This is the run to hand-label for the judge's kappa. The cases are fetched
// each time rather than stored in the repo; a fixed seed picks the same ones
// on every machine. More than 20 cases needs the admin token.
import { parseArgs } from "node:util";

const ROWS_URL = "https://datasets-server.huggingface.co/rows";
const PAGE = 100; // the rows API's maximum

const { values } = parseArgs({
  options: {
    cases: { type: "string", default: "50" },
    seed: { type: "string", default: "1" },
    models: { type: "string", default: "claude-haiku-5-5" },
    effort: { type: "string" }, // unset: each model's default
  },
});
const n = Number(values.cases);
const seed = Number(values.seed);
const models = values.models.split(",");

interface Row {
  category: string;
  question: string;
  best_answer: string;
}

async function fetchQuestions(): Promise<Row[]> {
  const rows: Row[] = [];
  for (let offset = 0, total = Infinity; offset < total; offset += PAGE) {
    const url = `${ROWS_URL}?dataset=truthfulqa/truthful_qa&config=generation&split=validation&offset=${offset}&length=${PAGE}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Hugging Face answered ${res.status} for offset ${offset}.`);
    const page = await res.json();
    rows.push(...page.rows.map((r: { row: Row }) => r.row));
    total = page.num_rows_total;
  }
  return rows;
}

// mulberry32, as in banking77.mts: the sample doesn't depend on Math.random.
function seeded(s: number): () => number {
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rows = await fetchQuestions();
if (!(n > 0 && n <= rows.length)) throw new Error(`--cases must be 1-${rows.length}.`);

// Fisher-Yates over all questions, then the first n. The file is grouped by
// category, so taking rows in order would cover only a few.
const random = seeded(seed);
const order = rows.map((_, i) => i);
for (let i = order.length - 1; i > 0; i--) {
  const j = Math.floor(random() * (i + 1));
  [order[i], order[j]] = [order[j], order[i]];
}
const picked = order.slice(0, n).map((i) => rows[i]);

process.stdout.write(
  JSON.stringify({
    name: `TruthfulQA sample (${n} questions, seed ${seed})`,
    source: "custom",
    grader: "judge",
    cases: picked.map((r) => ({ input: r.question.trim(), expected: r.best_answer.trim() })),
    models,
    prompts: [{ system: "Answer the question in one or two sentences." }],
    ...(values.effort && { effort: values.effort }),
  }),
);
const categories = new Set(picked.map((r) => r.category)).size;
console.error(`${n} of ${rows.length} questions, ${categories} categories, models: ${models.join(", ")}`);
