import { requireAdmin } from './_auth';

type ArticleRequest = {
	content_type?: unknown;
	server_id?: unknown;
	format?: unknown;
	[key: string]: unknown;
};

type ServerRow = {
	id: number;
	slug: string;
};

type ArticleRow = {
	id: number;
	content_type: 'guide' | 'news';
	article_id: string;
	server_id: number | null;
	source_path: string;
	status: 'publishing';
	created_by: string;
	updated_by: string;
	created_at: string;
	updated_at: string;
	published_at: string | null;
};

type HistoryMaxRow = {
	max_article_id: number | null;
};

type ArticleListRow = {
	id: number;
	content_type: 'guide' | 'news';
	article_id: string;
	server_id: number | null;
	server_name: string | null;
	source_path: string;
	status: 'publishing' | 'published' | 'deleted';
	updated_at: string;
	published_at: string | null;
};

type GitHubFile = {
	type?: string;
	path?: string;
	encoding?: string;
	content?: string;
};

const GITHUB_API = 'https://api.github.com/repos/yuruys/nug-astro/contents';
const GITHUB_BRANCH = 'main';

function decodeGitHubContent(value: string): string {
	const binary = atob(value.replace(/\s/g, ''));
	const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
	return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function parseFrontmatter(content: string): Pick<ArticleListItem, 'title' | 'category' | 'date' | 'featured'> {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
	if (!match) throw new Error('Published article has invalid frontmatter');
	const values = new Map<string, string>();
	for (const line of match[1].split(/\r?\n/)) {
		const field = line.match(/^(title|category|date|featured):\s*(.*)$/);
		if (!field) continue;
		let value = field[2].trim();
		if (value.startsWith('"')) {
			try { value = JSON.parse(value) as string; } catch { throw new Error(`Invalid ${field[1]} frontmatter`); }
		}
		values.set(field[1], value);
	}
	const title = values.get('title');
	const category = values.get('category');
	const date = values.get('date');
	const featured = values.get('featured');
	if (title === undefined || category === undefined || date === undefined || (featured !== undefined && featured !== 'true' && featured !== 'false')) {
		throw new Error('Published article has incomplete frontmatter');
	}
	return { title, category, date, featured: featured === 'true' };
}

type ArticleListItem = {
	db_id: number;
	article_id: string;
	server_id: number | null;
	server_name: string | null;
	title: string;
	category: string;
	date: string;
	featured: boolean;
	status: 'publishing' | 'published';
};

async function fetchPublishedMetadata(sourcePath: string, token: string): Promise<Pick<ArticleListItem, 'title' | 'category' | 'date' | 'featured'>> {
	const encodedPath = sourcePath.split('/').map(encodeURIComponent).join('/');
	const response = await fetch(`${GITHUB_API}/${encodedPath}?ref=${GITHUB_BRANCH}`, {
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: 'application/vnd.github+json',
			'X-GitHub-Api-Version': '2022-11-28',
			'User-Agent': 'NUGBASE',
		},
	});
	if (!response.ok) throw new Error(`GitHub article lookup failed (${response.status})`);
	const file = await response.json() as GitHubFile;
	if (file.type !== 'file' || file.path !== sourcePath || file.encoding !== 'base64' || typeof file.content !== 'string') {
		throw new Error('GitHub returned an unsupported article file');
	}
	return parseFrontmatter(decodeGitHubContent(file.content));
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
	try {
		const auth = await requireAdmin(context.request, context.env);
		if (!auth.ok) return auth.response;

		const contentType = new URL(context.request.url).searchParams.get('content_type');
		if (contentType !== 'guide' && contentType !== 'news') {
			return Response.json({ ok: false, error: 'content_type must be guide or news' }, { status: 400 });
		}

		const result = await context.env.DB.prepare(`
			SELECT
				a.id,
				a.article_id,
				a.server_id,
				s.name AS server_name,
				a.source_path,
				a.status,
				a.updated_at,
				a.published_at
			FROM articles AS a
			LEFT JOIN servers AS s ON s.id = a.server_id
			WHERE a.content_type = ? AND a.status != 'deleted'
			ORDER BY a.article_id DESC
		`).bind(contentType).all<ArticleListRow>();

		const rows = result.results ?? [];
		const token = context.env.GITHUB_TOKEN;
		const articles = await Promise.all(rows.map(async (row): Promise<ArticleListItem> => {
			const base = {
				db_id: row.id,
				article_id: row.article_id,
				server_id: row.server_id,
				server_name: row.server_name,
				status: row.status as ArticleListItem['status'],
			};
			if (row.status !== 'published') {
				return { ...base, title: '未公開', category: '—', date: '—', featured: false };
			}
			if (!token) throw new Error('GitHub integration is not configured');
			return { ...base, ...await fetchPublishedMetadata(row.source_path, token) };
		}));

		return Response.json({ ok: true, articles });
	} catch (error) {
		console.error('Failed to fetch admin article list:', error);
		return Response.json({ ok: false, error: 'Could not load article list' }, { status: 502 });
	}
};

