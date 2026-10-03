// Number guards shared by the Editor and the two Georgian agents. An agent that polishes or
// translates text may never change a figure: any difference sends the draft back for another try.

/** Numeric tokens including their separators ("4.25", "1,200"). Used for same-language editing. */
const tokens = (s: string): Set<string> => new Set((s.match(/\d+(?:[.,]\d+)*/g) ?? []).map((n) => n.replace(/,/g, '')));

/** True when `after` contains exactly the same numeric tokens as `before`. */
export function numbersPreserved(before: string, after: string): boolean {
  const a = tokens(before);
  const b = tokens(after);
  return a.size === b.size && [...a].every((n) => b.has(n));
}

/**
 * Separator-agnostic check for translation: Georgian prose writes "1,2" and "1 200" where English
 * writes "1.2" and "1,200". Compares the digit runs only, so formatting may change, digits may not.
 */
export function digitsPreserved(before: string, after: string): boolean {
  const runs = (s: string): string[] => (s.match(/\d+/g) ?? []).sort();
  const a = runs(before);
  const b = runs(after);
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
