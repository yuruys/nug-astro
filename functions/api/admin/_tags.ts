import { parseDocument, type Document } from 'yaml';

const GITHUB_API = 'https://api.github.com/repos/yuruys/nug-astro';
const GITHUB_BRANCH = 'main';

export type ManagedArticleFile = {
	sourcePath: string;
	content: string;
	sha: string;
	document: Document;
	body: string;
};

type ArticlePathRow = {
	content_type: 'guide' | 'news';
	article_id: string;
	server_slug: string | null;
	source_path: string;
};

type GitHubFile = {
	type?: string;
	path?: string;
	sha?: string;
	encoding?: string;
	content?: string;
};

export function normalizeTagName(value: string): string {
	return value.normalize('NFKC').trim().replace(/\s+/g, ' ');
}

export function tagKey(value: string): string {
	return normalizeTagName(value).toLocaleLowerCase('ja-JP');
}

export function validateTags(value: unknown): string[] | null {
	if (!Array.isArray(value) || value.length > 20) return null;
	const normalized: string[] = [];
	const keys = new Set<string>();

	for (const item of value) {
		if (typeof item !== 'string') return null;
		const name = normalizeTagName(item);
		const key = tagKey(name);
		if (!name || name.length > 40 || keys.has(key)) return null;
		keys.add(key);
		normalized.push(name);
	}

	return normalized;
}

export async function validateArticleTaxonomy(
	env: Env,
	contentType: 'guide' | 'news',
	category: string,
	tags: string[],
): Promise<string | null> {
	const categoryExists = await env.DB.prepare(`
		SELECT id FROM taxonomy_categories
		WHERE content_type = ? AND normalized_name = ?
		LIMIT 1
	`).bind(contentType, tagKey(category)).first<{ id: number }>();
	if (!categoryExists) return 'Category is not registered for this article type';
	if (tags.length === 0) return null;

	const placeholders = tags.map(() => '?').join(', ');
	const result = await env.DB.prepare(`
		SELECT normalized_name FROM taxonomy_tags
		WHERE normalized_name IN (${placeholders})
	`).bind(...tags.map(tagKey)).all<{ normalized_name: string }>();
	const known = new Set((result.results ?? []).map((row) => row.normalized_name));
	if (tags.some((tag) => !known.has(tagKey(tag)))) return 'One or more tags are not registered';
	return null;
}

export function splitArticleMarkdown(content: string): { document: Document; body: string } {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
	if (!match) throw new Error('Article frontmatter is missing');
	const document = parseDocument(match[1]);
	if (document.errors.length || !document.contents || document.contents.toJSON() === null
		|| typeof document.contents.toJSON() !== 'object' || Array.isArray(document.contents.toJSON())) {
		throw new Error('Article frontmatter is invalid');
	}

	let body = content.slice(match[0].length);
	if (body.startsWith('\r\n')) body = body.slice(2);
	else if (body.startsWith('\n')) body = body.slice(1);
	return { document, body };
}

export function getDocumentTags(document: Document): unknown {
	const metadata = document.toJSON();
	return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
		? (metadata as Record<string, unknown>).tags
		: undefined;
}

