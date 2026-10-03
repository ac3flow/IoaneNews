// Publish / Reject: the only place an article's terminal status is written.
// The status guard in each WHERE clause makes a repeated or concurrent decision a no-op.
//
// Lifecycle:  raw_research -> edited -> (fact-check pass: fact_checked = 1, still 'edited')
//             -> translated + Georgian-grammar-checked -> published      (or rejected at any step)

import type { ArticleRow, Env } from '../types';
import { nowIso } from '../time';
import { logEvent, type StageCtx } from './context';

/** Fact-Checker verdict "pass": record the score. The article is published later, once Georgian is ready. */
export function verifyStatement(env: Env, id: string, trustScore: number, now: number): D1PreparedStatement {
  return env.DB.prepare(`UPDATE articles SET fact_checked = 1, trust_score = ?2, updated_at = ?3 WHERE id = ?1 AND status = 'edited' AND fact_checked = 0`).bind(id, trustScore, nowIso(now));
}

export function publishStatement(env: Env, id: string, now: number): D1PreparedStatement {
  const ts = nowIso(now);
  return env.DB.prepare(`UPDATE articles SET status = 'published', published_at = ?2, updated_at = ?2 WHERE id = ?1 AND status = 'edited' AND fact_checked = 1`).bind(id, ts);
}

/** `from` lets the Editor reject a raw_research article and later stages an edited one. */
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

/** Publish stage: verified articles whose Georgian version has passed the Georgian Grammar Checker. */
export async function publishStage(ctx: StageCtx): Promise<Record<string, unknown>> {
  const { env, now, cfg } = ctx;
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.trust_score FROM articles a
     JOIN article_translations t ON t.article_id = a.id AND t.lang = 'ka' AND t.grammar_checked = 1
     WHERE a.status = 'edited' AND a.fact_checked = 1
     ORDER BY a.created_at ASC LIMIT ?1`,
  )
    .bind(cfg.maxArticlesPerRun)
    .all<Pick<ArticleRow, 'id' | 'trust_score'>>();
  if (results.length === 0) return { skipped: 'nothing ready to publish' };

  await env.DB.batch(results.map((r) => publishStatement(env, r.id, now)));
  for (const r of results) logEvent(ctx, { articleId: r.id, stage: 'publish', outcome: 'ok', detail: { trustScore: r.trust_score } });
  return { published: results.length };
}
