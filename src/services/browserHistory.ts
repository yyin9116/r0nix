export function appendBrowserHistory(entries: string[], index: number, nextUrl: string) {
  const current = entries[index];
  if (current === nextUrl) return { entries, index };
  const nextEntries = [...entries.slice(0, index + 1), nextUrl];
  return { entries: nextEntries, index: nextEntries.length - 1 };
}
