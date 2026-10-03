import { SOURCE_BY_ID } from '../registry/sources';
import { resolveSource } from '../registry/trust';
import type { FeedItemRow, SourceLink } from '../types';
import type { Citation } from './scoring';

const SOCIAL_BELOW = 2; // spec: social signals weigh 1.0–2.0 and are discovery-only

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** Who a pool item counts as when it is cited. */
export function citationFromItem(item: Pick<FeedItemRow, 'url' | 'title' | 'source_id' | 'via_social'>): Citation {
  const viaSocial = !!item.via_social;
  const r = resolveSource(item.url, { viaSocial });
  // Publisher unknown by domain but the feed itself is a registered source: trust the feed.
  const feedSource = !r.registered && !viaSocial ? SOURCE_BY_ID.get(item.source_id) : undefined;
  if (feedSource) {
    return { key: feedSource.id, name: feedSource.name, url: item.url, title: clip(item.title, 160), weight: feedSource.weight, social: feedSource.social };
  }
  return { key: r.key, name: r.name, url: item.url, title: clip(item.title, 160), weight: r.weight, social: r.social };
}

export function linksFromCitations(cs: Citation[]): SourceLink[] {
  const seen = new Set<string>();
  const out: SourceLink[] = [];
  for (const c of cs) {
    if (seen.has(c.url)) continue;
    seen.add(c.url);
    out.push({ title: c.title, url: c.url, trust_score: c.weight });
  }
  return out;
}

/** Rebuild scoring citations from stored links (weight is what was stored at research time). */
export function citationsFromLinks(links: SourceLink[]): Citation[] {
  return links
    .filter((l) => /^https?:\/\//i.test(l.url))
    .map((l) => {
      const r = resolveSource(l.url);
      return { key: r.key, name: r.name, url: l.url, title: l.title, weight: l.trust_score, social: r.social || l.trust_score < SOCIAL_BELOW };
    });
}

export function parseLinks(json: string): SourceLink[] {
  try {
    const v: unknown = JSON.parse(json);
    if (!Array.isArray(v)) return [];
    return v.flatMap((x): SourceLink[] => {
      if (!x || typeof x !== 'object') return [];
      const o = x as Record<string, unknown>;
      return typeof o.url === 'string' && typeof o.title === 'string' && typeof o.trust_score === 'number'
        ? [{ title: o.title, url: o.url, trust_score: o.trust_score }]
        : [];
    });
  } catch {
    return [];
  }
}
