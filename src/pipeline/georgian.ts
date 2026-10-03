// Cheap, deterministic checks on Georgian output. They cannot judge grammar (the Georgian
// Grammar Checker agent does that), but they catch the failures that matter most: a model that
// answers in English, or one that drops the Georgian script.

const isGeorgian = (c: number): boolean => (c >= 0x10d0 && c <= 0x10ff) || (c >= 0x1c90 && c <= 0x1cbf) || (c >= 0x2d00 && c <= 0x2d2f);
const isLatin = (c: number): boolean => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);

/** Share of Georgian letters among Georgian + Latin letters. 1 = all Georgian, 0 = none. */
export function georgianShare(text: string): number {
  let ka = 0;
  let latin = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (isGeorgian(c)) ka++;
    else if (isLatin(c)) latin++;
  }
  return ka + latin === 0 ? 0 : ka / (ka + latin);
}

export const hasGeorgian = (text: string): boolean => georgianShare(text) > 0;

/**
 * True when the narrative fields are really Georgian. Brand names, tickers and acronyms stay in
 * Latin script on purpose (as in "Google-მა"), so the bar is a majority, not 100%.
 */
export function looksGeorgian(fields: { headline: string; summary: string; what_happened: string; why_it_matters: string; risks_uncertainty?: string | null }): boolean {
  const body = [fields.summary, fields.what_happened, fields.why_it_matters, fields.risks_uncertainty ?? ''].join(' ');
  return hasGeorgian(fields.headline) && georgianShare(body) >= 0.6;
}
