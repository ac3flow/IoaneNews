import type { Env } from '../types';
import { nowIso } from '../time';
import type { Llm } from './llm';

export interface PipelineConfig {
  feedsPerRun: number;
  maxArticlesPerRun: number;
  publishThreshold: number;
}

const int = (v: string | undefined, dflt: number, min: number, max: number): number => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : dflt;
};

export function readConfig(env: Env): PipelineConfig {
  return {
    feedsPerRun: int(env.FEEDS_PER_RUN, 10, 1, 100),
    maxArticlesPerRun: int(env.MAX_ARTICLES_PER_RUN, 3, 1, 10),
    publishThreshold: int(env.PUBLISH_THRESHOLD, 60, 0, 100),
  };
}

export type Stage = 'research' | 'edit' | 'fact_check' | 'publish' | 'feed';
export type Outcome = 'ok' | 'rejected' | 'error' | 'skipped';

export interface PipelineEvent {
  articleId: string | null;
  stage: Stage;
  outcome: Outcome;
  detail?: unknown;
}

export interface StageCtx {
  env: Env;
  runId: string;
  now: number;
  cfg: PipelineConfig;
  /** null when GEMINI_API_KEY is not configured. */
  llm: Llm | null;
  events: PipelineEvent[];
}

export function logEvent(ctx: StageCtx, e: PipelineEvent): void {
  ctx.events.push(e);
}

/** Write buffered events with a single statement (D1 queries are a metered resource). */
export async function flushEvents(ctx: StageCtx): Promise<void> {
  if (ctx.events.length === 0) return;
  const created = nowIso(ctx.now);
  const rows = ctx.events.map((e) => ({
    run_id: ctx.runId,
    article_id: e.articleId,
    stage: e.stage,
    outcome: e.outcome,
    detail: e.detail === undefined ? null : JSON.stringify(e.detail).slice(0, 4000),
    created_at: created,
  }));
  ctx.events = [];
  await ctx.env.DB.prepare(
    `INSERT INTO pipeline_events (run_id, article_id, stage, outcome, detail, created_at)
     SELECT json_extract(value,'$.run_id'), json_extract(value,'$.article_id'), json_extract(value,'$.stage'),
            json_extract(value,'$.outcome'), json_extract(value,'$.detail'), json_extract(value,'$.created_at')
     FROM json_each(?1)`,
  )
    .bind(JSON.stringify(rows))
    .run();
}

export const MAX_ATTEMPTS = 3;

/** How many times an article failed a stage on its own content (LLM outages do not count). */
export async function attemptCounts(ctx: StageCtx, stage: Stage, ids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (ids.length === 0) return out;
  const { results } = await ctx.env.DB.prepare(
    `SELECT article_id, COUNT(*) AS n FROM pipeline_events
     WHERE stage = ?1 AND outcome = 'error' AND article_id IN (SELECT value FROM json_each(?2))
     GROUP BY article_id`,
  )
    .bind(stage, JSON.stringify(ids))
    .all<{ article_id: string; n: number }>();
  for (const r of results) out.set(r.article_id, r.n);
  return out;
}
