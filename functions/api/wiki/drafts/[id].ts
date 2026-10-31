import {
	getWikiDraftUser,
	json,
	validateDraftInput,
} from './_shared';

interface Env {
	DB: D1Database;
}

interface DraftVersionInput {
	version?: unknown;
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env, params }) => {
	try {
		const user = await getWikiDraftUser(request, env);
		if (!user) return json({ ok: false, error: 'ログインが必要です。' }, 401);
		const id = params.id;
		if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return json({ ok: false, error: '下書きIDが不正です。' }, 400);

		const draft = await env.DB.prepare(`
			SELECT
				d.id, d.operation, d.status, d.title, d.slug, d.folder_path,
				d.page_path, d.source_path, d.description, d.content,
				d.created_by, d.updated_by, d.created_at, d.updated_at,
				d.version, d.github_pr_number, d.github_pr_url, d.github_pr_state,
				creator.display_name AS created_by_name,
				editor.display_name AS updated_by_name
			FROM wiki_drafts d
			INNER JOIN users creator ON creator.id = d.created_by
			INNER JOIN users editor ON editor.id = d.updated_by
			WHERE d.id = ?
			LIMIT 1
		`)
			.bind(id)
			.first<Record<string, unknown> & { source_path: string }>();

		if (!draft) return json({ ok: false, error: '下書きが見つかりません。' }, 404);
		const sourcePath = draft.source_path;
		const directory = sourcePath.slice(0, sourcePath.lastIndexOf('/') + 1);
		const childPrefix = sourcePath.endsWith('/index.md') || sourcePath.endsWith('/index.mdx')
			? directory
			: `${directory}${sourcePath.slice(directory.length).replace(/\.(?:md|mdx)$/, '')}/`;
		const escapedChildPrefix = childPrefix.replace(/[!%_]/g, '!$&');
		const children = await env.DB.prepare(`
			SELECT COUNT(*) AS count
			FROM wiki_pages
			WHERE source_path LIKE ? ESCAPE '!' AND source_path != ?
		`)
			.bind(`${escapedChildPrefix}%`, sourcePath)
			.first<{ count: number }>();

		return json({ ok: true, draft, childPageCount: Number(children?.count ?? 0) });
	} catch (error) {
		console.error('Wiki draft read error:', error);
		return json({ ok: false, error: '下書きを取得できませんでした。' }, 500);
	}
};

export const onRequestPut: PagesFunction<Env> = async ({ request, env, params }) => {
	try {
		const user = await getWikiDraftUser(request, env);
		if (!user) return json({ ok: false, error: 'ログインが必要です。' }, 401);
		const id = params.id;
		if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return json({ ok: false, error: '下書きIDが不正です。' }, 400);

		let body: unknown;
		try {
			body = await request.json();
		} catch {
			return json({ ok: false, error: 'リクエスト形式が正しくありません。' }, 400);
		}
		const version = (body as DraftVersionInput | null)?.version;
		const input = validateDraftInput(body);
		if (!input || !Number.isSafeInteger(version) || Number(version) < 1) {
			return json({ ok: false, error: '下書き情報またはバージョンが不正です。' }, 400);
		}

		const current = await env.DB.prepare(`
			SELECT operation, page_path, source_path, status, version
			FROM wiki_drafts
			WHERE id = ?
			LIMIT 1
		`)
			.bind(id)
			.first<{ operation: string; page_path: string; source_path: string; status: string; version: number }>();
		if (!current || current.status !== 'draft' || current.version !== Number(version)) {
			return json({
				ok: false,
				error: '別のユーザーが更新したか、下書きが申請済みです。最新内容を読み直してください。',
				code: 'DRAFT_CONFLICT',
			}, 409);
		}

		if (current.operation === 'create') {
			if (input.operation !== 'create') {
				return json({ ok: false, error: '新規ページ下書きの操作種別は変更できません。' }, 400);
			}
			const published = await env.DB.prepare(`
				SELECT 1 FROM wiki_pages WHERE path = ? OR source_path = ? LIMIT 1
			`)
				.bind(input.pagePath, input.sourcePath)
				.first();
			const conflictingDraft = await env.DB.prepare(`
				SELECT 1 FROM wiki_drafts
				WHERE source_path = ? AND id != ? AND status IN ('draft', 'publishing', 'pending')
				LIMIT 1
			`)
				.bind(input.sourcePath, id)
				.first();
			if (published || conflictingDraft) {
				return json({ ok: false, error: '指定したURLには既にページまたは下書きがあります。' }, 409);
			}
		} else if (current.page_path !== input.pagePath || current.source_path !== input.sourcePath) {
			return json({ ok: false, error: '既存ページの保存先パスは変更できません。' }, 400);
		}

		const now = new Date().toISOString();
		const result = await env.DB.prepare(`
			UPDATE wiki_drafts
			SET
				operation = ?, title = ?, slug = ?, folder_path = ?,
				page_path = ?, source_path = ?, description = ?, content = ?,
				updated_by = ?, updated_at = ?,
				version = version + 1
			WHERE id = ? AND status = 'draft' AND version = ?
		`)
			.bind(
				input.operation,
				input.title,
				input.slug,
				input.folderPath,
				input.pagePath,
				input.sourcePath,
				input.description,
				input.content,
				user.id,
				now,
				id,
				version,
			)
			.run();

		if (result.meta?.changes !== 1) {
			return json({
				ok: false,
				error: '別のユーザーが更新したか、下書きが申請済みです。最新内容を読み直してください。',
				code: 'DRAFT_CONFLICT',
			}, 409);
		}
		return json({ ok: true, version: Number(version) + 1, updatedAt: now });
	} catch (error) {
		console.error('Wiki draft update error:', error);
		return json({ ok: false, error: '下書きを更新できませんでした。' }, 500);
	}
};

export const onRequestDelete: PagesFunction<Env> = async ({ request, env, params }) => {
	try {
		const user = await getWikiDraftUser(request, env);
		if (!user) return json({ ok: false, error: 'ログインが必要です。' }, 401);
		const id = params.id;
		if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return json({ ok: false, error: '下書きIDが不正です。' }, 400);

		let body: DraftVersionInput;
		try {
			body = await request.json() as DraftVersionInput;
		} catch {
			return json({ ok: false, error: 'バージョンが指定されていません。' }, 400);
		}
		if (!Number.isSafeInteger(body.version) || Number(body.version) < 1) {
			return json({ ok: false, error: 'バージョンが不正です。' }, 400);
		}

		const result = await env.DB.prepare(`
			DELETE FROM wiki_drafts
			WHERE id = ? AND status = 'draft' AND version = ?
		`)
			.bind(id, body.version)
			.run();
		if (result.meta?.changes !== 1) {
			return json({
				ok: false,
				error: '下書きが更新済み、またはPR申請済みです。最新内容を確認してください。',
				code: 'DRAFT_CONFLICT',
			}, 409);
		}
		return json({ ok: true });
	} catch (error) {
		console.error('Wiki draft delete error:', error);
		return json({ ok: false, error: '下書きを削除できませんでした。' }, 500);
	}
};
