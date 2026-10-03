// Georgian Grammar & Copy Checker Agent: a second, independent pass over the Georgian text.
// The Translator writes; this agent corrects case endings, verb forms, agreement, spelling,
// punctuation and English-isms. Same guards as the Translator: digits unchanged, still Georgian.
// An article is published only after this pass, so unchecked Georgian never reaches readers.

import { nowIso } from '../time';
import { MAX_ATTEMPTS, attemptCounts, logEvent, type StageCtx } from './context';
import { looksGeorgian } from './georgian';
import { digitsPreserved } from './numbers';
import { KA_GRAMMAR_SYSTEM } from './prompts';
import { rejectStatement } from './publish';
import { KaGrammarOutput } from './schemas';

interface Pending {
  article_id: string;
  headline: string;
  summary: string;
  what_happened: string;
  why_it_matters: string;
  figures_dates: string | null;
  affected_entities: string | null;
  risks_uncertainty: string | null;
  trust_score: number;
}

const FIELDS = ['headline', 'summary', 'what_happened', 'why_it_matters', 'figures_dates', 'affected_entities', 'risks_uncertainty'] as const;
const joined = (o: Record<(typeof FIELDS)[number], string | null | undefined>): string => FIELDS.map((f) => o[f] ?? '').join('\n');

export async function kaGrammarStage(ctx: StageCtx): Promise<Record<string, unknown>> {
  const { env, now, cfg } = ctx;
  const { results: queue } = await env.DB.prepare(
    `SELECT t.article_id, t.headline, t.summary, t.what_happened, t.why_it_matters, t.figures_dates, t.affected_entities, t.risks_uncertainty, a.trust_score
     FROM article_translations t JOIN articles a ON a.id = t.article_id
     WHERE t.lang = 'ka' AND t.grammar_checked = 0 AND a.status = 'edited'
     ORDER BY t.created_at ASC LIMIT ?1`,
  )
    .bind(cfg.maxArticlesPerRun)
    .all<Pending>();
  if (queue.length === 0) return { skipped: 'nothing to check' };
  if (!ctx.llm) return { skipped: 'GEMINI_API_KEY not configured', queued: queue.length };

  const attempts = await attemptCounts(ctx, 'ka_grammar', queue.map((q) => q.article_id));
  const statements: D1PreparedStatement[] = [];
  const live: Pending[] = [];
  let rejected = 0;
  for (const q of queue) {
    if ((attempts.get(q.article_id) ?? 0) >= MAX_ATTEMPTS) {
      statements.push(rejectStatement(env, q.article_id, now, { from: 'edited', factChecked: true, trustScore: q.trust_score }));
      logEvent(ctx, { articleId: q.article_id, stage: 'ka_grammar', outcome: 'rejected', detail: { reason: 'ka_grammar_failed', attempts: MAX_ATTEMPTS } });
      rejected++;
    } else live.push(q);
  }

  let checked = 0;
  let retry = 0;
  if (live.length) {
    const out = await ctx.llm.json({
      system: KA_GRAMMAR_SYSTEM,
      user: JSON.stringify({ articles: live.map((q) => ({ id: q.article_id, headline: q.headline, summary: q.summary, what_happened: q.what_happened, why_it_matters: q.why_it_matters, figures_dates: q.figures_dates ?? '', affected_entities: q.affected_entities ?? '', risks_uncertainty: q.risks_uncertainty ?? '' })) }),
      schema: KaGrammarOutput,
      label: 'ka_grammar',
      model: env.GEMINI_MODEL_KA,
    });
    const byId = new Map(out.articles.map((a) => [a.id, a]));
    const ts = nowIso(now);

    for (const q of live) {
      const c = byId.get(q.article_id);
      const reason = !c ? 'missing_from_output' : !digitsPreserved(joined(q), joined(c)) ? 'facts_changed' : !looksGeorgian(c) ? 'not_georgian' : null;
      if (!c || reason) {
        logEvent(ctx, { articleId: q.article_id, stage: 'ka_grammar', outcome: 'error', detail: { reason } });
        retry++;
        continue;
      }
      statements.push(
        env.DB.prepare(
          `UPDATE article_translations SET headline=?2, summary=?3, what_happened=?4, why_it_matters=?5, figures_dates=?6, affected_entities=?7,
             risks_uncertainty=?8, grammar_checked=1, updated_at=?9
           WHERE article_id=?1 AND lang='ka' AND grammar_checked=0`,
        ).bind(q.article_id, c.headline, c.summary, c.what_happened, c.why_it_matters, c.figures_dates, c.affected_entities, c.risks_uncertainty, ts),
      );
      logEvent(ctx, { articleId: q.article_id, stage: 'ka_grammar', outcome: 'ok', detail: { corrections: c.corrections } });
      checked++;
    }
  }

  if (statements.length) await env.DB.batch(statements);
  return { checked, retry, rejected };
}
