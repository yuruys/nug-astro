import { requireAdmin } from './_auth';
import {
	commitManagedArticleChanges,
	getDocumentTags,
	getManagedArticleRevision,
	listManagedArticleFiles,
	normalizeTagName,
	tagKey,
	validateTags,
} from './_tags';
import type { ManagedArticleFile } from './_tags';

type TaxonomyKind = 'category' | 'tag';
type ContentType = 'guide' | 'news';

type TaxonomyRow = {
	id: number;
	name: string;
	content_type?: ContentType;
};

const UNCATEGORIZED = '未分類';

function json(data: unknown, status = 200): Response {
	return Response.json(data, { status });
}

function normalizeName(value: string): string {
	return normalizeTagName(value);
}

function validName(value: unknown): value is string {
	return typeof value === 'string'
		&& normalizeName(value).length > 0
		&& normalizeName(value).length <= 40;
}

function isContentType(value: unknown): value is ContentType {
	return value === 'guide' || value === 'news';
}

function referenceCount(
	files: ManagedArticleFile[],
	kind: TaxonomyKind,
	name: string,
	contentType?: ContentType,
): number {
	return files.filter((file) => {
		if (contentType && !file.sourcePath.startsWith(`src/content/${contentType}/`)) return false;
		const metadata = file.document.toJSON();
		if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
		if (kind === 'category') {
			const category = (metadata as Record<string, unknown>).category;
			return typeof category === 'string' && tagKey(category) === tagKey(name);
		}
		const tags = validateTags(getDocumentTags(file.document) ?? []);
		if (!tags) throw new Error(`Invalid tags in ${file.sourcePath}`);
		return tags.some((tag) => tagKey(tag) === tagKey(name));
	}).length;
}

function matchingFiles(
	files: ManagedArticleFile[],
	kind: TaxonomyKind,
	name: string,
	contentType?: ContentType,
): ManagedArticleFile[] {
	return files.filter((file) => {
		if (contentType && !file.sourcePath.startsWith(`src/content/${contentType}/`)) return false;
		const metadata = file.document.toJSON();
		if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
		if (kind === 'category') {
			const category = (metadata as Record<string, unknown>).category;
			return typeof category === 'string' && tagKey(category) === tagKey(name);
		}
		const tags = validateTags(getDocumentTags(file.document) ?? []);
		if (!tags) throw new Error(`Invalid tags in ${file.sourcePath}`);
		return tags.some((tag) => tagKey(tag) === tagKey(name));
	});
}

async function loadCurrentFiles(env: Env): Promise<{ sha: string; files: ManagedArticleFile[] }> {
	const sha = await getManagedArticleRevision(env);
	const files = await listManagedArticleFiles(env, sha);
	return { sha, files };
}

async function ensureObservedDefinitions(env: Env, files: ManagedArticleFile[]): Promise<void> {
	const now = new Date().toISOString();
	const categories = new Map<string, { contentType: ContentType; name: string }>();
	const tags = new Map<string, string>();

	for (const file of files) {
		const contentType: ContentType = file.sourcePath.startsWith('src/content/news/') ? 'news' : 'guide';
		const metadata = file.document.toJSON();
		if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) continue;
		const rawCategory = (metadata as Record<string, unknown>).category;
		if (typeof rawCategory === 'string' && rawCategory.trim()) {
			if (!validName(rawCategory)) throw new Error(`Invalid category in ${file.sourcePath}`);
			const name = normalizeName(rawCategory);
			categories.set(`${contentType}:${tagKey(name)}`, { contentType, name });
		}
		const articleTags = validateTags(getDocumentTags(file.document) ?? []);
		if (!articleTags) throw new Error(`Invalid tags in ${file.sourcePath}`);
		for (const tag of articleTags) tags.set(tagKey(tag), tag);
	}

	const statements = [
		...[...categories.values()].map(({ contentType, name }) => env.DB.prepare(`
			INSERT OR IGNORE INTO taxonomy_categories (content_type, name, normalized_name, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?)
		`).bind(contentType, name, tagKey(name), now, now)),
		...[...tags.values()].map((name) => env.DB.prepare(`
			INSERT OR IGNORE INTO taxonomy_tags (name, normalized_name, created_at, updated_at)
			VALUES (?, ?, ?, ?)
		`).bind(name, tagKey(name), now, now)),
	];
	if (statements.length > 0) await env.DB.batch(statements);
}

