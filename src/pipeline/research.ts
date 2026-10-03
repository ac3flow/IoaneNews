// Research Agent: collect -> pool -> cluster -> draft. `collectStage` and `researchStage` are separate
// stages so they can run in separate cron invocations (see run.ts).
//
//  1. Poll a round-robin slice of the registry's feeds (FEEDS_PER_RUN per run).
//  2. Add new items to a rolling pool (feed_items), de-duplicated by normalised URL.
//  3. Cluster the pool by event, in code. A cluster is worth drafting only if it can
//     pass the Fact-Checker's double-sourcing rule (>= 2 independent non-social
//     publishers, or one primary/official source). Corroborating items often arrive in
//     different runs, which is why the pool exists. Most runs end here with no LLM call.
//  4. Ask the LLM to draft one briefing per top cluster, using only the cluster's text.
//     Source links are attached from the items, never taken from the model's output.

import { FEEDS, articleCategoryFor, type FeedRef } from '../registry/sources';
import { SLOT_MS, nowIso } from '../time';
import type { FeedItemRow } from '../types';
import { citationFromItem, linksFromCitations } from './citations';
import { clusterItems } from './cluster';
import { logEvent, type StageCtx } from './context';
import { fetchFeed, sha, type RawItem } from './feeds';
import { RESEARCH_SYSTEM } from './prompts';
import { ResearchOutput } from './schemas';
import type { Citation } from './scoring';

const MAX_ITEM_AGE_MS = 72 * 3600_000; // ignore very old feed items on ingest
const POOL_WINDOW_MS = 36 * 3600_000; // how long an unused item stays eligible
const POOL_LIMIT = 150;
const MAX_OFFERS = 3; // times an item may be sent to the LLM without becoming an article
const MAX_ITEMS_PER_CLUSTER = 6;
const BASELINE_AGE_MS = 7 * 86_400_000; // first sight of a page feed: mark existing links as old news

/**
 * Stride-interleave so every collect mixes categories; each feed is polled every `groups` ticks,
 * where groups = ceil(feeds / perRun). `tick` is any counter that advances by 1 per collect.
 */
export function selectFeedBatch<T>(feeds: T[], tick: number, perRun: number): T[] {
  const groups = Math.max(1, Math.ceil(feeds.length / perRun));
  const slot = tick % groups;
  return feeds.filter((_, i) => i % groups === slot);
}

export interface ClusterEval {
  citations: Citation[];
  independent: number;
  best: number;
  hasPrimary: boolean;
  eligible: boolean;
  priority: number;
}

export function evaluateCluster(items: FeedItemRow[], now: number): ClusterEval {
  const citations = items.map(citationFromItem);
  const solid = citations.filter((c) => !c.social);
  const independent = new Set(solid.map((c) => c.key)).size;
  const best = solid.reduce((m, c) => Math.max(m, c.weight), 0);
  const hasPrimary = best >= 5;
  const newest = items.reduce((m, i) => Math.max(m, Date.parse(i.published_at)), 0);
  const ageHours = Math.max(0, (now - newest) / 3600_000);
  const priority = (hasPrimary ? 3 : 0) + independent + best / 5 + (items.some((i) => i.georgia) ? 0.5 : 0) + Math.max(0, 1 - ageHours / 12);
  return { citations, independent, best, hasPrimary, eligible: solid.length > 0 && (independent >= 2 || hasPrimary), priority };
}

// ─── collect ────────────────────────────────────────────────────────────────

interface IngestRow {
  id: string;
  source_id: string;
  source_name: string;
  feed_id: string;
  title: string;
  url: string;
  snippet: string;
  published_at: string;
  fetched_at: string;
  via_social: number;
  georgia: number;
  category_hint: string | null;
}

