# IOANE News

Business, technology and Georgia news that is researched, copy-edited, fact-checked and **translated into Georgian**, every five minutes. Every story carries a trust score (0–100), its sources, and a breakdown of how the score was built. The site is Georgian by default, with an English switch.

One Cloudflare Worker (`ioane-news`) serves the site, the API and the pipeline. It replaces the separate `ioane-agent` and `ioane-agent-2` Workers. **To deploy, follow [DEPLOY.md](DEPLOY.md).**

```
 collect ─► Research ─► Copy editor ─► Fact-Checker ─► Georgian ─► Georgian grammar ─► Publish
 (poll      (cluster,    (English;      (trust score,   translator   checker             (only when Georgian
  sources)   draft)       numbers must   double-         (numbers     (case endings,       is checked)
                          not change)    sourcing gate)  must not     verb forms, style)
                                                         change)
 raw_research ─────────► edited ───────► edited + fact_checked ─────────────────────────► published
                         (any stage can end in: rejected)
```

Each stage is a module with the same signature (`StageCtx → result`) in `src/pipeline/` and reads its work from D1 by article status, so stages can run together or in separate invocations, and any one of them can later move to its own Worker.

## Schedule: searching for new information every five minutes

Two modes, chosen with `PIPELINE_MODE`:

| | `staged` (default, **Workers Free**) | `single` (**Workers Paid**) |
|---|---|---|
| Triggers | 5 crons, one minute apart | 1 cron, `*/5 * * * *` |
| Each 5-minute window | `:00` collect · `:01` research + edit · `:02` fact-check + translate · `:03` Georgian grammar + publish · `:04` collect | everything, in order |
| Sources searched per window | 50 of 75 (two collects of 25); all 75 every 15 minutes | all 75 every 5 minutes (`FEEDS_PER_RUN=80`) |
| Why | Free allows 50 outbound requests and about 10 ms of CPU **per invocation**, so work is split across invocations | Paid raises both limits a hundredfold |

An article drafted at `:01` is published at `:03`. The five expressions in `wrangler.jsonc` must match `STAGED_CRONS` in `src/pipeline/run.ts` (a test checks that every stage is covered). Free accounts allow five cron triggers in total, so disable the crons on the old agent Workers first.

**CPU on Free.** Parsing feeds is the expensive part. Measured on real feed bodies, parsing costs about 0.34 ms per feed, so a 25-feed collect is roughly 9 ms of parsing before anything else, which is at the edge of Free's limit. If Cloudflare logs `Worker exceeded CPU time limit` (error 1102), lower `FEEDS_PER_RUN` (for example `15`) or move to Workers Paid and `single` mode. The numbers were measured in Node, not on Cloudflare's Free plan, so treat them as a guide.

## Georgian

- **Translator** writes each verified English briefing in natural Georgian (Latin brand names stay Latin with a hyphenated ending, as in `Google-მა`).
- **Georgian grammar checker** is a second, independent pass: spelling, case endings (including the narrative case of transitive verbs), verb forms, agreement, singular nouns after numerals, punctuation, English-isms.
- Both stages are guarded in code, not just by prompt: the **digits must be identical** to the English (formatting may change, digits may not) and the text must **really be Georgian**. A failing result is retried and the article is rejected after 3 failed attempts. An LLM outage never counts against an article.
- An article is published only after its Georgian version has passed the grammar checker.
- The whole interface is translated (`public/i18n.js`, Georgian by default, English available). Month and weekday names come from tables in the app because some browsers ship no Georgian locale data.
- `GEMINI_MODEL_KA` lets the two Georgian stages use a stronger model than the rest.

## Configuration

