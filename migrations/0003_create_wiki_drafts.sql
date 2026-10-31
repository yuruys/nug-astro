CREATE TABLE wiki_drafts (
	id TEXT PRIMARY KEY,
	operation TEXT NOT NULL CHECK (operation IN ('create', 'update', 'delete')),
	status TEXT NOT NULL DEFAULT 'draft'
		CHECK (status IN ('draft', 'publishing', 'pending', 'merged', 'closed')),
	title TEXT NOT NULL,
	slug TEXT NOT NULL,
	folder_path TEXT NOT NULL,
	page_path TEXT NOT NULL,
	source_path TEXT NOT NULL,
	description TEXT NOT NULL DEFAULT '',
	content TEXT NOT NULL DEFAULT '',
	submitted_content TEXT,
	created_by TEXT NOT NULL,
	updated_by TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	version INTEGER NOT NULL DEFAULT 1,
	github_pr_number INTEGER,
	github_pr_url TEXT,
	github_pr_state TEXT,
	FOREIGN KEY (created_by) REFERENCES users(id),
	FOREIGN KEY (updated_by) REFERENCES users(id)
);

CREATE INDEX idx_wiki_drafts_status_updated
	ON wiki_drafts(status, updated_at DESC);

CREATE INDEX idx_wiki_drafts_source_path
	ON wiki_drafts(source_path);

CREATE UNIQUE INDEX idx_wiki_drafts_active_source
	ON wiki_drafts(source_path)
	WHERE status IN ('draft', 'publishing', 'pending');
