import { requireAdmin } from '../_auth';

type PublishRequest = {
	article_db_id?: unknown;
	title?: unknown;
	description?: unknown;
	category?: unknown;
	date?: unknown;
	server?: unknown;
	icon?: unknown;
	image?: unknown;
	featured?: unknown;
	body?: unknown;
	format?: unknown;
	[key: string]: unknown;
};

type ArticleRow = {
	id: number;
	content_type: 'guide' | 'news';
	article_id: string;
	server_id: number | null;
	source_path: string;
	status: 'publishing' | 'published' | 'deleted';
	server_slug: string | null;
};

type GitHubContent = {
	type?: string;
	path?: string;
	sha?: string;
	encoding?: string;
	content?: string;
};

type GitHubPutResult = {
	content?: {
		path?: string;
		sha?: string;
		html_url?: string;
	};
	commit?: {
		sha?: string;
		html_url?: string;
	};
	message?: string;
};

type ExistingFile = {
	exists: true;
	content: string;
	sha?: string;
};

type MissingFile = {
	exists: false;
};

type FileState = ExistingFile | MissingFile;

type FrontmatterInput = {
	title: string;
	description: string;
	category: string;
	date: string;
	serverSlug: string | null;
	icon?: string;
	image?: string;
	featured?: boolean;
	body: string;
};

