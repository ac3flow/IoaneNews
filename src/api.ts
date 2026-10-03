import { TIER_LABEL, tierOf } from './registry/sources';
import { resolveSource } from './registry/trust';
import { PIPELINE_ORDER, STAGE_NAMES, runPipeline, type StageName } from './pipeline/run';
import { parseLinks } from './pipeline/citations';
import { SLOT_MS, TIMEZONE, dayRangeUtc, formatSlot, isDate, nextSlot, nowIso, parseSlotMinute, slotRangeUtc, tbilisiDate } from './time';
import { ARTICLE_CATEGORIES, type ArticleRow, type Env } from './types';

// ─── tabs ───────────────────────────────────────────────────────────────────
export const TABS = [
  { id: 'top10', label: 'Top 10' },
  { id: 'all', label: 'All' },
  { id: 'georgia', label: 'Georgia Focus' },
  { id: 'ai-tech', label: 'AI & Tech', category: 'AI & Tech' },
  { id: 'economics', label: 'Economics', category: 'Economics' },
  { id: 'crypto', label: 'Crypto', category: 'Crypto' },
  { id: 'marketing', label: 'Marketing', category: 'Marketing' },
  { id: 'real-estate', label: 'Real Estate', category: 'Real Estate' },
  { id: 'global-trade', label: 'Global Trade', category: 'Global Trade' },
  { id: 'vc-startups', label: 'VC & Startups', category: 'VC & Startups' },
] as const;

const PUBLISHED = `status = 'published' AND fact_checked = 1`;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

// ─── response helpers ───────────────────────────────────────────────────────
const SECURITY = { 'x-content-type-options': 'nosniff' };

function json(data: unknown, status = 200, cache = 'no-store'): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': cache, ...SECURITY },
  });
}
const fail = (status: number, error: string): Response => json({ error }, status);

// ─── shaping ────────────────────────────────────────────────────────────────
export const LANGS = ['en', 'ka'] as const;
export type Lang = (typeof LANGS)[number];

/** Georgian columns joined in from article_translations (present only for lang=ka queries). */
interface KaColumns {
  k_headline?: string | null;
  k_summary?: string | null;
  k_what_happened?: string | null;
  k_why_it_matters?: string | null;
  k_figures_dates?: string | null;
  k_affected_entities?: string | null;
  k_risks_uncertainty?: string | null;
}
type Row = ArticleRow & KaColumns;

export interface ArticleDto {
  lang: Lang;
  id: string;
  headline: string;
  summary: string;
  what_happened: string;
  why_it_matters: string;
  figures: { label: string; value: string }[];
  affected_entities: string[];
  risks_uncertainty: string;
  category: string;
  georgia_related: boolean;
  sources: { title: string; url: string; trust_score: number; name: string; tier: string }[];
  trust_score: number;
  grammar_checked: boolean;
  fact_checked: boolean;
  /** ISO-8601 UTC. The client renders it in Asia/Tbilisi. */
  published_at: string | null;
  rank?: number;
}

export function parseFigures(s: string | null): { label: string; value: string }[] {
  return (s ?? '')
    .split('\n')
    .map((l) => l.trim().replace(/^[-•*]\s*/, ''))
    .filter(Boolean)
    .map((line) => {
      const i = line.indexOf(':');
      return i > 0 && i < 60 ? { label: line.slice(0, i).trim(), value: line.slice(i + 1).trim() } : { label: '', value: line };
    });
}

