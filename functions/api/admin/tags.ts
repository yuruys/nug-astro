import { requireAdmin } from './_auth';
import {
	listManagedArticleFiles,
	getDocumentTags,
	markdownWithDocument,
	normalizeTagName,
	tagKey,
	validateTags,
} from './_tags';

const GITHUB_API = 'https://api.github.com/repos/yuruys/nug-astro';
const GITHUB_BRANCH = 'main';

type GitHubGitRef = { object?: { sha?: string } };
type GitHubGitCommit = { tree?: { sha?: string } };
type GitHubGitObject = { sha?: string };
type TagRemovalFile = Awaited<ReturnType<typeof listManagedArticleFiles>>[number];

function json(data: unknown, status = 200): Response {
	return Response.json(data, { status });
}

function githubHeaders(token: string): HeadersInit {
	return {
		Authorization: `Bearer ${token}`,
		Accept: 'application/vnd.github+json',
		'X-GitHub-Api-Version': '2022-11-28',
		'User-Agent': 'NUGBASE',
	};
}

async function githubRequest<T>(url: string, token: string, init?: RequestInit): Promise<T> {
	const headers = new Headers(githubHeaders(token));
	new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
	const response = await fetch(url, {
		...init,
		headers,
		signal: init?.signal ?? AbortSignal.timeout(15_000),
	});
	if (!response.ok) throw new Error(`GitHub request failed (${response.status})`);
	return await response.json() as T;
}

async function commitTagRemoval(
	token: string,
	tagName: string,
	files: TagRemovalFile[],
	parentSha: string,
): Promise<string> {
	const parent = await githubRequest<GitHubGitCommit>(`${GITHUB_API}/git/commits/${parentSha}`, token);
	const baseTree = parent.tree?.sha;
	if (!baseTree) throw new Error('GitHub branch tree is incomplete');

	const treeEntries: Array<{ path: string; mode: '100644'; type: 'blob'; sha: string }> = [];
	for (const file of files) {
		const content = markdownWithDocument(file.document, file.body);
		const blob = await githubRequest<GitHubGitObject>(`${GITHUB_API}/git/blobs`, token, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ content, encoding: 'utf-8' }),
		});
		if (!blob.sha) throw new Error(`GitHub did not return a blob for ${file.sourcePath}`);
		treeEntries.push({ path: file.sourcePath, mode: '100644', type: 'blob', sha: blob.sha });
	}

	const tree = await githubRequest<GitHubGitObject>(`${GITHUB_API}/git/trees`, token, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ base_tree: baseTree, tree: treeEntries }),
	});
	if (!tree.sha) throw new Error('GitHub did not return the updated tree');

	const commit = await githubRequest<GitHubGitObject>(`${GITHUB_API}/git/commits`, token, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			message: `content: remove tag ${tagName} from articles`,
			tree: tree.sha,
			parents: [parentSha],
		}),
	});
	if (!commit.sha) throw new Error('GitHub did not return the tag-removal commit');

	await githubRequest(`${GITHUB_API}/git/refs/heads/${encodeURIComponent(GITHUB_BRANCH)}`, token, {
		method: 'PATCH',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ sha: commit.sha, force: false }),
	});
	return commit.sha;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
	const auth = await requireAdmin(context.request, context.env);
	if (!auth.ok) return auth.response;

	try {
		const files = await listManagedArticleFiles(context.env);
		const tags = new Map<string, { name: string; articleCount: number }>();
		for (const file of files) {
			const rawTags = getDocumentTags(file.document);
			if (rawTags === undefined) continue;
			const articleTags = validateTags(rawTags);
			if (!articleTags) throw new Error(`Invalid tags in ${file.sourcePath}`);
			for (const name of articleTags) {
				const key = tagKey(name);
				const current = tags.get(key);
				if (current) current.articleCount += 1;
				else tags.set(key, { name, articleCount: 1 });
			}
		}
		const now = new Date().toISOString();
		const inserts = [...tags.values()].map(({ name }) => context.env.DB.prepare(`
			INSERT OR IGNORE INTO taxonomy_tags (name, normalized_name, created_at, updated_at)
			VALUES (?, ?, ?, ?)
		`).bind(name, tagKey(name), now, now));
		if (inserts.length > 0) await context.env.DB.batch(inserts);
		const catalog = await context.env.DB.prepare(`
			SELECT name FROM taxonomy_tags ORDER BY name
		`).all<{ name: string }>();
		return json({
			ok: true,
			tags: (catalog.results ?? []).map(({ name }) => ({
				name,
				articleCount: tags.get(tagKey(name))?.articleCount ?? 0,
			})),
		});
	} catch (error) {
		console.error('Failed to load article tags:', error);
		return json({ ok: false, error: 'Could not load article tags' }, 502);
	}
};

