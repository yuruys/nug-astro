import { requireAdmin } from '../_auth';
import { parse } from 'yaml';

type ArticleDetail = {
	id: number;
	content_type: 'guide' | 'news';
	article_id: string;
	server_id: number | null;
	server_name: string | null;
	server_slug: string | null;
	source_path: string;
	status: 'publishing' | 'published' | 'deleted';
	created_at: string;
	updated_at: string;
};

type ArticleContent = {
	title: string;
	description: string;
	category: string;
	date: string;
	icon?: string;
	image?: string;
	featured: boolean;
	server?: string;
	body: string;
};

type GitHubFile = { type?: string; path?: string; sha?: string; encoding?: string; content?: string };
const GITHUB_OWNER = 'yuruys';
const GITHUB_REPOSITORY = 'nug-astro';
const GITHUB_BRANCH = 'main';

function decodeBase64(value: string): string {
	const binary = atob(value.replace(/\s/g, ''));
	const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
	return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function parseArticleFile(raw: string, contentType: ArticleDetail['content_type'], serverSlug: string | null): ArticleContent {
	const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
	if (!match) throw new Error('Article frontmatter is missing');
	const metadata = parse(match[1]) as Record<string, unknown> | null;
	if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('Article frontmatter must be a YAML mapping');
	const requiredString = (key: string): string => {
		const value = metadata[key];
		if (typeof value !== 'string' || !value.trim()) throw new Error(`Article frontmatter field ${key} is invalid`);
		return value;
	};
	const rawDate = metadata.date;
	const date = rawDate instanceof Date ? rawDate.toISOString().slice(0, 10) : rawDate;
	if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Article frontmatter field date is invalid');
	const optionalString = (key: string): string | undefined => {
		const value = metadata[key];
		if (value === undefined || value === null || value === '') return undefined;
		if (typeof value !== 'string') throw new Error(`Article frontmatter field ${key} is invalid`);
		return value;
	};
	const featured = metadata.featured;
	if (featured !== undefined && typeof featured !== 'boolean') throw new Error('Article frontmatter field featured is invalid');
	const server = optionalString('server');
	if (contentType === 'guide' && (!serverSlug || server !== serverSlug)) throw new Error('Guide frontmatter server does not match D1');
	let body = raw.slice(match[0].length);
	if (body.startsWith('\r\n')) body = body.slice(2);
	else if (body.startsWith('\n')) body = body.slice(1);
	return {
		title: requiredString('title'),
		description: requiredString('description'),
		category: requiredString('category'),
		date,
		icon: optionalString('icon'),
		image: optionalString('image'),
		featured: featured === true,
		...(contentType === 'guide' ? { server: serverSlug! } : {}),
		body,
	};
}

async function fetchArticleContent(sourcePath: string, token: string, contentType: ArticleDetail['content_type'], serverSlug: string | null): Promise<ArticleContent | null> {
	const path = sourcePath.split('/').map(encodeURIComponent).join('/');
	const response = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/contents/${path}?ref=${encodeURIComponent(GITHUB_BRANCH)}`, {
		headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'NUGBASE' },
		signal: AbortSignal.timeout(12_000),
	});
	if (response.status === 404) return null;
	if (!response.ok) throw new Error(`GitHub article lookup failed (${response.status})`);
	const file = await response.json() as GitHubFile;
	if (file.type !== 'file' || file.path !== sourcePath || file.encoding !== 'base64' || typeof file.content !== 'string') throw new Error('GitHub returned an unsupported article file');
	return parseArticleFile(decodeBase64(file.content), contentType, serverSlug);
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
	try {
		const auth = await requireAdmin(context.request, context.env);
		if (!auth.ok) return auth.response;

		const id = Number(context.params.id);
		if (!Number.isSafeInteger(id) || id <= 0) {
			return Response.json({ ok: false, error: 'Invalid article ID' }, { status: 400 });
		}

		const article = await context.env.DB.prepare(`
			SELECT a.id, a.content_type, a.article_id, a.server_id,
				s.name AS server_name, s.slug AS server_slug,
				a.source_path, a.status, a.created_at, a.updated_at
			FROM articles AS a
			LEFT JOIN servers AS s ON s.id = a.server_id
			WHERE a.id = ?
			LIMIT 1
		`).bind(id).first<ArticleDetail>();

		if (!article || article.status === 'deleted') {
			return Response.json({ ok: false, error: 'Article not found' }, { status: 404 });
		}
		if (article.content_type !== 'guide' && article.content_type !== 'news') {
			return Response.json({ ok: false, error: 'Unsupported article type' }, { status: 409 });
		}
		if (article.status !== 'publishing' && article.status !== 'published') {
			return Response.json({ ok: false, error: 'Article is not editable' }, { status: 404 });
		}
		if (article.content_type === 'guide' && (article.server_id === null || !article.server_slug)) {
			return Response.json({ ok: false, error: 'Guide server configuration is invalid' }, { status: 409 });
		}
		const sourcePathMatches = /^\d{3}$/.test(article.article_id)
			&& (article.content_type === 'guide'
				? /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(article.server_slug ?? '')
					&& new RegExp(`^src/content/guide/${article.server_slug}/${article.article_id}\\.md$`).test(article.source_path)
				: new RegExp(`^src/content/news/${article.article_id}\\.md$`).test(article.source_path));
		if (!sourcePathMatches) {
			return Response.json({ ok: false, error: 'D1 article ID and source_path do not match' }, { status: 409 });
		}
		if (!context.env.GITHUB_TOKEN) {
			return Response.json({ ok: false, error: 'GitHub integration is not configured' }, { status: 500 });
		}
		try {
			const content = await fetchArticleContent(article.source_path, context.env.GITHUB_TOKEN, article.content_type, article.server_slug);
			if (!content && article.status === 'published') {
				return Response.json({ ok: false, error: 'Could not load article content from GitHub' }, { status: 502 });
			}
			const { created_at, updated_at, ...record } = article;
			return Response.json({ ok: true, article: record, content });
		} catch (error) {
			console.error('Failed to load GitHub article content:', error);
			return Response.json({ ok: false, error: 'Could not load article content from GitHub' }, { status: 502 });
		}
	} catch (error) {
		console.error('Failed to fetch admin article:', error);
		return Response.json({ ok: false, error: 'Internal server error' }, { status: 500 });
	}
};

export const onRequestDelete: PagesFunction<Env> = async (context) => {
	const auth = await requireAdmin(context.request, context.env);
	if (!auth.ok) return auth.response;
	const id = Number(context.params.id);
	if (!Number.isSafeInteger(id) || id <= 0) return Response.json({ ok: false, error: 'Invalid article ID' }, { status: 400 });

	let article: ArticleDetail | null;
	try {
		article = await context.env.DB.prepare(`
			SELECT a.id, a.content_type, a.article_id, a.server_id, s.name AS server_name, s.slug AS server_slug,
				a.source_path, a.status, a.created_at, a.updated_at
			FROM articles AS a LEFT JOIN servers AS s ON s.id = a.server_id WHERE a.id = ? LIMIT 1
		`).bind(id).first<ArticleDetail>();
	} catch (error) {
		console.error('Failed to load article for deletion:', error);
		return Response.json({ ok: false, error: 'Could not load article' }, { status: 500 });
	}
	if (!article || article.status === 'deleted') return Response.json({ ok: false, error: 'Article not found' }, { status: 404 });
	if (article.content_type !== 'guide' && article.content_type !== 'news') return Response.json({ ok: false, error: 'Unsupported article type' }, { status: 409 });
	if (article.status !== 'publishing' && article.status !== 'published') return Response.json({ ok: false, error: 'Article cannot be deleted' }, { status: 409 });
	const pathMatches = /^\d{3}$/.test(article.article_id) && (article.content_type === 'guide'
		? article.server_id !== null && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(article.server_slug ?? '') && new RegExp(`^src/content/guide/${article.server_slug}/${article.article_id}\\.(?:md|mdx)$`).test(article.source_path)
		: article.server_id === null && new RegExp(`^src/content/news/${article.article_id}\\.(?:md|mdx)$`).test(article.source_path));
	if (!pathMatches) return Response.json({ ok: false, error: 'D1 article ID and source_path do not match' }, { status: 409 });
	const token = context.env.GITHUB_TOKEN;
	if (!token) return Response.json({ ok: false, error: 'GitHub integration is not configured' }, { status: 500 });

	const audit = async (action: string, metadata: Record<string, unknown> = {}) => context.env.DB.prepare(`
		INSERT INTO audit_logs (id, user_id, action, target_type, target_id, metadata, created_at)
		VALUES (?, ?, ?, 'article', ?, ?, ?)
	`).bind(crypto.randomUUID(), auth.user.id, action, String(article.id), JSON.stringify({
		article_id: article.article_id, content_type: article.content_type, source_path: article.source_path, ...metadata,
	}), new Date().toISOString()).run();
	const auditBestEffort = async (action: string, metadata: Record<string, unknown> = {}) => {
		try { await audit(action, metadata); } catch (error) { console.error(`Failed to write ${action} audit:`, error); }
	};
	try { await audit('admin.article.delete_start'); } catch (error) {
		console.error('Failed to record article deletion start:', error);
		return Response.json({ ok: false, error: 'Could not record deletion start' }, { status: 500 });
	}

	const path = article.source_path.split('/').map(encodeURIComponent).join('/');
	const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/contents/${path}`;
	const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'NUGBASE' };
	const syncDeleted = async (result: string): Promise<Response> => {
		const now = new Date().toISOString();
		try {
			const update = await context.env.DB.prepare(`
				UPDATE articles SET status = 'deleted', updated_at = ?, updated_by = ?
				WHERE id = ? AND source_path = ? AND status IN ('publishing', 'published')
			`).bind(now, auth.user.id, article.id, article.source_path).run();
			if ((update.meta?.changes ?? 0) === 0) {
				const current = await context.env.DB.prepare('SELECT status FROM articles WHERE id = ?').bind(article.id).first<{ status: string }>();
				if (current?.status !== 'deleted') throw new Error('Article changed during deletion');
			}
		} catch (error) {
			console.error('GitHub deletion succeeded but D1 update failed:', error);
			await auditBestEffort('admin.article.delete_failure', { failure_stage: 'd1_update' });
			return Response.json({ ok: false, error: 'GitHubから削除しましたが、D1の状態を同期できませんでした。再試行して状態を同期してください。' }, { status: 500 });
		}
		await auditBestEffort('admin.article.delete_success', { result });
		return Response.json({ ok: true, article: { id: article.id, content_type: article.content_type, article_id: article.article_id, source_path: article.source_path, status: 'deleted', updated_at: now } });
	};

	let sha: string;
	try {
		const current = await fetch(`${url}?ref=${encodeURIComponent(GITHUB_BRANCH)}`, { headers, signal: AbortSignal.timeout(12_000) });
		if (current.status === 404) return await syncDeleted('already_absent');
		if (!current.ok) throw new Error(`GitHub GET returned ${current.status}`);
		const file = await current.json() as GitHubFile;
		if (file.type !== 'file' || file.path !== article.source_path || typeof file.sha !== 'string' || !file.sha) {
			await auditBestEffort('admin.article.delete_failure', { failure_stage: 'github_file_validation' });
			return Response.json({ ok: false, error: 'GitHub returned an invalid source file' }, { status: 502 });
		}
		sha = file.sha;
	} catch (error) {
		console.error('Failed to read GitHub article before deletion:', error);
		await auditBestEffort('admin.article.delete_failure', { failure_stage: 'github_get' });
		return Response.json({ ok: false, error: 'Could not read the current GitHub article' }, { status: 502 });
	}

	let deletion: Response;
	try {
		deletion = await fetch(url, {
			method: 'DELETE', headers: { ...headers, 'Content-Type': 'application/json' },
			body: JSON.stringify({ message: `content: delete ${article.content_type} ${article.article_id}`, sha, branch: GITHUB_BRANCH }),
			signal: AbortSignal.timeout(15_000),
		});
	} catch (error) {
		console.error('GitHub deletion result is uncertain:', error);
		await auditBestEffort('admin.article.delete_failure', { failure_stage: 'github_delete_uncertain' });
		return Response.json({ ok: false, error: 'GitHubへの削除結果を確認できませんでした。再試行時に状態を確認します。' }, { status: 502 });
	}
	if (deletion.status === 409 || deletion.status === 422) {
		await auditBestEffort('admin.article.delete_failure', { failure_stage: 'github_conflict', http_status: deletion.status });
		return Response.json({ ok: false, error: '他の変更があるため削除できませんでした。記事は変更されていません。' }, { status: 409 });
	}
	if (deletion.status === 404) return await syncDeleted('disappeared_after_read');
	if (!deletion.ok) {
		await auditBestEffort('admin.article.delete_failure', { failure_stage: 'github_delete', http_status: deletion.status });
		return Response.json({ ok: false, error: 'GitHubでの削除に失敗しました' }, { status: 502 });
	}
	return await syncDeleted('deleted');
};
