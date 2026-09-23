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
 * POST
 *
 * draft状態の編集リクエストを
 * pending（レビュー待ち）へ提出する
 *
 * URL:
 * /api/wiki/edit-requests/:id/submit
 */
export const onRequestPost: PagesFunction<Env> = async ({
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
					id,
					page_id,
					revision_id,
					base_revision_id,
					user_id,
					status,
					message,
					reviewer_id,
					review_comment,
					created_at,
					reviewed_at
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
		 * draftのみ提出可能
		 */
		if (editRequest.status !== 'draft') {
			return json(
				{
					ok: false,
					error: 'Only draft edit requests can be submitted',
					status: editRequest.status,
				},
				400
			);
		}

		/**
		 * 編集者本人のリクエストか確認
		 *
		 * adminは他ユーザーのdraftも提出可能
		 */
		if (
			editRequest.user_id !== user.user_id &&
			user.role !== 'admin'
		) {
			return json(
				{
					ok: false,
					error: 'You can only submit your own edit requests',
				},
				403
			);
		}

		const now = new Date().toISOString();

		/**
		 * draft → pending
		 */
		await env.DB.prepare(`
			UPDATE edit_requests
			SET
				status = 'pending'
			WHERE id = ?
		`)
			.bind(editRequestId)
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
				'wiki.edit_request.submit',
				'edit_request',
				editRequestId,
				JSON.stringify({
					previousStatus: 'draft',
					newStatus: 'pending',
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
					reviewer_id,
					review_comment,
					created_at,
					reviewed_at
				FROM edit_requests
				WHERE id = ?
				LIMIT 1
			`)
				.bind(editRequestId)
				.first();

		return json({
			ok: true,
			editRequest: updated,
		});
	} catch (error) {
		console.error(
			'Wiki edit request submit error:',
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