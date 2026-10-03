# IOANE News

Business, technology and Georgia news that is researched, copy-edited and fact-checked every five minutes. Every story carries a trust score (0–100), its sources, and a breakdown of how the score was built.

One Cloudflare Worker (`ioane-news`) serves the site, the API and the pipeline. It replaces the separate `ioane-agent` and `ioane-agent-2` Workers.

```
        cron  */5 * * * *   (UTC; Tbilisi is UTC+4, so ticks line up on the same minutes)
          │
          ▼
  ┌───────────────┐   ┌────────────────┐   ┌────────────────┐   ┌──────────────────┐
  │ Research      │ → │ Grammar & Copy │ → │ Fact-Checker   │ → │ Publish / Reject │
  │ collect, pool,│   │ Editor         │   │ trust score,   │   │ articles.status  │
  │ cluster, draft│   │ numbers must   │   │ double-sourcing│   │ published_at     │
  │               │   │ not change     │   │ gate           │   │                  │
  └───────────────┘   └────────────────┘   └────────────────┘   └──────────────────┘
   raw_research          → edited              → published | rejected
```

Each stage is a module with the same signature (`StageCtx → result`) in `src/pipeline/`, so any one of them can later be moved to its own Worker behind a service binding without touching the others.

## Deploy

```bash
npm install
npx wrangler d1 create ioane-news          # paste the database_id into wrangler.jsonc
npm run db:init:remote                     # applies schema.sql (idempotent)
npx wrangler secret put GEMINI_API_KEY     # the key agent 2 already uses
npx wrangler secret put ADMIN_KEY          # optional: enables POST /api/run
npm run deploy                             # builds the CSS, then wrangler deploy
```

`wrangler deploy` runs `npm run build:css` first (see `build` in `wrangler.jsonc`), so `devDependencies` must be installed in whatever builds this.

This deploys to the existing `ioane-news` Worker name and replaces the current page.

**Cutover.** After you have seen the first stories published, disable the crons on `ioane-agent` and `ioane-agent-2`, otherwise they keep spending Gemini quota. Their D1 (`ioane-archive`) is untouched and nothing is migrated from it.

## Configuration

| Name | Kind | Default | Meaning |
|---|---|---|---|
| `GEMINI_API_KEY` | secret | – | Required for any drafting, editing or fact-checking. Without it the Worker still collects feeds but publishes nothing. |
| `ADMIN_KEY` | secret | – | Enables `POST /api/run[/research\|edit\|fact_check]`, sent as `x-admin-key` or `Authorization: Bearer`. Unset = endpoint disabled. |
| `GEMINI_MODEL` | var | `gemini-2.5-flash` | Same variable agent 2 uses. |
| `GEMINI_BASE_URL` | var | Google's endpoint | Route calls through a gateway (e.g. Cloudflare AI Gateway). |
| `FEEDS_PER_RUN` | var | `10` | Feeds polled per run, round-robin: every feed is polled every `ceil(feeds/10)` runs; with the 75 registered feeds that is 8 runs, about 40 minutes. |
| `MAX_ARTICLES_PER_RUN` | var | `3` | New drafts per run. |
| `PUBLISH_THRESHOLD` | var | `60` | Minimum trust score to publish. |

**Limits.** A run makes one subrequest per feed plus at most three Gemini calls, and a few D1 queries. Workers Free allows 50 subrequests and 50 D1 queries per invocation, which is enough at the defaults. Raise `FEEDS_PER_RUN` only on Workers Paid.

## Trust score

`score = credibility (0–40) + corroboration (0–25) + primary evidence (0–20) + claim support (0–15) − penalties`

| Component | How it is computed |
|---|---|
| Credibility | Best non-social source weight, scaled (5.0 → 40) |
| Corroboration | Independent non-social publishers: 1 → 5, 2 → 20, 3+ → 25 |
| Primary evidence | Best source 5.0 → 20, 4.5 → 14, 4.0 → 10, 3.5 → 5 |
| Claim support | Share of the article's claims the sources back, checked by the LLM against each source's excerpt |
| Penalty | −30 per contradicted claim |

A story is published only if **all** gates pass; a high score alone is never enough:
1. at least one non-social source (Hacker News, Reddit and X only help discover stories);
2. two independent publishers **or** one primary source (central bank, statistics office, regulator, ministry, journal);
3. no claim contradicted by its sources;
4. at least 70% of claims supported;
5. score ≥ `PUBLISH_THRESHOLD`.

