import { describe, expect, it } from 'vitest';
import { handleApi, parseFigures, parseListQuery } from '../src/api';
import { insertArticle, insertTranslation, makeEnv } from './helpers';

type Env = ReturnType<typeof makeEnv>;

async function get(env: Env, path: string) {
  const res = await handleApi(new Request(`https://news.test${path}`), env);
  return { status: res.status, body: (await res.json()) as any, headers: res.headers };
}

const pub = (env: Env, id: string, at: string, extra: Record<string, unknown> = {}) =>
  insertArticle(env, { id, status: 'published', fact_checked: 1, grammar_checked: 1, published_at: at, trust_score: 70, headline: `Headline ${id} goes here`, ...extra });

describe('GET /api/articles', () => {
  it('returns only published, fact-checked articles, newest first, with sources enriched', async () => {
    const env = makeEnv();
    pub(env, 'a1', '2026-10-03T10:00:00.000Z', { source_links: JSON.stringify([{ title: 'Fed statement', url: 'https://www.federalreserve.gov/x', trust_score: 5 }, { title: 'HN', url: 'https://news.ycombinator.com/item?id=1', trust_score: 1.5 }, { title: 'bad', url: 'javascript:alert(1)', trust_score: 5 }]), figures_dates: 'Rate: 4.25%\n- Next meeting: 28 October\nplain line', affected_entities: 'Fed, Markets , ' });
    pub(env, 'a2', '2026-10-03T11:00:00.000Z');
    insertArticle(env, { id: 'raw', status: 'raw_research' });
    insertArticle(env, { id: 'rej', status: 'rejected', fact_checked: 1, published_at: '2026-10-03T12:00:00.000Z' });
    insertArticle(env, { id: 'unchecked', status: 'published', fact_checked: 0, published_at: '2026-10-03T12:30:00.000Z' });

    const { status, body } = await get(env, '/api/articles');
    expect(status).toBe(200);
    expect(body.timezone).toBe('Asia/Tbilisi');
    expect(body.articles.map((a: any) => a.id)).toEqual(['a2', 'a1']);
    const a1 = body.articles[1];
    expect(a1.figures).toEqual([{ label: 'Rate', value: '4.25%' }, { label: 'Next meeting', value: '28 October' }, { label: '', value: 'plain line' }]);
    expect(a1.affected_entities).toEqual(['Fed', 'Markets']);
    expect(a1.sources).toEqual([
      { title: 'Fed statement', url: 'https://www.federalreserve.gov/x', trust_score: 5, name: 'Fed', tier: 'Primary / official' },
      { title: 'HN', url: 'https://news.ycombinator.com/item?id=1', trust_score: 1.5, name: 'Hacker News', tier: 'Social signal' },
    ]);
    expect(a1.published_at).toBe('2026-10-03T10:00:00.000Z'); // UTC on the wire
  });

  it('Top 10 is strictly trust_score DESC LIMIT 10 (ties: newest first), with ranks', async () => {
    const env = makeEnv();
    const scores = [55, 91, 70, 88, 91, 62, 99, 70, 81, 76, 64, 93];
    scores.forEach((s, i) => pub(env, `t${String(i).padStart(2, '0')}`, `2026-10-03T${String(i).padStart(2, '0')}:00:00.000Z`, { trust_score: s }));
    const { body } = await get(env, '/api/articles?tab=top10&limit=3');
    expect(body.articles).toHaveLength(10);
    expect(body.articles.map((a: any) => a.trust_score)).toEqual([99, 93, 91, 91, 88, 81, 76, 70, 70, 64]);
    expect(body.articles.map((a: any) => a.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(body.articles[2].id).toBe('t04'); // tie at 91: newer (04:00) before older (01:00)
    expect(body.nextBefore).toBeNull();
  });

  it('filters Georgia Focus by flag and categories by tab', async () => {
    const env = makeEnv();
    pub(env, 'g', '2026-10-03T10:00:00.000Z', { georgia_related: 1, category: 'Economics' });
    pub(env, 'e', '2026-10-03T10:01:00.000Z', { category: 'Economics' });
    pub(env, 'c', '2026-10-03T10:02:00.000Z', { category: 'Crypto' });
    pub(env, 'v', '2026-10-03T10:03:00.000Z', { category: 'VC & Startups' });
    const ids = async (q: string) => (await get(env, `/api/articles?${q}`)).body.articles.map((a: any) => a.id);
    expect(await ids('tab=georgia')).toEqual(['g']);
    expect(await ids('tab=economics')).toEqual(['e', 'g']);
    expect(await ids('tab=crypto')).toEqual(['c']);
    expect(await ids('tab=vc-startups')).toEqual(['v']);
    expect(await ids('tab=all')).toEqual(['v', 'c', 'e', 'g']);
    expect(await ids('tab=real-estate')).toEqual([]);
  });

  describe('5-minute time search (Asia/Tbilisi = UTC+4)', () => {
    const seed = (env: Env) => {
      pub(env, 'in-start', '2026-10-03T13:15:00.000Z'); // 17:15:00 Tbilisi
      pub(env, 'in-mid', '2026-10-03T13:17:42.500Z'); //   17:17
      pub(env, 'in-end', '2026-10-03T13:19:59.999Z'); //   17:19:59
      pub(env, 'out-next', '2026-10-03T13:20:00.000Z'); // 17:20 -> next slot
      pub(env, 'out-prev', '2026-10-03T13:14:59.999Z'); // 17:14
      pub(env, 'other-day', '2026-10-02T13:16:00.000Z'); // 17:16 on the previous day
      pub(env, 'morning', '2026-10-03T05:30:00.000Z'); //   09:30
      pub(env, 'late-night', '2026-10-03T19:57:00.000Z'); // 23:57
      pub(env, 'after-midnight', '2026-10-03T20:02:00.000Z'); // 00:02 next Tbilisi day
    };

    it('matches the half-open window [HH:MM, HH:MM+5) on any day', async () => {
      const env = makeEnv();
      seed(env);
      const { body } = await get(env, '/api/articles?time=17:15');
      expect(body.filter).toEqual({ date: null, time: '17:15' });
      expect(body.articles.map((a: any) => a.id).sort()).toEqual(['in-end', 'in-mid', 'in-start', 'other-day']);
    });

    it('snaps an off-grid minute down to its slot', async () => {
      const env = makeEnv();
      seed(env);
      const { body } = await get(env, '/api/articles?time=17:18');
      expect(body.filter.time).toBe('17:15');
      expect(body.articles).toHaveLength(4);
    });

    it('combines with a Tbilisi calendar date', async () => {
      const env = makeEnv();
      seed(env);
      const d3 = await get(env, '/api/articles?time=17:15&date=2026-10-03');
      expect(d3.body.articles.map((a: any) => a.id).sort()).toEqual(['in-end', 'in-mid', 'in-start']);
      const d2 = await get(env, '/api/articles?time=17:15&date=2026-10-02');
      expect(d2.body.articles.map((a: any) => a.id)).toEqual(['other-day']);
    });

    it('finds the morning slot and handles the day boundary', async () => {
      const env = makeEnv();
      seed(env);
      expect((await get(env, '/api/articles?time=09:30')).body.articles.map((a: any) => a.id)).toEqual(['morning']);
      expect((await get(env, '/api/articles?time=23:55')).body.articles.map((a: any) => a.id)).toEqual(['late-night']);
      // 00:02 Tbilisi on 4 Oct belongs to the 4 Oct Tbilisi date, not 3 Oct
      expect((await get(env, '/api/articles?time=00:00')).body.articles.map((a: any) => a.id)).toEqual(['after-midnight']);
      expect((await get(env, '/api/articles?time=00:00&date=2026-10-04')).body.articles.map((a: any) => a.id)).toEqual(['after-midnight']);
      expect((await get(env, '/api/articles?time=00:00&date=2026-10-03')).body.articles).toEqual([]);
    });

    it('a date alone returns the whole Tbilisi day', async () => {
      const env = makeEnv();
      seed(env);
      const ids = (await get(env, '/api/articles?date=2026-10-03&limit=50')).body.articles.map((a: any) => a.id);
      expect(ids).toContain('late-night');
      expect(ids).not.toContain('after-midnight');
      expect(ids).not.toContain('other-day');
    });

    it('works together with a tab, and Top 10 respects it', async () => {
      const env = makeEnv();
      pub(env, 'a', '2026-10-03T13:16:00.000Z', { trust_score: 60, georgia_related: 1 });
      pub(env, 'b', '2026-10-03T13:17:00.000Z', { trust_score: 95 });
      pub(env, 'c', '2026-10-03T08:00:00.000Z', { trust_score: 99 });
      expect((await get(env, '/api/articles?time=17:15&tab=georgia')).body.articles.map((a: any) => a.id)).toEqual(['a']);
      expect((await get(env, '/api/articles?time=17:15&tab=top10')).body.articles.map((a: any) => a.id)).toEqual(['b', 'a']);
    });
  });

  it('paginates with a stable cursor, including identical timestamps', async () => {
    const env = makeEnv();
    for (let i = 0; i < 7; i++) pub(env, `p${i}`, `2026-10-03T10:0${Math.floor(i / 2)}:00.000Z`); // pairs share a timestamp
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const { body } = await get(env, `/api/articles?limit=3${cursor ? `&before=${encodeURIComponent(cursor)}` : ''}`);
      seen.push(...body.articles.map((a: any) => a.id));
      cursor = body.nextBefore;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
  });

  it('rejects malformed parameters with 400, never SQL errors', async () => {
    const env = makeEnv();
    for (const q of ['tab=nope', 'time=25:00', 'time=9:30', 'date=2026-13-40', 'date=yesterday', 'limit=0', 'limit=abc', "before=x'; DROP TABLE articles;--", 'tab=all%27--']) {
      const r = await get(env, `/api/articles?${q}`);
      expect(r.status, q).toBe(400);
    }
    expect((await get(env, '/api/articles?limit=9999')).status).toBe(200);
    expect(parseListQuery(new URLSearchParams('limit=9999'))).toMatchObject({ limit: 50 });
  });
});

describe('Georgian (lang=ka)', () => {
  const seed = (env: Env) => {
    pub(env, 'a1', '2026-10-03T10:00:00.000Z', { trust_score: 90, figures_dates: 'Rate: 4.25%', affected_entities: 'Fed, Markets' });
    insertTranslation(env, 'a1', { headline: 'ფედმა განაკვეთი არ შეცვალა', figures_dates: 'განაკვეთი: 4.25%', affected_entities: 'ფედი, ბაზრები' });
    pub(env, 'a2', '2026-10-03T11:00:00.000Z', { trust_score: 70 });
    insertTranslation(env, 'a2', { grammar_checked: 0 }); // translated but not yet grammar-checked
    pub(env, 'a3', '2026-10-03T12:00:00.000Z', { trust_score: 80 }); // no translation at all
  };

  it('defaults to English and returns every published story', async () => {
    const env = makeEnv();
    seed(env);
    const { body } = await get(env, '/api/articles');
    expect(body.lang).toBe('en');
    expect(body.articles.map((a: any) => a.id)).toEqual(['a3', 'a2', 'a1']);
    expect(body.articles[2].headline).toBe('Headline a1 goes here');
  });

  it('lang=ka returns the Georgian text, and only stories whose Georgian passed the grammar check', async () => {
    const env = makeEnv();
    seed(env);
    const { body } = await get(env, '/api/articles?lang=ka');
    expect(body.lang).toBe('ka');
    expect(body.articles.map((a: any) => a.id)).toEqual(['a1']);
    const a = body.articles[0];
    expect(a).toMatchObject({ lang: 'ka', headline: 'ფედმა განაკვეთი არ შეცვალა', grammar_checked: true, trust_score: 90 });
    expect(a.figures).toEqual([{ label: 'განაკვეთი', value: '4.25%' }]);
    expect(a.affected_entities).toEqual(['ფედი', 'ბაზრები']);
    expect(a.sources[0].name).toBe('Reuters'); // sources are shared across languages
  });

  it('tabs, Top 10, time filters and cursors all work in Georgian', async () => {
    const env = makeEnv();
    for (let i = 0; i < 4; i++) {
      pub(env, `k${i}`, `2026-10-03T13:1${i}:00.000Z`, { trust_score: 60 + i, category: i % 2 ? 'Crypto' : 'Economics', georgia_related: i === 0 ? 1 : 0 });
      insertTranslation(env, `k${i}`);
    }
    const ids = async (q: string) => (await get(env, `/api/articles?lang=ka&${q}`)).body.articles.map((a: any) => a.id);
    expect(await ids('tab=crypto')).toEqual(['k3', 'k1']);
    expect(await ids('tab=georgia')).toEqual(['k0']);
    expect(await ids('tab=top10')).toEqual(['k3', 'k2', 'k1', 'k0']);
    expect(await ids('time=17:10')).toEqual(['k3', 'k2', 'k1', 'k0']);
    const page1 = (await get(env, '/api/articles?lang=ka&limit=2')).body;
    expect(page1.articles.map((a: any) => a.id)).toEqual(['k3', 'k2']);
    expect((await get(env, `/api/articles?lang=ka&limit=2&before=${encodeURIComponent(page1.nextBefore)}`)).body.articles.map((a: any) => a.id)).toEqual(['k1', 'k0']);
  });

  it('GET /api/articles/:id supports lang, and 404s in Georgian without a finished translation', async () => {
    const env = makeEnv();
    seed(env);
    expect((await get(env, '/api/articles/a1?lang=ka')).body.article.headline).toBe('ფედმა განაკვეთი არ შეცვალა');
    expect((await get(env, '/api/articles/a1')).body.article.headline).toBe('Headline a1 goes here');
    expect((await get(env, '/api/articles/a3?lang=ka')).status).toBe(404);
    expect((await get(env, '/api/articles/a3')).status).toBe(200);
  });

  it('rejects unknown languages', async () => {
    const env = makeEnv();
    expect((await get(env, '/api/articles?lang=fr')).status).toBe(400);
    expect((await get(env, '/api/articles/a1?lang=fr')).status).toBe(400);
  });
});

describe('other endpoints', () => {
  it('GET /api/slots counts published stories per 5-minute Tbilisi slot for a day', async () => {
    const env = makeEnv();
    pub(env, 's1', '2026-10-03T13:15:00.000Z'); // 17:15 -> slot 207
    pub(env, 's2', '2026-10-03T13:19:59.000Z'); // 17:19 -> slot 207
    pub(env, 's3', '2026-10-03T05:30:00.000Z', { category: 'Crypto' }); // 09:30 -> slot 114
    pub(env, 's4', '2026-10-03T19:59:00.000Z'); // 23:59 -> slot 287
    pub(env, 's5', '2026-10-03T20:00:00.000Z'); // 00:00 on 4 Oct -> other day
    insertArticle(env, { id: 'hidden', status: 'rejected', fact_checked: 1, published_at: '2026-10-03T13:16:00.000Z' });

    const day = await get(env, '/api/slots?date=2026-10-03');
    expect(day.status).toBe(200);
    expect(day.body).toEqual({ date: '2026-10-03', timezone: 'Asia/Tbilisi', slots: { '207': 2, '114': 1, '287': 1 } });
    expect((await get(env, '/api/slots?date=2026-10-03&tab=crypto')).body.slots).toEqual({ '114': 1 });
    expect((await get(env, '/api/slots?date=2026-10-04')).body.slots).toEqual({ '0': 1 });
    expect((await get(env, '/api/slots?date=nope')).status).toBe(400);
    expect((await get(env, '/api/slots?tab=zzz')).status).toBe(400);
    expect((await get(env, '/api/slots')).status).toBe(200); // defaults to today in Tbilisi
  });

  it('GET /api/articles/:id returns the article and its trust breakdown', async () => {
    const env = makeEnv();
    pub(env, 'x1', '2026-10-03T10:00:00.000Z');
    env.DB.raw.prepare(`INSERT INTO pipeline_events (article_id, stage, outcome, detail, created_at) VALUES ('x1','fact_check','ok',?, 'now')`).run(JSON.stringify({ breakdown: { credibility: 40 }, claims: { total: 3 }, independentSources: 2 }));
    const r = await get(env, '/api/articles/x1');
    expect(r.status).toBe(200);
    expect(r.body.article.id).toBe('x1');
    expect(r.body.trust.breakdown.credibility).toBe(40);
    expect((await get(env, '/api/articles/missing')).status).toBe(404);
    expect((await get(env, '/api/articles/bad%20id')).status).toBe(400);
  });

  it('GET /api/meta reports tabs, counts and the next cron slot', async () => {
    const env = makeEnv();
    pub(env, 'm1', '2026-10-03T10:00:00.000Z', { category: 'Crypto', georgia_related: 1 });
    pub(env, 'm2', '2026-10-03T11:00:00.000Z', { category: 'Crypto' });
    const { body } = await get(env, '/api/meta');
    expect(body.counts).toMatchObject({ total: 2, georgia: 1 });
    expect(body.counts.byCategory.Crypto).toBe(2);
    expect(body.tabs.map((t: any) => t.label)).toEqual(['Top 10', 'All', 'Georgia Focus', 'AI & Tech', 'Economics', 'Crypto', 'Marketing', 'Real Estate', 'Global Trade', 'VC & Startups']);
    expect(Date.parse(body.nextRunAt) % 300_000).toBe(0);
    expect(Date.parse(body.nextRunAt)).toBeGreaterThan(Date.parse(body.now));
    expect(body.lastPublishedAt).toBe('2026-10-03T11:00:00.000Z');
    expect(body.lastRunAt).toBeNull();
    env.DB.raw.prepare(`INSERT INTO pipeline_runs (run_id, trigger, started_at, finished_at, status) VALUES ('r','cron','2026-10-03T13:15:00.000Z','2026-10-03T13:15:20.000Z','ok')`).run();
    expect((await get(env, '/api/meta')).body.lastRunAt).toBe('2026-10-03T13:15:20.000Z');
  });

  it('GET /api/status exposes health without secrets', async () => {
    const env = makeEnv({ GEMINI_API_KEY: 'sk-secret' });
    insertArticle(env, { id: 'q', status: 'raw_research' });
    const { body } = await get(env, '/api/status');
    expect(body.llmConfigured).toBe(true);
    expect(body.articles).toEqual({ raw_research: 1 });
    expect(JSON.stringify(body)).not.toContain('sk-secret');
  });

  it('POST /api/run requires the admin key (header or bearer), is disabled without one, and rejects GET', async () => {
    const call = (env: Env, init: RequestInit, path = '/api/run/research') => handleApi(new Request(`https://news.test${path}`, init), env);
    const off = makeEnv();
    expect((await call(off, { method: 'POST', headers: { 'x-admin-key': 'anything' } })).status).toBe(401);

    const env = makeEnv({ ADMIN_KEY: 's3cret' });
    expect((await call(env, { method: 'POST' })).status).toBe(401);
    expect((await call(env, { method: 'POST', headers: { 'x-admin-key': 'wrong' } })).status).toBe(401);
    expect((await call(env, { method: 'POST', headers: { 'x-admin-key': 's3crett' } })).status).toBe(401);
    expect((await call(env, { method: 'GET' })).status).toBe(405);
    expect((await call(env, { method: 'POST', headers: { 'x-admin-key': 's3cret' } }, '/api/run/bogus')).status).toBe(404);

    const ok = await call(env, { method: 'POST', headers: { authorization: 'Bearer s3cret' } }, '/api/run/edit');
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as any;
    expect(body.status).toBe('ok');
    expect(body.stages.edit.skipped).toBeDefined();
  });

  it('unknown routes 404 as JSON', async () => {
    const r = await get(makeEnv(), '/api/nope');
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('not found');
  });
});

describe('parseFigures', () => {
  it('handles bullets, colons in values, and empty input', () => {
    expect(parseFigures(null)).toEqual([]);
    expect(parseFigures('')).toEqual([]);
    expect(parseFigures('* Meeting: 28 Oct, 14:00')).toEqual([{ label: 'Meeting', value: '28 Oct, 14:00' }]);
  });
});