const MAX_RESERVATION_RETRIES = 5;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isRetryableReservationError(error: unknown): boolean {
	const message = errorMessage(error).toLowerCase();
	return message.includes('unique constraint')
		|| message.includes('database is locked')
		|| message.includes('sqlite_busy')
		|| message.includes('busy snapshot')
		|| message.includes('d1 db is overloaded')
		|| message.includes('too many requests queued');
}

async function writeAudit(
	env: Env,
	values: {
		id: string;
		userId: string;
		action: string;
		targetId: string;
		metadata: Record<string, unknown>;
		createdAt: string;
	},
): Promise<void> {
	await env.DB.prepare(`
		INSERT INTO audit_logs (
			id,
			user_id,
			action,
			target_type,
			target_id,
			metadata,
			created_at
		)
		VALUES (?, ?, ?, 'article', ?, ?, ?)
	`)
		.bind(
			values.id,
			values.userId,
			values.action,
			values.targetId,
			JSON.stringify(values.metadata),
			values.createdAt,
		)
		.run();
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
	try {
		const auth = await requireAdmin(context.request, context.env);
		if (!auth.ok) return auth.response;

		let body: ArticleRequest;
		try {
			body = await context.request.json() as ArticleRequest;
		} catch {
			return Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
		}

		if (!body || typeof body !== 'object' || Array.isArray(body)) {
			return Response.json({ ok: false, error: 'Request body must be an object' }, { status: 400 });
		}

		const allowedKeys = new Set(['content_type', 'server_id', 'format']);
		if (Object.keys(body).some((key) => !allowedKeys.has(key))) {
			return Response.json({ ok: false, error: 'Only content_type, server_id, and format are accepted' }, { status: 400 });
		}

		if (body.content_type !== 'guide' && body.content_type !== 'news') {
			return Response.json({ ok: false, error: 'content_type must be guide or news' }, { status: 400 });
		}
		if (body.format !== 'md') {
			return Response.json({ ok: false, error: 'format must be md' }, { status: 400 });
		}

		const contentType = body.content_type;
		let serverId: number | null = null;
		let serverSlug: string | null = null;

		if (contentType === 'guide') {
			if (!Number.isSafeInteger(body.server_id) || (body.server_id as number) <= 0) {
				return Response.json({ ok: false, error: 'server_id must be a positive integer for guide articles' }, { status: 400 });
			}
			serverId = body.server_id as number;

			const server = await context.env.DB.prepare(`
				SELECT id, slug
				FROM servers
				WHERE id = ?
				LIMIT 1
			`)
				.bind(serverId)
				.first<ServerRow>();

			if (!server) {
				return Response.json({ ok: false, error: 'Server not found' }, { status: 404 });
			}
			// Slugs come only from D1. Reject unsafe path segments without rewriting them.
			if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(server.slug)) {
				return Response.json({ ok: false, error: 'Server slug is not a safe path segment' }, { status: 409 });
			}
			serverSlug = server.slug;
		} else if (body.server_id !== undefined && body.server_id !== null) {
			return Response.json({ ok: false, error: 'server_id is not accepted for news articles' }, { status: 400 });
		}

		const requestId = crypto.randomUUID();
		const startedAt = new Date().toISOString();
		const auditContext = {
			requestId,
			content_type: contentType,
			server_id: serverId,
			server_slug: serverSlug,
			format: body.format,
		};

		await writeAudit(context.env, {
			id: crypto.randomUUID(),
			userId: auth.user.id,
			action: 'admin.article.create_start',
			targetId: requestId,
			metadata: auditContext,
			createdAt: startedAt,
		});

		let articleId: string | null = null;
		let reservationError: unknown;
		let retryCount = 0;

		for (let attempt = 0; attempt <= MAX_RESERVATION_RETRIES; attempt += 1) {
			try {
				const reservation = await context.env.DB.prepare(`
					INSERT INTO article_id_history (
						content_type,
						server_id,
						article_id,
						used_at
					)
					SELECT
						?,
						?,
						printf('%03d', COALESCE(MAX(CAST(article_id AS INTEGER)), 0) + 1),
						?
					FROM article_id_history
					WHERE content_type = ?
						AND server_id IS ?
				HAVING COALESCE(MAX(CAST(article_id AS INTEGER)), 0) < 999
					RETURNING article_id
				`)
					.bind(contentType, serverId, new Date().toISOString(), contentType, serverId)
					.first<{ article_id: string }>();

				if (reservation) {
					articleId = reservation.article_id;
					break;
				}

				const maxRow = await context.env.DB.prepare(`
					SELECT MAX(CAST(article_id AS INTEGER)) AS max_article_id
					FROM article_id_history
					WHERE content_type = ?
						AND server_id IS ?
				`)
					.bind(contentType, serverId)
					.first<HistoryMaxRow>();

				if ((maxRow?.max_article_id ?? 0) >= 999) {
					await writeAudit(context.env, {
						id: crypto.randomUUID(),
						userId: auth.user.id,
						action: 'admin.article.create_failed',
						targetId: requestId,
						metadata: { ...auditContext, failure_stage: 'id_limit', retry_count: retryCount },
						createdAt: new Date().toISOString(),
					});
					return Response.json({
						ok: false,
						error: 'Article ID limit reached (999)',
						code: 'ARTICLE_ID_LIMIT_REACHED',
					}, { status: 409 });
				}

				// No row without a full history means the reservation statement failed unexpectedly.
				throw new Error('Article ID reservation returned no row');
			} catch (error) {
				reservationError = error;
				if (!isRetryableReservationError(error) || attempt === MAX_RESERVATION_RETRIES) break;

				retryCount += 1;
				try {
					await writeAudit(context.env, {
						id: crypto.randomUUID(),
						userId: auth.user.id,
						action: 'admin.article.reserve_retry',
						targetId: requestId,
						metadata: { ...auditContext, retry_count: retryCount },
						createdAt: new Date().toISOString(),
					});
				} catch (auditError) {
					// Keep retrying if D1 is temporarily rejecting work due to queue pressure.
					console.error('Failed to write article retry audit:', auditError);
				}
				await new Promise((resolve) => setTimeout(resolve, Math.min(50 * (2 ** (retryCount - 1)), 400)));
			}
		}

		if (!articleId) {
			const message = errorMessage(reservationError);
			try {
				await writeAudit(context.env, {
					id: crypto.randomUUID(),
					userId: auth.user.id,
					action: 'admin.article.create_failed',
					targetId: requestId,
					metadata: {
						...auditContext,
						failure_stage: 'id_reservation',
						retry_count: retryCount,
						error: message.slice(0, 300),
					},
					createdAt: new Date().toISOString(),
				});
			} catch (auditError) {
				console.error('Failed to write article reservation failure audit:', auditError);
			}
			console.error('Failed to reserve article ID:', reservationError);
			const retryableFailure = isRetryableReservationError(reservationError);
			return Response.json({
				ok: false,
				error: retryableFailure ? 'Article ID reservation is temporarily unavailable' : 'Failed to reserve article ID',
				code: retryableFailure ? 'ARTICLE_ID_RESERVATION_BUSY' : undefined,
			}, { status: retryableFailure ? 503 : 500 });
		}

		const now = new Date().toISOString();
		const sourcePath = contentType === 'guide'
			? `src/content/guide/${serverSlug}/${articleId}.md`
			: `src/content/news/${articleId}.md`;
		const successAuditId = crypto.randomUUID();

		try {
			const results = await context.env.DB.batch<D1Result<ArticleRow>>([
				context.env.DB.prepare(`
					INSERT INTO articles (
						content_type,
						article_id,
						server_id,
						source_path,
						status,
						created_by,
						updated_by,
						created_at,
						updated_at,
						published_at
					)
					VALUES (?, ?, ?, ?, 'publishing', ?, ?, ?, ?, NULL)
					RETURNING
						id,
						content_type,
						article_id,
						server_id,
						source_path,
						status,
						created_by,
						updated_by,
						created_at,
						updated_at,
						published_at
				`)
					.bind(contentType, articleId, serverId, sourcePath, auth.user.id, auth.user.id, now, now),
				context.env.DB.prepare(`
					INSERT INTO audit_logs (
						id,
					user_id,
					action,
					target_type,
					target_id,
					metadata,
					created_at
				)
					SELECT
						?,
						?,
						'admin.article.create_success',
						'article',
						CAST(id AS TEXT),
						?,
						?
					FROM articles
					WHERE content_type = ?
						AND article_id = ?
						AND server_id IS ?
				`)
					.bind(
						successAuditId,
						auth.user.id,
						JSON.stringify({ ...auditContext, article_id: articleId, source_path: sourcePath, status: 'publishing' }),
						now,
						contentType,
						articleId,
						serverId,
					),
			]);

			const article = results[0]?.results?.[0];
			if (!article) throw new Error('Created article row was not returned');

			return Response.json({ ok: true, article }, { status: 201 });
		} catch (error) {
			try {
				await writeAudit(context.env, {
					id: crypto.randomUUID(),
					userId: auth.user.id,
					action: 'admin.article.create_failed',
					targetId: articleId,
					metadata: {
						...auditContext,
						article_id: articleId,
						source_path: sourcePath,
						failure_stage: 'article_record',
						error: errorMessage(error).slice(0, 300),
					},
					createdAt: new Date().toISOString(),
				});
			} catch (auditError) {
				console.error('Failed to write article creation failure audit:', auditError);
			}
			console.error('Failed to create article record:', error);
			return Response.json({
				ok: false,
				error: 'ID was reserved, but the article record could not be created',
				code: 'ARTICLE_RECORD_CREATION_FAILED',
			}, { status: 500 });
		}
	} catch (error) {
		console.error('Failed to create article:', error);
		return Response.json({ ok: false, error: 'Internal server error' }, { status: 500 });
	}
};
