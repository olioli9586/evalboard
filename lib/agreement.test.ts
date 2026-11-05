import { describe, expect, it } from "vitest";
import { judgeAgreement } from "./agreement";

// n results with the given judge verdict and hand label.
const rows = (n: number, pass: boolean | null, humanPass: boolean | null) =>
  Array.from({ length: n }, () => ({ pass, humanPass }));

describe("judgeAgreement", () => {
  it("matches Cohen's kappa on the standard worked example", () => {
    // 50 items: 20 yes/yes, 5 yes/no, 10 no/yes, 15 no/no. Observed 0.7,
    // chance 0.5, kappa 0.4.
    const a = judgeAgreement([...rows(20, true, true), ...rows(5, true, false), ...rows(10, false, true), ...rows(15, false, false)]);
    expect(a).toMatchObject({ labeled: 50, agreed: 35, bothPass: 20, bothFail: 15, judgeOnlyPass: 5, humanOnlyPass: 10 });
    expect(a!.kappa).toBeCloseTo(0.4, 10);
    // SE = sqrt(0.7 * 0.3 / 50) / 0.5 = 0.1296
    expect(a!.ci95![0]).toBeCloseTo(0.4 - 1.96 * 0.129615, 4);
    expect(a!.ci95![1]).toBeCloseTo(0.4 + 1.96 * 0.129615, 4);
  });

  it("only counts graded results that have a hand label", () => {
    const a = judgeAgreement([...rows(3, true, true), ...rows(2, false, false), ...rows(4, true, null), ...rows(2, null, true)]);
    expect(a).toMatchObject({ labeled: 5, agreed: 5 });
    expect(judgeAgreement(rows(4, true, null))).toBeNull();
    expect(judgeAgreement([])).toBeNull();
  });

  it("gives kappa 1 for full agreement on both verdicts", () => {
    const a = judgeAgreement([...rows(8, true, true), ...rows(2, false, false)]);
    expect(a!.kappa).toBe(1);
    expect(a!.ci95).toEqual([1, 1]);
  });

  it("gives kappa below 0 when the raters agree less than chance", () => {
    const a = judgeAgreement([...rows(5, true, false), ...rows(5, false, true)]);
    expect(a!.kappa).toBe(-1);
    expect(a!.ci95![0]).toBe(-1);
  });

  it("has no kappa when both raters passed every case", () => {
    expect(judgeAgreement(rows(6, true, true))).toMatchObject({ agreed: 6, kappa: null, ci95: null });
  });
});
