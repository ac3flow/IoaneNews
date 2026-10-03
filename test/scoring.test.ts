import { describe, expect, it } from 'vitest';
import { scoreArticle, type Citation } from '../src/pipeline/scoring';

const cite = (key: string, weight: number, social = false): Citation => ({ key, name: key, url: `https://${key}.example/x`, title: key, weight, social });
const allGood = { total: 5, supported: 5, contradicted: 0 };

describe('scoreArticle', () => {
  it('publishes a single primary source', () => {
    const r = scoreArticle([cite('nbg', 5)], allGood, 60);
    expect(r.breakdown).toEqual({ credibility: 40, corroboration: 5, primaryEvidence: 20, claimSupport: 15, penalties: 0 });
    expect(r.score).toBe(80);
    expect(r.decision).toBe('publish');
  });

  it('rejects a single non-primary source however good (double-sourcing rule)', () => {
    const r = scoreArticle([cite('reuters', 4.5)], allGood, 60);
    expect(r.decision).toBe('reject');
    expect(r.reasons).toEqual(['not_double_sourced']);
  });

  it('publishes two independent wires with a high score', () => {
    const r = scoreArticle([cite('reuters', 4.5), cite('ap', 4.5)], allGood, 60);
    expect(r.score).toBe(85);
    expect(r.decision).toBe('publish');
  });

  it('does not count two links from the same publisher as independent', () => {
    const r = scoreArticle([cite('reuters', 4.5), cite('reuters', 4.5)], allGood, 60);
    expect(r.independentSources).toBe(1);
    expect(r.reasons).toContain('not_double_sourced');
  });

  it('never counts social signals', () => {
    const only = scoreArticle([cite('hn', 1.5, true), cite('reddit', 1.5, true)], allGood, 60);
    expect(only.decision).toBe('reject');
    expect(only.reasons).toContain('no_non_social_source');
    expect(only.score).toBe(Math.round(0 + 0 + 0 + 15)); // only claim support contributes

    const mixed = scoreArticle([cite('hn', 1.5, true), cite('coindesk', 3.5)], allGood, 60);
    expect(mixed.independentSources).toBe(1);
    expect(mixed.reasons).toContain('not_double_sourced');
  });

  it('rejects when two weak sources fall under the threshold', () => {
    const r = scoreArticle([cite('a', 3), cite('b', 3)], allGood, 60);
    expect(r.score).toBe(59);
    expect(r.reasons).toEqual(['below_threshold']);
  });

  it('a contradicted claim is penalised and always blocks publication', () => {
    const r = scoreArticle([cite('nbg', 5)], { total: 5, supported: 4, contradicted: 1 }, 0);
    expect(r.breakdown.penalties).toBe(-30);
    expect(r.decision).toBe('reject');
    expect(r.reasons).toContain('contradicted_claim');
  });

  it('requires at least 70% of claims supported', () => {
    expect(scoreArticle([cite('nbg', 5)], { total: 10, supported: 7, contradicted: 0 }, 0).decision).toBe('publish');
    const r = scoreArticle([cite('nbg', 5)], { total: 10, supported: 6, contradicted: 0 }, 0);
    expect(r.reasons).toContain('low_claim_support');
  });

  it('treats an empty claim check as unsupported rather than dividing by zero', () => {
    const r = scoreArticle([cite('nbg', 5)], { total: 0, supported: 0, contradicted: 0 }, 0);
    expect(r.breakdown.claimSupport).toBe(0);
    expect(r.decision).toBe('reject');
  });

  it('clamps to 0..100 and never returns NaN', () => {
    const r = scoreArticle([], { total: 3, supported: 0, contradicted: 3 }, 60);
    expect(r.score).toBe(0);
    expect(Number.isNaN(r.score)).toBe(false);
  });
});
