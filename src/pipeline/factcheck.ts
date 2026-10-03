// Fact-Checker Agent: trust score (0–100) from source credibility, double-sourcing and
// primary evidence (deterministic, see scoring.ts) plus an LLM claim check against the
// source excerpts. Publishes or rejects. Without the LLM nothing is published, because
// an unchecked article must never reach readers.

import type { ArticleRow, FeedItemRow } from '../types';
import { citationsFromLinks, parseLinks } from './citations';
import { MAX_ATTEMPTS, attemptCounts, logEvent, type StageCtx } from './context';
import { FACTCHECK_SYSTEM } from './prompts';
import { publishStatement, rejectStatement } from './publish';
import { FactCheckOutput } from './schemas';
import { scoreArticle } from './scoring';

const BATCH = 5;

export async function factCheckStage(ctx: StageCtx): Promise<Record<string, unknown>> {
  const { env, now, cfg } = ctx;
  const { results: queue } = await env.DB.prepare(`SELECT * FROM articles WHERE status = 'edited' ORDER BY created_at ASC LIMIT ?1`).bind(BATCH).all<ArticleRow>();
  if (queue.length === 0) return { skipped: 'nothing to check' };
  if (!ctx.llm) return { skipped: 'GEMINI_API_KEY not configured', queued: queue.length };

  const attempts = await attemptCounts(ctx, 'fact_check', queue.map((a) => a.id));
  const statements: D1PreparedStatement[] = [];
  const live: ArticleRow[] = [];
  let rejected = 0;
  for (const a of queue) {
    if ((attempts.get(a.id) ?? 0) >= MAX_ATTEMPTS) {
      statements.push(rejectStatement(env, a.id, now, { factChecked: false }));
      logEvent(ctx, { articleId: a.id, stage: 'fact_check', outcome: 'rejected', detail: { reason: 'factcheck_failed', attempts: MAX_ATTEMPTS } });
      rejected++;
    } else live.push(a);
  }

  let published = 0;
  let retry = 0;
  if (live.length) {
    const { results: items } = await env.DB.prepare(`SELECT url, title, snippet, source_name FROM feed_items WHERE article_id IN (SELECT value FROM json_each(?1))`)
      .bind(JSON.stringify(live.map((a) => a.id)))
      .all<Pick<FeedItemRow, 'url' | 'title' | 'snippet' | 'source_name'>>();
    const byUrl = new Map(items.map((i) => [i.url, i]));

    const prepared = live.map((a) => {
      const links = parseLinks(a.source_links);
      const sources = links.map((l, i) => {
        const it = byUrl.get(l.url);
        return { index: i + 1, source: it?.source_name ?? l.title, title: it?.title ?? l.title, excerpt: (it?.snippet ?? '').slice(0, 600) };
      });
      return { a, links, sources };
    });

    const out = await ctx.llm.json({
      system: FACTCHECK_SYSTEM,
      user: JSON.stringify({
        articles: prepared.map(({ a, sources }) => ({
          id: a.id,
          headline: a.headline,
          summary: a.summary,
          what_happened: a.what_happened,
          why_it_matters: a.why_it_matters,
          figures_dates: a.figures_dates ?? '',
          sources,
        })),
      }),
      schema: FactCheckOutput,
      label: 'fact_check',
    });
    const byId = new Map(out.results.map((r) => [r.id, r]));

    for (const { a, links } of prepared) {
      const res = byId.get(a.id);
      if (!res) {
        logEvent(ctx, { articleId: a.id, stage: 'fact_check', outcome: 'error', detail: { reason: 'missing_from_output' } });
        retry++;
        continue;
      }
      const claims = {
        total: res.claims.length,
        supported: res.claims.filter((c) => c.verdict === 'supported').length,
        contradicted: res.claims.filter((c) => c.verdict === 'contradicted').length,
      };
      const r = scoreArticle(citationsFromLinks(links), claims, cfg.publishThreshold);
      const detail = {
        score: r.score,
        breakdown: r.breakdown,
        reasons: r.reasons,
        independentSources: r.independentSources,
        bestWeight: r.bestWeight,
        claims,
        flagged: res.claims.filter((c) => c.verdict !== 'supported').slice(0, 8),
      };
      if (r.decision === 'publish') {
        statements.push(publishStatement(env, a.id, r.score, now));
        logEvent(ctx, { articleId: a.id, stage: 'fact_check', outcome: 'ok', detail });
        published++;
      } else {
        statements.push(rejectStatement(env, a.id, now, { trustScore: r.score, factChecked: true }));
        logEvent(ctx, { articleId: a.id, stage: 'fact_check', outcome: 'rejected', detail });
        rejected++;
      }
    }
  }

  if (statements.length) await env.DB.batch(statements);
  return { published, rejected, retry };
}
