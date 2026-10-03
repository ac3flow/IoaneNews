import { afterEach, describe, expect, it, vi } from 'vitest';
import { georgianShare, looksGeorgian } from '../src/pipeline/georgian';
import { digitsPreserved } from '../src/pipeline/numbers';
import { PIPELINE_ORDER, STAGED_CRONS, runPipeline, stagesForCron, type StageName } from '../src/pipeline/run';
import type { ArticleRow } from '../src/types';
import { fakeLlm, insertArticle, kaFigures, kaText, makeEnv, rows, rss, stubFeeds } from './helpers';

const NOW = Date.parse('2026-10-03T13:15:00Z');
type Env = ReturnType<typeof makeEnv>;
const run = (env: Env, stages: StageName[], llm: ReturnType<typeof fakeLlm> | null, at = NOW) => runPipeline(env, { trigger: 'manual', stages, now: at, llm });
const state = (env: Env, id = 'v1') => rows<ArticleRow>(env, `SELECT * FROM articles WHERE id = ?`, id)[0];
const ka = (env: Env, id = 'v1') => rows<{ grammar_checked: number; headline: string; summary: string }>(env, `SELECT * FROM article_translations WHERE article_id = ? AND lang = 'ka'`, id)[0];
const events = (env: Env, stage: string) => rows<{ outcome: string; detail: string | null }>(env, `SELECT outcome, detail FROM pipeline_events WHERE stage = ? ORDER BY id`, stage);

/** An article that has passed the Fact-Checker and is waiting for Georgian. */
const verified = (env: Env, id = 'v1') =>
  insertArticle(env, { id, status: 'edited', grammar_checked: 1, fact_checked: 1, trust_score: 80, figures_dates: 'Rate: 4.25 percent', summary: 'The rate is 4.25 percent as of 2026, officials said today.' });

afterEach(() => vi.unstubAllGlobals());

describe('Georgian guards', () => {
  it('measures Georgian share by letters, ignoring digits and punctuation', () => {
    expect(georgianShare('ქართული ტექსტი 4.25!')).toBe(1);
    expect(georgianShare('Only English here')).toBe(0);
    expect(georgianShare('')).toBe(0);
    expect(georgianShare('Google-მა ახალი ჩიპი წარადგინა')).toBeGreaterThan(0.7);
  });

  it('accepts Georgian with Latin brand names, rejects English and mixed-up output', () => {
    const f = (t: string) => ({ headline: t, summary: t, what_happened: t, why_it_matters: t, risks_uncertainty: t });
    expect(looksGeorgian(f('Nvidia-მ ახალი ჩიპი წარადგინა მონაცემთა ცენტრებისთვის'))).toBe(true);
    expect(looksGeorgian(f('Nvidia unveiled a new chip for data centres'))).toBe(false);
    expect(looksGeorgian({ ...f('ქართული ტექსტი'), summary: 'English summary left behind in the output', what_happened: 'Also English text here', why_it_matters: 'And more English text' })).toBe(false);
  });

  it('digitsPreserved allows reformatting but not changed digits', () => {
    expect(digitsPreserved('Up 1.2 billion, 1,200 firms in 2026', 'მოიმატა 1,2 მილიარდით, 1 200 ფირმა 2026 წელს')).toBe(true);
    expect(digitsPreserved('Rate 4.25 percent', 'განაკვეთი 4.52 პროცენტი')).toBe(false);
    expect(digitsPreserved('Rate 4.25 percent', 'განაკვეთი 4.25 და 7 პროცენტი')).toBe(false);
    expect(digitsPreserved('No figures', 'რიცხვების გარეშე')).toBe(true);
  });
});

