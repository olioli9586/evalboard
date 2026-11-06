// One page of a list for ?page= links. The page number is clamped to the
// list, and anything that isn't a number reads as page 1.
export function paginate<T>(items: T[], pageParam: string | undefined, perPage: number) {
  const pages = Math.max(1, Math.ceil(items.length / perPage));
  const page = Math.min(pages, Math.max(1, Number.parseInt(pageParam ?? "", 10) || 1));
  const start = (page - 1) * perPage;
  return { page, pages, start, items: items.slice(start, start + perPage) };
}
