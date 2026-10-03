import { afterEach, describe, expect, it, vi } from 'vitest';
import { numbersPreserved } from '../src/pipeline/numbers';
import { PIPELINE_ORDER, runPipeline } from '../src/pipeline/run';
import { selectFeedBatch } from '../src/pipeline/research';
import { FEEDS } from '../src/registry/sources';
import type { ArticleRow } from '../src/types';
import { fakeLlm, insertArticle, makeEnv, rows, rss, stubFeeds } from './helpers';

const NOW = Date.parse('2026-10-03T13:15:00Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3600_000).toUTCString();

const FED = 'https://www.federalreserve.gov/feeds/press_all.xml';
const COINDESK = 'https://www.coindesk.com/arc/outboundfeeds/rss/';
const THEBLOCK = 'https://www.theblock.co/rss.xml';
const WIRED = 'https://www.wired.com/feed/rss';
const HN = 'https://news.ycombinator.com/rss';
const NBG = 'https://nbg.gov.ge/en/media/news';

afterEach(() => vi.unstubAllGlobals());

describe('end-to-end pipeline: Research -> Edit -> Fact-Check -> Publish/Reject', () => {
  it('publishes primary-sourced and double-sourced stories and leaves the rest', async () => {
    const env = makeEnv();
    stubFeeds({
      [FED]: rss([{ title: 'Federal Reserve issues FOMC statement holding rates at 4.25 percent', link: 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20261003a.htm', pub: hoursAgo(2), desc: 'The Committee decided to maintain the target range at 4.25 percent.' }]),
      [COINDESK]: rss([{ title: 'Bitcoin ETFs record $1.2 billion inflows as price tops $120,000', link: 'https://www.coindesk.com/markets/2026/10/03/bitcoin-etf-inflows', pub: hoursAgo(3) }]),
      [THEBLOCK]: rss([{ title: 'Bitcoin ETF inflows reach $1.2 billion, price tops $120,000', link: 'https://www.theblock.co/post/1/bitcoin-etf-inflows', pub: hoursAgo(1) }]),
      [WIRED]: rss([{ title: 'A single-source gadget review nobody else covered', link: 'https://www.wired.com/story/gadget', pub: hoursAgo(1) }]),
      [HN]: rss([{ title: 'Show HN: a social-only rumour about a merger', link: 'https://obscure-blog.example/rumour', pub: hoursAgo(1) }]),
    });
    const llm = fakeLlm();

    const r = await runPipeline(env, { trigger: 'manual', now: NOW, llm });
    expect(r.status).toBe('ok');
    expect(llm.calls).toEqual(['research', 'edit', 'fact_check', 'translate', 'ka_grammar']);

    const articles = rows<ArticleRow>(env, `SELECT * FROM articles ORDER BY created_at, id`);
    expect(articles).toHaveLength(2);
    // Georgian version exists, was grammar-checked, and the article was published only after that
    const ka = rows<{ article_id: string; grammar_checked: number; headline: string }>(env, `SELECT * FROM article_translations WHERE lang='ka'`);
    expect(ka).toHaveLength(2);
    for (const t of ka) {
      expect(t.grammar_checked).toBe(1);
      expect(t.headline).toContain('ქართული');
    }
    for (const a of articles) {
      expect(a.status).toBe('published');
      expect(a.grammar_checked).toBe(1);
      expect(a.fact_checked).toBe(1);
      expect(a.published_at).toBe('2026-10-03T13:15:00.000Z');
    }
    const fed = articles.find((a) => a.source_links.includes('federalreserve.gov'));
    const btc = articles.find((a) => a.source_links.includes('coindesk.com'));
    expect(fed?.trust_score).toBe(80); // 40 + 5 + 20 + 15
    expect(btc?.trust_score).toBe(68); // 28 + 20 + 5 + 15
    expect(JSON.parse(btc?.source_links ?? '[]').map((l: { trust_score: number }) => l.trust_score)).toEqual([3.5, 3.5]);

    // used items are linked to their article; unrelated and social-only items stay in the pool
    const used = rows<{ n: number }>(env, `SELECT COUNT(*) n FROM feed_items WHERE article_id IS NOT NULL`)[0]?.n;
    const pooled = rows<{ title: string }>(env, `SELECT title FROM feed_items WHERE article_id IS NULL ORDER BY title`).map((x) => x.title);
    expect(used).toBe(3);
    expect(pooled).toEqual(['A single-source gadget review nobody else covered', 'Show HN: a social-only rumour about a merger']);

    // audit trail: breakdown stored for every fact-check decision, feed failures logged
    const audits = rows<{ detail: string }>(env, `SELECT detail FROM pipeline_events WHERE stage='fact_check' AND outcome='ok'`);
    expect(audits).toHaveLength(2);
    expect(JSON.parse(audits[0]?.detail ?? '{}').breakdown).toBeDefined();
    expect(rows<{ n: number }>(env, `SELECT COUNT(*) n FROM pipeline_events WHERE stage='feed' AND outcome='error'`)[0]?.n).toBeGreaterThan(10);
    expect(rows<{ status: string }>(env, `SELECT status FROM pipeline_runs`)[0]?.status).toBe('ok');
  });

  it('makes no LLM call when nothing can meet the double-sourcing rule', async () => {
    const env = makeEnv();
    stubFeeds({ [WIRED]: rss([{ title: 'Only one tech outlet has this story today', link: 'https://www.wired.com/story/x', pub: hoursAgo(1) }]) });
    const llm = fakeLlm();
    const r = await runPipeline(env, { trigger: 'cron', now: NOW, llm });
    expect(llm.calls).toEqual([]);
    expect((r.stages.research as { skipped: string }).skipped).toMatch(/double-sourcing/);
  });

  it('corroboration can arrive in a later run (rolling pool)', async () => {
    const env = makeEnv();
    const llm = fakeLlm();
    stubFeeds({ [COINDESK]: rss([{ title: 'Ethereum upgrade goes live reducing fees by 40 percent', link: 'https://www.coindesk.com/eth-upgrade', pub: hoursAgo(4) }]) });
    await runPipeline(env, { trigger: 'cron', now: NOW, llm });
    expect(llm.calls).toEqual([]);

    stubFeeds({
      [COINDESK]: rss([{ title: 'Ethereum upgrade goes live reducing fees by 40 percent', link: 'https://www.coindesk.com/eth-upgrade', pub: hoursAgo(4) }]),
      [THEBLOCK]: rss([{ title: 'Ethereum upgrade is live, cutting fees by 40 percent', link: 'https://www.theblock.co/eth-upgrade', pub: hoursAgo(0.2) }]),
    });
    await runPipeline(env, { trigger: 'cron', now: NOW + 5 * 60_000, llm });
    expect(llm.calls[0]).toBe('research');
    expect(rows<{ status: string }>(env, `SELECT status FROM articles`)[0]?.status).toBe('published');
  });

  it('page feeds: links present on first sight are baseline (old news), new links are fresh', async () => {
    const env = makeEnv();
    const page = (links: string[]) => `<html>${links.map((l) => `<a href="/en/media/news/${l}">Headline for ${l} with enough text</a>`).join('')}</html>`;
    stubFeeds({ [NBG]: page(['old-one', 'old-two']) });
    await runPipeline(env, { trigger: 'cron', now: NOW, llm: fakeLlm() });
    const first = rows<{ published_at: string }>(env, `SELECT published_at FROM feed_items WHERE feed_id LIKE 'national-bank%'`);
    expect(first).toHaveLength(2);
    for (const r of first) expect(Date.parse(r.published_at)).toBeLessThan(NOW - 6 * 86_400_000);

    stubFeeds({ [NBG]: page(['old-one', 'old-two', 'brand-new']) });
    await runPipeline(env, { trigger: 'cron', now: NOW + 5 * 60_000, llm: fakeLlm() });
    const fresh = rows<{ url: string; published_at: string }>(env, `SELECT url, published_at FROM feed_items WHERE url LIKE '%brand-new'`);
    expect(fresh).toHaveLength(1);
    expect(Date.parse(fresh[0]?.published_at ?? '')).toBe(NOW + 5 * 60_000);
  });
});

describe('Editor', () => {
  const draft = (id: string) => insertArticle(makeEnvRef, { id, figures_dates: 'Rate: 4.25 percent', summary: 'The rate is 4.25 percent as of 2026.' });
  let makeEnvRef: ReturnType<typeof makeEnv>;

  it('keeps numbers intact check', () => {
    expect(numbersPreserved('Up 4.25% to 1,200 in 2026', 'In 2026, up 4.25% to 1200')).toBe(true);
    expect(numbersPreserved('Up 4.25%', 'Up 4.5%')).toBe(false);
    expect(numbersPreserved('Up 4.25%', 'Up 4.25% and 3 firms')).toBe(false);
    expect(numbersPreserved('Up 4.25% in 2026', 'Up 4.25%')).toBe(false);
  });

  it('retries an edit that changes a number, then rejects after 3 failed attempts', async () => {
    makeEnvRef = makeEnv();
    const env = makeEnvRef;
    draft('a1');
    const llm = fakeLlm({ edit: (input) => ({ articles: input.articles.map((a: any) => ({ ...a, summary: 'The rate is 9.99 percent as of 2026, said officials today.' })) }) });
    for (let i = 0; i < 3; i++) {
      await runPipeline(env, { trigger: 'manual', stages: ['edit'], now: NOW + i * 300_000, llm });
      expect(rows<{ status: string }>(env, `SELECT status FROM articles`)[0]?.status).toBe('raw_research');
    }
    await runPipeline(env, { trigger: 'manual', stages: ['edit'], now: NOW + 3 * 300_000, llm });
    expect(rows<{ status: string }>(env, `SELECT status FROM articles`)[0]?.status).toBe('rejected');
    const why = rows<{ detail: string }>(env, `SELECT detail FROM pipeline_events WHERE stage='edit' AND outcome='rejected'`)[0]?.detail;
    expect(JSON.parse(why ?? '{}').reason).toBe('editor_failed');
  });

  it('an LLM outage does not burn an article\'s attempts', async () => {
    makeEnvRef = makeEnv();
    const env = makeEnvRef;
    draft('a1');
    const down = { calls: [], json: async () => { throw new Error('Gemini 503: overloaded'); } };
    for (let i = 0; i < 6; i++) {
      const r = await runPipeline(env, { trigger: 'manual', stages: ['edit'], now: NOW + i * 300_000, llm: down });
      expect(r.status).toBe('error');
    }
    expect(rows<{ status: string }>(env, `SELECT status FROM articles`)[0]?.status).toBe('raw_research');
    expect(rows<{ n: number }>(env, `SELECT COUNT(*) n FROM pipeline_events WHERE article_id IS NOT NULL`)[0]?.n).toBe(0);
    // ...and once the LLM is back the article is edited normally
    await runPipeline(env, { trigger: 'manual', stages: ['edit'], now: NOW + 9 * 300_000, llm: fakeLlm() });
    expect(rows<{ status: string }>(env, `SELECT status FROM articles`)[0]?.status).toBe('edited');
  });
});

describe('Fact-Checker', () => {
  const edited = (env: ReturnType<typeof makeEnv>, id: string, links: { url: string; trust_score: number }[]) =>
    insertArticle(env, { id, status: 'edited', grammar_checked: 1, source_links: JSON.stringify(links.map((l) => ({ title: 'T', ...l }))) });

  it('rejects a single non-primary source (double-sourcing) and records why', async () => {
    const env = makeEnv();
    edited(env, 'one', [{ url: 'https://www.reuters.com/a', trust_score: 4.5 }]);
    await runPipeline(env, { trigger: 'manual', stages: ['fact_check'], now: NOW, llm: fakeLlm() });
    const a = rows<ArticleRow>(env, `SELECT * FROM articles`)[0];
    expect(a?.status).toBe('rejected');
    expect(a?.fact_checked).toBe(1);
    expect(a?.published_at).toBeNull();
    const d = JSON.parse(rows<{ detail: string }>(env, `SELECT detail FROM pipeline_events WHERE stage='fact_check'`)[0]?.detail ?? '{}');
    expect(d.reasons).toEqual(['not_double_sourced']);
  });

  it('rejects when the sources contradict the article, even with strong sources', async () => {
    const env = makeEnv();
    edited(env, 'bad', [{ url: 'https://www.federalreserve.gov/x', trust_score: 5 }]);
    const llm = fakeLlm({
      fact_check: (i) => ({ results: i.articles.map((a: any) => ({ id: a.id, claims: [{ claim: 'Rate is 5%', verdict: 'contradicted' }, { claim: 'Ok', verdict: 'supported' }] })) }),
    });
    await runPipeline(env, { trigger: 'manual', stages: ['fact_check'], now: NOW, llm });
    expect(rows<ArticleRow>(env, `SELECT * FROM articles`)[0]?.status).toBe('rejected');
  });

  it('never publishes without the LLM: the article waits', async () => {
    const env = makeEnv();
    edited(env, 'wait', [{ url: 'https://www.federalreserve.gov/x', trust_score: 5 }]);
    const r = await runPipeline(env, { trigger: 'manual', stages: ['fact_check'], now: NOW, llm: null });
    expect(r.status).toBe('ok');
    expect(rows<ArticleRow>(env, `SELECT * FROM articles`)[0]?.status).toBe('edited');
  });

  it('a social link adds nothing: Hacker News + one wire still fails double-sourcing', async () => {
    const env = makeEnv();
    edited(env, 's', [{ url: 'https://news.ycombinator.com/item?id=1', trust_score: 1.5 }, { url: 'https://www.reuters.com/a', trust_score: 4.5 }]);
    await runPipeline(env, { trigger: 'manual', stages: ['fact_check'], now: NOW, llm: fakeLlm() });
    expect(rows<ArticleRow>(env, `SELECT * FROM articles`)[0]?.status).toBe('rejected');
  });
});

describe('orchestration', () => {
  it('expires unpublished drafts older than 24h', async () => {
    const env = makeEnv();
    insertArticle(env, { id: 'old', created_at: '2026-10-02T10:00:00.000Z' });
    insertArticle(env, { id: 'new', created_at: '2026-10-03T12:00:00.000Z' });
    await runPipeline(env, { trigger: 'manual', stages: ['research'], now: NOW, llm: null });
    const s = Object.fromEntries(rows<{ id: string; status: string }>(env, `SELECT id, status FROM articles`).map((r) => [r.id, r.status]));
    expect(s).toEqual({ old: 'rejected', new: 'raw_research' });
  });

  it('a second run of the same stages yields; runs of other stages and crashed runs do not block', async () => {
    const env = makeEnv();
    stubFeeds({});
    const full = PIPELINE_ORDER.join('+');
    env.DB.raw.prepare(`INSERT INTO pipeline_runs (run_id, scope, trigger, started_at, status) VALUES ('live',?,'cron',?,'running')`).run(full, new Date(NOW - 60_000).toISOString());
    expect((await runPipeline(env, { trigger: 'cron', now: NOW, llm: null })).status).toBe('skipped');
    // a different scope (staged crons overlap in time) is not blocked
    expect((await runPipeline(env, { trigger: 'cron', stages: ['edit'], now: NOW, llm: null })).status).toBe('ok');
    // a crashed run (older than the lock window) does not block forever
    env.DB.raw.prepare(`UPDATE pipeline_runs SET started_at = ? WHERE run_id = 'live'`).run(new Date(NOW - 3600_000).toISOString());
    expect((await runPipeline(env, { trigger: 'cron', now: NOW + 1000, llm: null })).status).toBe('ok');
  });

  it('round-robin feed batches cover every feed exactly once per cycle', () => {
    const per = 10;
    const groups = Math.ceil(FEEDS.length / per);
    const seen = new Map<string, number>();
    for (let slot = 0; slot < groups; slot++) {
      for (const f of selectFeedBatch(FEEDS, slot, per)) seen.set(f.id, (seen.get(f.id) ?? 0) + 1);
    }
    expect(seen.size).toBe(FEEDS.length);
    expect([...seen.values()].every((n) => n === 1)).toBe(true);
    expect(selectFeedBatch(FEEDS, 12345, per).length).toBeLessThanOrEqual(per + 1);
  });
});
