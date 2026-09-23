-- =========================================================
-- NUGBACE Wiki Editing System
-- Database Schema
-- =========================================================

PRAGMA foreign_keys = ON;


-- =========================================================
-- 01. users
-- ---------------------------------------------------------
-- NUGBACEのユーザー本体。
-- Google / Discordのログイン情報そのものは
-- user_identitiesで管理する。
-- =========================================================

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,

    display_name TEXT NOT NULL,

    email TEXT,

    avatar_url TEXT,

    role TEXT NOT NULL DEFAULT 'user'
        CHECK (role IN ('user', 'editor', 'admin')),

    created_at TEXT NOT NULL,

    updated_at TEXT NOT NULL
);


-- =========================================================
-- 02. user_identities
-- ---------------------------------------------------------
-- Google / Discordなど、外部ログインサービスとの紐付け。
--
-- 例:
-- provider = 'google'
-- provider_user_id = Google側のユーザーID
--
-- provider = 'discord'
-- provider_user_id = Discord側のユーザーID
--
-- 1つのNUGBACEアカウントに複数のログイン方法を
-- 紐付けられる設計。
-- =========================================================

CREATE TABLE IF NOT EXISTS user_identities (
    id TEXT PRIMARY KEY,

    user_id TEXT NOT NULL,

    provider TEXT NOT NULL
        CHECK (provider IN ('google', 'discord')),

    provider_user_id TEXT NOT NULL,

    created_at TEXT NOT NULL,

    FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON DELETE CASCADE,

    UNIQUE (provider, provider_user_id)
);


-- =========================================================
-- 03. sessions
-- ---------------------------------------------------------
-- NUGBACEへのログイン状態を管理する。
--
-- ブラウザのCookieと、このテーブルを組み合わせて
-- ログイン状態を維持する。
-- =========================================================

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,

    user_id TEXT NOT NULL,

    expires_at TEXT NOT NULL,

    created_at TEXT NOT NULL,

    FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON DELETE CASCADE
);


-- =========================================================
-- 04. wiki_pages
-- ---------------------------------------------------------
-- NUGBACE Wikiの「ページそのもの」を管理する。
--
-- 実際の公開Markdown/MDXファイルはGitHub側に存在し、
-- このテーブルではページの管理情報を持つ。
-- =========================================================

CREATE TABLE IF NOT EXISTS wiki_pages (
    id TEXT PRIMARY KEY,

    path TEXT NOT NULL UNIQUE,

    title TEXT NOT NULL,

    source_path TEXT NOT NULL UNIQUE,

    published_revision_id TEXT,

    created_at TEXT NOT NULL,

    updated_at TEXT NOT NULL
);


-- =========================================================
-- 05. wiki_revisions
-- ---------------------------------------------------------
-- Wikiページの編集履歴。
--
-- 編集内容を毎回Revisionとして保存するため、
-- 過去の編集内容を残せる。
-- =========================================================

CREATE TABLE IF NOT EXISTS wiki_revisions (
    id TEXT PRIMARY KEY,

    page_id TEXT NOT NULL,

    revision_number INTEGER NOT NULL,

    content TEXT NOT NULL,

    editor_id TEXT NOT NULL,

    created_at TEXT NOT NULL,

    FOREIGN KEY (page_id)
        REFERENCES wiki_pages(id)
        ON DELETE CASCADE,

    FOREIGN KEY (editor_id)
        REFERENCES users(id)
);


-- =========================================================
-- 06. edit_requests
-- ---------------------------------------------------------
-- Wikiの編集申請を管理する。
--
-- draft
--   下書き
--
-- pending
--   管理者による確認待ち
--
-- approved
--   管理者が承認
--
-- rejected
--   管理者が却下
--
-- publishing
--   GitHubへの反映処理中
--
-- published
--   公開済み
-- =========================================================

CREATE TABLE IF NOT EXISTS edit_requests (
    id TEXT PRIMARY KEY,

    page_id TEXT NOT NULL,

    revision_id TEXT NOT NULL,

    base_revision_id TEXT,

    user_id TEXT NOT NULL,

    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (
            status IN (
                'draft',
                'pending',
                'approved',
                'rejected',
                'publishing',
                'published'
            )
        ),

    message TEXT,

    reviewer_id TEXT,

    review_comment TEXT,

    created_at TEXT NOT NULL,

    reviewed_at TEXT,

    FOREIGN KEY (page_id)
        REFERENCES wiki_pages(id)
        ON DELETE CASCADE,

    FOREIGN KEY (revision_id)
        REFERENCES wiki_revisions(id),

    FOREIGN KEY (base_revision_id)
        REFERENCES wiki_revisions(id),

    FOREIGN KEY (user_id)
        REFERENCES users(id),

    FOREIGN KEY (reviewer_id)
        REFERENCES users(id)
);


-- =========================================================
-- 07. audit_logs
-- ---------------------------------------------------------
-- 管理操作・重要操作の記録。
--
-- 例:
--   編集申請を承認
--   編集申請を却下
--   権限変更
--   GitHub反映
-- =========================================================

CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,

    user_id TEXT,

    action TEXT NOT NULL,

    target_type TEXT,

    target_id TEXT,

    metadata TEXT,

    created_at TEXT NOT NULL,

    FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON DELETE SET NULL
);


-- =========================================================
-- INDEXES
-- =========================================================

CREATE INDEX IF NOT EXISTS idx_user_identities_user_id
    ON user_identities(user_id);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id
    ON sessions(user_id);

CREATE INDEX IF NOT EXISTS idx_sessions_expires_at
    ON sessions(expires_at);

CREATE INDEX IF NOT EXISTS idx_wiki_revisions_page_id
    ON wiki_revisions(page_id);

CREATE INDEX IF NOT EXISTS idx_edit_requests_status
    ON edit_requests(status);

CREATE INDEX IF NOT EXISTS idx_edit_requests_page_id
    ON edit_requests(page_id);

CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id
    ON audit_logs(user_id);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at
    ON audit_logs(created_at);