interface WikiDraftEnvironment {
	DB: D1Database;
}

export interface WikiDraftUser {
	id: string;
	display_name: string;
}

export interface WikiDraftInput {
	operation: 'create' | 'update' | 'delete';
	title: string;
	slug: string;
	folderPath: string;
	pagePath: string;
	sourcePath: string;
	description: string;
	content: string;
}

const docsSourceRoot = 'src/content/docs/docs/';

export async function getWikiDraftUser(
	request: Request,
	env: WikiDraftEnvironment,
): Promise<WikiDraftUser | null> {
	const cookie = request.headers.get('Cookie') ?? '';
	const sessionCookie = cookie
		.split(';')
		.map((part) => part.trim())
		.find((part) => /^(nug_session|session|session_id)=/.test(part));

	if (!sessionCookie) return null;

	const encodedSessionId = sessionCookie.slice(sessionCookie.indexOf('=') + 1);
	let sessionId: string;
	try {
		sessionId = decodeURIComponent(encodedSessionId);
	} catch {
		return null;
	}

	return env.DB.prepare(`
		SELECT u.id, u.display_name
		FROM sessions s
		INNER JOIN users u ON u.id = s.user_id
		WHERE s.id = ? AND s.expires_at > datetime('now')
		LIMIT 1
	`)
		.bind(sessionId)
		.first<WikiDraftUser>();
}

export function validSlug(value: string): boolean {
	return value.length <= 80 && /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/.test(value);
}

function validFolderPath(value: string): boolean {
	return value.length <= 200 &&
		(value === '' || value.split('/').every((part) => validSlug(part)));
}

export function isWikiSourcePath(value: string): boolean {
	if (!value.startsWith(docsSourceRoot) || value.length > 400) return false;
	const relative = value.slice(docsSourceRoot.length);
	return /^(?:[a-z0-9_-]+\/)*[a-z0-9_-]+\.(?:md|mdx)$/.test(relative);
}

export function getPublicPagePath(sourcePath: string): string | null {
	if (!isWikiSourcePath(sourcePath)) return null;
	const relative = sourcePath.slice(docsSourceRoot.length);
	const withoutExtension = relative.replace(/\.(?:md|mdx)$/, '');
	const segments = withoutExtension.split('/');
	if (segments.some((part) => !part)) return null;
	if (segments.at(-1) === 'index') segments.pop();
	return `/docs/${segments.length ? `${segments.join('/')}/` : ''}`;
}

export function validateDraftInput(value: unknown): WikiDraftInput | null {
	if (!value || typeof value !== 'object') return null;
	const body = value as Record<string, unknown>;
	if (
		(body.operation !== 'create' && body.operation !== 'update' && body.operation !== 'delete') ||
		typeof body.title !== 'string' ||
		typeof body.slug !== 'string' ||
		typeof body.folderPath !== 'string' ||
		typeof body.pagePath !== 'string' ||
		typeof body.sourcePath !== 'string' ||
		typeof body.description !== 'string' ||
		typeof body.content !== 'string' ||
		body.title.trim().length < 1 ||
		body.title.trim().length > 200 ||
		body.description.length > 500 ||
		body.content.length > 500_000 ||
		!validSlug(body.slug) ||
		!validFolderPath(body.folderPath) ||
		!isWikiSourcePath(body.sourcePath) ||
		getPublicPagePath(body.sourcePath) !== body.pagePath ||
		!body.pagePath.startsWith('/docs/')
	) {
		return null;
	}

	const expectedFolder = body.sourcePath.slice(docsSourceRoot.length).split('/').slice(0, -1).join('/');
	if (body.operation === 'create') {
		const expectedSource = `${docsSourceRoot}${body.folderPath ? `${body.folderPath}/` : ''}${body.slug}.md`;
		const expectedPage = getPublicPagePath(expectedSource);
		if (body.sourcePath !== expectedSource || expectedPage !== body.pagePath) return null;
	} else {
		const pageSlug = body.pagePath === '/docs/'
			? 'index'
			: body.pagePath.replace(/\/$/, '').split('/').at(-1);
		if (body.folderPath !== expectedFolder || body.slug !== pageSlug) return null;
	}

	return {
		operation: body.operation,
		title: body.title.trim(),
		slug: body.slug,
		folderPath: body.folderPath,
		pagePath: body.pagePath,
		sourcePath: body.sourcePath,
		description: body.description.trim(),
		content: body.content,
	};
}

export function json(data: unknown, status = 200): Response {
	return Response.json(data, {
		status,
		headers: { 'Cache-Control': 'no-store' },
	});
}