| Name | Kind | Default | Meaning |
|---|---|---|---|
| `GEMINI_API_KEY` | secret | – | Required for any drafting, editing, fact-checking or translating. Without it the Worker still collects sources but publishes nothing. |
| `ADMIN_KEY` | secret | – | Enables `POST /api/run[/stage]`, sent as `x-admin-key` or `Authorization: Bearer`. Unset = endpoint disabled. |
| `GEMINI_MODEL` | var | `gemini-2.5-flash` | Same variable agent 2 uses. |
| `GEMINI_MODEL_KA` | var | `GEMINI_MODEL` | Optional stronger model for translate + Georgian grammar check. |
| `GEMINI_BASE_URL` | var | Google's endpoint | Route calls through a gateway (e.g. Cloudflare AI Gateway). |
| `PIPELINE_MODE` | var | `staged` | `staged` (Free) or `single` (Paid). |
| `FEEDS_PER_RUN` | var | `30` | Sources per collect. Sources are split into `ceil(75 / FEEDS_PER_RUN)` groups visited in turn: `30` → 3 groups of 25. Use `80` with `single` on Paid. |
| `MAX_ARTICLES_PER_RUN` | var | `3` | New drafts per research run, and the batch size of every later stage. |
| `PUBLISH_THRESHOLD` | var | `60` | Minimum trust score to publish. |

**Per-invocation budget (Free allows 50 outbound requests and 50 D1 queries).** Measured in the test suite with three stories moving through every stage: a collect makes 25 outbound requests and 6 D1 calls; the busiest invocation (research + edit) makes 2 Gemini calls and 19 D1 calls (26 counting each statement inside a batch). A stage makes one Gemini call, or two if the first response fails validation.

## Trust score

`score = credibility (0–40) + corroboration (0–25) + primary evidence (0–20) + claim support (0–15) − penalties`

| Component | How it is computed |
|---|---|
| Credibility | Best non-social source weight, scaled (5.0 → 40) |
| Corroboration | Independent non-social publishers: 1 → 5, 2 → 20, 3+ → 25 |
| Primary evidence | Best source 5.0 → 20, 4.5 → 14, 4.0 → 10, 3.5 → 5 |
| Claim support | Share of the article's claims the sources back, checked by the LLM against each source's excerpt |
| Penalty | −30 per contradicted claim |

A story advances only if **all** gates pass; a high score alone is never enough:
1. at least one non-social source (Hacker News, Reddit and X only help discover stories);
2. two independent publishers **or** one primary source (central bank, statistics office, regulator, ministry, journal);
3. no claim contradicted by its sources;
4. at least 70% of claims supported;
5. score ≥ `PUBLISH_THRESHOLD`.

Source weights live in `src/registry/sources.ts` (5.0 primary/official, 4.5 wires, 4.0 major financial press, 3.5 specialist press and company newsrooms, 2.5–3.0 commentary, 1.0–2.0 social). Sources the spec did not place in a tier were assigned by analogy: exchanges and rating agencies 4.0, trade press 3.5, consultancy research 3.0, aggregators 3.0, blogs and newsletters 2.5. Change a number there and scoring follows. Every decision, with its breakdown and reject reasons, is stored in `pipeline_events`; the UI shows the breakdown when a story is expanded.

## Sources

The registry holds all 13 categories from the brief. Only sources with a working public feed are **polled**; the rest still count when they are cited. Not polled (no public feed): Reuters, AP, Bloomberg, and most paywalled or bot-blocked sites. 75 feeds are polled (71 RSS, 4 scraped listings). At most 12 newest items are read per feed.

- **Georgia.** NBG, GeoStat, the Ministry of Finance and the Georgian Stock Exchange publish no RSS, so their HTML news listings are read by link pattern (`kind: 'page'`). The first time a listing is seen, its existing links are recorded as old news so a backlog does not flood the pool. The Revenue Service has no scrapeable listing and is weight-only.
- **Additions beyond the brief:** Civil.ge (Georgian press, so official Georgian data has independent corroboration), and the trade feeds agent 2 already polled (Marketing Dive, HousingWire, Supply Chain Dive, FreightWaves, Banking Dive, Finextra, Realtor.com).
- **Not polled on purpose:** the general Nature and Science feeds. They carry essays and non-business science that would pass the primary-source rule and crowd out news.
- A dead or blocked feed never fails a run: it is logged to `pipeline_events` (`stage = 'feed'`) and counted in `/api/status`.

