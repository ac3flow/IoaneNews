// Minimal D1Database stand-in over Node's built-in SQLite, so tests exercise the real SQL
// (json_each, strftime, batch transactions) without a Worker runtime.
import { DatabaseSync } from 'node:sqlite';
import schema from '../schema.sql?raw';

class Stmt {
  constructor(private db: DatabaseSync, readonly sql: string, readonly params: unknown[] = []) {}
  bind(...values: unknown[]): Stmt {
    return new Stmt(this.db, this.sql, values);
  }
  async run() {
    const r = this.db.prepare(this.sql).run(...this.params);
    return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  async all<T>() {
    const results = this.db.prepare(this.sql).all(...this.params) as T[];
    return { success: true, results, meta: { changes: 0 } };
  }
  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.sql).get(...this.params) as T | undefined) ?? null;
  }
}

export function createD1(opts: { schema?: boolean } = {}): D1Database & { raw: DatabaseSync } {
  const db = new DatabaseSync(':memory:');
  if (opts.schema !== false) db.exec(schema);
  const shim = {
    raw: db,
    prepare: (sql: string) => new Stmt(db, sql),
    async batch(stmts: Stmt[]) {
      db.exec('BEGIN');
      try {
        const out = [];
        for (const s of stmts) out.push(/^\s*select/i.test(s.sql) ? await s.all() : await s.run());
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
  return shim as unknown as D1Database & { raw: DatabaseSync };
}
