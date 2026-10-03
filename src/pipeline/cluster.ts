// Group pool items that report the same event, so the Fact-Checker's double-sourcing
// rule can be met by items collected in different runs. Cheap and deterministic: it
// runs before any LLM call and decides whether a call is worth making at all.

export interface ClusterInput {
  id: string;
  title: string;
  snippet?: string | null;
}

const STOP = new Set(
  'a an the and or but of to in on at for from by with as is are was were be been it its this that these those will would could should may might has have had not no new says said say after before over under into out up down more most than about amid per vs via off one two three also just now today us uk'.split(' '),
);

export function tokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().replace(/['’]s\b/g, '').split(/[^a-z0-9.%$€£]+/)) {
    const t = raw.replace(/^[.%]+|[.]+$/g, '');
    if (t.length < 3 && !/\d/.test(t)) continue;
    if (STOP.has(t)) continue;
    out.add(t);
  }
  return out;
}

function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
}

/** Same event if they share >= 3 significant title tokens and >= 40% of the shorter title. */
export function sameEvent(a: Set<string>, b: Set<string>): boolean {
  const shared = overlap(a, b);
  if (shared < 3) return false;
  return shared / Math.min(a.size, b.size) >= 0.4;
}

export function clusterItems<T extends ClusterInput>(items: T[]): T[][] {
  const toks = items.map((i) => tokens(i.title));
  const parent = items.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i] as number] as number;
      i = parent[i] as number;
    }
    return i;
  };
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (sameEvent(toks[i] as Set<string>, toks[j] as Set<string>)) parent[find(j)] = find(i);
    }
  }
  const groups = new Map<number, T[]>();
  items.forEach((item, i) => {
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(item);
    else groups.set(r, [item]);
  });
  return [...groups.values()];
}
