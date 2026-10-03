# Deploy IOANE News

**Where it runs: Cloudflare Workers**, the same place `ioane-news`, `ioane-agent` and `ioane-agent-2` run now. After deploying, the site is at `https://ioane-news.ac3flow33.workers.dev` (the address you already use). You do not need any other host.

You need: a Cloudflare account, [Node.js 20 or newer](https://nodejs.org), and your Gemini API key (the one `ioane-agent-2` uses).

## 1. Install

Unzip the project, open a terminal in the folder, then:

```bash
npm install
npx wrangler login          # opens a browser; log in to the Cloudflare account that owns ioane-news
```

## 2. Create the database

```bash
npx wrangler d1 create ioane-news
```

It prints a block containing `"database_id": "xxxxxxxx-xxxx-…"`. Open `wrangler.jsonc`, find `PASTE_YOUR_D1_ID_HERE`, and replace it with that id. Then create the tables:

```bash
npm run db:init:remote
```

## 3. Add your secrets

```bash
npx wrangler secret put GEMINI_API_KEY    # paste your Gemini key when asked
npx wrangler secret put ADMIN_KEY         # invent a long random password; it lets you start the pipeline by hand
```

## 4. Free up cron triggers

A Free Cloudflare account allows **5 cron triggers in total**, and this project uses all 5. In the Cloudflare dashboard, open **Workers & Pages → ioane-agent → Settings → Triggers** and delete its cron triggers. Do the same for **ioane-agent-2**. (Skip this step if you are on the Paid plan.)

## 5. Publish

```bash
npm run deploy
```

This builds the stylesheet and publishes the Worker. It replaces the current `ioane-news` page.

## 6. Check that it works

1. Open `https://ioane-news.ac3flow33.workers.dev`. The page is Georgian; the **EN** button switches to English. It will say there are no stories yet.
2. Start the pipeline once by hand instead of waiting for the clock. Replace `YOUR_ADMIN_KEY`:

   ```bash
   curl -X POST -H "x-admin-key: YOUR_ADMIN_KEY" https://ioane-news.ac3flow33.workers.dev/api/run
   ```

   This runs every stage once. It can take a minute or two.
3. Look at `https://ioane-news.ac3flow33.workers.dev/api/status`. You want `"llmConfigured": true` and a recent `lastRun` with `"status": "ok"`.
4. From now on it runs by itself. The first stories can take 10–15 minutes or longer: sources are collected first, then a story needs corroboration before it is drafted, checked, translated and published. Stories only appear if they have two independent sources or one official source, so a quiet news hour can mean few or no new stories.

## Where to look when something is wrong

| You see | Likely cause and fix |
|---|---|
| No stories after 30 minutes, `llmConfigured: false` | The `GEMINI_API_KEY` secret is missing. Run step 3 again, then `npm run deploy`. |
| `lastRun` has `"status": "error"` | `curl https://ioane-news.ac3flow33.workers.dev/api/status`, then in the dashboard open **ioane-news → Logs** to read the error. A Gemini error (429, 503) usually passes by itself. |
| Logs show `Worker exceeded CPU time limit` (error 1102) | The Free plan's CPU limit. Either set `FEEDS_PER_RUN` to `15` in `wrangler.jsonc` and run `npm run deploy`, or move to Workers Paid (below). |
| Georgian text reads badly | Uncomment `GEMINI_MODEL_KA` in `wrangler.jsonc` to use a larger Gemini model for the Georgian stages, then `npm run deploy`. Have a Georgian speaker review the interface text in `public/i18n.js`. |
| The page loads but has no styling | `npm run deploy` was skipped or the build failed. Run `npm run build:css`, then `npm run deploy`. |

## Optional: Workers Paid ($5/month)

Search **every source every 5 minutes** instead of every 15, and remove the CPU risk. In `wrangler.jsonc`:

1. Replace the five crons with `"crons": ["*/5 * * * *"]`.
2. Set `"PIPELINE_MODE": "single"` and `"FEEDS_PER_RUN": "80"`.
3. Run `npm run deploy`.

## Optional: your own domain

Cloudflare dashboard → **Workers & Pages → ioane-news → Settings → Domains & Routes → Add**. The domain must be on Cloudflare.

## Optional: deploy from GitHub instead of your terminal

The code is on GitHub. In the dashboard, **Workers & Pages → ioane-news → Settings → Builds → Connect** the repository, set the deploy command to `npx wrangler deploy`, and each push to the branch you choose deploys automatically. You still do steps 2 and 3 once (the database id goes into `wrangler.jsonc` before you commit it).
