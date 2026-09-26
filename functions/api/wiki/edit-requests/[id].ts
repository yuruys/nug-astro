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

/**
 * PUT
 *
 * draft状態の編集リクエストを更新する
 *
 * URL:
 * /api/wiki/edit-requests/:id
 *
 * Body:
 * {
 *   "content": "...",
 *   "message": "..."
 * }
 *
 * draft以外の編集リクエストは更新できない。
 */
export const onRequestPut: PagesFunction<Env> = async ({
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
		 * JSONを取得
		 */
		let body: {
			content?: unknown;
			message?: unknown;
		};

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

		/**
		 * contentの確認
		 */
		if (typeof body.content !== 'string') {
			return json(
				{
					ok: false,
					error: 'content is required',
				},
				400
			);
		}

		const content = body.content;
		const message =
			typeof body.message === 'string'
				? body.message.trim() || null
				: null;

		/**
		 * 編集リクエストを取得
		 */
		const editRequest =
			await env.DB.prepare(`
				SELECT
					id,
					page_id,
					revision_id,
					base_revision_id,
					user_id,
					status,
					message,
					created_at
				FROM edit_requests
				WHERE id = ?
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
		 * draftのみ更新可能
		 */
		if (editRequest.status !== 'draft') {
			return json(
				{
					ok: false,
					error:
						'Only draft edit requests can be updated',
					status: editRequest.status,
				},
				400
			);
		}

		/**
		 * 編集者本人のdraftか確認
		 *
		 * adminは他ユーザーのdraftも更新可能
		 */
		if (
			editRequest.user_id !== user.user_id &&
			user.role !== 'admin'
		) {
			return json(
				{
					ok: false,
					error:
						'You can only update your own edit requests',
				},
				403
			);
		}

		/**
		 * 現在のRevisionを取得
		 */
		const currentRevision =
			await env.DB.prepare(`
				SELECT
					id,
					page_id,
					revision_number,
					content
				FROM wiki_revisions
				WHERE id = ?
				LIMIT 1
			`)
				.bind(editRequest.revision_id)
				.first();

		if (!currentRevision) {
			return json(
				{
					ok: false,
					error: 'Current revision not found',
				},
				404
			);
		}

		/**
		 * 内容もメッセージも変更されていない場合
		 */
		const currentMessage =
			editRequest.message ?? null;

		if (
			currentRevision.content === content &&
			currentMessage === message
		) {
			return json(
				{
					ok: true,
					changed: false,
					editRequest: {
						id: editRequest.id,
						status: editRequest.status,
						revisionId:
							editRequest.revision_id,
					},
				}
			);
		}

		/**
		 * 次のRevision番号を取得
		 */
		const revisionResult =
			await env.DB.prepare(`
				SELECT
					COALESCE(MAX(revision_number), 0) + 1 AS next_revision_number
				FROM wiki_revisions
				WHERE page_id = ?
			`)
				.bind(editRequest.page_id)
				.first();

		const nextRevisionNumber =
			Number(
				revisionResult?.next_revision_number ?? 1
			);

		const revisionId = crypto.randomUUID();
		const now = new Date().toISOString();

		/**
		 * 新しいRevisionを作成
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
				editRequest.page_id,
				nextRevisionNumber,
				content,
				user.user_id,
				now
			)
			.run();

		/**
		 * 編集リクエストを新Revisionへ更新
		 */
		await env.DB.prepare(`
			UPDATE edit_requests
			SET
				revision_id = ?,
				message = ?
			WHERE id = ?
		`)
			.bind(
				revisionId,
				message,
				editRequestId
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
				'wiki.edit_request.update',
				'edit_request',
				editRequestId,
				JSON.stringify({
					previousRevisionId:
						editRequest.revision_id,
					newRevisionId: revisionId,
					revisionNumber:
						nextRevisionNumber,
				}),
				now
			)
			.run();

		/**
		 * 更新後の編集リクエストを取得
		 */
		const updated =
			await env.DB.prepare(`
				SELECT
					id,
					page_id,
					revision_id,
					base_revision_id,
					user_id,
					status,
					message,
					created_at
				FROM edit_requests
				WHERE id = ?
				LIMIT 1
			`)
				.bind(editRequestId)
				.first();

		return json({
			ok: true,
			changed: true,
			editRequest: updated,
			revision: {
				id: revisionId,
				pageId: editRequest.page_id,
				revisionNumber: nextRevisionNumber,
			},
		});
	} catch (error) {
		console.error(
			'Wiki edit request PUT error:',
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