export const onRequestDelete: PagesFunction<Env> = async (context) => {
	const auth = await requireAdmin(context.request, context.env);
	if (!auth.ok) return auth.response;

	let requestBody: unknown;
	try {
		requestBody = await context.request.json();
	} catch {
		return json({ ok: false, error: 'Invalid JSON' }, 400);
	}
	if (!requestBody || typeof requestBody !== 'object' || Array.isArray(requestBody)) {
		return json({ ok: false, error: 'Request body must be an object' }, 400);
	}
	const body = requestBody as Record<string, unknown>;
	if (Object.keys(body).some((key) => key !== 'name' && key !== 'expected_count')
		|| typeof body.name !== 'string' || typeof body.expected_count !== 'number'
		|| !Number.isSafeInteger(body.expected_count) || body.expected_count < 0) {
		return json({ ok: false, error: 'name and a non-negative expected_count are required' }, 400);
	}
	const name = normalizeTagName(body.name);
	if (!name || name.length > 40) return json({ ok: false, error: 'Invalid tag name' }, 400);
	if (!context.env.GITHUB_TOKEN) return json({ ok: false, error: 'GitHub integration is not configured' }, 500);

	try {
		const ref = await githubRequest<GitHubGitRef>(
			`${GITHUB_API}/git/ref/heads/${encodeURIComponent(GITHUB_BRANCH)}`,
			context.env.GITHUB_TOKEN,
		);
		const parentSha = ref.object?.sha;
		if (!parentSha) throw new Error('GitHub branch reference is incomplete');
		const files = await listManagedArticleFiles(context.env, parentSha);
		const matchingFiles = files.filter((file) => {
			const rawTags = getDocumentTags(file.document);
			const tags = validateTags(rawTags === undefined ? [] : rawTags);
			if (!tags) throw new Error(`Invalid tags in ${file.sourcePath}`);
			return tags.some((tag) => tagKey(tag) === tagKey(name));
		});
		if (matchingFiles.length !== body.expected_count) {
			return json({
				ok: false,
				error: 'Tag usage changed. Reload the tag list and confirm the deletion again.',
				current_count: matchingFiles.length,
			}, 409);
		}
		const catalogTag = await context.env.DB.prepare(`
			SELECT id FROM taxonomy_tags WHERE normalized_name = ? LIMIT 1
		`).bind(tagKey(name)).first<{ id: number }>();
		if (!catalogTag) return json({ ok: false, error: 'Tag not found' }, 404);

		for (const file of matchingFiles) {
			const rawTags = getDocumentTags(file.document);
			const tags = validateTags(rawTags === undefined ? [] : rawTags);
			if (!tags) throw new Error(`Invalid tags in ${file.sourcePath}`);
			const remainingTags = tags.filter((tag) => tagKey(tag) !== tagKey(name));
			if (remainingTags.length > 0) file.document.set('tags', remainingTags);
			else file.document.delete('tags');
		}

		const commitSha = matchingFiles.length > 0
			? await commitTagRemoval(context.env.GITHUB_TOKEN, name, matchingFiles, parentSha)
			: null;
		try {
			const deletion = await context.env.DB.prepare(`
				DELETE FROM taxonomy_tags WHERE id = ?
			`).bind(catalogTag.id).run();
			if ((deletion.meta?.changes ?? 0) === 0) throw new Error('Tag catalog entry changed during deletion');
		} catch (error) {
			console.error('Article tags were removed but D1 catalog synchronization failed:', error);
			return json({ ok: false, error: '記事のタグ関連付けは更新されましたが、D1の管理カタログを更新できませんでした。再読み込みして状態を確認してください。' }, 500);
		}
		try {
			await context.env.DB.prepare(`
				INSERT INTO audit_logs (id, user_id, action, target_type, target_id, metadata, created_at)
				VALUES (?, ?, 'admin.tag.delete', 'tag', ?, ?, ?)
			`).bind(
				crypto.randomUUID(),
				auth.user.id,
				tagKey(name),
				JSON.stringify({ name, affected_articles: matchingFiles.length, commit_sha: commitSha }),
				new Date().toISOString(),
			).run();
		} catch (error) {
			console.error('Tag deletion succeeded but audit logging failed:', error);
		}
		return json({ ok: true, tag: name, affected_articles: matchingFiles.length, commit_sha: commitSha });
	} catch (error) {
		console.error('Failed to delete article tag:', error);
		return json({ ok: false, error: '処理結果を確定できませんでした。タグ一覧を再読み込みして状態を確認してください。記事レコードは削除していません。' }, 502);
	}
};
