import {
	getWikiDraftUser,
	json,
	validateDraftInput,
} from './drafts/_shared';

interface Env {
	DB: D1Database;
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
	try {
		const user = await getWikiDraftUser(request, env);
		if (!user) return json({ ok: false, error: 'ログインが必要です。' }, 401);

		const result = await env.DB.prepare(`
			SELECT
				d.id, d.operation, d.status, d.title, d.slug, d.folder_path,
				d.page_path, d.source_path, d.description, d.created_by,
				d.updated_by, d.created_at, d.updated_at, d.version,
				d.github_pr_number, d.github_pr_url, d.github_pr_state,
				creator.display_name AS created_by_name,
				editor.display_name AS updated_by_name
			FROM wiki_drafts d
			INNER JOIN users creator ON creator.id = d.created_by
			INNER JOIN users editor ON editor.id = d.updated_by
			ORDER BY d.updated_at DESC, d.id
		`).all();

		return json({ ok: true, drafts: result.results });
	} catch (error) {
		console.error('Wiki drafts list error:', error);
		return json({ ok: false, error: '下書き一覧を取得できませんでした。' }, 500);
	}
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
	try {
		const user = await getWikiDraftUser(request, env);
		if (!user) return json({ ok: false, error: 'ログインが必要です。' }, 401);

		let body: unknown;
		try {
			body = await request.json();
		} catch {
			return json({ ok: false, error: 'リクエスト形式が正しくありません。' }, 400);
		}

		const input = validateDraftInput(body);
		if (!input) return json({ ok: false, error: 'ページ情報またはMarkdownが不正です。' }, 400);

		if (input.operation === 'create') {
			const published = await env.DB.prepare(`
				SELECT 1 FROM wiki_pages WHERE path = ? OR source_path = ? LIMIT 1
			`)
				.bind(input.pagePath, input.sourcePath)
				.first();
			if (published) return json({ ok: false, error: '同じパスのWikiページが既にあります。' }, 409);
		} else {
			const page = await env.DB.prepare(`
				SELECT 1 FROM wiki_pages WHERE path = ? AND source_path = ? LIMIT 1
			`)
				.bind(input.pagePath, input.sourcePath)
				.first();
			if (!page) return json({ ok: false, error: '編集対象のWikiページが見つかりません。' }, 404);
		}

		const activeDraft = await env.DB.prepare(`
			SELECT id, status FROM wiki_drafts
			WHERE source_path = ? AND status IN ('draft', 'publishing', 'pending')
			LIMIT 1
		`)
			.bind(input.sourcePath)
			.first<{ id: string; status: string }>();

		if (activeDraft) {
			return json({
				ok: false,
				error: 'このページには既に有効な下書きまたはPR申請があります。',
				draftId: activeDraft.id,
				status: activeDraft.status,
			}, 409);
		}

		const id = crypto.randomUUID();
		const now = new Date().toISOString();
		await env.DB.prepare(`
			INSERT INTO wiki_drafts (
				id, operation, status, title, slug, folder_path,
				page_path, source_path, description, content,
				created_by, updated_by, created_at, updated_at, version
			)
			VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
		`)
			.bind(
				id,
				input.operation,
				input.title,
				input.slug,
				input.folderPath,
				input.pagePath,
				input.sourcePath,
				input.description,
				input.content,
				user.id,
				user.id,
				now,
				now,
			)
			.run();

		return json({ ok: true, draft: { id, status: 'draft', version: 1, updatedAt: now } }, 201);
	} catch (error) {
		console.error('Wiki draft create error:', error);
		return json({ ok: false, error: '下書きを保存できませんでした。' }, 500);
	}
};
