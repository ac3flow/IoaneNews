// Translator Agent: verified English briefings -> Georgian (ka). Runs only on articles that
// passed the Fact-Checker, so no tokens are spent translating stories that will be rejected.
//
// Two guards run on every translation before it is stored: digits must be identical to the
// English (formatting may change, digits may not) and the text must really be Georgian.
// A translation that fails is retried on a later run, and the article is rejected after
// MAX_ATTEMPTS. An LLM outage never counts against an article.

import { nowIso } from '../time';
import type { ArticleRow } from '../types';
import { MAX_ATTEMPTS, attemptCounts, logEvent, type StageCtx } from './context';
import { groundTranslatedChart } from './chart';
import { looksGeorgian } from './georgian';
import { digitsPreserved } from './numbers';
import { TRANSLATOR_SYSTEM } from './prompts';
import { rejectStatement } from './publish';
import { ChartData, TranslationOutput } from './schemas';

const FIELDS = ['headline', 'summary', 'what_happened', 'why_it_matters', 'figures_dates', 'affected_entities', 'risks_uncertainty'] as const;
const joined = (o: Record<(typeof FIELDS)[number], string | null | undefined>): string => FIELDS.map((f) => o[f] ?? '').join('\n');

export async function translateStage(ctx: StageCtx): Promise<Record<string, unknown>> {
  const { env, now, cfg } = ctx;
  const { results: queue } = await env.DB.prepare(
    `SELECT a.* FROM articles a
     WHERE a.status = 'edited' AND a.fact_checked = 1
       AND NOT EXISTS (SELECT 1 FROM article_translations t WHERE t.article_id = a.id AND t.lang = 'ka')
     ORDER BY a.created_at ASC LIMIT ?1`,
  )
    .bind(cfg.maxArticlesPerRun)
    .all<ArticleRow>();
  if (queue.length === 0) return { skipped: 'nothing to translate' };
  if (!ctx.llm) return { skipped: 'GEMINI_API_KEY not configured', queued: queue.length };

  const attempts = await attemptCounts(ctx, 'translate', queue.map((a) => a.id));
  const statements: D1PreparedStatement[] = [];
  const live: ArticleRow[] = [];
  let rejected = 0;
  for (const a of queue) {
    if ((attempts.get(a.id) ?? 0) >= MAX_ATTEMPTS) {
      statements.push(rejectStatement(env, a.id, now, { from: 'edited', factChecked: true, trustScore: a.trust_score }));
      logEvent(ctx, { articleId: a.id, stage: 'translate', outcome: 'rejected', detail: { reason: 'translation_failed', attempts: MAX_ATTEMPTS } });
      rejected++;
    } else live.push(a);
  }

  let translated = 0;
  let retry = 0;
  if (live.length) {
    // English charts (written by Research) travel with their articles to be translated.
    const { results: chartRows } = await env.DB.prepare(`SELECT article_id, data FROM article_charts WHERE lang = 'en' AND article_id IN (SELECT value FROM json_each(?1))`)
      .bind(JSON.stringify(live.map((a) => a.id)))
      .all<{ article_id: string; data: string }>();
    const charts = new Map<string, ChartData>();
    for (const r of chartRows) {
      try {
        charts.set(r.article_id, ChartData.parse(JSON.parse(r.data)));
      } catch {
        /* a chart that no longer parses is simply not shown */
      }
    }
    const out = await ctx.llm.json({
      system: TRANSLATOR_SYSTEM,
      user: JSON.stringify({ articles: live.map((a) => ({ id: a.id, headline: a.headline, summary: a.summary, what_happened: a.what_happened, why_it_matters: a.why_it_matters, figures_dates: a.figures_dates ?? '', affected_entities: a.affected_entities ?? '', risks_uncertainty: a.risks_uncertainty ?? '', chart: charts.get(a.id) ?? null })) }),
      schema: TranslationOutput,
      label: 'translate',
      model: env.GEMINI_MODEL_KA,
    });
    const byId = new Map(out.articles.map((t) => [t.id, t]));
    const ts = nowIso(now);

    for (const a of live) {
      const t = byId.get(a.id);
      const reason = !t ? 'missing_from_output' : !digitsPreserved(joined(a), joined(t)) ? 'facts_changed' : !looksGeorgian(t) ? 'not_georgian' : null;
      if (!t || reason) {
        logEvent(ctx, { articleId: a.id, stage: 'translate', outcome: 'error', detail: { reason } });
        retry++;
        continue;
      }
      statements.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO article_translations (article_id, lang, headline, summary, what_happened, why_it_matters, figures_dates, affected_entities, risks_uncertainty, grammar_checked, created_at, updated_at)
           VALUES (?1, 'ka', ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9, ?9)`,
        ).bind(a.id, t.headline, t.summary, t.what_happened, t.why_it_matters, t.figures_dates, t.affected_entities, t.risks_uncertainty, ts),
      );
      // The chart is a bonus: a bad Georgian chart is dropped, never a reason to retry or reject the article.
      const enChart = charts.get(a.id);
      const kaChart = enChart ? groundTranslatedChart(enChart, t.chart) : null;
      if (kaChart) statements.push(env.DB.prepare(`INSERT OR IGNORE INTO article_charts (article_id, lang, data, created_at) VALUES (?1, 'ka', ?2, ?3)`).bind(a.id, JSON.stringify(kaChart), ts));
      logEvent(ctx, { articleId: a.id, stage: 'translate', outcome: 'ok', detail: enChart ? { chart: !!kaChart } : undefined });
      translated++;
    }
  }

  if (statements.length) await env.DB.batch(statements);
  return { translated, retry, rejected };
}
