export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;

  // secrets
  GEMINI_API_KEY?: string;
  ADMIN_KEY?: string;

  // vars (all strings, as Workers delivers them)
  GEMINI_MODEL?: string;
  /** Optional stronger model for the two Georgian stages (translate, ka_grammar). */
  GEMINI_MODEL_KA?: string;
  /** 'staged' (default): several cron triggers, one slice of the pipeline each. 'single': one trigger runs everything. */
  PIPELINE_MODE?: string;
  /** Optional: route Gemini calls through a gateway (e.g. Cloudflare AI Gateway) or a test server. */
  GEMINI_BASE_URL?: string;
  FEEDS_PER_RUN?: string;
  MAX_ARTICLES_PER_RUN?: string;
  PUBLISH_THRESHOLD?: string;
}

/** Article categories shown as tabs. "Georgia Focus" is a flag, not a category. */
export const ARTICLE_CATEGORIES = [
  'General',
  'AI & Tech',
  'Economics',
  'Crypto',
  'Marketing',
  'Real Estate',
  'Global Trade',
  'VC & Startups',
] as const;
export type ArticleCategory = (typeof ARTICLE_CATEGORIES)[number];

export type ArticleStatus = 'raw_research' | 'edited' | 'published' | 'rejected';

/** One cited source, as stored in articles.source_links. */
export interface SourceLink {
  title: string;
  url: string;
  /** Source credibility weight on the 0–5 scale from the registry. */
  trust_score: number;
}

/** Row shape of the articles table. */
export interface ArticleRow {
  id: string;
  headline: string;
  summary: string;
  what_happened: string;
  why_it_matters: string;
  figures_dates: string | null;
  affected_entities: string | null;
  risks_uncertainty: string | null;
  category: string;
  georgia_related: number;
  source_links: string;
  trust_score: number;
  grammar_checked: number;
  fact_checked: number;
  status: ArticleStatus;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Row shape of feed_items. */
export interface FeedItemRow {
  id: string;
  source_id: string;
  source_name: string;
  feed_id: string;
  title: string;
  url: string;
  snippet: string | null;
  published_at: string;
  fetched_at: string;
  via_social: number;
  georgia: number;
  category_hint: string | null;
  offered_count: number;
  article_id: string | null;
}

export interface StageResult {
  stage: 'research' | 'edit' | 'fact_check';
  skipped?: string;
  [k: string]: unknown;
}