function decodeBase64(value: string): string {
	const binary = atob(value.replace(/\s/g, ''));
	const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
	return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function encodeBase64(value: string): string {
	const bytes = new TextEncoder().encode(value);
	let binary = '';
	for (let offset = 0; offset < bytes.length; offset += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
	}
	return btoa(binary);
}

export async function listManagedArticleFiles(env: Env, ref = GITHUB_BRANCH): Promise<ManagedArticleFile[]> {
	if (!env.GITHUB_TOKEN) throw new Error('GitHub integration is not configured');

	const result = await env.DB.prepare(`
		SELECT a.content_type, a.article_id, s.slug AS server_slug, a.source_path
		FROM articles AS a
		LEFT JOIN servers AS s ON s.id = a.server_id
		WHERE a.status = 'published'
		ORDER BY a.content_type, a.article_id
	`).all<ArticlePathRow>();
	const rows = result.results ?? [];
	const files: ManagedArticleFile[] = [];
	const headers = {
		Authorization: `Bearer ${env.GITHUB_TOKEN}`,
		Accept: 'application/vnd.github+json',
		'X-GitHub-Api-Version': '2022-11-28',
		'User-Agent': 'NUGBASE',
	};

	for (let offset = 0; offset < rows.length; offset += 5) {
		const batch = rows.slice(offset, offset + 5);
		const batchFiles = await Promise.all(batch.map(async (row) => {
			if (!/^\d{3}$/.test(row.article_id)) throw new Error('Published article has an invalid ID');
			const expectedPath = row.content_type === 'news'
				? `src/content/news/${row.article_id}.md`
				: row.server_slug && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(row.server_slug)
					? `src/content/guide/${row.server_slug}/${row.article_id}.md`
					: '';
			if (!expectedPath || row.source_path !== expectedPath) throw new Error('Published article has an invalid source path');

			const encodedPath = row.source_path.split('/').map(encodeURIComponent).join('/');
			const response = await fetch(`${GITHUB_API}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`, {
				headers,
				signal: AbortSignal.timeout(12_000),
			});
			if (!response.ok) throw new Error(`GitHub article lookup failed (${response.status})`);
			const file = await response.json() as GitHubFile;
			if (file.type !== 'file' || file.path !== row.source_path || file.encoding !== 'base64'
				|| typeof file.content !== 'string' || typeof file.sha !== 'string' || !file.sha) {
				throw new Error('GitHub returned an unsupported article file');
			}

			const content = decodeBase64(file.content);
			const { document, body } = splitArticleMarkdown(content);
			return { sourcePath: row.source_path, content, sha: file.sha, document, body };
		}));
		files.push(...batchFiles);
	}

	return files;
}

export function markdownWithDocument(document: Document, body: string): string {
	return `---\n${document.toString({ lineWidth: 0 }).trimEnd()}\n---\n\n${body}`;
}

export function encodeMarkdown(value: string): string {
	return encodeBase64(value);
}

export async function commitManagedArticleChanges(
	env: Env,
	files: ManagedArticleFile[],
	parentSha: string,
	message: string,
): Promise<string> {
	if (!env.GITHUB_TOKEN) throw new Error('GitHub integration is not configured');
	if (files.length === 0) throw new Error('No article files were provided');

	const headers: HeadersInit = {
		Authorization: `Bearer ${env.GITHUB_TOKEN}`,
		Accept: 'application/vnd.github+json',
		'X-GitHub-Api-Version': '2022-11-28',
		'User-Agent': 'NUGBASE',
	};
	const request = async <T>(url: string, init?: RequestInit): Promise<T> => {
		const requestHeaders = new Headers(headers);
		new Headers(init?.headers).forEach((value, key) => requestHeaders.set(key, value));
		const response = await fetch(url, {
			...init,
			headers: requestHeaders,
			signal: init?.signal ?? AbortSignal.timeout(15_000),
		});
		if (!response.ok) throw new Error(`GitHub request failed (${response.status})`);
		return await response.json() as T;
	};

	const parent = await request<{ tree?: { sha?: string } }>(
		`${GITHUB_API}/git/commits/${encodeURIComponent(parentSha)}`,
	);
	if (!parent.tree?.sha) throw new Error('GitHub branch tree is incomplete');

	const treeEntries: Array<{ path: string; mode: '100644'; type: 'blob'; sha: string }> = [];
	for (const file of files) {
		const blob = await request<{ sha?: string }>(`${GITHUB_API}/git/blobs`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				content: markdownWithDocument(file.document, file.body),
				encoding: 'utf-8',
			}),
		});
		if (!blob.sha) throw new Error(`GitHub did not return a blob for ${file.sourcePath}`);
		treeEntries.push({ path: file.sourcePath, mode: '100644', type: 'blob', sha: blob.sha });
	}

	const tree = await request<{ sha?: string }>(`${GITHUB_API}/git/trees`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ base_tree: parent.tree.sha, tree: treeEntries }),
	});
	if (!tree.sha) throw new Error('GitHub did not return the updated tree');

	const commit = await request<{ sha?: string }>(`${GITHUB_API}/git/commits`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ message, tree: tree.sha, parents: [parentSha] }),
	});
	if (!commit.sha) throw new Error('GitHub did not return the metadata commit');

	let updateResponse: Response;
	try {
		const updateHeaders = new Headers(headers);
		updateHeaders.set('Content-Type', 'application/json');
		updateResponse = await fetch(
			`${GITHUB_API}/git/refs/heads/${encodeURIComponent(GITHUB_BRANCH)}`,
			{
				method: 'PATCH',
				headers: updateHeaders,
				body: JSON.stringify({ sha: commit.sha, force: false }),
				signal: AbortSignal.timeout(15_000),
			},
		);
	} catch (error) {
		try {
			if (await getManagedArticleRevision(env) === commit.sha) return commit.sha;
		} catch (verifyError) {
			console.error('Could not verify the GitHub metadata commit:', verifyError);
		}
		console.error('GitHub metadata commit result is uncertain:', error);
		throw new Error('GitHub branch update result is uncertain');
	}
	if (!updateResponse.ok) {
		try {
			if (await getManagedArticleRevision(env) === commit.sha) return commit.sha;
		} catch (error) {
			console.error('Could not verify the GitHub metadata commit:', error);
		}
		throw new Error(`GitHub branch update failed (${updateResponse.status})`);
	}
	return commit.sha;
}

export async function getManagedArticleRevision(env: Env): Promise<string> {
	if (!env.GITHUB_TOKEN) throw new Error('GitHub integration is not configured');
	const response = await fetch(
		`${GITHUB_API}/git/ref/heads/${encodeURIComponent(GITHUB_BRANCH)}`,
		{
			headers: {
				Authorization: `Bearer ${env.GITHUB_TOKEN}`,
				Accept: 'application/vnd.github+json',
				'X-GitHub-Api-Version': '2022-11-28',
				'User-Agent': 'NUGBASE',
			},
			signal: AbortSignal.timeout(12_000),
		},
	);
	if (!response.ok) throw new Error(`GitHub branch lookup failed (${response.status})`);
	const ref = await response.json() as { object?: { sha?: string } };
	if (!ref.object?.sha) throw new Error('GitHub branch reference is incomplete');
	return ref.object.sha;
}
