-- ============================================================
-- NUGBASE
-- Guide / News Management
-- Migration 0001
--
-- D1:
--   - servers
--   - articles
--   - article_id_history
--
-- Article body/frontmatter are NOT stored in D1.
-- GitHub src/content/ is the source of truth.
-- ============================================================


-- ============================================================
-- 1. Servers
-- ------------------------------------------------------------
-- Minecraft servers managed from the admin panel.
--
-- Example:
--   slug = "cho"
--   name = "Cho"
--
-- A server is disabled instead of being physically deleted.
-- ============================================================

CREATE TABLE servers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT,

    enabled INTEGER NOT NULL DEFAULT 1
        CHECK (enabled IN (0, 1)),

    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);


-- ============================================================
-- 2. Articles
-- ------------------------------------------------------------
-- Management ledger for Guide / News articles.
--
-- IMPORTANT:
-- The actual Markdown/MDX content is stored in GitHub.
-- This table does NOT duplicate article frontmatter/body.
--
-- Guide:
--   content_type = 'guide'
--   server_id    = corresponding server
--   article_id   = '001', '002', ...
--
-- News:
--   content_type = 'news'
--   server_id    = NULL
--   article_id   = '001', '002', ...
-- ============================================================

CREATE TABLE articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    content_type TEXT NOT NULL
        CHECK (content_type IN ('guide', 'news')),

    article_id TEXT NOT NULL,

    server_id INTEGER,

    source_path TEXT NOT NULL UNIQUE,

    status TEXT NOT NULL DEFAULT 'published'
        CHECK (
            status IN (
                'publishing',
                'published',
                'deleted'
            )
        ),

    created_by TEXT NOT NULL,
    updated_by TEXT NOT NULL,

    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    published_at TEXT,

    FOREIGN KEY (server_id)
        REFERENCES servers(id),

    FOREIGN KEY (created_by)
        REFERENCES users(id),

    FOREIGN KEY (updated_by)
        REFERENCES users(id)
);


-- ============================================================
-- 3. Article ID History
-- ------------------------------------------------------------
-- Permanent record of article numbers that have been used.
--
-- This is intentionally NOT deleted when an article is deleted.
--
-- Therefore:
--
--   Cho 001 -> used
--   delete Cho 001
--   Cho 001 -> CANNOT be reused
--
-- Guide IDs are per server.
-- News IDs are global.
-- ============================================================

CREATE TABLE article_id_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    content_type TEXT NOT NULL
        CHECK (content_type IN ('guide', 'news')),

    server_id INTEGER,

    article_id TEXT NOT NULL,

    used_at TEXT NOT NULL,

    FOREIGN KEY (server_id)
        REFERENCES servers(id)
);


-- ============================================================
-- 4. Article uniqueness
-- ------------------------------------------------------------
-- Guide:
--   server + article_id must be unique.
--
-- News:
--   article_id must be globally unique.
--
-- COALESCE(server_id, 0):
--   NULL (News) is treated as 0 for uniqueness.
-- ============================================================

CREATE UNIQUE INDEX idx_articles_unique_id
ON articles (
    content_type,
    COALESCE(server_id, 0),
    article_id
);


-- ============================================================
-- 5. Permanent ID history uniqueness
-- ------------------------------------------------------------
-- Prevent the same article number from being registered
-- more than once in the permanent history.
-- ============================================================

CREATE UNIQUE INDEX idx_article_id_history_unique
ON article_id_history (
    content_type,
    COALESCE(server_id, 0),
    article_id
);


-- ============================================================
-- 6. Search / filter indexes
-- ============================================================

CREATE INDEX idx_articles_content_type
ON articles(content_type);

CREATE INDEX idx_articles_server_id
ON articles(server_id);

CREATE INDEX idx_articles_status
ON articles(status);

CREATE INDEX idx_articles_updated_at
ON articles(updated_at);

CREATE INDEX idx_articles_published_at
ON articles(published_at);