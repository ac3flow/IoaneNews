// Pipeline orchestrator: Research -> Edit -> Fact-Check -> Publish/Reject, sequentially,
// once per cron tick (*/5 * * * *). Stages are independent modules with the same
// signature (StageCtx -> result), so any of them can later move to its own Worker.

import type { Env } from '../types';
import { nowIso } from '../time';
import { flushEvents, logEvent, readConfig, type StageCtx } from './context';
import { editStage } from './editor';
import { factCheckStage } from './factcheck';
import { createLlm, type Llm } from './llm';
import { researchStage } from './research';

export type StageName = 'research' | 'edit' | 'fact_check';
const STAGES: Record<StageName, (ctx: StageCtx) => Promise<Record<string, unknown>>> = {
  research: researchStage,
  edit: editStage,
  fact_check: factCheckStage,
};
export const STAGE_ORDER: StageName[] = ['research', 'edit', 'fact_check'];

const LOCK_WINDOW_MS = 10 * 60_000; // a 'running' row older than this is considered dead
const STALE_AFTER_MS = 24 * 3600_000; // unpublished drafts older than this are dropped as stale
const LOG_RETENTION_MS = 30 * 86_400_000;

export interface RunOptions {
  trigger: 'cron' | 'manual';
  only?: StageName;
  now?: number;
  /** Test seam. `undefined` builds the Gemini client from env; `null` means "no LLM". */
  llm?: Llm | null;
}

export interface RunResult {
  runId: string;
  status: 'ok' | 'error' | 'skipped';
  note?: string;
  stages: Record<string, unknown>;
  ms: number;
}

export async function runPipeline(env: Env, opts: RunOptions): Promise<RunResult> {
  const t0 = Date.now();
  const now = opts.now ?? t0;
  const runId = crypto.randomUUID();
  const started = nowIso(now);

  // Lock: insert our row, then yield to any earlier live run.
  await env.DB.prepare(`INSERT INTO pipeline_runs (run_id, trigger, started_at, status) VALUES (?1, ?2, ?3, 'running')`).bind(runId, opts.trigger, started).run();
  const earlier = await env.DB.prepare(
    `SELECT run_id FROM pipeline_runs WHERE status = 'running' AND started_at >= ?1 AND (started_at < ?2 OR (started_at = ?2 AND run_id < ?3)) LIMIT 1`,
  )
    .bind(nowIso(now - LOCK_WINDOW_MS), started, runId)
    .first<{ run_id: string }>();
  if (earlier) {
    await env.DB.prepare(`UPDATE pipeline_runs SET status = 'ok', finished_at = ?2, stats = ?3 WHERE run_id = ?1`)
      .bind(runId, nowIso(), JSON.stringify({ skipped: 'another run is in progress' }))
      .run();
    return { runId, status: 'skipped', note: 'another run is in progress', stages: {}, ms: Date.now() - t0 };
  }

  const ctx: StageCtx = {
    env,
    runId,
    now,
    cfg: readConfig(env),
    llm: opts.llm === undefined ? createLlm(env) : opts.llm,
    events: [],
  };

  const stages: Record<string, unknown> = {};
  let failed = false;
  try {
    stages.housekeeping = await housekeeping(env, now);
    for (const name of opts.only ? [opts.only] : STAGE_ORDER) {
      try {
        stages[name] = await STAGES[name](ctx);
      } catch (e) {
        failed = true;
        const message = e instanceof Error ? e.message : String(e);
        console.error(`stage ${name} failed:`, message);
        stages[name] = { error: message };
        // Stage-level failure (LLM outage, D1 error). Deliberately not tied to an article,
        // so it never counts against an article's retry budget.
        logEvent(ctx, { articleId: null, stage: name, outcome: 'error', detail: { error: message } });
      }
      await flushEvents(ctx).catch((e) => console.error('event flush failed:', e));
    }
  } finally {
    await flushEvents(ctx).catch((e) => console.error('event flush failed:', e));
    await env.DB.prepare(`UPDATE pipeline_runs SET status = ?2, finished_at = ?3, stats = ?4 WHERE run_id = ?1`)
      .bind(runId, failed ? 'error' : 'ok', nowIso(), JSON.stringify(stages))
      .run()
      .catch((e) => console.error('run finalise failed:', e));
  }
  return { runId, status: failed ? 'error' : 'ok', stages, ms: Date.now() - t0 };
}

async function housekeeping(env: Env, now: number): Promise<Record<string, unknown>> {
  const stale = await env.DB.prepare(`UPDATE articles SET status = 'rejected', updated_at = ?1 WHERE status IN ('raw_research','edited') AND created_at < ?2`)
    .bind(nowIso(now), nowIso(now - STALE_AFTER_MS))
    .run();
  const out: Record<string, unknown> = { expired: stale.meta.changes ?? 0 };

  // Once a day (00:00–00:04 UTC) trim operational logs. Articles and feed_items are never deleted.
  const d = new Date(now);
  if (d.getUTCHours() === 0 && d.getUTCMinutes() < 5) {
    const cutoff = nowIso(now - LOG_RETENTION_MS);
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM pipeline_events WHERE created_at < ?1`).bind(cutoff),
      env.DB.prepare(`DELETE FROM pipeline_runs WHERE started_at < ?1`).bind(cutoff),
    ]);
    out.pruned = true;
  }
  return out;
}