const GITHUB_OWNER = 'yuruys';
const GITHUB_REPOSITORY = 'nug-astro';
const GITHUB_BRANCH = 'main';
const GITHUB_API = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPOSITORY}`;

function json(data: unknown, status = 200): Response {
	return Response.json(data, { status });
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function githubHeaders(token: string): HeadersInit {
	return {
		Authorization: `Bearer ${token}`,
		Accept: 'application/vnd.github+json',
		'X-GitHub-Api-Version': '2022-11-28',
		'User-Agent': 'NUGBACE',
	};
}

function encodeBase64(value: string): string {
	const bytes = new TextEncoder().encode(value);
	let binary = '';
	const chunkSize = 0x8000;
	for (let i = 0; i < bytes.length; i += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunkSize, bytes.length)));
	}
	return btoa(binary);
}

function decodeBase64(value: string): string {
	const binary = atob(value.replace(/\s/g, ''));
	const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
	return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function yamlString(value: string): string {
	// JSON quoted strings are valid YAML strings and safely escape controls/quotes.
	return JSON.stringify(value);
}

function buildMarkdown(input: FrontmatterInput, contentType: ArticleRow['content_type']): string {
	const entries: Array<[string, string]> = [
		['title', yamlString(input.title)],
		['description', yamlString(input.description)],
		['category', yamlString(input.category)],
	];

	if (contentType === 'guide' && input.serverSlug !== null) {
		entries.push(['server', yamlString(input.serverSlug)]);
	}
	entries.push(['date', yamlString(input.date)]);
	if (input.icon !== undefined) entries.push(['icon', yamlString(input.icon)]);
	if (input.image !== undefined) entries.push(['image', yamlString(input.image)]);
	if (input.featured !== undefined) entries.push(['featured', String(input.featured)]);

	return `---\n${entries.map(([key, value]) => `${key}: ${value}`).join('\n')}\n---\n\n${input.body}`;
}

function validateDate(value: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const date = new Date(`${value}T00:00:00.000Z`);
	return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function encodedPath(sourcePath: string): string {
	return sourcePath.split('/').map((part) => encodeURIComponent(part)).join('/');
}

async function readFile(
	sourcePath: string,
	token: string,
): Promise<FileState> {
	const response = await fetch(
		`${GITHUB_API}/contents/${encodedPath(sourcePath)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`,
		{ method: 'GET', headers: githubHeaders(token) },
	);

	if (response.status === 404) return { exists: false };
	if (!response.ok) {
		throw new Error(`GitHub content lookup failed (${response.status}): ${(await response.text()).slice(0, 200)}`);
	}

	const file = await response.json() as GitHubContent;
	if (file.type !== 'file' || file.path !== sourcePath || file.encoding !== 'base64' || typeof file.content !== 'string') {
		throw new Error('GitHub returned an unsupported or incomplete content response');
	}
	return { exists: true, content: decodeBase64(file.content), sha: file.sha };
}

async function audit(
	env: Env,
	userId: string,
	article: ArticleRow,
	action: string,
	metadata: Record<string, unknown>,
): Promise<void> {
	await env.DB.prepare(`
		INSERT INTO audit_logs (
			id, user_id, action, target_type, target_id, metadata, created_at
		)
		VALUES (?, ?, ?, 'article', ?, ?, ?)
	`)
		.bind(
			crypto.randomUUID(),
			userId,
			action,
			String(article.id),
			JSON.stringify({
				article_db_id: article.id,
				content_type: article.content_type,
				article_id: article.article_id,
				server_id: article.server_id,
				source_path: article.source_path,
				...metadata,
			}),
			new Date().toISOString(),
		)
		.run();
}

async function auditSafely(
	env: Env,
	userId: string,
	article: ArticleRow,
	action: string,
	metadata: Record<string, unknown>,
): Promise<void> {
	try {
		await audit(env, userId, article, action, metadata);
	} catch (error) {
		console.error(`Failed to write ${action} audit:`, error);
	}
}

function validatePayload(body: PublishRequest): string | null {
	const allowed = new Set([
		'article_db_id', 'title', 'description', 'category', 'date', 'server',
		'icon', 'image', 'featured', 'body', 'format',
	]);
	if (Object.keys(body).some((key) => !allowed.has(key))) {
		return 'Only article fields and format are accepted';
	}
	if (!Number.isSafeInteger(body.article_db_id) || (body.article_db_id as number) <= 0) {
		return 'article_db_id must be a positive integer';
	}
	if (body.format !== 'md') {
		return 'format must be md';
	}
	for (const key of ['title', 'description', 'category', 'date', 'body'] as const) {
		if (typeof body[key] !== 'string') return `${key} must be a string`;
	}
	for (const key of ['title', 'description', 'category'] as const) {
		if (!(body[key] as string).trim()) return `${key} is required`;
	}
	if (!validateDate(body.date as string)) return 'date must be a valid YYYY-MM-DD date';
	if (body.server !== undefined && body.server !== null && typeof body.server !== 'string') {
		return 'server must be a string';
	}
	for (const key of ['icon', 'image'] as const) {
		if (body[key] !== undefined && body[key] !== null && typeof body[key] !== 'string') {
			return `${key} must be a string`;
		}
	}
	if (body.featured !== undefined && body.featured !== null && typeof body.featured !== 'boolean') {
		return 'featured must be a boolean';
	}
	return null;
}

function optionalString(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined;
	return value.length > 0 ? value : undefined;
}

async function markPublished(
	env: Env,
	userId: string,
	article: ArticleRow,
	commitSha: string | null,
	resolution: 'created' | 'matching_existing',
): Promise<Response> {
	const now = new Date().toISOString();
	try {
		const update = await env.DB.prepare(`
			UPDATE articles
			SET status = 'published', published_at = ?, updated_at = ?
			WHERE id = ? AND status = 'publishing'
		`)
			.bind(now, now, article.id)
			.run();

		if ((update.meta?.changes ?? 0) === 1) {
			await auditSafely(env, userId, article, 'admin.article.d1_publish_success', {
				status: 'published', resolution, commit_sha: commitSha,
			});
			return json({
				ok: true,
				article: { ...article, status: 'published', published_at: now, updated_at: now },
				github: { repository: `${GITHUB_OWNER}/${GITHUB_REPOSITORY}`, branch: GITHUB_BRANCH, source_path: article.source_path, commit_sha: commitSha, resolution },
			});
		}

		const current = await env.DB.prepare(`
			SELECT status, published_at, updated_at
			FROM articles
			WHERE id = ?
			LIMIT 1
		`)
			.bind(article.id)
			.first<{ status: string; published_at: string | null; updated_at: string }>();

		if (current?.status === 'published') {
			await auditSafely(env, userId, article, 'admin.article.d1_publish_success', {
				status: 'published', resolution, commit_sha: commitSha, concurrent_sync: true,
			});
			return json({
				ok: true,
				article: { ...article, ...current },
				github: { repository: `${GITHUB_OWNER}/${GITHUB_REPOSITORY}`, branch: GITHUB_BRANCH, source_path: article.source_path, commit_sha: commitSha, resolution },
			});
		}

		throw new Error(`Article status changed before sync (${current?.status ?? 'missing'})`);
	} catch (error) {
		await auditSafely(env, userId, article, 'admin.article.d1_publish_failure', {
			failure_stage: 'd1_status_update',
			github_resolution: resolution,
			commit_sha: commitSha,
			error: errorMessage(error).slice(0, 250),
		});
		return json({
			ok: false,
			error: 'GitHub content is confirmed, but D1 status synchronization failed. Retry to synchronize.',
			code: 'D1_PUBLISH_SYNC_FAILED',
			github: { source_path: article.source_path, resolution, commit_sha: commitSha },
		}, 500);
	}
}

function conflictResponse(): Response {
	return json({
		ok: false,
		error: 'A different file already exists at the reserved source_path; it was not overwritten',
		code: 'ARTICLE_SOURCE_PATH_CONFLICT',
	}, 409);
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
	try {
		const auth = await requireAdmin(context.request, context.env);
		if (!auth.ok) return auth.response;

		let body: PublishRequest;
		try {
			body = await context.request.json() as PublishRequest;
		} catch {
			return json({ ok: false, error: 'Invalid JSON' }, 400);
		}
		if (!body || typeof body !== 'object' || Array.isArray(body)) {
			return json({ ok: false, error: 'Request body must be an object' }, 400);
		}

		const validationError = validatePayload(body);
		if (validationError) return json({ ok: false, error: validationError }, 400);

		const article = await context.env.DB.prepare(`
			SELECT
				a.id,
				a.content_type,
				a.article_id,
				a.server_id,
				a.source_path,
				a.status,
				s.slug AS server_slug
			FROM articles AS a
			LEFT JOIN servers AS s ON s.id = a.server_id
			WHERE a.id = ?
			LIMIT 1
		`)
			.bind(body.article_db_id)
			.first<ArticleRow>();

		if (!article) return json({ ok: false, error: 'Article not found' }, 404);
		if (article.status !== 'publishing') {
			return json({
				ok: false,
				error: `Only publishing articles can be published (current status: ${article.status})`,
				code: 'ARTICLE_NOT_PUBLISHING',
			}, 409);
		}
		if (article.content_type !== 'guide' && article.content_type !== 'news') {
			return json({ ok: false, error: 'Unsupported article content_type' }, 409);
		}

		let serverSlug: string | null = null;
		if (article.content_type === 'guide') {
			if (article.server_id === null || !article.server_slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(article.server_slug)) {
				return json({ ok: false, error: 'Guide server configuration is invalid' }, 409);
			}
			serverSlug = article.server_slug;
			if (body.server !== undefined && body.server !== null && body.server !== serverSlug) {
				return json({ ok: false, error: 'server must match the server slug stored in D1' }, 400);
			}
		} else if (article.server_id !== null) {
			return json({ ok: false, error: 'News article must not reference a server' }, 409);
		} else if (body.server !== undefined && body.server !== null) {
			return json({ ok: false, error: 'server is not accepted for news articles' }, 400);
		}

		const format = body.format as 'md';
		const expectedPath = article.content_type === 'guide'
			? `src/content/guide/${serverSlug}/${article.article_id}.md`
			: `src/content/news/${article.article_id}.md`;
		if (article.source_path !== expectedPath) {
			return json({ ok: false, error: 'format or D1 source_path does not match the reserved article path', code: 'ARTICLE_SOURCE_PATH_MISMATCH' }, 409);
		}
		if (!context.env.GITHUB_TOKEN) {
			return json({ ok: false, error: 'GitHub integration is not configured' }, 500);
		}

		const generatedContent = buildMarkdown({
			title: (body.title as string).trim(),
			description: (body.description as string).trim(),
			category: (body.category as string).trim(),
			date: body.date as string,
			serverSlug,
			icon: optionalString(body.icon),
			image: optionalString(body.image),
			featured: typeof body.featured === 'boolean' ? body.featured : undefined,
			body: body.body as string,
		}, article.content_type);

		try {
			await audit(context.env, auth.user.id, article, 'admin.article.publish_start', {
				repository: `${GITHUB_OWNER}/${GITHUB_REPOSITORY}`,
				branch: GITHUB_BRANCH,
				format,
			});
		} catch (error) {
			console.error('Failed to write article publish start audit:', error);
			return json({ ok: false, error: 'Could not record publish start' }, 500);
		}

		let initialFile: FileState;
		try {
			initialFile = await readFile(article.source_path, context.env.GITHUB_TOKEN);
		} catch (error) {
			await auditSafely(context.env, auth.user.id, article, 'admin.article.github_failure', {
				failure_stage: 'initial_content_check',
				error: errorMessage(error).slice(0, 250),
			});
			return json({ ok: false, error: 'Could not verify GitHub source_path; article remains publishing' }, 502);
		}

		await auditSafely(context.env, auth.user.id, article, 'admin.article.github_check', {
			result: initialFile.exists ? (initialFile.content === generatedContent ? 'matching' : 'different') : 'missing',
		});

		if (initialFile.exists) {
			if (initialFile.content !== generatedContent) {
				await auditSafely(context.env, auth.user.id, article, 'admin.article.source_conflict', { reason: 'existing_content_differs' });
				return conflictResponse();
			}
			await auditSafely(context.env, auth.user.id, article, 'admin.article.github_resync_existing', {
				file_sha: initialFile.sha ?? null,
			});
			return markPublished(context.env, auth.user.id, article, null, 'matching_existing');
		}

		let putResponse: Response | null = null;
		let putResult: GitHubPutResult | null = null;
		let putError: unknown;
		try {
			putResponse = await fetch(`${GITHUB_API}/contents/${encodedPath(article.source_path)}`, {
				method: 'PUT',
				headers: { ...githubHeaders(context.env.GITHUB_TOKEN), 'Content-Type': 'application/json' },
				body: JSON.stringify({
					message: `content: add ${article.content_type} ${article.article_id}`,
					content: encodeBase64(generatedContent),
					branch: GITHUB_BRANCH,
				}),
			});
			if (putResponse.ok) putResult = await putResponse.json() as GitHubPutResult;
		} catch (error) {
			putError = error;
		}

		if (putResponse?.ok && putResult) {
			await auditSafely(context.env, auth.user.id, article, 'admin.article.github_create_success', {
				commit_sha: putResult.commit?.sha ?? null,
				commit_url: putResult.commit?.html_url ?? null,
			});
			return markPublished(context.env, auth.user.id, article, putResult.commit?.sha ?? null, 'created');
		}

		// A failed or timed-out PUT is ambiguous. Read the path again before deciding whether to retry.
		let afterPut: FileState;
		try {
			afterPut = await readFile(article.source_path, context.env.GITHUB_TOKEN);
		} catch (readError) {
			await auditSafely(context.env, auth.user.id, article, 'admin.article.github_failure', {
				failure_stage: 'recheck_after_put',
				put_status: putResponse?.status ?? null,
				put_error: putError ? errorMessage(putError).slice(0, 160) : null,
				error: errorMessage(readError).slice(0, 200),
			});
			return json({ ok: false, error: 'GitHub write result is uncertain and could not be rechecked; retry safely', code: 'GITHUB_RESULT_UNCERTAIN' }, 502);
		}

		await auditSafely(context.env, auth.user.id, article, 'admin.article.github_check', {
			check_stage: 'after_put_result',
			result: afterPut.exists ? (afterPut.content === generatedContent ? 'matching' : 'different') : 'missing',
		});

		if (afterPut.exists && afterPut.content === generatedContent) {
			await auditSafely(context.env, auth.user.id, article, 'admin.article.github_resync_existing', {
				resolution: 'put_response_lost_or_rejected_but_content_matches',
				file_sha: afterPut.sha ?? null,
			});
			return markPublished(context.env, auth.user.id, article, null, 'matching_existing');
		}

		if (afterPut.exists) {
			await auditSafely(context.env, auth.user.id, article, 'admin.article.source_conflict', {
				reason: 'content_changed_during_create_attempt',
				put_status: putResponse?.status ?? null,
			});
			return conflictResponse();
		}

		await auditSafely(context.env, auth.user.id, article, 'admin.article.github_failure', {
			failure_stage: 'contents_put',
			put_status: putResponse?.status ?? null,
			error: putError ? errorMessage(putError).slice(0, 250) : (putResult?.message ?? 'GitHub did not create the file'),
		});
		return json({
			ok: false,
			error: 'GitHub did not confirm file creation; article remains publishing',
			code: 'GITHUB_PUBLISH_FAILED',
		}, 502);
	} catch (error) {
		console.error('Failed to publish article:', error);
		return json({ ok: false, error: 'Internal server error' }, 500);
	}
};
