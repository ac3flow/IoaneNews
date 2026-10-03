import { vi } from 'vitest';
import type { Llm } from '../src/pipeline/llm';
import type { ArticleRow, Env } from '../src/types';
import { createD1 } from './d1';

export function makeEnv(overrides: Partial<Env> = {}): Env & { DB: ReturnType<typeof createD1> } {
  return { DB: createD1(), ASSETS: {} as Fetcher, FEEDS_PER_RUN: '100', MAX_ARTICLES_PER_RUN: '5', PUBLISH_THRESHOLD: '60', ...overrides } as Env & { DB: ReturnType<typeof createD1> };
}

export interface SeedArticle extends Partial<ArticleRow> {
  id: string;
}

export function insertArticle(env: Env, a: SeedArticle): void {
  const ts = a.created_at ?? '2026-10-03T10:00:00.000Z';
  const row: ArticleRow = {
    headline: 'A sufficiently long headline',
    summary: 'A summary that is comfortably longer than thirty characters.',
    what_happened: 'What happened is described here in enough detail to satisfy the validators.',
    why_it_matters: 'It matters because of reasons that are stated here.',
    figures_dates: null,
    affected_entities: null,
    risks_uncertainty: 'Some risk remains.',
    category: 'General',
    georgia_related: 0,
    source_links: JSON.stringify([{ title: 'Source one', url: 'https://www.reuters.com/a', trust_score: 4.5 }]),
    trust_score: 0,
    grammar_checked: 0,
    fact_checked: 0,
    status: 'raw_research',
    published_at: null,
    created_at: ts,
    updated_at: ts,
    ...a,
  };
  const cols = Object.keys(row) as (keyof ArticleRow)[];
  (env.DB as unknown as { raw: { prepare(s: string): { run(...p: unknown[]): unknown } } }).raw
    .prepare(`INSERT INTO articles (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .run(...cols.map((c) => row[c]));
}

export const rss = (items: { title: string; link: string; pub?: string; desc?: string }[]): string =>
  `<?xml version="1.0"?><rss><channel>${items
    .map((i) => `<item><title>${i.title}</title><link>${i.link}</link>${i.pub ? `<pubDate>${i.pub}</pubDate>` : ''}<description>${i.desc ?? ''}</description></item>`)
    .join('')}</channel></rss>`;

/** Stub global fetch with a url -> body map; everything else is a 404. */
export function stubFeeds(map: Record<string, string>): void {
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const body = map[url];
    return body === undefined ? new Response('not found', { status: 404 }) : new Response(body, { status: 200 });
  });
}

type Handler = (input: any) => unknown;

const KA = 'ქართული ტექსტი ';
const digitsOf = (s: string): string => (s.match(/\d+(?:[.,]\d+)*/g) ?? []).join(' ');
/** Georgian-looking filler that keeps the source's digits, so it passes the real guards. */
export const kaText = (src: string): string => `${KA.repeat(Math.max(3, Math.ceil(src.length / 14)))}${digitsOf(src)}`.trim();
export const kaFigures = (src: string): string =>
  (src ?? '').split('\n').filter(Boolean).map((l) => `ლეიბლი: ${digitsOf(l) || 'მნიშვნელობა'}`).join('\n');
const kaArticle = (a: any) => ({
  id: a.id,
  headline: kaText(a.headline),
  summary: kaText(a.summary),
  what_happened: kaText(a.what_happened),
  why_it_matters: kaText(a.why_it_matters),
  figures_dates: kaFigures(a.figures_dates),
  affected_entities: 'ბაზრები, ინვესტორები',
  risks_uncertainty: kaText(a.risks_uncertainty),
});

/** Fake LLM that runs the stage's own zod schema, like the real client. */
export function fakeLlm(handlers: Partial<Record<'research' | 'edit' | 'fact_check' | 'translate' | 'ka_grammar', Handler>> = {}): Llm & { calls: string[] } {
  const defaults: Record<string, Handler> = {
    research: (input) => ({
      briefings: input.clusters.map((c: any) => ({
        cluster_id: c.cluster_id,
        headline: `Briefing on: ${c.items[0].title}`.slice(0, 150),
        summary: `Summary of the reporting about ${c.items[0].title}.`.slice(0, 300),
        what_happened: `According to the sources, ${c.items[0].title}. ${c.items[0].snippet ?? ''}`.trim().padEnd(60, '.'),
        why_it_matters: 'This could matter for markets and businesses that depend on the outcome.',
        figures_dates: 'Reported rate: 4.25',
        affected_entities: 'Markets, Investors',
        risks_uncertainty: 'Details may change as more information is confirmed.',
        category: 'Economics',
        georgia_related: false,
        used_item_ids: c.items.map((i: any) => i.id),
      })),
    }),
    edit: (input) => ({ articles: input.articles.map((a: any) => ({ ...a, summary: a.summary.replace(/\s+/g, ' ') })) }),
    translate: (input) => ({ articles: input.articles.map(kaArticle) }),
    ka_grammar: (input) => ({ articles: input.articles.map((a: any) => ({ ...a, summary: a.summary.replace(/\s+/g, ' '), corrections: 'Fixed case endings.' })) }),
    fact_check: (input) => ({
      results: input.articles.map((a: any) => ({
        id: a.id,
        claims: [
          { claim: 'Headline claim', verdict: 'supported', source_index: 1 },
          { claim: 'Figure claim', verdict: 'supported', source_index: 1 },
          { claim: 'Context claim', verdict: 'supported', source_index: null },
        ],
      })),
    }),
  };
  const calls: string[] = [];
  return {
    calls,
    async json(req) {
      calls.push(req.label);
      const h = handlers[req.label as 'research'] ?? defaults[req.label];
      if (!h) throw new Error(`no fake handler for ${req.label}`);
      return req.schema.parse(h(JSON.parse(req.user)));
    },
  };
}

export const rows = <T>(env: Env, sql: string, ...p: unknown[]): T[] =>
  (env.DB as unknown as { raw: { prepare(s: string): { all(...p: unknown[]): unknown[] } } }).raw.prepare(sql).all(...p) as T[];

export function insertTranslation(env: Env, articleId: string, o: Record<string, unknown> = {}): void {
  const ts = '2026-10-03T10:00:00.000Z';
  const row = {
    article_id: articleId,
    lang: 'ka',
    headline: 'ქართული სათაური ამ სიახლისთვის',
    summary: 'ქართული მოკლე შინაარსი, რომელიც საკმარისად გრძელია.',
    what_happened: 'ქართული ტექსტი იმის შესახებ, თუ რა მოხდა, საკმარისი სიგრძით.',
    why_it_matters: 'ქართული ტექსტი იმის შესახებ, თუ რატომ არის ეს მნიშვნელოვანი.',
    figures_dates: null,
    affected_entities: null,
    risks_uncertainty: 'ქართული ტექსტი რისკების შესახებ.',
    grammar_checked: 1,
    created_at: ts,
    updated_at: ts,
    ...o,
  };
  const cols = Object.keys(row);
  (env.DB as unknown as { raw: { prepare(s: string): { run(...p: unknown[]): unknown } } }).raw
    .prepare(`INSERT INTO article_translations (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .run(...cols.map((c) => (row as Record<string, unknown>)[c]));
}