describe('Georgian lifecycle: Fact-Check -> Translate -> Georgian Grammar -> Publish', () => {
  it('the Fact-Checker only verifies; nothing is published until Georgian is checked', async () => {
    const env = makeEnv();
    insertArticle(env, { id: 'v1', status: 'edited', grammar_checked: 1, source_links: JSON.stringify([{ title: 'Fed', url: 'https://www.federalreserve.gov/x', trust_score: 5 }]) });
    await run(env, ['fact_check'], fakeLlm());
    expect(state(env)).toMatchObject({ status: 'edited', fact_checked: 1, trust_score: 80, published_at: null });
  });

  it('translate -> ka_grammar -> publish, step by step', async () => {
    const env = makeEnv();
    verified(env);
    const llm = fakeLlm();

    await run(env, ['publish'], llm);
    expect(state(env)?.status).toBe('edited'); // no Georgian yet

    await run(env, ['translate'], llm);
    expect(ka(env)).toMatchObject({ grammar_checked: 0 });
    expect(ka(env)?.headline).toContain('ქართული');
    await run(env, ['publish'], llm);
    expect(state(env)?.status).toBe('edited'); // translated but not grammar-checked

    await run(env, ['ka_grammar'], llm);
    expect(ka(env)?.grammar_checked).toBe(1);
    expect(state(env)?.status).toBe('edited');
    expect(JSON.parse(events(env, 'ka_grammar')[0]?.detail ?? '{}').corrections).toBe('Fixed case endings.');

    await run(env, ['publish'], llm);
    expect(state(env)).toMatchObject({ status: 'published', published_at: '2026-10-03T13:15:00.000Z' });
    expect(llm.calls).toEqual(['translate', 'ka_grammar']);
  });

  it('translates only verified articles, never unchecked or rejected ones', async () => {
    const env = makeEnv();
    insertArticle(env, { id: 'unchecked', status: 'edited', fact_checked: 0 });
    insertArticle(env, { id: 'rejected', status: 'rejected', fact_checked: 1 });
    const llm = fakeLlm();
    const r = await run(env, ['translate'], llm);
    expect(llm.calls).toEqual([]);
    expect((r.stages.translate as { skipped: string }).skipped).toBe('nothing to translate');
  });

  it('retries a translation that changes a digit, then rejects after 3 failed attempts', async () => {
    const env = makeEnv();
    verified(env);
    const llm = fakeLlm({ translate: (i) => ({ articles: i.articles.map((a: any) => ({ id: a.id, headline: kaText(a.headline), summary: kaText('rate 9.99'), what_happened: kaText(a.what_happened), why_it_matters: kaText(a.why_it_matters), figures_dates: kaFigures(a.figures_dates), affected_entities: 'ბაზრები', risks_uncertainty: kaText(a.risks_uncertainty) })) }) });
    for (let i = 0; i < 3; i++) {
      await run(env, ['translate'], llm, NOW + i * 300_000);
      expect(state(env)?.status).toBe('edited');
      expect(ka(env)).toBeUndefined();
    }
    expect(JSON.parse(events(env, 'translate')[0]?.detail ?? '{}').reason).toBe('facts_changed');
    await run(env, ['translate'], llm, NOW + 4 * 300_000);
    expect(state(env)).toMatchObject({ status: 'rejected', fact_checked: 1, trust_score: 80 });
    expect(JSON.parse(events(env, 'translate').at(-1)?.detail ?? '{}').reason).toBe('translation_failed');
  });

  it('refuses a "translation" that is still English', async () => {
    const env = makeEnv();
    verified(env);
    const llm = fakeLlm({
      translate: (i) => ({ articles: i.articles.map((a: any) => ({ ...a, affected_entities: a.affected_entities || 'Markets' })) }),
    });
    await run(env, ['translate'], llm);
    expect(ka(env)).toBeUndefined();
    expect(JSON.parse(events(env, 'translate')[0]?.detail ?? '{}').reason).toBe('not_georgian');
  });

  it('the Georgian Grammar Checker may not change a figure, and unchecked Georgian never publishes', async () => {
    const env = makeEnv();
    verified(env);
    await run(env, ['translate'], fakeLlm());
    const bad = fakeLlm({ ka_grammar: (i) => ({ articles: i.articles.map((a: any) => ({ ...a, summary: a.summary + ' 77', corrections: '' })) }) });
    for (let i = 0; i < 3; i++) await run(env, ['ka_grammar', 'publish'], bad, NOW + i * 300_000);
    expect(ka(env)?.grammar_checked).toBe(0);
    expect(state(env)?.status).toBe('edited');
    await run(env, ['ka_grammar'], bad, NOW + 4 * 300_000);
    expect(state(env)?.status).toBe('rejected');
    expect(JSON.parse(events(env, 'ka_grammar').at(-1)?.detail ?? '{}').reason).toBe('ka_grammar_failed');
  });

  it('an LLM outage in a Georgian stage burns no attempts', async () => {
    const env = makeEnv();
    verified(env);
    const down = { calls: [], json: async () => { throw new Error('Gemini 503'); } };
    for (let i = 0; i < 6; i++) expect((await run(env, ['translate'], down, NOW + i * 300_000)).status).toBe('error');
    expect(rows<{ n: number }>(env, `SELECT COUNT(*) n FROM pipeline_events WHERE article_id IS NOT NULL`)[0]?.n).toBe(0);
    await run(env, ['translate'], fakeLlm(), NOW + 9 * 300_000);
    expect(ka(env)).toBeDefined();
  });

  it('uses GEMINI_MODEL_KA for the Georgian stages only', async () => {
    const env = makeEnv({ GEMINI_MODEL_KA: 'gemini-2.5-pro' });
    verified(env);
    const seen: Record<string, string | undefined> = {};
    const base = fakeLlm();
    const spy = { calls: base.calls, json: (req: any) => ((seen[req.label] = req.model), base.json(req)) } as typeof base;
    await run(env, ['translate', 'ka_grammar'], spy);
    expect(seen).toEqual({ translate: 'gemini-2.5-pro', ka_grammar: 'gemini-2.5-pro' });
  });
});