async function auditTaxonomy(
	env: Env,
	userId: string,
	action: string,
	kind: TaxonomyKind,
	name: string,
	metadata: Record<string, unknown>,
): Promise<void> {
	try {
		await env.DB.prepare(`
			INSERT INTO audit_logs (id, user_id, action, target_type, target_id, metadata, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)
		`).bind(
			crypto.randomUUID(),
			userId,
			action,
			kind,
			tagKey(name),
			JSON.stringify(metadata),
			new Date().toISOString(),
		).run();
	} catch (error) {
		console.error(`Failed to write ${action} audit:`, error);
	}
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
	const auth = await requireAdmin(context.request, context.env);
	if (!auth.ok) return auth.response;

	try {
		const publishedResult = await context.env.DB.prepare(`
			SELECT COUNT(*) AS count
			FROM articles
			WHERE status = 'published'
		`).first<{ count: number }>();
		const files = publishedResult?.count
			? (await loadCurrentFiles(context.env)).files
			: [];
		await ensureObservedDefinitions(context.env, files);
		const [categoryResult, tagResult] = await Promise.all([
			context.env.DB.prepare(`
				SELECT id, name, content_type
				FROM taxonomy_categories
				ORDER BY content_type, name
			`).all<TaxonomyRow>(),
			context.env.DB.prepare(`
				SELECT id, name
				FROM taxonomy_tags
				ORDER BY name
			`).all<TaxonomyRow>(),
		]);

		return json({
			ok: true,
			categories: (categoryResult.results ?? []).map((row) => ({
				id: row.id,
				name: row.name,
				contentType: row.content_type,
				articleCount: referenceCount(files, 'category', row.name, row.content_type),
			})),
			tags: (tagResult.results ?? []).map((row) => ({
				id: row.id,
				name: row.name,
				articleCount: referenceCount(files, 'tag', row.name),
			})),
		});
	} catch (error) {
		console.error('Failed to load taxonomy catalog:', error);
		const message = error instanceof Error ? error.message : '';
		const migrationMissing = /no such table: taxonomy_(categories|tags)/i.test(message);
		return json({
			ok: false,
			error: migrationMissing
				? 'カテゴリ・タグ用のD1移行が未適用です。migrations/0002_create_taxonomy_catalog.sqlを適用してから再読み込みしてください。'
				: 'カテゴリ・タグ一覧を読み込めませんでした。D1とGitHub連携の設定を確認して再試行してください。',
		}, migrationMissing ? 503 : 502);
	}
};

export const onRequestPost: PagesFunction<Env> = async (context) => {
	const auth = await requireAdmin(context.request, context.env);
	if (!auth.ok) return auth.response;

	let body: Record<string, unknown>;
	try {
		const parsed: unknown = await context.request.json();
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return json({ ok: false, error: 'リクエスト形式が正しくありません。' }, 400);
		}
		body = parsed as Record<string, unknown>;
	} catch {
		return json({ ok: false, error: 'JSONを読み取れませんでした。' }, 400);
	}

	const { kind, content_type: contentType, name: rawName } = body;
	if (Object.keys(body).some((key) => !['kind', 'content_type', 'name'].includes(key))
		|| (kind !== 'category' && kind !== 'tag')
		|| !validName(rawName)
		|| (kind === 'category' && !isContentType(contentType))
		|| (kind === 'tag' && contentType !== undefined)) {
		return json({ ok: false, error: '種別、対象、名前を正しく指定してください。' }, 400);
	}

	const name = normalizeName(rawName);
	const normalized = tagKey(name);
	const now = new Date().toISOString();
	try {
		if (kind === 'category') {
			await context.env.DB.prepare(`
				INSERT INTO taxonomy_categories (content_type, name, normalized_name, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?)
			`).bind(contentType, name, normalized, now, now).run();
		} else {
			await context.env.DB.prepare(`
				INSERT INTO taxonomy_tags (name, normalized_name, created_at, updated_at)
				VALUES (?, ?, ?, ?)
			`).bind(name, normalized, now, now).run();
		}
		await auditTaxonomy(context.env, auth.user.id, 'admin.taxonomy.create', kind, name, { content_type: contentType ?? null });
		return json({ ok: true, name }, 201);
	} catch (error) {
		if (error instanceof Error && /unique|constraint/i.test(error.message)) {
			return json({ ok: false, error: '同じ名前の項目が既にあります。' }, 409);
		}
		console.error('Failed to create taxonomy entry:', error);
		return json({ ok: false, error: '項目を保存できませんでした。' }, 500);
	}
};

