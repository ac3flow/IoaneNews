import { SCHEMA_STATEMENTS } from './schema';
import type { Env } from './types';

// Creates the tables on first use, so a fresh D1 database works without anyone running schema.sql.
// Every statement is CREATE ... IF NOT EXISTS, so repeating it is harmless. One batch per isolate.
const ready = new WeakMap<D1Database, Promise<void>>();

export function ensureSchema(env: Env): Promise<void> {
  let p = ready.get(env.DB);
  if (!p) {
    p = env.DB.batch(SCHEMA_STATEMENTS.map((s) => env.DB.prepare(s))).then(() => undefined);
    p.catch(() => ready.delete(env.DB)); // a failed attempt must not be cached
    ready.set(env.DB, p);
  }
  return p;
}
