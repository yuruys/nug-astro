export const onRequestGet: PagesFunction<{
	DB: D1Database;
}> = async ({ request, env }) => {
	const cookie = request.headers.get('Cookie');

	// ========================================
	// 1. Cookieがない場合
	// ========================================

	if (!cookie) {
		return new Response(
			JSON.stringify({
				ok: true,
				loggedIn: false,
				user: null,
			}),
			{
				headers: {
					'Content-Type':
						'application/json; charset=utf-8',
					'Cache-Control':
						'no-store',
				},
			},
		);
	}

	// ========================================
	// 2. セッションCookieを取得
	// ========================================

	const sessionMatch = cookie.match(
		/(?:^|;\s*)nug_session=([^;]+)/,
	);

	if (!sessionMatch) {
		return new Response(
			JSON.stringify({
				ok: true,
				loggedIn: false,
				user: null,
			}),
			{
				headers: {
					'Content-Type':
						'application/json; charset=utf-8',
					'Cache-Control':
						'no-store',
				},
			},
		);
	}

	const sessionId = sessionMatch[1];

	// ========================================
	// 3. セッションとユーザーを取得
	// ========================================

	const result = await env.DB
		.prepare(`
			SELECT
				users.id,
				users.display_name,
				users.email,
				users.avatar_url,
				users.role,
				sessions.expires_at
			FROM sessions
			INNER JOIN users
				ON users.id = sessions.user_id
			WHERE
				sessions.id = ?
				AND sessions.expires_at > datetime('now')
			LIMIT 1
		`)
		.bind(sessionId)
		.first();

	// ========================================
	// 4. セッションが存在しない
	//    または期限切れの場合
	// ========================================

	if (!result) {
		return new Response(
			JSON.stringify({
				ok: true,
				loggedIn: false,
				user: null,
			}),
			{
				headers: {
					'Content-Type':
						'application/json; charset=utf-8',
					'Cache-Control':
						'no-store',
				},
			},
		);
	}

	// ========================================
	// 5. 有効なログイン状態
	// ========================================

	return new Response(
		JSON.stringify({
			ok: true,
			loggedIn: true,
			user: result,
		}),
		{
			headers: {
				'Content-Type':
					'application/json; charset=utf-8',
				'Cache-Control':
					'no-store',
			},
		},
	);
};