async function readMutationBody(request: Request): Promise<Record<string, unknown> | Response> {
	try {
		const parsed: unknown = await request.json();
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return json({ ok: false, error: 'リクエスト形式が正しくありません。' }, 400);
		}
		return parsed as Record<string, unknown>;
	} catch {
		return json({ ok: false, error: 'JSONを読み取れませんでした。' }, 400);
	}
}

function validateMutationBody(body: Record<string, unknown>): {
	kind: TaxonomyKind;
	contentType?: ContentType;
	name: string;
	expectedCount: number;
} | null {
	const allowedKeys = ['kind', 'content_type', 'name', 'expected_count', 'new_name'];
	if (Object.keys(body).some((key) => !allowedKeys.includes(key))
		|| (body.kind !== 'category' && body.kind !== 'tag')
		|| !validName(body.name)
		|| typeof body.expected_count !== 'number'
		|| !Number.isSafeInteger(body.expected_count)
		|| body.expected_count < 0
		|| (body.kind === 'category' && !isContentType(body.content_type))
		|| (body.kind === 'tag' && body.content_type !== undefined)) {
		return null;
	}
	return {
		kind: body.kind,
		contentType: body.content_type as ContentType | undefined,
		name: normalizeName(body.name),
		expectedCount: body.expected_count,
	};
}

export const onRequestPatch: PagesFunction<Env> = async (context) => {
	const auth = await requireAdmin(context.request, context.env);
	if (!auth.ok) return auth.response;
	const body = await readMutationBody(context.request);
	if (body instanceof Response) return body;
	const mutation = validateMutationBody(body);
	if (!mutation || !validName(body.new_name)) {
		return json({ ok: false, error: '変更対象と新しい名前を正しく指定してください。' }, 400);
	}

	const newName = normalizeName(body.new_name);
	const { kind, contentType, name, expectedCount } = mutation;
	if (name === newName) {
		return json({ ok: false, error: '現在と異なる名前を入力してください。' }, 400);
	}

	try {
		const table = kind === 'category' ? 'taxonomy_categories' : 'taxonomy_tags';
		const lookup = kind === 'category'
			? await context.env.DB.prepare(`
				SELECT id, name FROM taxonomy_categories WHERE content_type = ? AND normalized_name = ? LIMIT 1
			`).bind(contentType, tagKey(name)).first<TaxonomyRow>()
			: await context.env.DB.prepare(`
				SELECT id, name FROM taxonomy_tags WHERE normalized_name = ? LIMIT 1
			`).bind(tagKey(name)).first<TaxonomyRow>();
		if (!lookup) return json({ ok: false, error: '項目が見つかりません。' }, 404);

		const duplicate = kind === 'category'
			? await context.env.DB.prepare(`
				SELECT id FROM taxonomy_categories WHERE content_type = ? AND normalized_name = ? AND id != ? LIMIT 1
			`).bind(contentType, tagKey(newName), lookup.id).first<{ id: number }>()
			: await context.env.DB.prepare(`
				SELECT id FROM taxonomy_tags WHERE normalized_name = ? AND id != ? LIMIT 1
			`).bind(tagKey(newName), lookup.id).first<{ id: number }>();
		if (duplicate) return json({ ok: false, error: '同じ名前の項目が既にあります。' }, 409);

		const { sha, files } = await loadCurrentFiles(context.env);
		const affected = matchingFiles(files, kind, name, contentType);
		if (affected.length !== expectedCount) {
			return json({
				ok: false,
				error: '記事での使用数が変わりました。一覧を再読み込みしてから再度確認してください。',
				current_count: affected.length,
			}, 409);
		}
		for (const file of affected) {
			if (kind === 'category') {
				file.document.set('category', newName);
			} else {
				const tags = validateTags(getDocumentTags(file.document) ?? []);
				if (!tags) throw new Error(`Invalid tags in ${file.sourcePath}`);
				file.document.set('tags', tags.map((tag) => tagKey(tag) === tagKey(name) ? newName : tag));
			}
		}
		const commitSha = affected.length > 0
			? await commitManagedArticleChanges(context.env, affected, sha, `content: rename ${kind} ${name}`)
			: null;

		try {
			const result = await context.env.DB.prepare(`
				UPDATE ${table}
				SET name = ?, normalized_name = ?, updated_at = ?
				WHERE id = ?
			`).bind(newName, tagKey(newName), new Date().toISOString(), lookup.id).run();
			if ((result.meta?.changes ?? 0) === 0) throw new Error('Taxonomy row changed during rename');
		} catch (error) {
			console.error('Article metadata was renamed but taxonomy catalog synchronization failed:', error);
			return json({ ok: false, error: '記事のメタデータは更新されましたが、管理カタログの同期に失敗しました。再読み込みして状態を確認してください。' }, 500);
		}

		await auditTaxonomy(context.env, auth.user.id, 'admin.taxonomy.rename', kind, name, {
			content_type: contentType ?? null,
			new_name: newName,
			affected_articles: affected.length,
			commit_sha: commitSha,
		});
		return json({ ok: true, name: newName, affected_articles: affected.length, commit_sha: commitSha });
	} catch (error) {
		console.error('Failed to rename taxonomy entry:', error);
		return json({ ok: false, error: '処理結果を確定できませんでした。再読み込みして記事frontmatterと管理カタログの状態を確認してください。' }, 502);
	}
};

