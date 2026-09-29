type AdminUser = {
	id: string;
	role: string;
};

type RequireAdminSuccess = {
	ok: true;
	user: AdminUser;
};

type RequireAdminFailure = {
	ok: false;
	response: Response;
};

export type RequireAdminResult =
	| RequireAdminSuccess
	| RequireAdminFailure;

/**
 * 攻略・ニュース管理API専用のadmin認証。
 *
 * 既存Wikiの認証処理とは分離して使用する。
 *
 * - Cookie: nug_session のみを使用
 * - 有効なセッションがなければ 401
 * - ログイン済みだがadminでなければ 403
 * - adminの場合はユーザー情報を返す
 */
export async function requireAdmin(
	request: Request,
	env: Env,
): Promise<RequireAdminResult> {
	const cookieHeader = request.headers.get('Cookie') ?? '';

	const sessionId = cookieHeader
		.split(';')
		.map((part) => part.trim())
		.find((part) => part.startsWith('nug_session='))
		?.slice('nug_session='.length);

	if (!sessionId) {
		return {
			ok: false,
			response: Response.json(
				{
					ok: false,
					error: 'Unauthorized',
				},
				{ status: 401 },
			),
		};
	}

	const user = await env.DB
		.prepare(
			`
				SELECT
					u.id,
					u.role
				FROM sessions AS s
				INNER JOIN users AS u
					ON s.user_id = u.id
				WHERE
					s.id = ?
					AND s.expires_at > datetime('now')
				LIMIT 1
			`,
		)
		.bind(sessionId)
		.first<AdminUser>();

	if (!user) {
		return {
			ok: false,
			response: Response.json(
				{
					ok: false,
					error: 'Unauthorized',
				},
				{ status: 401 },
			),
		};
	}

	if (user.role !== 'admin') {
		return {
			ok: false,
			response: Response.json(
				{
					ok: false,
					error: 'Forbidden',
				},
				{ status: 403 },
			),
		};
	}

	return {
		ok: true,
		user,
	};
}