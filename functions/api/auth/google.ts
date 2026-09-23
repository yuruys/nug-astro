export const onRequestGet: PagesFunction<{
	DB: D1Database;
	GOOGLE_CLIENT_ID: string;
}> = async ({ request, env }) => {
	const url = new URL(request.url);

	const state = crypto.randomUUID();

	const googleAuthUrl = new URL(
		'https://accounts.google.com/o/oauth2/v2/auth',
	);

	googleAuthUrl.searchParams.set(
		'client_id',
		env.GOOGLE_CLIENT_ID,
	);

	googleAuthUrl.searchParams.set(
		'redirect_uri',
		`${url.origin}/api/auth/google/callback`,
	);

	googleAuthUrl.searchParams.set(
		'response_type',
		'code',
	);

	googleAuthUrl.searchParams.set(
		'scope',
		'openid email profile',
	);

	googleAuthUrl.searchParams.set(
		'access_type',
		'offline',
	);

	googleAuthUrl.searchParams.set(
		'state',
		state,
	);

	const headers = new Headers();

	headers.set(
		'Location',
		googleAuthUrl.toString(),
	);

	headers.append(
		'Set-Cookie',
		`nug_oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
	);

	return new Response(null, {
		status: 302,
		headers,
	});
};