export const onRequestDelete: PagesFunction<Env> = async (context) => {
	const auth = await requireAdmin(context.request, context.env);
	if (!auth.ok) return auth.response;
	const body = await readMutationBody(context.request);
	if (body instanceof Response) return body;
	const mutation = validateMutationBody(body);
	if (!mutation) return json({ ok: false, error: '削除対象を正しく指定してください。' }, 400);

	const { kind, contentType, name, expectedCount } = mutation;
	if (kind === 'category' && name === UNCATEGORIZED) {
		return json({ ok: false, error: '「未分類」は記事の退避先として使用するため削除できません。' }, 409);
	}

	try {
		const table = kind === 'category' ? 'taxonomy_categories' : 'taxonomy_tags';
		const lookup = kind === 'category'
			? await context.env.DB.prepare(`
				SELECT id, name FROM taxonomy_categories WHERE content_type = ? AND normalized_name = ? LIMIT 1
			`).bind(contentType, tagKey(name)).first<TaxonomyRow>()
			: await context.env.DB.prepare(`
				SELECT id, name FROM taxonomy_tags WHERE normalized_name = ? LIMIT 1
			`).bind(tagKey(name)).first<TaxonomyRow>();
		if (!lookup) return json({ ok: false, error: '項目が見つかりません。' }, 404);

		const { sha, files } = await loadCurrentFiles(context.env);
		const affected = matchingFiles(files, kind, name, contentType);
		if (affected.length !== expectedCount) {
			return json({
				ok: false,
				error: '記事での使用数が変わりました。一覧を再読み込みしてから削除を確認してください。',
				current_count: affected.length,
			}, 409);
		}
		for (const file of affected) {
			if (kind === 'category') {
				file.document.set('category', UNCATEGORIZED);
			} else {
				const tags = validateTags(getDocumentTags(file.document) ?? []);
				if (!tags) throw new Error(`Invalid tags in ${file.sourcePath}`);
				const remaining = tags.filter((tag) => tagKey(tag) !== tagKey(name));
				if (remaining.length > 0) file.document.set('tags', remaining);
				else file.document.delete('tags');
			}
		}
		const commitSha = affected.length > 0
			? await commitManagedArticleChanges(context.env, affected, sha, `content: remove ${kind} ${name}`)
			: null;

		try {
			const result = await context.env.DB.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(lookup.id).run();
			if ((result.meta?.changes ?? 0) === 0) throw new Error('Taxonomy row changed during delete');
		} catch (error) {
			console.error('Article metadata changed but taxonomy catalog deletion failed:', error);
			return json({ ok: false, error: '記事のメタデータは更新されましたが、管理カタログの同期に失敗しました。再読み込みして状態を確認してください。' }, 500);
		}

		await auditTaxonomy(context.env, auth.user.id, 'admin.taxonomy.delete', kind, name, {
			content_type: contentType ?? null,
			affected_articles: affected.length,
			replacement_category: kind === 'category' ? UNCATEGORIZED : null,
			commit_sha: commitSha,
		});
		return json({
			ok: true,
			name,
			affected_articles: affected.length,
			replacement_category: kind === 'category' ? UNCATEGORIZED : undefined,
			commit_sha: commitSha,
		});
	} catch (error) {
		console.error('Failed to delete taxonomy entry:', error);
		return json({ ok: false, error: '処理結果を確定できませんでした。再読み込みして記事frontmatterと管理カタログの状態を確認してください。' }, 502);
	}
};
