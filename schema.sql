CREATE TABLE IF NOT EXISTS articles (
    id TEXT PRIMARY KEY,
    headline TEXT NOT NULL,
    summary TEXT NOT NULL,
    what_happened TEXT NOT NULL,
    why_it_matters TEXT NOT NULL,
    figures_dates TEXT,
    affected_entities TEXT,
    risks_uncertainty TEXT,
    category TEXT DEFAULT 'General',
    georgia_related INTEGER DEFAULT 0,
    source_links TEXT NOT NULL, -- JSON array of [{title, url, trust_score}]
    trust_score INTEGER DEFAULT 0,
    grammar_checked INTEGER DEFAULT 0,
    fact_checked INTEGER DEFAULT 0,
    status TEXT DEFAULT 'raw_research', -- 'raw_research' -> 'edited' -> 'published' / 'rejected'
    published_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_status_published ON articles(status, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_trust_score ON articles(trust_score DESC);
CREATE INDEX IF NOT EXISTS idx_category ON articles(category);

-- ─────────────────────────────────────────────────────────────────────────────
-- Operational tables (not part of the content model above). All timestamps UTC.
-- ─────────────────────────────────────────────────────────────────────────────

-- Rolling pool of items collected by the Research agent. Permanent archive:
-- nothing is deleted. An item is "used" once an article cites it.
CREATE TABLE IF NOT EXISTS feed_items (
    id TEXT PRIMARY KEY,                -- sha256(normalized URL), first 32 hex chars
    source_id TEXT NOT NULL,            -- registry id, or registrable domain if unregistered
    source_name TEXT NOT NULL,
    feed_id TEXT NOT NULL,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    snippet TEXT,
    published_at TEXT NOT NULL,         -- ISO-8601 UTC
    fetched_at TEXT NOT NULL,           -- ISO-8601 UTC
    via_social INTEGER DEFAULT 0,       -- discovered through a social aggregator
    georgia INTEGER DEFAULT 0,
    category_hint TEXT,
    offered_count INTEGER DEFAULT 0,    -- times sent to the Research LLM without becoming an article
    article_id TEXT                     -- set when cited by an article
);

CREATE INDEX IF NOT EXISTS idx_feed_items_pool ON feed_items(article_id, published_at DESC);

-- One row per pipeline execution (cron or manual). Doubles as the run lock.
CREATE TABLE IF NOT EXISTS pipeline_runs (
    run_id TEXT PRIMARY KEY,
    trigger TEXT NOT NULL,              -- 'cron' | 'manual'
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL,               -- 'running' | 'ok' | 'error'
    stats TEXT                          -- JSON
);

CREATE INDEX IF NOT EXISTS idx_runs_started ON pipeline_runs(started_at DESC);

-- Audit trail: every stage decision per article (incl. trust-score breakdown and
-- reject reasons) and per-feed failures.
CREATE TABLE IF NOT EXISTS pipeline_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT,
    article_id TEXT,
    stage TEXT NOT NULL,                -- 'research' | 'edit' | 'fact_check' | 'publish' | 'feed'
    outcome TEXT NOT NULL,              -- 'ok' | 'rejected' | 'error' | 'skipped'
    detail TEXT,                        -- JSON
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_article ON pipeline_events(article_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_events_stage ON pipeline_events(stage, id DESC);
