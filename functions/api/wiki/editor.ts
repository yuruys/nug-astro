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
 * Wiki編集者として登録する
 *
 * user   → editor
 * editor → そのまま
 * admin  → そのまま
 */
export const onRequestPost: PagesFunction<Env> = async ({
	env,
	request,
}) => {
	try {
		const user = await getSessionUser(request, env);

		/**
		 * 未ログイン
		 */
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
		 * すでにeditor/adminの場合
		 */
		if (
			user.role === 'editor' ||
			user.role === 'admin'
		) {
			return json({
				ok: true,
				alreadyEditor: true,
				user: {
					id: user.user_id,
					displayName: user.display_name,
					role: user.role,
				},
			});
		}

		/**
		 * user → editor
		 */
		if (user.role !== 'user') {
			return json(
				{
					ok: false,
					error: 'Invalid user role',
				},
				403
			);
		}

		const now = new Date().toISOString();

		/**
		 * ユーザー権限をeditorへ変更
		 */
		await env.DB.prepare(`
			UPDATE users
			SET
				role = 'editor',
				updated_at = ?
			WHERE id = ?
				AND role = 'user'
		`)
			.bind(now, user.user_id)
			.run();

		/**
		 * 更新後のユーザーを取得
		 */
		const updatedUser = await env.DB.prepare(`
			SELECT
				id,
				display_name,
				role
			FROM users
			WHERE id = ?
			LIMIT 1
		`)
			.bind(user.user_id)
			.first();

		if (!updatedUser) {
			return json(
				{
					ok: false,
					error: 'User not found after update',
				},
				500
			);
		}

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
				'wiki.editor.register',
				'user',
				user.user_id,
				JSON.stringify({
					previousRole: 'user',
					newRole: 'editor',
				}),
				now
			)
			.run();

		return json({
			ok: true,
			alreadyEditor: false,
			user: updatedUser,
		});
	} catch (error) {
		console.error(
			'Wiki editor registration POST error:',
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