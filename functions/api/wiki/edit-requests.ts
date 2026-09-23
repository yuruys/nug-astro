interface Env {
	DB: D1Database;
}

interface EditRequestBody {
	pagePath?: string;
	content?: string;
	message?: string;
}

const allowedStatuses = [
	'draft',
	'pending',
	'approved',
	'rejected',
	'publishing',
	'published',
] as const;

type EditRequestStatus = (typeof allowedStatuses)[number];

function json(
	data: unknown,
	status = 200
): Response {
	return Response.json(data, { status });
}

/**
 * Cookieからnug_sessionを取得する
 */
function getSessionId(request: Request): string | null {
	const cookie = request.headers.get('Cookie');

	if (!cookie) {
		return null;
	}

	const cookies = cookie.split(';');

	for (const item of cookies) {
		const [name, ...valueParts] = item.trim().split('=');
		const value = valueParts.join('=');

		if (
			name === 'nug_session' ||
			name === 'session' ||
			name === 'session_id'
		) {
			return decodeURIComponent(value);
		}
	}

	return null;
}

/**
 * 現在ログインしているユーザーを取得する
 */
async function getSessionUser(
	request: Request,
	env: Env
) {
	const sessionId = getSessionId(request);

	if (!sessionId) {
		return null;
	}

	const session = await env.DB.prepare(`
		SELECT
			s.id AS session_id,
			s.user_id,
			s.expires_at,
			u.display_name,
			u.role
		FROM sessions s
		INNER JOIN users u
			ON u.id = s.user_id
		WHERE s.id = ?
			AND s.expires_at > datetime('now')
		LIMIT 1
	`)
		.bind(sessionId)
		.first();

	return session ?? null;
}

/**
 * POST
 *
 * 編集リクエストを作成する
 */
