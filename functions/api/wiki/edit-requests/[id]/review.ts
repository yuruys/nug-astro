interface Env {
	DB: D1Database;
}

type ReviewStatus = 'approved' | 'rejected';

interface ReviewBody {
	status?: ReviewStatus;
	comment?: string;
}

function json(
	data: unknown,
	status = 200
): Response {
	return Response.json(data, { status });
}

function getSessionId(
	request: Request
): string | null {
	const cookie =
		request.headers.get('Cookie');

	if (!cookie) {
		return null;
	}

	const cookies =
		cookie.split(';');

	for (const item of cookies) {
		const [
			name,
			...valueParts
		] = item.trim().split('=');

		const value =
			valueParts.join('=');

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

async function getSessionUser(
	request: Request,
	env: Env
) {
	const sessionId =
		getSessionId(request);

	if (!sessionId) {
		return null;
	}

	const session =
		await env.DB.prepare(`
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

export const onRequestPost: PagesFunction<Env> =
	async ({
		env,
		request,
		params,
	}) => {
		try {
			/*
			 * ========================================
			 * 1. ログイン確認
			 * ========================================
			 */

			const user =
				await getSessionUser(
					request,
					env
				);

			if (!user) {
				return json(
					{
						ok: false,
						error: 'Unauthorized',
					},
					401
				);
			}

			/*
			 * ========================================
			 * 2. 管理者確認
			 * ========================================
			 */

			if (user.role !== 'admin') {
				return json(
					{
						ok: false,
						error: 'Forbidden',
					},
					403
				);
			}

			/*
			 * ========================================
			 * 3. 編集申請ID確認
			 * ========================================
			 */

			const editRequestId =
				typeof params.id === 'string'
					? params.id
					: null;

			if (!editRequestId) {
				return json(
					{
						ok: false,
						error:
							'Edit request ID is required',
					},
					400
				);
			}

			/*
			 * ========================================
			 * 4. リクエストボディ取得
			 * ========================================
			 */

			let body: ReviewBody;

			try {
				body =
					await request.json();
			} catch {
				return json(
					{
						ok: false,
						error: 'Invalid JSON body',
					},
					400
				);
			}

			const status =
				body.status;

			const comment =
				typeof body.comment === 'string'
					? body.comment.trim()
					: null;

			/*
			 * ========================================
			 * 5. ステータス確認
			 * ========================================
			 */

			if (
				status !== 'approved' &&
				status !== 'rejected'
			) {
				return json(
					{
						ok: false,
						error:
							'Status must be approved or rejected',
					},
					400
				);
			}

			/*
			 * ========================================
			 * 6. 編集申請取得
			 * ========================================
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
						error:
							'Edit request not found',
					},
					404
				);
			}

			/*
			 * ========================================
			 * 7. pending のみレビュー可能
			 * ========================================
			 */

			if (
				editRequest.status !==
				'pending'
			) {
				return json(
					{
						ok: false,
						error:
							'Only pending edit requests can be reviewed',
						status:
							editRequest.status,
					},
					400
				);
			}

			/*
			 * ========================================
			 * 8. レビュー日時
			 * ========================================
			 */

			const now =
				new Date().toISOString();

			/*
			 * ========================================
			 * 9. 編集申請更新
			 * ========================================
			 */

			await env.DB.prepare(`
				UPDATE edit_requests
				SET
					status = ?,
					reviewer_id = ?,
					review_comment = ?,
					reviewed_at = ?
				WHERE id = ?
			`)
				.bind(
					status,
					user.user_id,
					comment,
					now,
					editRequestId
				)
				.run();

			/*
			 * ========================================
			 * 10. 監査ログ
			 * ========================================
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
					`wiki.edit_request.${status}`,
					'edit_request',
					editRequestId,
					JSON.stringify({
						previousStatus:
							'pending',
						newStatus:
							status,
						comment,
					}),
					now
				)
				.run();

			/*
			 * ========================================
			 * 11. 更新後のデータ取得
			 * ========================================
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

			/*
			 * ========================================
			 * 12. 完了
			 * ========================================
			 */

			return json({
				ok: true,
				editRequest: updated,
			});
		} catch (error) {
			console.error(
				'Wiki edit request review error:',
				error
			);

			return json(
				{
					ok: false,
					error:
						'Internal server error',
				},
				500
			);
		}
	};