async function collect(ctx: StageCtx, batch: FeedRef[]): Promise<{ polled: number; failed: number; fetched: number; inserted: number }> {
  const { env, now } = ctx;
  const settled = await Promise.allSettled(batch.map((f) => fetchFeed(f, now)));

  const pageFeedIds = batch.filter((f) => f.kind === 'page').map((f) => f.id);
  const known = new Set<string>();
  if (pageFeedIds.length) {
    const { results } = await env.DB.prepare(`SELECT DISTINCT feed_id FROM feed_items WHERE feed_id IN (SELECT value FROM json_each(?1))`)
      .bind(JSON.stringify(pageFeedIds))
      .all<{ feed_id: string }>();
    for (const r of results) known.add(r.feed_id);
  }

  const cutoff = now - MAX_ITEM_AGE_MS;
  const fetchedAt = nowIso(now);
  const rows = new Map<string, IngestRow>();
  let failed = 0;

  for (let i = 0; i < batch.length; i++) {
    const feed = batch[i] as FeedRef;
    const res = settled[i] as PromiseSettledResult<RawItem[]>;
    if (res.status === 'rejected') {
      failed++;
      logEvent(ctx, { articleId: null, stage: 'feed', outcome: 'error', detail: { feed: feed.id, url: feed.url, error: String(res.reason?.message ?? res.reason) } });
      continue;
    }
    const baseline = feed.kind === 'page' && !known.has(feed.id);
    for (const it of res.value) {
      let published = Date.parse(it.published);
      if (baseline) published = now - BASELINE_AGE_MS;
      else if (published < cutoff) continue;
      else if (published > now) published = now;
      const id = await sha(it.url);
      if (rows.has(id)) continue;
      rows.set(id, {
        id,
        source_id: feed.source.id,
        source_name: feed.source.name,
        feed_id: feed.id,
        title: it.title,
        url: it.url,
        snippet: it.snippet,
        published_at: nowIso(published),
        fetched_at: fetchedAt,
        via_social: feed.source.social ? 1 : 0,
        georgia: feed.source.georgia ? 1 : 0,
        category_hint: feed.hint ? articleCategoryFor(feed.hint) : null,
      });
    }
  }

  let inserted = 0;
  if (rows.size) {
    const out = await env.DB.prepare(
      `INSERT OR IGNORE INTO feed_items (id, source_id, source_name, feed_id, title, url, snippet, published_at, fetched_at, via_social, georgia, category_hint)
       SELECT json_extract(value,'$.id'), json_extract(value,'$.source_id'), json_extract(value,'$.source_name'), json_extract(value,'$.feed_id'),
              json_extract(value,'$.title'), json_extract(value,'$.url'), json_extract(value,'$.snippet'), json_extract(value,'$.published_at'),
              json_extract(value,'$.fetched_at'), json_extract(value,'$.via_social'), json_extract(value,'$.georgia'), json_extract(value,'$.category_hint')
       FROM json_each(?1)`,
    )
      .bind(JSON.stringify([...rows.values()]))
      .run();
    inserted = out.meta.changes ?? 0;
  }
  return { polled: batch.length, failed, fetched: rows.size, inserted };
}

// ─── draft ──────────────────────────────────────────────────────────────────

interface Candidate {
  cid: string;
  items: FeedItemRow[];
  ev: ClusterEval;
}

/**
 * Collect: poll this tick's slice of the registry and add new items to the pool. No LLM.
 * In staged mode it runs twice per 5-minute slot (phase 0 at :00, phase 1 at :04), so the
 * counter advances by 2 per slot and every feed is still visited on a regular cycle.
 */
export async function collectStage(ctx: StageCtx, phase = 0): Promise<Record<string, unknown>> {
  const { now, cfg } = ctx;
  const perSlot = cfg.mode === 'staged' ? 2 : 1;
  const tick = Math.floor(now / SLOT_MS) * perSlot + (perSlot === 2 ? phase : 0);
  const batch = selectFeedBatch(FEEDS, tick, cfg.feedsPerRun);
  return { ...(await collect(ctx, batch)), cycleTicks: Math.max(1, Math.ceil(FEEDS.length / cfg.feedsPerRun)) };
}

