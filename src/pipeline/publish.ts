// Publish / Reject: the only place an article's terminal status is written.
// The status guard in each WHERE clause makes a repeated or concurrent decision a no-op.

import type { Env } from '../types';
import { nowIso } from '../time';

export function publishStatement(env: Env, id: string, trustScore: number, now: number): D1PreparedStatement {
  const ts = nowIso(now);
  return env.DB.prepare(
    `UPDATE articles SET status = 'published', fact_checked = 1, trust_score = ?2, published_at = ?3, updated_at = ?3
     WHERE id = ?1 AND status = 'edited'`,
  ).bind(id, trustScore, ts);
}

/** `fromStatuses` lets the Editor reject a raw_research article and the Fact-Checker an edited one. */
export function rejectStatement(
  env: Env,
  id: string,
  now: number,
  opts: { trustScore?: number; factChecked?: boolean; from?: 'raw_research' | 'edited' } = {},
): D1PreparedStatement {
  const from = opts.from ?? 'edited';
  return env.DB.prepare(
    `UPDATE articles SET status = 'rejected', fact_checked = ?3, trust_score = ?4, updated_at = ?5
     WHERE id = ?1 AND status = ?2`,
  ).bind(id, from, opts.factChecked ? 1 : 0, opts.trustScore ?? 0, nowIso(now));
}
