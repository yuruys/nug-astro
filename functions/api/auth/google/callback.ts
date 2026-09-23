/* =========================================================
 * NUGBACE Google OAuth Callback
 * ---------------------------------------------------------
 * Google OAuth 認証後の callback を処理する。
 *
 * Flow:
 *
 * Google
 *   ↓
 * /api/auth/google/callback
 *   ↓
 * OAuth state 検証
 *   ↓
 * authorization code → access token
 *   ↓
 * Google UserInfo
 *   ↓
 * D1 users / user_identities
 *   ↓
 * D1 sessions
 *   ↓
 * nug_session Cookie
 *   ↓
 * /account/
 * ========================================================= */


export const onRequestGet: PagesFunction<{
	DB: D1Database;
	GOOGLE_CLIENT_ID: string;
	GOOGLE_CLIENT_SECRET: string;
}> = async ({ request, env }) => {
	const url = new URL(request.url);

	const code = url.searchParams.get('code');
	const state = url.searchParams.get('state');
	const error = url.searchParams.get('error');


	/* =====================================================
	 * 01. Google側で認証がキャンセルされた場合
	 * ===================================================== */

	if (error) {
		return new Response(
			`Googleログインがキャンセルまたは失敗しました: ${error}`,
			{
				status: 400,
				headers: {
					'Content-Type':
						'text/plain; charset=utf-8',
				},
			},
		);
	}


	/* =====================================================
	 * 02. Googleから認証コードが届いているか確認
	 * ===================================================== */

	if (!code || !state) {
		return new Response(
			'Googleから必要な認証情報を受け取れませんでした。',
			{
				status: 400,
				headers: {
					'Content-Type':
						'text/plain; charset=utf-8',
				},
			},
		);
	}


	/* =====================================================
	 * 03. OAuth stateをCookieと照合
	 * ===================================================== */

	const cookie =
		request.headers.get('Cookie') ?? '';

	const stateMatch = cookie.match(
		/(?:^|;\s*)nug_oauth_state=([^;]+)/,
	);

	if (!stateMatch) {
		return new Response(
			'OAuth stateが見つかりません。もう一度ログインしてください。',
			{
				status: 400,
				headers: {
					'Content-Type':
						'text/plain; charset=utf-8',
				},
			},
		);
	}

	const savedState = stateMatch[1];

	if (state !== savedState) {
		return new Response(
			'OAuth stateが一致しません。ログインを中止しました。',
			{
				status: 400,
				headers: {
					'Content-Type':
						'text/plain; charset=utf-8',
				},
			},
		);
	}


	/* =====================================================
	 * 04. Googleからアクセストークンを取得
	 * ===================================================== */

	const redirectUri =
		`${url.origin}/api/auth/google/callback`;

	const tokenResponse = await fetch(
		'https://oauth2.googleapis.com/token',
		{
			method: 'POST',

			headers: {
				'Content-Type':
					'application/x-www-form-urlencoded',
			},

			body: new URLSearchParams({
				code,

				client_id:
					env.GOOGLE_CLIENT_ID,

				client_secret:
					env.GOOGLE_CLIENT_SECRET,

				redirect_uri:
					redirectUri,

				grant_type:
					'authorization_code',
			}),
		},
	);


	/* =====================================================
	 * 05. アクセストークン取得結果を確認
	 * ===================================================== */

	if (!tokenResponse.ok) {
		const errorText =
			await tokenResponse.text();

		return new Response(
			`Googleトークン取得に失敗しました。\n${errorText}`,
			{
				status: 502,
				headers: {
					'Content-Type':
						'text/plain; charset=utf-8',
				},
			},
		);
	}


	/* =====================================================
	 * 06. Google Token Response
	 * -----------------------------------------------------
	 * Response.json<T>() は現在のDOM型では使用しない。
	 * json() の結果を明示的に型付けする。
	 * ===================================================== */

	const tokenData =
		(await tokenResponse.json()) as {
			access_token?: string;
			token_type?: string;
			expires_in?: number;
			scope?: string;
			id_token?: string;
		};


	/* =====================================================
	 * 07. アクセストークンの存在を確認
	 * ===================================================== */

	if (!tokenData.access_token) {
		return new Response(
			'Googleからアクセストークンを取得できませんでした。',
			{
				status: 502,
				headers: {
					'Content-Type':
						'text/plain; charset=utf-8',
				},
			},
		);
	}


	/* =====================================================
	 * 08. Googleユーザー情報を取得
	 * ===================================================== */

	const userInfoResponse = await fetch(
		'https://openidconnect.googleapis.com/v1/userinfo',
		{
			headers: {
				Authorization:
					`Bearer ${tokenData.access_token}`,
			},
		},
	);


	/* =====================================================
	 * 09. Googleユーザー情報取得結果を確認
	 * ===================================================== */

	if (!userInfoResponse.ok) {
		const errorText =
			await userInfoResponse.text();

		return new Response(
			`Googleユーザー情報の取得に失敗しました。\n${errorText}`,
			{
				status: 502,
				headers: {
					'Content-Type':
						'text/plain; charset=utf-8',
				},
			},
		);
	}


	/* =====================================================
	 * 10. Google UserInfo
	 * ===================================================== */

	const googleUser =
		(await userInfoResponse.json()) as GoogleUserInfo;


	/* =====================================================
	 * 11. 必須ユーザー情報を確認
	 * ===================================================== */

	if (
		!googleUser.sub ||
		!googleUser.email
	) {
		return new Response(
			'Googleから必要なユーザー情報を取得できませんでした。',
			{
				status: 502,
				headers: {
					'Content-Type':
						'text/plain; charset=utf-8',
				},
			},
		);
	}


	/* =====================================================
	 * 12. NUGBACEユーザーを検索
	 * ===================================================== */

	const existingIdentity =
		await env.DB
			.prepare(`
				SELECT
					users.id,
					users.display_name,
					users.email,
					users.avatar_url,
					users.role
				FROM user_identities
				INNER JOIN users
					ON users.id =
						user_identities.user_id
				WHERE
					user_identities.provider = ?
					AND user_identities.provider_user_id = ?
				LIMIT 1
			`)
			.bind(
				'google',
				googleUser.sub,
			)
			.first<{
				id: string;
				display_name: string;
				email: string;
				avatar_url: string | null;
				role: string;
			}>();


	/* =====================================================
	 * 13. 既存ユーザーならそのユーザーを使用
	 * ===================================================== */

	let userId: string;

	if (existingIdentity) {
		userId = existingIdentity.id;

		await env.DB
			.prepare(`
				UPDATE users
				SET
					display_name = ?,
					email = ?,
					avatar_url = ?,
					updated_at = datetime('now')
				WHERE id = ?
			`)
			.bind(
				userId
					? (
						googleUser.name ??
						googleUser.email
					)
					: googleUser.email,

				googleUser.email,

				googleUser.picture ??
					null,

				userId,
			)
			.run();
	} else {


		/* =================================================
		 * 14. 新規ユーザーを作成
		 * ================================================= */

		userId =
			crypto.randomUUID();

		await env.DB
			.prepare(`
				INSERT INTO users (
					id,
					display_name,
					email,
					avatar_url,
					role,
					created_at,
					updated_at
				)
				VALUES (
					?,
					?,
					?,
					?,
					?,
					datetime('now'),
					datetime('now')
				)
			`)
			.bind(
				userId,

				googleUser.name ??
					googleUser.email,

				googleUser.email,

				googleUser.picture ??
					null,

				'user',
			)
			.run();


		/* =================================================
		 * 15. Googleアカウントとの紐付けを保存
		 * ================================================= */

		await env.DB
			.prepare(`
				INSERT INTO user_identities (
					id,
					user_id,
					provider,
					provider_user_id,
					created_at
				)
				VALUES (
					?,
					?,
					?,
					?,
					datetime('now')
				)
			`)
			.bind(
				crypto.randomUUID(),

				userId,

				'google',

				googleUser.sub,
			)
			.run();
	}


	/* =====================================================
	 * 16. ログインセッションを作成
	 * ================================================= */

	const sessionId =
		crypto.randomUUID();

	const expiresAt =
		new Date(
			Date.now() +
			1000 * 60 * 60 * 24 * 30,
		).toISOString();

	await env.DB
		.prepare(`
			INSERT INTO sessions (
				id,
				user_id,
				expires_at,
				created_at
			)
			VALUES (
				?,
				?,
				?,
				datetime('now')
			)
		`)
		.bind(
			sessionId,

			userId,

			expiresAt,
		)
		.run();


	/* =====================================================
	 * 17. セッションCookieを発行
	 * ===================================================== */

	const headers =
		new Headers();


	/* -----------------------------------------------------
	 * ログイン成功後はアカウントページへ移動
	 * ----------------------------------------------------- */

	headers.set(
		'Location',
		'/account/',
	);


	/* -----------------------------------------------------
	 * セッションCookie
	 * ----------------------------------------------------- */

	headers.append(
		'Set-Cookie',
		[
			`nug_session=${sessionId}`,
			'Path=/',
			'HttpOnly',
			'Secure',
			'SameSite=Lax',
			'Max-Age=2592000',
		].join('; '),
	);


	/* -----------------------------------------------------
	 * OAuth state Cookieを削除
	 * ----------------------------------------------------- */

	headers.append(
		'Set-Cookie',
		[
			'nug_oauth_state=',
			'Path=/',
			'HttpOnly',
			'Secure',
			'SameSite=Lax',
			'Max-Age=0',
		].join('; '),
	);


	/* =====================================================
	 * 18. アカウントページへリダイレクト
	 * ===================================================== */

	return new Response(null, {
		status: 302,

		headers,
	});
};