export function toDto(r: Row, rank?: number, lang: Lang = 'en'): ArticleDto {
  // For lang=ka the joined translation replaces the English text; everything else is shared.
  const ka = lang === 'ka' && r.k_headline != null;
  const v = ka
    ? {
        headline: r.k_headline ?? r.headline,
        summary: r.k_summary ?? r.summary,
        what_happened: r.k_what_happened ?? r.what_happened,
        why_it_matters: r.k_why_it_matters ?? r.why_it_matters,
        figures_dates: r.k_figures_dates ?? null,
        affected_entities: r.k_affected_entities ?? null,
        risks_uncertainty: r.k_risks_uncertainty ?? '',
      }
    : r;
  const dto: ArticleDto = {
    lang: ka ? 'ka' : 'en',
    id: r.id,
    headline: v.headline,
    summary: v.summary,
    what_happened: v.what_happened,
    why_it_matters: v.why_it_matters,
    figures: parseFigures(v.figures_dates),
    affected_entities: (v.affected_entities ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    risks_uncertainty: v.risks_uncertainty ?? '',
    category: r.category,
    georgia_related: !!r.georgia_related,
    // Only http(s) links ever leave the API, whatever is stored.
    sources: parseLinks(r.source_links)
      .filter((l) => /^https?:\/\//i.test(l.url))
      .map((l) => ({
        ...l,
        name: resolveSource(l.url).name,
        tier: TIER_LABEL[tierOf(l.trust_score, l.trust_score < 2)],
      })),
    trust_score: r.trust_score,
    // For Georgian, "grammar checked" means the Georgian Grammar Checker has passed (the join requires it).
    grammar_checked: ka ? true : !!r.grammar_checked,
    fact_checked: !!r.fact_checked,
    published_at: r.published_at,
  };
  if (rank !== undefined) dto.rank = rank;
  return dto;
}

// ─── GET /api/articles ──────────────────────────────────────────────────────
export interface ListQuery {
  lang: Lang;
  tab: string;
  date?: string;
  slot?: number;
  limit: number;
  before?: { at: string; id: string };
}

export function parseListQuery(sp: URLSearchParams): ListQuery | { error: string } {
  const tab = sp.get('tab') ?? 'all';
  if (!TABS.some((t) => t.id === tab)) return { error: `unknown tab "${tab}"` };

  const lang = sp.get('lang') ?? 'en';
  if (!LANGS.includes(lang as Lang)) return { error: `lang must be one of ${LANGS.join(', ')}` };

  const q: ListQuery = { lang: lang as Lang, tab, limit: DEFAULT_LIMIT };
  const date = sp.get('date');
  if (date) {
    if (!isDate(date)) return { error: 'date must be YYYY-MM-DD (Asia/Tbilisi)' };
    q.date = date;
  }
  const time = sp.get('time');
  if (time) {
    const slot = parseSlotMinute(time);
    if (slot === null) return { error: 'time must be HH:MM, 24-hour (Asia/Tbilisi)' };
    q.slot = slot;
  }
  const limit = sp.get('limit');
  if (limit) {
    const n = Number.parseInt(limit, 10);
    if (!Number.isFinite(n) || n < 1) return { error: 'limit must be a positive integer' };
    q.limit = Math.min(n, MAX_LIMIT);
  }
  const before = sp.get('before');
  if (before) {
    const m = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\|([A-Za-z0-9_-]{1,64})$/.exec(before);
    if (!m) return { error: 'before must be a cursor returned by this API' };
    q.before = { at: m[1] as string, id: m[2] as string };
  }
  return q;
}

/** Tbilisi minute-of-day (0–1439) of published_at. Tbilisi is a fixed UTC+4. */
const MINUTE_OF_DAY = `(CAST(strftime('%H', published_at, '+4 hours') AS INTEGER) * 60 + CAST(strftime('%M', published_at, '+4 hours') AS INTEGER))`;

function filters(q: Pick<ListQuery, 'tab' | 'date' | 'slot'>): { where: string[]; binds: (string | number)[]; bind: (v: string | number) => string } {
  const where: string[] = [PUBLISHED];
  const binds: (string | number)[] = [];
  const bind = (v: string | number): string => {
    binds.push(v);
    return `?${binds.length}`;
  };

  if (q.tab === 'georgia') where.push('georgia_related = 1');
  const cat = TABS.find((t) => t.id === q.tab && 'category' in t);
  if (cat && 'category' in cat) where.push(`category = ${bind(cat.category)}`);

  // Time filters. published_at is stored as UTC ISO-8601.
  if (q.date && q.slot !== undefined) {
    const { start, end } = slotRangeUtc(q.date, q.slot);
    where.push(`published_at >= ${bind(start)} AND published_at < ${bind(end)}`);
  } else if (q.date) {
    const { start, end } = dayRangeUtc(q.date);
    where.push(`published_at >= ${bind(start)} AND published_at < ${bind(end)}`);
  } else if (q.slot !== undefined) {
    where.push(`${MINUTE_OF_DAY} BETWEEN ${bind(q.slot)} AND ${bind(q.slot + SLOT_MS / 60_000 - 1)}`);
  }
  return { where, binds, bind };
}

const KA_COLUMNS = `t.headline AS k_headline, t.summary AS k_summary, t.what_happened AS k_what_happened, t.why_it_matters AS k_why_it_matters,
  t.figures_dates AS k_figures_dates, t.affected_entities AS k_affected_entities, t.risks_uncertainty AS k_risks_uncertainty`;

/** Georgian reads join the finished translation; a story without one is simply not listed in Georgian. */
function source(lang: Lang): { select: string; from: string } {
  return lang === 'ka'
    ? { select: `a.*, ${KA_COLUMNS}`, from: `articles a JOIN article_translations t ON t.article_id = a.id AND t.lang = 'ka' AND t.grammar_checked = 1` }
    : { select: 'a.*', from: 'articles a' };
}

export function buildListSql(q: ListQuery): { sql: string; binds: (string | number)[] } {
  const { where, binds, bind } = filters(q);
  const { select, from } = source(q.lang);
  if (q.tab === 'top10') {
    return { sql: `SELECT ${select} FROM ${from} WHERE ${where.join(' AND ')} ORDER BY trust_score DESC, published_at DESC, id DESC LIMIT 10`, binds };
  }
  if (q.before) {
    const a = bind(q.before.at);
    const i = bind(q.before.id);
    where.push(`(published_at < ${a} OR (published_at = ${a} AND id < ${i}))`);
  }
  // one extra row tells us whether another page exists
  return { sql: `SELECT ${select} FROM ${from} WHERE ${where.join(' AND ')} ORDER BY published_at DESC, id DESC LIMIT ${q.limit + 1}`, binds };
}

async function listArticles(env: Env, sp: URLSearchParams): Promise<Response> {
  const q = parseListQuery(sp);
  if ('error' in q) return fail(400, q.error);
  const { sql, binds } = buildListSql(q);
  const { results } = await env.DB.prepare(sql).bind(...binds).all<Row>();

  const isTop = q.tab === 'top10';
  const page = isTop ? results : results.slice(0, q.limit);
  const last = page[page.length - 1];
  const nextBefore = !isTop && results.length > q.limit && last?.published_at ? `${last.published_at}|${last.id}` : null;

  return json(
    {
      tab: q.tab,
      lang: q.lang,
      timezone: TIMEZONE,
      filter: { date: q.date ?? null, time: q.slot === undefined ? null : formatSlot(q.slot) },
      articles: page.map((r, i) => toDto(r, isTop ? i + 1 : undefined, q.lang)),
      nextBefore,
    },
    200,
    'public, max-age=30, stale-while-revalidate=60',
  );
}

async function getArticle(env: Env, id: string, langParam: string | null): Promise<Response> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return fail(400, 'invalid id');
  const lang = langParam ?? 'en';
  if (!LANGS.includes(lang as Lang)) return fail(400, `lang must be one of ${LANGS.join(', ')}`);
  const { select, from } = source(lang as Lang);
  const row = await env.DB.prepare(`SELECT ${select} FROM ${from} WHERE a.id = ?1 AND ${PUBLISHED}`).bind(id).first<Row>();
  if (!row) return fail(404, 'not found');
  const audit = await env.DB.prepare(`SELECT detail FROM pipeline_events WHERE article_id = ?1 AND stage = 'fact_check' AND outcome = 'ok' ORDER BY id DESC LIMIT 1`).bind(id).first<{ detail: string | null }>();
  let trust: unknown = null;
  try {
    const d = audit?.detail ? (JSON.parse(audit.detail) as Record<string, unknown>) : null;
    if (d) trust = { breakdown: d.breakdown, claims: d.claims, independentSources: d.independentSources };
  } catch {
    /* audit detail is best-effort */
  }
  return json({ article: toDto(row, undefined, lang as Lang), trust }, 200, 'public, max-age=60');
}

// ─── GET /api/slots ─────────────────────────────────────────────────────────
/** Published-story counts per 5-minute Tbilisi slot for one day: powers the UI's time tape. */
async function slots(env: Env, sp: URLSearchParams): Promise<Response> {
  const tab = sp.get('tab') ?? 'all';
  if (!TABS.some((t) => t.id === tab)) return fail(400, `unknown tab "${tab}"`);
  const date = sp.get('date') ?? tbilisiDate();
  if (!isDate(date)) return fail(400, 'date must be YYYY-MM-DD (Asia/Tbilisi)');

  const { where, binds } = filters({ tab, date });
  const { results } = await env.DB.prepare(`SELECT CAST(${MINUTE_OF_DAY} / 5 AS INTEGER) AS slot, COUNT(*) AS n FROM articles WHERE ${where.join(' AND ')} GROUP BY slot`)
    .bind(...binds)
    .all<{ slot: number; n: number }>();
  return json({ date, timezone: TIMEZONE, slots: Object.fromEntries(results.map((r) => [r.slot, r.n])) }, 200, 'public, max-age=30');
}

// ─── GET /api/meta, /api/status ─────────────────────────────────────────────
async function meta(env: Env): Promise<Response> {
  const [counts, last, run] = await Promise.all([
    env.DB.prepare(`SELECT category, COUNT(*) AS n, SUM(georgia_related) AS g FROM articles WHERE ${PUBLISHED} GROUP BY category`).all<{ category: string; n: number; g: number }>(),
    env.DB.prepare(`SELECT MAX(published_at) AS t FROM articles WHERE ${PUBLISHED}`).first<{ t: string | null }>(),
    env.DB.prepare(`SELECT MAX(finished_at) AS t FROM pipeline_runs WHERE finished_at IS NOT NULL`).first<{ t: string | null }>(),
  ]);
  const byCategory: Record<string, number> = Object.fromEntries(ARTICLE_CATEGORIES.map((c) => [c, 0]));
  let total = 0;
  let georgia = 0;
  for (const r of counts.results) {
    byCategory[r.category] = (byCategory[r.category] ?? 0) + r.n;
    total += r.n;
    georgia += r.g ?? 0;
  }
  const now = Date.now();
  return json(
    {
      timezone: TIMEZONE,
      now: nowIso(now),
      nextRunAt: nowIso(nextSlot(now)),
      lastPublishedAt: last?.t ?? null,
      lastRunAt: run?.t ?? null,
      counts: { total, georgia, byCategory },
      tabs: TABS.map(({ id, label }) => ({ id, label })),
    },
    200,
    'public, max-age=30',
  );
}

async function status(env: Env): Promise<Response> {
  const since = nowIso(Date.now() - 24 * 3600_000);
  const [run, queue, feedErrors] = await Promise.all([
    env.DB.prepare(`SELECT run_id, trigger, started_at, finished_at, status, stats FROM pipeline_runs ORDER BY started_at DESC LIMIT 1`).first<Record<string, string | null>>(),
    env.DB.prepare(`SELECT status, COUNT(*) AS n FROM articles GROUP BY status`).all<{ status: string; n: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM pipeline_events WHERE stage = 'feed' AND outcome = 'error' AND created_at >= ?1`).bind(since).first<{ n: number }>(),
  ]);
  return json({
    ok: run?.status !== 'error',
    llmConfigured: !!env.GEMINI_API_KEY,
    lastRun: run ? { startedAt: run.started_at, finishedAt: run.finished_at, status: run.status, trigger: run.trigger } : null,
    articles: Object.fromEntries(queue.results.map((r) => [r.status, r.n])),
    feedErrors24h: feedErrors?.n ?? 0,
  });
}

// ─── POST /api/run[/stage] (admin) ──────────────────────────────────────────
async function authorised(req: Request, env: Env): Promise<boolean> {
  if (!env.ADMIN_KEY) return false;
  const header = req.headers.get('x-admin-key') ?? /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') ?? '')?.[1] ?? '';
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(header)), crypto.subtle.digest('SHA-256', enc.encode(env.ADMIN_KEY))]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= (x[i] as number) ^ (y[i] as number);
  return diff === 0;
}

// ─── router ─────────────────────────────────────────────────────────────────
export async function handleApi(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  try {
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (path === '/api/articles') return await listArticles(env, url.searchParams);
      const one = /^\/api\/articles\/([^/]+)$/.exec(path);
      if (one) return await getArticle(env, decodeURIComponent(one[1] as string), url.searchParams.get('lang'));
      if (path === '/api/slots') return await slots(env, url.searchParams);
      if (path === '/api/meta') return await meta(env);
      if (path === '/api/status') return await status(env);
    }

    const run = /^\/api\/run(?:\/([a-z_]+))?$/.exec(path);
    if (run) {
      if (req.method !== 'POST') return fail(405, 'use POST');
      if (!(await authorised(req, env))) return fail(401, 'unauthorized');
      const stage = run[1] as StageName | undefined;
      if (stage && !STAGE_NAMES.includes(stage)) return fail(404, `unknown stage "${stage}" (use ${PIPELINE_ORDER.join(', ')})`);
      return json(await runPipeline(env, { trigger: 'manual', stages: stage ? [stage] : undefined }));
    }

    return fail(404, 'not found');
  } catch (e) {
    console.error('api error:', e);
    return fail(500, 'internal error');
  }
}
