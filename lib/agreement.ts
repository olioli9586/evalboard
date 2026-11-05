import type { ResultRow } from "./store";

// How often the LLM judge agrees with a person's hand labels on the same
// results. Raw agreement flatters a judge when most cases pass (calling
// everything a pass would already agree often), so this also reports Cohen's
// kappa, which subtracts the agreement two raters would reach by chance.

export interface Agreement {
  labeled: number; // graded results with a hand label
  agreed: number;
  bothPass: number;
  bothFail: number;
  judgeOnlyPass: number; // the judge passed it, the person did not
  humanOnlyPass: number; // the person passed it, the judge did not
  // Null when chance agreement is 1: both raters gave every case the same
  // verdict, so there is nothing to tell apart.
  kappa: number | null;
  ci95: [number, number] | null;
}

export function judgeAgreement(results: Pick<ResultRow, "pass" | "humanPass">[]): Agreement | null {
  const pairs = results.filter((r) => r.pass !== null && r.humanPass !== null);
  const n = pairs.length;
  if (n === 0) return null;
  const count = (judge: boolean, human: boolean) =>
    pairs.filter((r) => r.pass === judge && r.humanPass === human).length;
  const bothPass = count(true, true);
  const bothFail = count(false, false);
  const judgeOnlyPass = count(true, false);
  const humanOnlyPass = count(false, true);

  const observed = (bothPass + bothFail) / n;
  const judgeRate = (bothPass + judgeOnlyPass) / n;
  const humanRate = (bothPass + humanOnlyPass) / n;
  const chance = judgeRate * humanRate + (1 - judgeRate) * (1 - humanRate);

  let kappa: number | null = null;
  let ci95: [number, number] | null = null;
  if (chance < 1) {
    kappa = (observed - chance) / (1 - chance);
    // Cohen's (1960) large-sample standard error. At 50 labels the interval
    // is wide, which is the point of showing it.
    const se = Math.sqrt((observed * (1 - observed)) / n) / (1 - chance);
    ci95 = [Math.max(-1, kappa - 1.96 * se), Math.min(1, kappa + 1.96 * se)];
  }
  return { labeled: n, agreed: bothPass + bothFail, bothPass, bothFail, judgeOnlyPass, humanOnlyPass, kappa, ci95 };
}