Source weights live in `src/registry/sources.ts` (5.0 primary/official, 4.5 wires, 4.0 major financial press, 3.5 specialist press and company newsrooms, 2.5–3.0 commentary, 1.0–2.0 social). Sources the spec did not place in a tier were assigned by analogy: exchanges and rating agencies 4.0, trade press 3.5, consultancy research 3.0, aggregators 3.0, blogs and newsletters 2.5. Change a number there and scoring follows.

Every decision, with its breakdown and reject reasons, is stored in `pipeline_events`; the UI shows the breakdown when a story is expanded.

## Sources

The registry holds all 13 categories from the brief. Only sources with a working public feed are **polled**; the rest still count when they are cited. Not polled (no public feed): Reuters, AP, Bloomberg, and most paywalled or bot-blocked sites. 75 feeds are polled (71 RSS, 4 scraped listings).

- **Georgia.** NBG, GeoStat, the Ministry of Finance and the Georgian Stock Exchange publish no RSS, so their HTML news listings are read by link pattern (`kind: 'page'`). The first time a listing is seen, its existing links are recorded as old news so a backlog does not flood the pool. The Revenue Service has no scrapeable listing and is weight-only.
- **Additions beyond the brief:** Civil.ge (Georgian press, so official Georgian data has independent corroboration), and the trade feeds agent 2 already polled (Marketing Dive, HousingWire, Supply Chain Dive, FreightWaves, Banking Dive, Finextra, Realtor.com).
- **Not polled on purpose:** the general Nature and Science feeds. They carry essays and non-business science that would pass the primary-source rule and crowd out news.
- A dead or blocked feed never fails a run: it is logged to `pipeline_events` (`stage = 'feed'`) and counted in `/api/status`.

## API

| Endpoint | |
|---|---|
| `GET /api/articles?tab=&date=&time=&limit=&before=` | `tab`: `top10`, `all`, `georgia`, `ai-tech`, `economics`, `crypto`, `marketing`, `real-estate`, `global-trade`, `vc-startups`. `top10` is `trust_score DESC LIMIT 10`. `time=HH:MM` matches the 5-minute slot `[HH:MM, HH:MM+5)` in Asia/Tbilisi, on any day, or on `date=YYYY-MM-DD` if given. Timestamps in the response are UTC. |
| `GET /api/articles/:id` | One story plus its trust breakdown. |
| `GET /api/slots?date=&tab=` | Stories per 5-minute slot (feeds the tape in the UI). |
| `GET /api/meta` | Tabs, counts, next cron slot, last run. |
| `GET /api/status` | Health: last run, queue sizes, feed errors in 24h. No secrets. |
| `POST /api/run[/stage]` | Admin only. Runs the pipeline, or one stage, now. |

All stored timestamps are UTC ISO-8601. The browser renders them with `Intl` in `Asia/Tbilisi`.

## Database

`schema.sql` holds the `articles` table exactly as specified, plus three operational tables: `feed_items` (the rolling pool of collected items), `pipeline_runs` (also the run lock) and `pipeline_events` (audit trail). It is safe to re-run. If a different `articles` table already exists in the target database, `CREATE TABLE IF NOT EXISTS` will not change it, so use a fresh database.

Articles and feed items are never deleted. Run and event logs older than 30 days are trimmed daily. Drafts not published within 24 hours are rejected as stale.

## Develop

```bash
npm install
npm run build:css
npm run db:init && npm run db:seed   # local D1 + clearly-labelled "[Sample]" stories
npm run dev                          # http://localhost:8787
curl "http://localhost:8787/__scheduled?cron=*%2F5+*+*+*+*"   # fire the cron handler
npm test                             # unit + integration tests (real SQLite semantics)
npm run typecheck
```

`seed.sql` is demo content for local use only. Never run it against production.

## Known limits

- **Gemini calls are tested against a fake, not live.** The request shape is the same as agent 2's working call plus `system_instruction`; the sandbox this was built in had no key. Check `GET /api/status` and `pipeline_events` after the first cron runs.
- **Fact-checking judges claims against feed excerpts** (title plus up to 600 characters), not full articles. Briefings are therefore short, and the Research prompt forbids facts the excerpts do not state.
- **Syndicated copies count as separate publishers** when they appear under another domain (a Reuters story on a partner site is not detected as a duplicate of Reuters).
- **English only.** The previous site was Georgian with an English toggle; this version writes and displays English. The pipeline already tells the model to write English even from Georgian sources.
- `ioane-agent` (agent 1) was not available to read, so nothing from it was carried over.
