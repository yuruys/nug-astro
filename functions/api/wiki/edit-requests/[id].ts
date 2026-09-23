interface Env {
	DB: D1Database;
}

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
 * GET
 *
 * 特定の編集リクエストの詳細を取得する
 *
 * URL:
 * /api/wiki/edit-requests/:id
 */
export const onRequestGet: PagesFunction<Env> = async ({
	env,
	request,
	params,
}) => {
	try {
		/**
		 * 認証
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

		/**
		 * editor / admin のみ許可
		 */
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
		 * [id] パラメータ
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
		 * 編集リクエストを取得
		 *
		 * review_comment を含めて、
		 * 承認・却下時のレビュー情報も返す。
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
					er.review_comment,
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
		 * 編集者が作成したRevision
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
		 * 編集開始時点のベースRevision
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
		 * 現在公開されているRevision
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

		/**
		 * レスポンス
		 */
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