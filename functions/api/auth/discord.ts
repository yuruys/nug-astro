import { createReturnToCookie } from './_return-to';

export const onRequestGet: PagesFunction<{
	DISCORD_CLIENT_ID: string;
}> = async ({ request, env }) => {
	if (!env.DISCORD_CLIENT_ID) {
		return new Response('Discordログインの設定がありません。サイト管理者にお問い合わせください。', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
	}

	const url = new URL(request.url);
	const state = crypto.randomUUID();
	const authUrl = new URL('https://discord.com/oauth2/authorize');
	authUrl.searchParams.set('client_id', env.DISCORD_CLIENT_ID);
	authUrl.searchParams.set('redirect_uri', `${url.origin}/api/auth/discord/callback`);
	authUrl.searchParams.set('response_type', 'code');
	authUrl.searchParams.set('scope', 'identify');
	authUrl.searchParams.set('state', state);

	const headers = new Headers({
		Location: authUrl.toString(),
		'Cache-Control': 'no-store',
	});
	headers.append('Set-Cookie', `nug_discord_oauth_state_${state}=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
	const returnToCookie = createReturnToCookie(state, url.searchParams.get('returnTo'));
	if (returnToCookie) headers.append('Set-Cookie', returnToCookie);

	return new Response(null, {
		status: 302,
		headers,
	});
};
