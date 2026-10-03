declare module 'node:sqlite' {
  export class StatementSync {
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  }
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}

declare module '*.sql?raw' {
  const sql: string;
  export default sql;
}

declare module '*.html?raw' {
  const html: string;
  export default html;
}
declare module '*.js?raw' {
  const js: string;
  export default js;
}
