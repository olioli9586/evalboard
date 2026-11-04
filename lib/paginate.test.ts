import { describe, expect, it } from "vitest";
import { paginate } from "./paginate";

const list = Array.from({ length: 250 }, (_, i) => i);

describe("paginate", () => {
  it("returns the requested page", () => {
    expect(paginate(list, "2", 100)).toMatchObject({ page: 2, pages: 3, start: 100 });
    expect(paginate(list, "2", 100).items).toEqual(list.slice(100, 200));
    expect(paginate(list, "3", 100).items).toHaveLength(50);
  });

  it("clamps out-of-range pages and reads junk as page 1", () => {
    expect(paginate(list, "99", 100).page).toBe(3);
    expect(paginate(list, "0", 100).page).toBe(1);
    expect(paginate(list, "-4", 100).page).toBe(1);
    expect(paginate(list, "abc", 100).page).toBe(1);
    expect(paginate(list, undefined, 100).page).toBe(1);
  });

  it("gives an empty list one empty page", () => {
    expect(paginate([], "5", 100)).toEqual({ page: 1, pages: 1, start: 0, items: [] });
  });
});
