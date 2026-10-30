CREATE TABLE taxonomy_categories (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	content_type TEXT NOT NULL CHECK (content_type IN ('guide', 'news')),
	name TEXT NOT NULL,
	normalized_name TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	UNIQUE (content_type, normalized_name)
);

CREATE TABLE taxonomy_tags (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL,
	normalized_name TEXT NOT NULL UNIQUE,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

INSERT INTO taxonomy_categories (content_type, name, normalized_name, created_at, updated_at)
VALUES
	('guide', '初心者向け', '初心者向け', datetime('now'), datetime('now')),
	('guide', '基本情報', '基本情報', datetime('now'), datetime('now')),
	('guide', '経済', '経済', datetime('now'), datetime('now')),
	('guide', '土地・建築', '土地・建築', datetime('now'), datetime('now')),
	('guide', '国家・外交', '国家・外交', datetime('now'), datetime('now')),
	('guide', '戦闘', '戦闘', datetime('now'), datetime('now')),
	('guide', '採掘・資源', '採掘・資源', datetime('now'), datetime('now')),
	('guide', '農業・生活', '農業・生活', datetime('now'), datetime('now')),
	('guide', 'プラグイン', 'プラグイン', datetime('now'), datetime('now')),
	('guide', 'ワールド', 'ワールド', datetime('now'), datetime('now')),
	('guide', '便利機能', '便利機能', datetime('now'), datetime('now')),
	('guide', '困ったとき', '困ったとき', datetime('now'), datetime('now')),
	('guide', '未分類', '未分類', datetime('now'), datetime('now')),
	('news', 'マイクラアプデ', 'マイクラアプデ', datetime('now'), datetime('now')),
	('news', 'サーバーアプデ', 'サーバーアプデ', datetime('now'), datetime('now')),
	('news', 'マイクライベント', 'マイクライベント', datetime('now'), datetime('now')),
	('news', 'サーバーイベント', 'サーバーイベント', datetime('now'), datetime('now')),
	('news', 'NUGBASEおしらせ', 'nugbaseおしらせ', datetime('now'), datetime('now')),
	('news', '未分類', '未分類', datetime('now'), datetime('now'));
