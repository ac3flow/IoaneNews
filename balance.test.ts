import { afterEach, describe, expect, it, vi } from 'vitest';
import { runPipeline } from '../src/pipeline/run';
import { GEORGIA_BUCKET, bucketOf, pickBalanced } from '../src/pipeline/research';
import { FEEDS } from '../src/registry/sources';
import { fakeLlm, insertArticle, makeEnv, rss, stubFeeds } from './helpers';

const NOW = Date.parse('2026-10-03T13:15:00Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3600_000).toUTCString();
const FED = 'https://www.federalreserve.gov/feeds/press_all.xml';
const TC_STARTUPS = 'https://techcrunch.com/category/startups/feed/';
const EU_STARTUPS = 'https://www.eu-startups.com/feed/';

afterEach(() => vi.unstubAllGlobals());

const c = (bucket: string, priority: number, name = `${bucket}-${priority}`) => ({ bucket, priority, name });

describe('pickBalanced: fair share between topics', () => {
  it('gives the topic with the fewest recent stories the first slot, even with a weaker cluster', () => {
    const picked = pickBalanced([c('Economics', 6.5), c('Economics', 6), c(GEORGIA_BUCKET, 6.2), c('VC & Startups', 3.5)], new Map([['Economics', 9], [GEORGIA_BUCKET, 7], ['VC & Startups', 2]]), 1);
    expect(picked.map((p) => p.bucket)).toEqual(['VC & Startups']);
  });

  it('rotates between topics instead of draining the strongest one', () => {
    const picked = pickBalanced(
      [c('Economics', 6.5, 'e1'), c('Economics', 6.4, 'e2'), c('Economics', 6.3, 'e3'), c('Crypto', 4, 'c1'), c('VC & Startups', 3.5, 'v1')],
      new Map(),
      3,
    );
    expect(picked.map((p) => p.name)).toEqual(['e1', 'c1', 'v1']);
  });

  it('counts the clusters it has already picked toward a topic', () => {
    const picked = pickBalanced([c('A', 5, 'a1'), c('A', 4.9, 'a2'), c('B', 3, 'b1')], new Map([['A', 1], ['B', 2]]), 3);
    expect(picked.map((p) => p.name)).toEqual(['a1', 'a2', 'b1']); // A is at 1 then 2, B waits at 2, A's stronger cluster wins the tie
  });

  it('never leaves a slot empty while any topic still has an eligible cluster', () => {
    const picked = pickBalanced([c('Economics', 6, 'e1'), c('Economics', 5, 'e2'), c('Economics', 4, 'e3')], new Map(), 3);
    expect(picked).toHaveLength(3);
    expect(pickBalanced([], new Map(), 3)).toEqual([]);
  });
});

describe('bucketOf: which topic a cluster counts toward', () => {
  it('uses Georgia when any item is from a Georgian source', () => {
    expect(bucketOf([{ georgia: 0, category_hint: 'Economics' }, { georgia: 1, category_hint: 'Economics' }])).toBe(GEORGIA_BUCKET);
  });
  it('otherwise uses the most common category hint, then General', () => {
    expect(bucketOf([{ georgia: 0, category_hint: 'AI & Tech' }, { georgia: 0, category_hint: 'VC & Startups' }, { georgia: 0, category_hint: 'VC & Startups' }])).toBe('VC & Startups');
    expect(bucketOf([{ georgia: 0, category_hint: null }])).toBe('General');
  });
});

describe('research stage: topics share the drafting slots', () => {
  const funding = [
    { title: 'Acme raises $20 million Series A to build robotic arms', link: 'https://techcrunch.com/2026/10/03/acme-raises', pub: hoursAgo(5) },
  ];
  const fundingEu = [
    { title: 'Acme secures $20 million Series A for robotic arms', link: 'https://www.eu-startups.com/2026/10/acme-secures', pub: hoursAgo(4) },
  ];
  const fedItem = { title: 'Federal Reserve issues FOMC statement holding rates at 4.25 percent', link: 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20261003a.htm', pub: hoursAgo(1) };

  function capturing() {
    const seen: { clusters: { items: { title: string }[] }[] }[] = [];
    const llm = fakeLlm({
      research: (input: any) => {
        seen.push(input);
        return {
          briefings: input.clusters.map((cl: any) => ({
            cluster_id: cl.cluster_id,
            headline: `Briefing on: ${cl.items[0].title}`.slice(0, 150),
            summary: `Summary of the reporting about ${cl.items[0].title}.`.slice(0, 300),
            what_happened: `According to the sources, ${cl.items[0].title}.`.padEnd(60, '.'),
            why_it_matters: 'This could matter for markets and businesses that depend on the outcome.',
            figures_dates: '',
            affected_entities: 'Markets',
            risks_uncertainty: 'Details may change.',
            category: 'Economics',
            georgia_related: false,
            used_item_ids: cl.items.map((i: any) => i.id),
          })),
        };
      },
    });
    return { llm, seen };
  }

  it('drafts the startup story first when Economics already has stories today and one slot is free', async () => {
    const env = makeEnv({ MAX_ARTICLES_PER_RUN: '1' });
    for (let i = 0; i < 3; i++) insertArticle(env, { id: `econ${i}`, category: 'Economics', status: 'published', created_at: '2026-10-03T09:00:00.000Z' });
    stubFeeds({ [FED]: rss([fedItem]), [TC_STARTUPS]: rss(funding), [EU_STARTUPS]: rss(fundingEu) });
    const { llm, seen } = capturing();
    const r = await runPipeline(env, { trigger: 'manual', now: NOW, llm });
    expect(r.status).toBe('ok');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.clusters).toHaveLength(1);
    expect(seen[0]?.clusters[0]?.items.map((i) => i.title).join(' ')).toContain('Acme');
  });

  it('a topic that is behind is not crowded out of the pool by a chatty one', async () => {
    const env = makeEnv({ MAX_ARTICLES_PER_RUN: '1' });
    const map: Record<string, string> = { [TC_STARTUPS]: rss(funding), [EU_STARTUPS]: rss(fundingEu) };
    // Every AI feed publishes 12 brand-new, unrelated stories: 14 feeds x 12 = 168 items, more than the pool can hold.
    FEEDS.filter((f) => f.hint === 'ai_tech').forEach((f, n) => {
      map[f.url] = rss(Array.from({ length: 12 }, (_, k) => ({ title: `qx${n}a${k} wy${n}b${k} zv${n}c${k} ur${n}d${k}`, link: `https://example.com/ai/${n}/${k}`, pub: hoursAgo(0.5) })));
    });
    stubFeeds(map);
    const { llm, seen } = capturing();
    await runPipeline(env, { trigger: 'manual', now: NOW, llm });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.clusters[0]?.items.map((i) => i.title).join(' ')).toContain('Acme');
  });
});