/** Research: cluster the pool and have the LLM draft briefings for clusters that can pass the gates. */
export async function researchStage(ctx: StageCtx): Promise<Record<string, unknown>> {
  const { env, now, cfg } = ctx;

  const { results: pool } = await env.DB.prepare(
    `SELECT * FROM feed_items WHERE article_id IS NULL AND offered_count < ?1 AND published_at >= ?2
     ORDER BY published_at DESC LIMIT ?3`,
  )
    .bind(MAX_OFFERS, nowIso(now - POOL_WINDOW_MS), POOL_LIMIT)
    .all<FeedItemRow>();

  const clusters = clusterItems(pool)
    .map((items) => ({ items, ev: evaluateCluster(items, now) }))
    .filter((c) => c.ev.eligible)
    .sort((a, b) => b.ev.priority - a.ev.priority)
    .slice(0, cfg.maxArticlesPerRun)
    .map(
      (c, i): Candidate => ({
        cid: `c${i + 1}`,
        // keep the most credible items if a cluster is large
        items: [...c.items].sort((a, b) => citationFromItem(b).weight - citationFromItem(a).weight).slice(0, MAX_ITEMS_PER_CLUSTER),
        ev: c.ev,
      }),
    );

  const summary = { pool: pool.length, eligibleClusters: clusters.length };
  if (clusters.length === 0) return { ...summary, skipped: 'no cluster can meet the double-sourcing rule yet' };
  if (!ctx.llm) return { ...summary, skipped: 'GEMINI_API_KEY not configured' };

  const payload = {
    clusters: clusters.map((c) => ({
      cluster_id: c.cid,
      category_hint: c.items.find((i) => i.category_hint)?.category_hint ?? null,
      items: c.items.map((i) => ({
        id: i.id,
        source: citationFromItem(i).name,
        published_at: i.published_at,
        title: i.title,
        snippet: (i.snippet ?? '').slice(0, 500),
      })),
    })),
  };

  const out = await ctx.llm.json({ system: RESEARCH_SYSTEM, user: JSON.stringify(payload), schema: ResearchOutput, label: 'research' });

  const byCid = new Map(clusters.map((c) => [c.cid, c]));
  const statements: D1PreparedStatement[] = [];
  const used = new Set<string>();
  const created: string[] = [];
  const ts = nowIso(now);

  for (const b of out.briefings) {
    const cand = byCid.get(b.cluster_id);
    if (!cand) continue;
    const members = new Map(cand.items.map((i) => [i.id, i]));
    const ids = [...new Set(b.used_item_ids)].filter((id) => members.has(id));
    const items = ids.map((id) => members.get(id) as FeedItemRow);
    const ev = evaluateCluster(items, now);
    if (items.length === 0 || !ev.eligible) {
      logEvent(ctx, { articleId: null, stage: 'research', outcome: 'skipped', detail: { cluster: b.cluster_id, reason: 'cited items cannot meet the double-sourcing rule' } });
      continue;
    }
    if (created.length >= cfg.maxArticlesPerRun) break;

    const id = `a_${(await sha([...ids].sort().join(','))).slice(0, 16)}`;
    const georgia = b.georgia_related || items.some((i) => i.georgia) ? 1 : 0;
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO articles (id, headline, summary, what_happened, why_it_matters, figures_dates, affected_entities, risks_uncertainty,
           category, georgia_related, source_links, trust_score, grammar_checked, fact_checked, status, published_at, created_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,0,0,0,'raw_research',NULL,?12,?12)`,
      ).bind(id, b.headline, b.summary, b.what_happened, b.why_it_matters, b.figures_dates, b.affected_entities, b.risks_uncertainty, b.category, georgia, JSON.stringify(linksFromCitations(ev.citations)), ts),
      env.DB.prepare(`UPDATE feed_items SET article_id = ?1 WHERE article_id IS NULL AND id IN (SELECT value FROM json_each(?2))`).bind(id, JSON.stringify(ids)),
    );
    ids.forEach((i) => used.add(i));
    created.push(id);
    logEvent(ctx, { articleId: id, stage: 'research', outcome: 'ok', detail: { sources: ev.citations.map((c) => ({ name: c.name, weight: c.weight })), independent: ev.independent } });
  }

  // Everything offered but not used counts as an offer, so stale clusters stop being re-sent.
  const offered = clusters.flatMap((c) => c.items.map((i) => i.id)).filter((id) => !used.has(id));
  if (offered.length) {
    statements.push(env.DB.prepare(`UPDATE feed_items SET offered_count = offered_count + 1 WHERE article_id IS NULL AND id IN (SELECT value FROM json_each(?1))`).bind(JSON.stringify(offered)));
  }
  if (statements.length) await env.DB.batch(statements);

  return { ...summary, drafted: created.length };
}
