import { handleApi } from './api';
import { runPipeline } from './pipeline/run';
import type { Env } from './types';

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(req.url);
    // wrangler.jsonc routes only /api/* here; anything else is a static asset.
    if (pathname.startsWith('/api/')) return handleApi(req, env);
    return env.ASSETS.fetch(req);
  },

  // */5 * * * *  ->  Research -> Edit -> Fact-Check -> Publish/Reject
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runPipeline(env, { trigger: 'cron' })
        .then((r) => console.log('pipeline', r.status, JSON.stringify(r.stages)))
        .catch((e) => console.error('pipeline FAILED:', e instanceof Error ? e.message : e)),
    );
  },
} satisfies ExportedHandler<Env>;
