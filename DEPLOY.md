# Deploy IOANE News

**Where it runs: Cloudflare Workers**, the same place `ioane-news`, `ioane-agent` and `ioane-agent-2` run now. After deploying, the site is at `https://<worker-name>.ac3flow33.workers.dev`: `ioane-news` if you deploy over the existing Worker, or `ioanenews` if you keep the Worker your GitHub connection is set up for (see step A2). The commands below use the `ioane-news` address; swap in yours. You do not need any other host.

You need: a Cloudflare account, [Node.js 20 or newer](https://nodejs.org), and your Gemini API key (the one `ioane-agent-2` uses).

## Which way are you deploying?

- **A. Cloudflare's GitHub connection** (Workers & Pages builds the repo for you; no terminal). Follow the section below, then jump to **"Check that it works"**.
- **B. From your own terminal.** Skip to **"1. Install"**.

## A. Deploying through Cloudflare's GitHub connection

If your build log ends with `binding DB … must have a valid database_id`, you are at step A1.

**A1. Create the database and put its id in `wrangler.jsonc`.**
In the Cloudflare dashboard open **Storage & databases → D1 SQL database → Create database**, name it `ioane-news`, and copy its **Database ID** (a long `xxxxxxxx-xxxx-…` value; it is not a secret). On GitHub, open `wrangler.jsonc`, replace `PASTE_YOUR_D1_ID_HERE` with that id, and commit. **You do not need to create any tables**: the Worker creates them itself the first time it runs.

**A2. Make the Worker name match.**
The `name` in `wrangler.jsonc` must equal the Worker's name in Cloudflare. A build log line like `the CI system expected "ioanenews"` means the connected Worker is called `ioanenews`. You have two choices:
- Keep the connected Worker. Change `"name": "ioane-news"` to `"name": "ioanenews"` in `wrangler.jsonc`. The site is then at `https://ioanenews.<your-subdomain>.workers.dev`, which is a **new address**, not the old `ioane-news` one.
- Or deploy over your existing `ioane-news` Worker: open **Workers & Pages → ioane-news → Settings → Builds**, connect this repository there, and remove the connection from `ioanenews`.

**A3. Add the secrets in the dashboard.**
Open your Worker → **Settings → Variables and Secrets → Add**, type **Secret**, and add `GEMINI_API_KEY` (your Gemini key) and `ADMIN_KEY` (a long random password you invent). Secrets survive every deploy. Plain-text variables you add in the dashboard do not: `wrangler.jsonc` overwrites them, so change those in the file instead.

**A4. Free up cron triggers** (Free plan): see step 4 below.

**A5.** Push or re-run the build. It should end with a deployed Worker.

## B. Deploying from your terminal

### 1. Install

Unzip the project, open a terminal in the folder, then:

```bash
npm install
npx wrangler login          # opens a browser; log in to the Cloudflare account that owns ioane-news
```

### 2. Create the database

```bash
npx wrangler d1 create ioane-news
```

It prints a block containing `"database_id": "xxxxxxxx-xxxx-…"`. Open `wrangler.jsonc`, find `PASTE_YOUR_D1_ID_HERE`, and replace it with that id. The tables are created automatically the first time the Worker runs (`npm run db:init:remote` does the same by hand if you prefer).

### 3. Add your secrets

```bash
npx wrangler secret put GEMINI_API_KEY    # paste your Gemini key when asked
npx wrangler secret put ADMIN_KEY         # invent a long random password; it lets you start the pipeline by hand
```

### 4. Free up cron triggers

A Free Cloudflare account allows **5 cron triggers in total**, and this project uses all 5. In the Cloudflare dashboard, open **Workers & Pages → ioane-agent → Settings → Triggers** and delete its cron triggers. Do the same for **ioane-agent-2**. (Skip this step if you are on the Paid plan.)

### 5. Publish

```bash
npm run deploy
```

This builds the stylesheet and publishes the Worker. It replaces the current `ioane-news` page.

## Check that it works

1. Open `https://ioane-news.ac3flow33.workers.dev`. The page is Georgian; the **EN** button switches to English. It will say there are no stories yet.
2. Start the pipeline once by hand instead of waiting for the clock. Replace `YOUR_ADMIN_KEY`:

   ```bash
   curl -X POST -H "x-admin-key: YOUR_ADMIN_KEY" https://ioane-news.ac3flow33.workers.dev/api/run
   ```

   This runs every stage once. It can take a minute or two.
3. Look at `https://ioane-news.ac3flow33.workers.dev/api/status`. You want `"llmConfigured": true`, a recent `lastRun` with `"status": "ok"`, and `"lastError": null`. If `lastError` is not null, it names the stage and the message (see the table below).
4. From now on it runs by itself. The first stories can take 10–15 minutes or longer: sources are collected first, then a story needs corroboration before it is drafted, checked, translated and published. Stories only appear if they have two independent sources or one official source, so a quiet news hour can mean few or no new stories.

## Where to look when something is wrong

| You see | Likely cause and fix |
|---|---|
| No stories after 30 minutes, `llmConfigured: false` | The `GEMINI_API_KEY` secret is missing. Add it again (step A3 or 3), then redeploy. |
| `lastError` says `Gemini 404 … no longer available to new users` | Google retired the model named in `wrangler.jsonc`. Open <https://ai.google.dev/gemini-api/docs/models>, pick a current Flash model (this project uses `gemini-3.5-flash-lite`; `gemini-3.8-flash` is the larger one), put it in the `GEMINI_MODEL` line, and deploy again. |
| `lastRun` has `"status": "error"` | `curl https://ioane-news.ac3flow33.workers.dev/api/status`, then in the dashboard open **ioane-news → Logs** to read the error. A Gemini error (429, 503) usually passes by itself. |
| Logs show `Worker exceeded CPU time limit` (error 1102) | The Free plan's CPU limit. Either set `FEEDS_PER_RUN` to `15` in `wrangler.jsonc` and run `npm run deploy`, or move to Workers Paid (below). |
| Georgian text reads badly | `gemini-3.5-flash-lite` is the smallest Gemini tier. Uncomment `GEMINI_MODEL_KA` in `wrangler.jsonc` (set to `gemini-3.8-flash`) to use a larger Gemini model for the Georgian stages only, then `npm run deploy`. Have a Georgian speaker review the interface text in `public/i18n.js`. |
| The page loads but has no styling | The build step failed. Run `npm run build`, then deploy again. |
| Build log: `binding DB … must have a valid database_id` | `wrangler.jsonc` still has `PASTE_YOUR_D1_ID_HERE`. See step A1 or 2. |
| Build log: `Failed to match Worker name` | See step A2. |

## Optional: Workers Paid ($5/month)

Search **every source every 5 minutes** instead of every 15, and remove the CPU risk. In `wrangler.jsonc`:

1. Replace the five crons with `"crons": ["*/5 * * * *"]`.
2. Set `"PIPELINE_MODE": "single"` and `"FEEDS_PER_RUN": "80"`.
3. Run `npm run deploy`.

## Optional: your own domain

Cloudflare dashboard → **Workers & Pages → ioane-news → Settings → Domains & Routes → Add**. The domain must be on Cloudflare.
