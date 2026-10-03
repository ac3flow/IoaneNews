import { W, findSourceByHost, tierOf, type TierId } from './sources';

export interface ResolvedSource {
  /** Registry id, or the registrable domain for unregistered publishers. */
  key: string;
  name: string;
  /** Credibility weight on the 0–5 scale. */
  weight: number;
  tier: TierId;
  /** Social signals are discovery-only and never count towards corroboration. */
  social: boolean;
  registered: boolean;
}

// Government / official hosts that are not individually registered still count as primary.
const OFFICIAL_HOST = /(^|\.)(gov|mil|int|gob|gouv)(\.[a-z]{2})?$|(^|\.)europa\.eu$/;

const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'ac', 'edu']);

/** example.co.uk -> example.co.uk, news.bbc.com -> bbc.com */
export function registrableDomain(host: string): string {
  const parts = host.toLowerCase().replace(/^www\./, '').split('.');
  if (parts.length <= 2) return parts.join('.');
  const tail = parts.slice(-2);
  const keep = tail[0] !== undefined && SECOND_LEVEL.has(tail[0]) && (tail[1] ?? '').length === 2 ? 3 : 2;
  return parts.slice(-keep).join('.');
}

export function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname : null;
  } catch {
    return null;
  }
}

/**
 * Classify where a citation comes from.
 *  - Registered publisher: registry weight (a Hacker News link to Reuters is Reuters).
 *  - Official government/IO host: 5.0.
 *  - Unknown publisher found through a social aggregator: social weight, discovery only.
 *  - Unknown publisher otherwise: 2.0, never primary.
 */
export function resolveSource(url: string, opts: { viaSocial?: boolean } = {}): ResolvedSource {
  const host = hostOf(url);
  if (!host) return { key: 'invalid', name: 'Invalid URL', weight: 0, tier: 'unclassified', social: false, registered: false };

  const hit = findSourceByHost(host);
  if (hit) {
    return { key: hit.id, name: hit.name, weight: hit.weight, tier: tierOf(hit.weight, hit.social), social: hit.social, registered: true };
  }

  const domain = registrableDomain(host);
  if (OFFICIAL_HOST.test(host.toLowerCase())) {
    return { key: domain, name: domain, weight: W.PRIMARY, tier: 'primary', social: false, registered: false };
  }
  if (opts.viaSocial) {
    return { key: domain, name: domain, weight: W.SOCIAL, tier: 'social', social: true, registered: false };
  }
  return { key: domain, name: domain, weight: W.UNCLASSIFIED, tier: 'unclassified', social: false, registered: false };
}