export const onRequestPost: PagesFunction<Env> = async ({
	env,
	request,
}) => {
	try {
		const user = await getSessionUser(request, env);

		if (!user) {
			return json(
				{
					ok: false,
					error: 'Unauthorized',
				},
				401
			);
		}

		if (
			user.role !== 'editor' &&
			user.role !== 'admin'
		) {
			return json(
				{
					ok: false,
					error: 'Forbidden',
				},
				403
			);
		}

		let body: EditRequestBody;

		try {
			body = await request.json();
		} catch {
			return json(
				{
					ok: false,
					error: 'Invalid JSON',
				},
				400
			);
		}

		const pagePath = body.pagePath?.trim();
		const content = body.content;
		const message = body.message?.trim() || null;

		if (!pagePath) {
			return json(
				{
					ok: false,
					error: 'pagePath is required',
				},
				400
			);
		}

		if (typeof content !== 'string') {
			return json(
				{
					ok: false,
					error: 'content is required',
				},
				400
			);
		}

		/**
		 * 対象Wikiページを取得
		 */
		const page = await env.DB.prepare(`
			SELECT
				id,
				path,
				title,
				source_path,
				published_revision_id
			FROM wiki_pages
			WHERE path = ?
			LIMIT 1
		`)
			.bind(pagePath)
			.first();

		if (!page) {
			return json(
				{
					ok: false,
					error: 'Wiki page not found',
				},
				404
			);
		}

		/**
		 * 現在公開されているRevisionを取得
		 */
		let publishedRevision = null;

		if (page.published_revision_id) {
			publishedRevision = await env.DB.prepare(`
				SELECT
					id,
					page_id,
					revision_number,
					content,
					editor_id,
					created_at
				FROM wiki_revisions
				WHERE id = ?
				LIMIT 1
			`)
				.bind(page.published_revision_id)
				.first();
		}

		/**
		 * 現在公開されている内容と同じ場合は拒否
		 */
		if (
			publishedRevision &&
			publishedRevision.content === content
		) {
			return json(
				{
					ok: false,
					error: 'No changes detected',
				},
				400
			);
		}

		/**
		 * 次のRevision番号を取得
		 */
		const revisionResult = await env.DB.prepare(`
			SELECT
				COALESCE(MAX(revision_number), 0) + 1 AS next_revision_number
			FROM wiki_revisions
			WHERE page_id = ?
		`)
			.bind(page.id)
			.first();

		const nextRevisionNumber =
			Number(
				revisionResult?.next_revision_number ?? 1
			);

		const revisionId = crypto.randomUUID();
		const editRequestId = crypto.randomUUID();
		const now = new Date().toISOString();

		/**
		 * Revisionを作成
		 */
		await env.DB.prepare(`
			INSERT INTO wiki_revisions (
				id,
				page_id,
				revision_number,
				content,
				editor_id,
				created_at
			)
			VALUES (?, ?, ?, ?, ?, ?)
		`)
			.bind(
				revisionId,
				page.id,
				nextRevisionNumber,
				content,
				user.user_id,
				now
			)
			.run();

		/**
		 * 編集リクエストを作成
		 */
		await env.DB.prepare(`
			INSERT INTO edit_requests (
				id,
				page_id,
				revision_id,
				base_revision_id,
				user_id,
				status,
				message,
				created_at
			)
			VALUES (?, ?, ?, ?, ?, 'draft', ?, ?)
		`)
			.bind(
				editRequestId,
				page.id,
				revisionId,
				publishedRevision?.id ?? null,
				user.user_id,
				message,
				now
			)
			.run();

		/**
		 * 監査ログ
		 */
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
			VALUES (?, ?, ?, ?, ?, ?, ?)
		`)
			.bind(
				crypto.randomUUID(),
				user.user_id,
				'wiki.edit_request.create',
				'edit_request',
				editRequestId,
				JSON.stringify({
					pagePath,
					revisionId,
					revisionNumber: nextRevisionNumber,
				}),
				now
			)
			.run();

		return json(
			{
				ok: true,
				editRequest: {
					id: editRequestId,
					pageId: page.id,
					pagePath: page.path,
					revisionId,
					revisionNumber: nextRevisionNumber,
					status: 'draft',
					message,
					baseRevisionId:
						publishedRevision?.id ?? null,
					createdAt: now,
				},
			},
			201
		);
	} catch (error) {
		console.error(
			'Wiki edit request POST error:',
			error
		);

		return json(
			{
				ok: false,
				error: 'Internal server error',
			},
			500
		);
	}
};

/**
 * GET
 *
 * 編集リクエスト一覧を取得する
 *
 * 例:
 * GET /api/wiki/edit-requests
 * GET /api/wiki/edit-requests?status=draft
 */
export const onRequestGet: PagesFunction<Env> = async ({
	env,
	request,
}) => {
	try {
		const user = await getSessionUser(request, env);

		if (!user) {
			return json(
				{
					ok: false,
					error: 'Unauthorized',
				},
				401
			);
		}

		if (
			user.role !== 'editor' &&
			user.role !== 'admin'
		) {
			return json(
				{
					ok: false,
					error: 'Forbidden',
				},
				403
			);
		}

		const url = new URL(request.url);
		const status = url.searchParams.get('status');

		if (
			status &&
			!allowedStatuses.includes(
				status as EditRequestStatus
			)
		) {
			return json(
				{
					ok: false,
					error: 'Invalid status',
					allowedStatuses,
				},
				400
			);
		}

		let query = `
			SELECT
				er.id,
				er.status,
				er.message,
				er.base_revision_id,
				er.revision_id,
				er.created_at,
				er.reviewed_at,

				p.id AS page_id,
				p.path AS page_path,
				p.title AS page_title,
				p.source_path,

				r.revision_number,

				er.user_id,
				editor.display_name AS user_display_name,
				editor.role AS user_role,

				er.reviewer_id,
				reviewer.display_name AS reviewer_display_name

			FROM edit_requests er

			INNER JOIN wiki_pages p
				ON p.id = er.page_id

			INNER JOIN wiki_revisions r
				ON r.id = er.revision_id

			INNER JOIN users editor
				ON editor.id = er.user_id

			LEFT JOIN users reviewer
				ON reviewer.id = er.reviewer_id
		`;

		const params: string[] = [];

		if (status) {
			query += `
				WHERE er.status = ?
			`;

			params.push(status);
		}

		query += `
			ORDER BY er.created_at DESC
		`;

		const result =
			params.length > 0
				? await env.DB.prepare(query)
						.bind(...params)
						.all()
				: await env.DB.prepare(query).all();

		return json({
			ok: true,
			editRequests: result.results,
		});
	} catch (error) {
		console.error(
			'Wiki edit request GET error:',
			error
		);

		return json(
			{
				ok: false,
				error: 'Internal server error',
			},
			500
		);
	}
};

/**
 * GET詳細
 *
 * 特定の編集リクエストを取得する
 *
 * 例:
 * GET /api/wiki/edit-requests/:id
 *
 * 取得内容:
 * - 編集リクエスト
 * - 対象Wikiページ
 * - 編集Revision
 * - ベースRevision
 * - 編集者
 * - レビュアー
 */
export const onRequest: PagesFunction<Env> = async ({
	env,
	request,
	params,
}) => {
	try {
		/**
		 * GET一覧・POSTと同じ認証を行う
		 */
		const user = await getSessionUser(request, env);

		if (!user) {
			return json(
				{
					ok: false,
					error: 'Unauthorized',
				},
				401
			);
		}

		if (
			user.role !== 'editor' &&
			user.role !== 'admin'
		) {
			return json(
				{
					ok: false,
					error: 'Forbidden',
				},
				403
			);
		}

		/**
		 * /api/wiki/edit-requests/:id
		 *
		 * Cloudflare Pages Functionsの
		 * 動的ルートパラメータを取得
		 */
		const editRequestId =
			typeof params.id === 'string'
				? params.id
				: null;

		if (!editRequestId) {
			return json(
				{
					ok: false,
					error: 'Edit request ID is required',
				},
				400
			);
		}

		/**
		 * 編集リクエスト本体を取得
		 */
		const editRequest =
			await env.DB.prepare(`
				SELECT
					er.id,
					er.status,
					er.message,
					er.base_revision_id,
					er.revision_id,
					er.user_id,
					er.reviewer_id,
					er.created_at,
					er.reviewed_at,

					p.id AS page_id,
					p.path AS page_path,
					p.title AS page_title,
					p.source_path,
					p.published_revision_id,

					editor.display_name AS user_display_name,
					editor.role AS user_role,

					reviewer.display_name AS reviewer_display_name,
					reviewer.role AS reviewer_role

				FROM edit_requests er

				INNER JOIN wiki_pages p
					ON p.id = er.page_id

				INNER JOIN users editor
					ON editor.id = er.user_id

				LEFT JOIN users reviewer
					ON reviewer.id = er.reviewer_id

				WHERE er.id = ?

				LIMIT 1
			`)
				.bind(editRequestId)
				.first();

		if (!editRequest) {
			return json(
				{
					ok: false,
					error: 'Edit request not found',
				},
				404
			);
		}

		/**
		 * 編集対象のRevisionを取得
		 */
		const revision =
			await env.DB.prepare(`
				SELECT
					r.id,
					r.page_id,
					r.revision_number,
					r.content,
					r.editor_id,
					r.created_at,

					editor.display_name AS editor_display_name,
					editor.role AS editor_role

				FROM wiki_revisions r

				INNER JOIN users editor
					ON editor.id = r.editor_id

				WHERE r.id = ?

				LIMIT 1
			`)
				.bind(editRequest.revision_id)
				.first();

		/**
		 * ベースRevisionを取得
		 */
		let baseRevision = null;

		if (editRequest.base_revision_id) {
			baseRevision =
				await env.DB.prepare(`
					SELECT
						r.id,
						r.page_id,
						r.revision_number,
						r.content,
						r.editor_id,
						r.created_at,

						editor.display_name AS editor_display_name,
						editor.role AS editor_role

					FROM wiki_revisions r

					INNER JOIN users editor
						ON editor.id = r.editor_id

					WHERE r.id = ?

					LIMIT 1
				`)
					.bind(
						editRequest.base_revision_id
					)
					.first();
		}

		/**
		 * 現在公開されているRevisionを取得
		 */
		let publishedRevision = null;

		if (editRequest.published_revision_id) {
			publishedRevision =
				await env.DB.prepare(`
					SELECT
						r.id,
						r.page_id,
						r.revision_number,
						r.content,
						r.editor_id,
						r.created_at,

						editor.display_name AS editor_display_name,
						editor.role AS editor_role

					FROM wiki_revisions r

					INNER JOIN users editor
						ON editor.id = r.editor_id

					WHERE r.id = ?

					LIMIT 1
				`)
					.bind(
						editRequest.published_revision_id
					)
					.first();
		}

		return json({
			ok: true,

			editRequest,

			revision,

			baseRevision,

			publishedRevision,
		});
	} catch (error) {
		console.error(
			'Wiki edit request detail GET error:',
			error
		);

		return json(
			{
				ok: false,
				error: 'Internal server error',
			},
			500
		);
	}
};