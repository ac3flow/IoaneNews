import { describe, expect, it } from 'vitest';
import schemaSql from '../schema.sql?raw';
import { handleApi } from '../src/api';
import { ensureSchema } from '../src/db-init';
import { SCHEMA_STATEMENTS } from '../src/schema';
import type { Env } from '../src/types';
import { createD1 } from './d1';

const tables = (db: ReturnType<typeof createD1>) =>
  (db.raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as { name: string }[]).map((r) => r.name);

const EXPECTED = ['article_translations', 'articles', 'feed_items', 'pipeline_events', 'pipeline_runs'];
const envWith = (DB: unknown): Env => ({ DB, ASSETS: {} as Fetcher }) as Env;

describe('self-initialising schema', () => {
  it('src/schema.ts is exactly schema.sql (run `npm run build` if this fails)', () => {
    const fromSql = schemaSql
      .replace(/--.*$/gm, '')
      .split(';')
      .map((s) => s.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    expect(SCHEMA_STATEMENTS).toEqual(fromSql);
    expect(SCHEMA_STATEMENTS.some((s) => /create table if not exists articles\b/i.test(s))).toBe(true);
  });

  it('every statement is idempotent', () => {
    for (const s of SCHEMA_STATEMENTS) expect(s).toMatch(/^CREATE (TABLE|INDEX) IF NOT EXISTS /);
  });

  it('creates every table on an empty database, and is safe to repeat', async () => {
    const db = createD1({ schema: false });
    expect(tables(db)).toEqual([]);
    await ensureSchema(envWith(db));
    expect(tables(db)).toEqual(EXPECTED);
    db.raw.prepare(`INSERT INTO pipeline_runs (run_id, trigger, started_at, status) VALUES ('keep','cron','x','ok')`).run();
    for (const s of SCHEMA_STATEMENTS) db.raw.exec(s); // re-running by hand leaves data alone
    expect((db.raw.prepare(`SELECT COUNT(*) n FROM pipeline_runs`).get() as { n: number }).n).toBe(1);
  });

  it('runs once per database, not once per request', async () => {
    const db = createD1({ schema: false });
    let batches = 0;
    const real = db.batch.bind(db);
    (db as unknown as { batch: unknown }).batch = (l: never[]) => (batches++, real(l));
    const env = envWith(db);
    await Promise.all([ensureSchema(env), ensureSchema(env), ensureSchema(env)]);
    await ensureSchema(env);
    expect(batches).toBe(1);
  });

  it('a failed first attempt is not cached, so the next request retries', async () => {
    const db = createD1({ schema: false });
    const real = db.batch.bind(db);
    let calls = 0;
    (db as unknown as { batch: unknown }).batch = (l: never[]) => (++calls === 1 ? Promise.reject(new Error('D1 hiccup')) : real(l));
    const env = envWith(db);
    await expect(ensureSchema(env)).rejects.toThrow('D1 hiccup');
    await ensureSchema(env);
    expect(tables(db)).toEqual(EXPECTED);
  });

  it('the API works on a brand-new empty database (no schema step needed)', async () => {
    const db = createD1({ schema: false });
    const env = envWith(db);
    const status = await handleApi(new Request('https://x.test/api/status'), env);
    expect(status.status).toBe(200);
    const list = await handleApi(new Request('https://x.test/api/articles?lang=ka'), env);
    expect(list.status).toBe(200);
    expect(((await list.json()) as { articles: unknown[] }).articles).toEqual([]);
    expect(tables(db)).toEqual(EXPECTED);
  });
});
