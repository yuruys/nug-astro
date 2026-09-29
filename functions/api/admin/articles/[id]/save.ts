import { parseDocument } from 'yaml';
import { requireAdmin } from '../../_auth';

type ArticleRow = {
	id: number;
	content_type: 'guide' | 'news';
	article_id: string;
	server_id: number | null;
	server_slug: string | null;
	source_path: string;
	status: 'publishing' | 'published' | 'deleted';
};

type SaveRequest = {
	title?: unknown;
	description?: unknown;
	category?: unknown;
	icon?: unknown;
	image?: unknown;
	date?: unknown;
	featured?: unknown;
	body?: unknown;
	[key: string]: unknown;
};

type GitHubFile = {
	type?: string;
	path?: string;
	sha?: string;
	encoding?: string;
	content?: string;
};

const GITHUB_OWNER = 'yuruys';
const GITHUB_REPOSITORY = 'nug-astro';
const GITHUB_BRANCH = 'main';
const GITHUB_API = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPOSITORY}`;
const ALLOWED_FIELDS = new Set(['title', 'description', 'category', 'icon', 'image', 'date', 'featured', 'body']);

function json(data: unknown, status = 200): Response {
	return Response.json(data, { status });
}

function encodeBase64(value: string): string {
	const bytes = new TextEncoder().encode(value);
	let binary = '';
	for (let offset = 0; offset < bytes.length; offset += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
	}
	return btoa(binary);
}

function decodeBase64(value: string): string {
	const binary = atob(value.replace(/\s/g, ''));
	const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
	return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function validDate(value: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const parsed = new Date(`${value}T00:00:00.000Z`);
	return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function validateBody(body: SaveRequest): string | null {
	if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Request body must be an object';
	if (Object.keys(body).some((key) => !ALLOWED_FIELDS.has(key))) return 'Unsupported field in request';
	for (const key of ['title', 'description', 'category'] as const) {
		if (typeof body[key] !== 'string' || !body[key].trim()) return `${key} is required`;
		if (body[key].length > (key === 'description' ? 5000 : 500)) return `${key} is too long`;
	}
	if (typeof body.date !== 'string' || !validDate(body.date)) return 'date must be a valid YYYY-MM-DD date';
	if (typeof body.featured !== 'boolean') return 'featured must be a boolean';
	if (typeof body.body !== 'string' || body.body.length > 500_000) return 'body must be a string up to 500000 characters';
	for (const key of ['icon', 'image'] as const) {
		if (body[key] !== undefined && body[key] !== null && typeof body[key] !== 'string') return `${key} must be a string`;
		if (typeof body[key] === 'string' && body[key].length > (key === 'icon' ? 100 : 1000)) return `${key} is too long`;
	}
	return null;
}

function expectedSourcePath(article: ArticleRow): string | null {
	if (!/^\d{3}$/.test(article.article_id)) return null;
	if (article.content_type === 'news') return `src/content/news/${article.article_id}.${article.source_path.endsWith('.mdx') ? 'mdx' : 'md'}`;
	if (!article.server_slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(article.server_slug)) return null;
	return `src/content/guide/${article.server_slug}/${article.article_id}.${article.source_path.endsWith('.mdx') ? 'mdx' : 'md'}`;
}

async function audit(
	env: Env,
	userId: string,
	article: ArticleRow,
	action: string,
	metadata: Record<string, unknown> = {},
): Promise<void> {
	await env.DB.prepare(`
		INSERT INTO audit_logs (id, user_id, action, target_type, target_id, metadata, created_at)
		VALUES (?, ?, ?, 'article', ?, ?, ?)
	`).bind(
		crypto.randomUUID(), userId, action, String(article.id),
		JSON.stringify({ article_id: article.article_id, content_type: article.content_type, source_path: article.source_path, ...metadata }),
		new Date().toISOString(),
	).run();
}

function auditBestEffort(env: Env, userId: string, article: ArticleRow, action: string, metadata: Record<string, unknown> = {}): Promise<void> {
	return audit(env, userId, article, action, metadata).catch((error) => {
		console.error(`Failed to write ${action} audit:`, error);
	});
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
	const auth = await requireAdmin(context.request, context.env);
	if (!auth.ok) return auth.response;

	const id = Number(context.params.id);
	if (!Number.isSafeInteger(id) || id <= 0) return json({ ok: false, error: 'Invalid article ID' }, 400);

	let body: SaveRequest;
	try {
		body = await context.request.json() as SaveRequest;
	} catch {
		return json({ ok: false, error: 'Invalid JSON' }, 400);
	}
	const validationError = validateBody(body);
	if (validationError) return json({ ok: false, error: validationError }, 400);

	let article: ArticleRow | null;
	try {
		article = await context.env.DB.prepare(`
			SELECT a.id, a.content_type, a.article_id, a.server_id, s.slug AS server_slug, a.source_path, a.status
			FROM articles AS a
			LEFT JOIN servers AS s ON s.id = a.server_id
			WHERE a.id = ?
			LIMIT 1
		`).bind(id).first<ArticleRow>();
	} catch (error) {
		console.error('Failed to load article for save:', error);
		return json({ ok: false, error: 'Could not load article' }, 500);
	}
	if (!article || article.status === 'deleted') return json({ ok: false, error: 'Article not found' }, 404);
	if (article.status !== 'publishing' && article.status !== 'published') return json({ ok: false, error: 'Article is not editable' }, 409);
	if (article.content_type !== 'guide' && article.content_type !== 'news') return json({ ok: false, error: 'Unsupported article type' }, 409);
	if (article.content_type === 'guide' && (article.server_id === null || !article.server_slug)) return json({ ok: false, error: 'Guide server configuration is invalid' }, 409);
	const expectedPath = expectedSourcePath(article);
	if (!expectedPath || article.source_path !== expectedPath) return json({ ok: false, error: 'D1 article ID and source_path do not match' }, 409);
	if (!context.env.GITHUB_TOKEN) return json({ ok: false, error: 'GitHub integration is not configured' }, 500);

	try {
		await audit(context.env, auth.user.id, article, 'admin.article.update_start');
	} catch (error) {
		console.error('Failed to record article save start:', error);
		return json({ ok: false, error: 'Could not record save start' }, 500);
	}

	const encodedPath = article.source_path.split('/').map(encodeURIComponent).join('/');
	let file: GitHubFile;
	try {
		const response = await fetch(`${GITHUB_API}/contents/${encodedPath}?ref=${encodeURIComponent(GITHUB_BRANCH)}`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${context.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'NUGBASE' },
			signal: AbortSignal.timeout(12_000),
		});
		if (response.status === 404) {
			await auditBestEffort(context.env, auth.user.id, article, 'admin.article.update_failure', { failure_stage: 'github_get', http_status: 404 });
			return json({ ok: false, error: 'GitHub source file was not found' }, 404);
		}
		if (!response.ok) throw new Error(`GitHub GET returned ${response.status}`);
		file = await response.json() as GitHubFile;
	} catch (error) {
		console.error('Failed to read GitHub article before save:', error);
		await auditBestEffort(context.env, auth.user.id, article, 'admin.article.update_failure', { failure_stage: 'github_get' });
		return json({ ok: false, error: 'Could not read the current GitHub article' }, 502);
	}

	if (file.type !== 'file' || file.path !== article.source_path || file.encoding !== 'base64' || typeof file.content !== 'string' || typeof file.sha !== 'string' || !file.sha) {
		await auditBestEffort(context.env, auth.user.id, article, 'admin.article.update_failure', { failure_stage: 'github_file_validation' });
		return json({ ok: false, error: 'GitHub returned an invalid source file' }, 502);
	}

	let document;
	let currentBody: string;
	try {
		const currentContent = decodeBase64(file.content);
		const frontmatter = currentContent.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
		if (!frontmatter) throw new Error('Missing frontmatter');
		document = parseDocument(frontmatter[1]);
		if (document.errors.length || !document.contents || document.contents.toJSON() === null || typeof document.contents.toJSON() !== 'object') throw new Error('Invalid frontmatter YAML');
		currentBody = currentContent.slice(frontmatter[0].length);
		if (currentBody.startsWith('\r\n')) currentBody = currentBody.slice(2);
		else if (currentBody.startsWith('\n')) currentBody = currentBody.slice(1);
		if (article.content_type === 'guide' && document.get('server') !== article.server_slug) throw new Error('Guide server does not match D1');
	} catch (error) {
		console.error('Failed to parse GitHub article before save:', error);
		await auditBestEffort(context.env, auth.user.id, article, 'admin.article.update_failure', { failure_stage: 'frontmatter_parse' });
		return json({ ok: false, error: 'Could not parse the current article frontmatter' }, 409);
	}

	document.set('title', (body.title as string).trim());
	document.set('description', (body.description as string).trim());
	document.set('category', (body.category as string).trim());
	document.set('date', body.date as string);
	for (const key of ['icon', 'image'] as const) {
		const value = typeof body[key] === 'string' ? body[key].trim() : '';
		if (value) document.set(key, value);
		else if (document.has(key)) document.delete(key);
	}
	if (document.has('featured') || body.featured === true) document.set('featured', body.featured as boolean);

	const yaml = document.toString({ lineWidth: 0 }).trimEnd();
	const newContent = `---\n${yaml}\n---\n\n${body.body as string}`;
	if (newContent === decodeBase64(file.content)) {
		return await syncDatabase(context.env, auth.user.id, article, file.sha, 'unchanged');
	}

	let putResponse: Response;
	try {
		putResponse = await fetch(`${GITHUB_API}/contents/${encodedPath}`, {
			method: 'PUT',
			headers: { Authorization: `Bearer ${context.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'NUGBASE', 'Content-Type': 'application/json' },
			body: JSON.stringify({ message: `content: update ${article.content_type} ${article.article_id}`, content: encodeBase64(newContent), sha: file.sha, branch: GITHUB_BRANCH }),
			signal: AbortSignal.timeout(15_000),
		});
	} catch (error) {
		console.error('GitHub article save result is uncertain:', error);
		await auditBestEffort(context.env, auth.user.id, article, 'admin.article.update_failure', { failure_stage: 'github_put_uncertain' });
		return json({ ok: false, error: 'GitHubへの保存結果を確認できませんでした。記事を再読み込みして確認してください。' }, 502);
	}
	if (putResponse.status === 409 || putResponse.status === 422) {
		await auditBestEffort(context.env, auth.user.id, article, 'admin.article.update_failure', { failure_stage: 'github_conflict', http_status: putResponse.status });
		return json({ ok: false, error: '他の変更があるため保存できませんでした' }, 409);
	}
	if (!putResponse.ok) {
		await auditBestEffort(context.env, auth.user.id, article, 'admin.article.update_failure', { failure_stage: 'github_put', http_status: putResponse.status });
		return json({ ok: false, error: 'GitHubへの保存に失敗しました' }, 502);
	}

	let putResult: { commit?: { sha?: string } } = {};
	try { putResult = await putResponse.json() as { commit?: { sha?: string } }; } catch { /* GitHub accepted the content; D1 still needs synchronization. */ }
	return syncDatabase(context.env, auth.user.id, article, putResult.commit?.sha ?? file.sha, 'updated');
};

async function syncDatabase(env: Env, userId: string, article: ArticleRow, sha: string, result: 'updated' | 'unchanged'): Promise<Response> {
	const now = new Date().toISOString();
	try {
		const update = await env.DB.prepare(`
			UPDATE articles
			SET updated_at = ?, updated_by = ?
			WHERE id = ? AND source_path = ? AND status IN ('publishing', 'published')
		`).bind(now, userId, article.id, article.source_path).run();
		if ((update.meta?.changes ?? 0) === 0) throw new Error('Article changed or became unavailable during save');
	} catch (error) {
		console.error('GitHub save succeeded but D1 article metadata update failed:', error);
		await auditBestEffort(env, userId, article, 'admin.article.update_failure', { failure_stage: 'd1_update', github_sha: sha });
		return json({ ok: false, error: 'GitHubへ保存しましたが、D1の更新日時を同期できませんでした。再読み込みして確認してください。' }, 500);
	}
	await auditBestEffort(env, userId, article, 'admin.article.update_success', { result, github_sha: sha });
	return json({ ok: true, article: { id: article.id, content_type: article.content_type, article_id: article.article_id, source_path: article.source_path, status: article.status, updated_at: now }, result });
}