## API

| Endpoint | |
|---|---|
| `GET /api/articles?lang=&tab=&date=&time=&limit=&before=` | `lang`: `en` (default) or `ka`. In `ka`, only stories whose Georgian version passed the grammar checker are listed, with the Georgian text. `tab`: `top10`, `all`, `georgia`, `ai-tech`, `economics`, `crypto`, `marketing`, `real-estate`, `global-trade`, `vc-startups`. `top10` is `trust_score DESC LIMIT 10`. `time=HH:MM` matches the 5-minute slot `[HH:MM, HH:MM+5)` in Asia/Tbilisi, on any day, or on `date=YYYY-MM-DD` if given. Timestamps in the response are UTC. |
| `GET /api/articles/:id?lang=` | One story plus its trust breakdown. |
| `GET /api/slots?date=&tab=` | Stories per 5-minute slot (feeds the tape in the UI). |
| `GET /api/meta` | Tabs, counts, next cron slot, last run. |
| `GET /api/status` | Health: last run, queue sizes, feed errors in 24h. No secrets. |
| `POST /api/run[/stage]` | Admin only. Runs the whole pipeline, or one stage (`collect`, `research`, `edit`, `fact_check`, `translate`, `ka_grammar`, `publish`), now. |

All stored timestamps are UTC ISO-8601. The browser renders them in `Asia/Tbilisi`.

## Database

`schema.sql` holds the `articles` table exactly as specified, plus operational tables: `article_translations` (the Georgian text, one row per article and language), `feed_items` (the rolling pool of collected items), `pipeline_runs` (also the run lock, one live run per scope) and `pipeline_events` (audit trail). It is safe to re-run. If a different `articles` table already exists in the target database, `CREATE TABLE IF NOT EXISTS` will not change it, so use a fresh database.

Articles, translations and feed items are never deleted. Run and event logs older than 30 days are trimmed daily. Drafts not published within 24 hours are rejected as stale.

## Develop

```bash
npm install
npm run build:css
npm run db:init && npm run db:seed   # local D1 + clearly-labelled "[Sample]" stories, in both languages
npm run dev                          # http://localhost:8787
curl "http://localhost:8787/__scheduled?cron=2-59%2F5+*+*+*+*"   # fire one staged trigger
npm test                             # unit + integration tests (real SQLite semantics)
npm run typecheck
```

`seed.sql` is demo content for local use only. Never run it against production.

## Known limits

- **The Georgian has not been read by a native speaker.** The interface text, the agents' prompts and the demo content were written without native review. The Georgian grammar checker and the code guards catch a lot, but they are no substitute for a person. Before launch, have a Georgian speaker read the interface strings in `public/i18n.js` and a day of generated stories, and consider `GEMINI_MODEL_KA` set to a larger model.
- **Gemini calls are tested against a fake, not live.** The request shape is the same as agent 2's working call plus `system_instruction`; the environment this was built in had no key. Check `GET /api/status` and `pipeline_events` after the first cron runs.
- **The Free plan's CPU limit is the main risk** (see above). Workers Paid removes it.
- **Fact-checking judges claims against feed excerpts** (title plus up to 600 characters), not full articles. Briefings are therefore short, and the Research prompt forbids facts the excerpts do not state. Translation fidelity is guarded by the digit check and the grammar pass, not by a second fact-check of the Georgian.
- **Source titles are shown as published** (mostly English), even in the Georgian interface.
- **Syndicated copies count as separate publishers** when they appear under another domain.
- `ioane-agent` (agent 1) was not available to read, so nothing from it was carried over.
