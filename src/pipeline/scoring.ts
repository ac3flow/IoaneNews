// Fact-Checker scoring: pure and deterministic so it can be tested and audited.
//
// Trust score (0–100) = credibility (0–40) + corroboration (0–25)
//                     + primary evidence (0–20) + claim support (0–15) − penalties
//
//   credibility      best non-social source weight, scaled (5.0 => 40)
//   corroboration    independent non-social publishers: 1 => 5, 2 => 20, 3+ => 25
//   primary evidence 5.0 => 20, wire 4.5 => 14, major 4.0 => 10, specialist 3.5 => 5
//   claim support    share of the article's claims the sources actually back (LLM-checked)
//
// An article is published only when ALL gates hold; the score alone is never enough:
//   1. at least one non-social source (social signals are discovery only)
//   2. double-sourced (>= 2 independent non-social publishers) OR backed by a primary source
//   3. no claim contradicted by the sources
//   4. at least 70% of claims supported
//   5. score >= PUBLISH_THRESHOLD

export interface Citation {
  /** Publisher identity: two citations with the same key are not independent. */
  key: string;
  name: string;
  url: string;
  title: string;
  weight: number;
  social: boolean;
}

export interface ClaimCheck {
  total: number;
  supported: number;
  contradicted: number;
}

export interface ScoreBreakdown {
  credibility: number;
  corroboration: number;
  primaryEvidence: number;
  claimSupport: number;
  penalties: number;
}

export type RejectReason =
  | 'no_non_social_source'
  | 'not_double_sourced'
  | 'contradicted_claim'
  | 'low_claim_support'
  | 'below_threshold';

export interface ScoreResult {
  score: number;
  decision: 'publish' | 'reject';
  reasons: RejectReason[];
  breakdown: ScoreBreakdown;
  independentSources: number;
  bestWeight: number;
  hasPrimary: boolean;
}

export const MIN_CLAIM_SUPPORT = 0.7;
const CONTRADICTION_PENALTY = 30;

const round1 = (n: number): number => Math.round(n * 10) / 10;

export function scoreArticle(citations: Citation[], claims: ClaimCheck, threshold: number): ScoreResult {
  const solid = citations.filter((c) => !c.social);
  const independentSources = new Set(solid.map((c) => c.key)).size;
  const bestWeight = solid.reduce((m, c) => Math.max(m, c.weight), 0);
  const hasPrimary = bestWeight >= 5;

  const credibility = round1((bestWeight / 5) * 40);
  const corroboration = independentSources >= 3 ? 25 : independentSources === 2 ? 20 : independentSources === 1 ? 5 : 0;
  const primaryEvidence = bestWeight >= 5 ? 20 : bestWeight >= 4.5 ? 14 : bestWeight >= 4 ? 10 : bestWeight >= 3.5 ? 5 : 0;
  const ratio = claims.total > 0 ? claims.supported / claims.total : 0;
  const claimSupport = round1(15 * ratio);
  const penalties = claims.contradicted > 0 ? -CONTRADICTION_PENALTY * claims.contradicted : 0;

  const raw = credibility + corroboration + primaryEvidence + claimSupport + penalties;
  const score = Math.max(0, Math.min(100, Math.round(raw)));

  const reasons: RejectReason[] = [];
  if (solid.length === 0) reasons.push('no_non_social_source');
  else if (independentSources < 2 && !hasPrimary) reasons.push('not_double_sourced');
  if (claims.contradicted > 0) reasons.push('contradicted_claim');
  if (ratio < MIN_CLAIM_SUPPORT) reasons.push('low_claim_support');
  if (score < threshold) reasons.push('below_threshold');

  return {
    score,
    decision: reasons.length === 0 ? 'publish' : 'reject',
    reasons,
    breakdown: { credibility, corroboration, primaryEvidence, claimSupport, penalties },
    independentSources,
    bestWeight,
    hasPrimary,
  };
}
