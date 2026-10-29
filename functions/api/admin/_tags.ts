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
