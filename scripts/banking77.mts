// Builds a Banking77 run as a POST /api/runs body, printed to stdout:
//
//   node scripts/banking77.mts [--cases 250] [--seed 77] [--models a,b] > run.json
//
// Banking77 (PolyAI/banking77 on Hugging Face, CC BY 4.0) is 13k customer
// messages to a bank, each labeled with one of 77 intents. The cases come from
// its test split and are fetched each time rather than stored in the repo; a
// fixed seed picks the same ones on every machine. Graded by exact match on
// the intent name. More than 20 cases needs the admin token. The server
// checks the body (models, lengths) like any other request.
import { parseArgs } from "node:util";

const ROWS_URL = "https://datasets-server.huggingface.co/rows";
const PAGE = 100; // the rows API's maximum

const { values } = parseArgs({
  options: {
    cases: { type: "string", default: "250" },
    seed: { type: "string", default: "77" },
    models: { type: "string", default: "claude-haiku-5-5,claude-sonnet-5-5,claude-opus-5-5" },
  },
});
const n = Number(values.cases);
const seed = Number(values.seed);
const models = values.models.split(",");

interface Split {
  labels: string[];
  rows: { text: string; label: number }[];
}

async function fetchTestSplit(): Promise<Split> {
  const split: Split = { labels: [], rows: [] };
  for (let offset = 0, total = Infinity; offset < total; offset += PAGE) {
    const url = `${ROWS_URL}?dataset=PolyAI/banking77&config=default&split=test&offset=${offset}&length=${PAGE}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Hugging Face answered ${res.status} for offset ${offset}.`);
    const page = await res.json();
    split.labels = page.features.find((f: { name: string }) => f.name === "label").type.names;
    split.rows.push(...page.rows.map((r: { row: Split["rows"][number] }) => r.row));
    total = page.num_rows_total;
  }
  return split;
}

// mulberry32: a tiny seeded generator, so the sample doesn't depend on
// Math.random or the machine.
function seeded(s: number): () => number {
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const { labels, rows } = await fetchTestSplit();
if (!(n > 0 && n <= rows.length)) throw new Error(`--cases must be 1-${rows.length}.`);

// Fisher-Yates over the whole split, then the first n. The split is sorted by
// intent, so taking rows in order would cover only a few intents.
const random = seeded(seed);
const order = rows.map((_, i) => i);
for (let i = order.length - 1; i > 0; i--) {
  const j = Math.floor(random() * (i + 1));
  [order[i], order[j]] = [order[j], order[i]];
}
const cases = order.slice(0, n).map((i) => ({ input: rows[i].text.trim(), expected: labels[rows[i].label] }));

const system = [
  "Classify the customer's message to a bank into exactly one of the intents below.",
  "Reply with the intent name only, exactly as written, and nothing else.",
  "",
  ...labels,
].join("\n");

process.stdout.write(
  JSON.stringify({
    name: `Banking77 test sample (${n} cases, seed ${seed})`,
    source: "custom",
    grader: "exact",
    cases,
    models,
    prompts: [{ system }],
  }),
);
const intents = new Set(cases.map((c) => c.expected)).size;
console.error(`${n} of ${rows.length} test messages, ${intents} of ${labels.length} intents, models: ${models.join(", ")}`);