describe('staged cron triggers (Workers Free)', () => {
  it('five triggers cover every stage of the pipeline, in order', () => {
    expect(Object.keys(STAGED_CRONS)).toEqual(['*/5 * * * *', '1-59/5 * * * *', '2-59/5 * * * *', '3-59/5 * * * *', '4-59/5 * * * *']);
    const covered = Object.values(STAGED_CRONS).flat().map((s) => (s === 'collect2' ? 'collect' : s));
    expect([...new Set(covered)]).toEqual(PIPELINE_ORDER);
  });

  it('single mode and unknown crons run everything', () => {
    expect(stagesForCron('single', '*/5 * * * *')).toEqual(PIPELINE_ORDER);
    expect(stagesForCron('staged', '7 7 7 7 7')).toEqual(PIPELINE_ORDER);
    expect(stagesForCron(undefined, '2-59/5 * * * *')).toEqual(['fact_check', 'translate']);
  });

  it('an article drafted at :01 is published at :03, one trigger at a time', async () => {
    const env = makeEnv();
    const pub = (h: number) => new Date(NOW - h * 3600_000).toUTCString();
    stubFeeds({
      'https://www.federalreserve.gov/feeds/press_all.xml': rss([{ title: 'Federal Reserve issues FOMC statement holding rates at 4.25 percent', link: 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20261003a.htm', pub: pub(2), desc: 'The Committee decided to maintain the target range at 4.25 percent.' }]),
    });
    const llm = fakeLlm();
    const at = (min: number) => NOW + min * 60_000; // NOW is :15 -> a */5 boundary
    const trig = (cron: string, min: number) => runPipeline(env, { trigger: 'cron', stages: stagesForCron('staged', cron), now: at(min), llm });
    const status = () => state(env, rows<{ id: string }>(env, `SELECT id FROM articles`)[0]?.id ?? '')?.status;

    await trig('*/5 * * * *', 0);
    expect(llm.calls).toEqual([]); // collect only fills the pool
    expect(rows<{ n: number }>(env, `SELECT COUNT(*) n FROM feed_items`)[0]?.n).toBe(1);

    await trig('1-59/5 * * * *', 1);
    expect(llm.calls).toEqual(['research', 'edit']);
    expect(status()).toBe('edited');
    expect(rows<ArticleRow>(env, `SELECT * FROM articles`)[0]?.fact_checked).toBe(0);

    await trig('2-59/5 * * * *', 2);
    expect(llm.calls.slice(2)).toEqual(['fact_check', 'translate']);
    expect(rows<ArticleRow>(env, `SELECT * FROM articles`)[0]?.fact_checked).toBe(1);
    expect(status()).toBe('edited');

    await trig('3-59/5 * * * *', 3);
    expect(llm.calls.slice(4)).toEqual(['ka_grammar']);
    expect(status()).toBe('published');
    expect(rows<ArticleRow>(env, `SELECT * FROM articles`)[0]?.published_at).toBe(new Date(at(3)).toISOString());

    await trig('4-59/5 * * * *', 4); // second collect: no new work, no crash
    expect(status()).toBe('published');
  });
});
