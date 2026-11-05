import type { EvalCase } from "./eval";

// ---------------------------------------------------------------------------
// CSV datasets. Parsed in the browser, so the server only ever sees the same
// { input, expected } list as any other launch.
// ---------------------------------------------------------------------------

// RFC 4180: comma-separated, a quoted field may hold commas, line breaks and
// "" for a quote. CRLF and LF both end a row. Null when a quote is never
// closed, since everything after it would land in one field.
export function parseCsv(text: string): string[][] | null {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const endField = () => {
    row.push(field);
    field = "";
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') {
        field += ch;
      } else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        quoted = false;
      }
    } else if (ch === '"' && field === "") {
      quoted = true;
    } else if (ch === ",") {
      endField();
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endField();
      rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (quoted) return null;
  if (field !== "" || row.length > 0) {
    endField();
    rows.push(row);
  }
  return rows;
}

const INPUT_HEADERS = ["input", "question", "prompt", "text", "query", "instruction", "input_text"];
const EXPECTED_HEADERS = [
  "expected", "answer", "label", "output", "target",
  "expected_output", "expected_answer", "ground_truth", "reference", "correct_answer", "gold",
];

// Cases from a CSV file. A first row that names an input column or an
// expected column (see the lists above, any case) is a header. It picks the
// named columns; when it names only one, the other is its neighbor (the input
// comes before the expected answer when it can). Without a header, the first
// two columns are used. Rows with an empty input or expected answer are
// skipped, as in the pasted format. `total` counts every usable row, so the
// page can say how many were left out by `max`.
export function parseCsvCases(text: string, max: number): { cases: EvalCase[]; total: number } | { error: string } {
  const rows = parseCsv(text.replace(/^﻿/, ""));
  if (!rows) return { error: "A quoted field is never closed." };

  const header = (rows[0] ?? []).map((h) => h.trim().toLowerCase());
  let i = header.findIndex((h) => INPUT_HEADERS.includes(h));
  let e = header.findIndex((h) => EXPECTED_HEADERS.includes(h));
  const hasHeader = i !== -1 || e !== -1;
  if (!hasHeader) [i, e] = [0, 1];
  else if (e === -1) e = i + 1 < header.length ? i + 1 : i - 1;
  else if (i === -1) i = e > 0 ? e - 1 : e + 1;

  const all = rows
    .slice(hasHeader ? 1 : 0)
    .map((r) => ({ input: (r[i] ?? "").trim(), expected: (r[e] ?? "").trim() }))
    .filter((c) => c.input && c.expected);
  if (all.length === 0) return { error: "No rows with both an input and an expected answer." };
  return { cases: all.slice(0, max), total: all.length };
}
