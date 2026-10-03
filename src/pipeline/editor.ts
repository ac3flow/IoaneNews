// Grammar & Copy Editor Agent: polishes tone, clarity and readability of raw_research
// drafts. It may not change facts: every number in the draft must survive unchanged and
// no new number may appear. A draft that fails that check is retried on a later run and
// rejected after MAX_ATTEMPTS.

import type { ArticleRow } from '../types';
import { nowIso } from '../time';
import { MAX_ATTEMPTS, attemptCounts, logEvent, type StageCtx } from './context';
import { EDITOR_SYSTEM } from './prompts';
import { rejectStatement } from './publish';
import { numbersPreserved } from './numbers';
import { EditorOutput, type BriefingFields } from './schemas';

const FIELDS = ['headline', 'summary', 'what_happened', 'why_it_matters', 'figures_dates', 'affected_entities', 'risks_uncertainty'] as const;

const joined = (o: Record<(typeof FIELDS)[number], string | null>): string => FIELDS.map((f) => o[f] ?? '').join('\n');

export async function editStage(ctx: StageCtx): Promise<Record<string, unknown>> {
  const { env, now } = ctx;
  const { results: drafts } = await env.DB.prepare(`SELECT * FROM articles WHERE status = 'raw_research' ORDER BY created_at ASC LIMIT ?1`).bind(ctx.cfg.maxArticlesPerRun).all<ArticleRow>();
  if (drafts.length === 0) return { skipped: 'nothing to edit' };
  if (!ctx.llm) return { skipped: 'GEMINI_API_KEY not configured', queued: drafts.length };

  const attempts = await attemptCounts(ctx, 'edit', drafts.map((d) => d.id));
  const statements: D1PreparedStatement[] = [];
  const live: ArticleRow[] = [];
  let rejected = 0;
  for (const d of drafts) {
    if ((attempts.get(d.id) ?? 0) >= MAX_ATTEMPTS) {
      statements.push(rejectStatement(env, d.id, now, { from: 'raw_research' }));
      logEvent(ctx, { articleId: d.id, stage: 'edit', outcome: 'rejected', detail: { reason: 'editor_failed', attempts: MAX_ATTEMPTS } });
      rejected++;
    } else live.push(d);
  }

  let edited = 0;
  let retry = 0;
  if (live.length) {
    const out = await ctx.llm.json({
      system: EDITOR_SYSTEM,
      user: JSON.stringify({ articles: live.map((d) => ({ id: d.id, headline: d.headline, summary: d.summary, what_happened: d.what_happened, why_it_matters: d.why_it_matters, figures_dates: d.figures_dates ?? '', affected_entities: d.affected_entities ?? '', risks_uncertainty: d.risks_uncertainty ?? '' })) }),
      schema: EditorOutput,
      label: 'edit',
    });
    const byId = new Map(out.articles.map((a) => [a.id, a]));
    const ts = nowIso(now);

    for (const d of live) {
      const e: (BriefingFields & { id: string }) | undefined = byId.get(d.id);
      if (!e) {
        logEvent(ctx, { articleId: d.id, stage: 'edit', outcome: 'error', detail: { reason: 'missing_from_output' } });
        retry++;
        continue;
      }
      if (!numbersPreserved(joined(d), joined(e))) {
        logEvent(ctx, { articleId: d.id, stage: 'edit', outcome: 'error', detail: { reason: 'facts_changed', note: 'a number was added, removed or altered' } });
        retry++;
        continue;
      }
      statements.push(
        env.DB.prepare(
          `UPDATE articles SET headline=?2, summary=?3, what_happened=?4, why_it_matters=?5, figures_dates=?6, affected_entities=?7,
             risks_uncertainty=?8, grammar_checked=1, status='edited', updated_at=?9
           WHERE id=?1 AND status='raw_research'`,
        ).bind(d.id, e.headline, e.summary, e.what_happened, e.why_it_matters, e.figures_dates, e.affected_entities, e.risks_uncertainty, ts),
      );
      logEvent(ctx, { articleId: d.id, stage: 'edit', outcome: 'ok' });
      edited++;
    }
  }

  if (statements.length) await env.DB.batch(statements);
  return { edited, retry, rejected };
}
