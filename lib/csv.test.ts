import { describe, expect, it } from "vitest";
import { parseCsv, parseCsvCases } from "./csv";

describe("parseCsv", () => {
  it("splits rows and fields, with CRLF or LF", () => {
    expect(parseCsv("a,b\r\nc,d\ne,f")).toEqual([
      ["a", "b"],
      ["c", "d"],
      ["e", "f"],
    ]);
  });

  it("keeps commas, line breaks and doubled quotes inside quoted fields", () => {
    expect(parseCsv('"Hi, there","He said ""no""\nthen left"\n')).toEqual([["Hi, there", 'He said "no"\nthen left']]);
  });

  it("keeps empty fields and a trailing empty field", () => {
    expect(parseCsv("a,,c\nd,e,")).toEqual([
      ["a", "", "c"],
      ["d", "e", ""],
    ]);
  });

  it("refuses a quote that is never closed", () => {
    expect(parseCsv('a,"b\nc,d')).toBeNull();
  });
});

describe("parseCsvCases", () => {
  it("picks the columns a header names, in any order and case", () => {
    const r = parseCsvCases("id,Expected,Input\n1,billing,I was charged twice\n2,bug,Export crashes", 20);
    expect(r).toEqual({
      cases: [
        { input: "I was charged twice", expected: "billing" },
        { input: "Export crashes", expected: "bug" },
      ],
      total: 2,
    });
  });

  it("knows common header names", () => {
    expect(parseCsvCases("question,answer\nWhat is 2+2?,4", 20)).toEqual({
      cases: [{ input: "What is 2+2?", expected: "4" }],
      total: 1,
    });
  });

  it("reads a header that names only one column, taking its neighbor for the other", () => {
    const one = (csv: string) => parseCsvCases(csv, 20);
    expect(one("prompt,completion\nHi,Hello")).toEqual({ cases: [{ input: "Hi", expected: "Hello" }], total: 1 });
    expect(one("sentence,label\nGreat film,positive")).toEqual({ cases: [{ input: "Great film", expected: "positive" }], total: 1 });
    expect(one("label,sentence\npositive,Great film")).toEqual({ cases: [{ input: "Great film", expected: "positive" }], total: 1 });
    expect(one("id,question,ground_truth\n1,What is 2+2?,4")).toEqual({ cases: [{ input: "What is 2+2?", expected: "4" }], total: 1 });
  });

  it("uses the first two columns when there is no header", () => {
    expect(parseCsvCases("charged twice,billing\ncrashes,bug", 20)).toMatchObject({ total: 2 });
  });

  it("strips a byte-order mark before reading the header", () => {
    expect(parseCsvCases("﻿input,expected\na,b", 20)).toEqual({ cases: [{ input: "a", expected: "b" }], total: 1 });
  });

  it("skips rows missing either side and counts what the cap left out", () => {
    const r = parseCsvCases("input,expected\na,1\n,2\nb,\n\nc,3\nd,4", 2);
    expect(r).toEqual({
      cases: [
        { input: "a", expected: "1" },
        { input: "c", expected: "3" },
      ],
      total: 3,
    });
  });

  it("explains a file it can't use", () => {
    expect(parseCsvCases("just one column\nper row", 20)).toEqual({ error: "No rows with both an input and an expected answer." });
    expect(parseCsvCases('input,expected\n"never closed,x', 20)).toEqual({ error: "A quoted field is never closed." });
    expect(parseCsvCases("", 20)).toEqual({ error: "No rows with both an input and an expected answer." });
  });
});
