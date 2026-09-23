export const onRequestPost: PagesFunction<{
	DB: D1Database;
}> = async ({ request, env }) => {
	const cookie = request.headers.get('Cookie');

	if (cookie) {
		const sessionMatch = cookie.match(
			/(?:^|;\s*)nug_session=([^;]+)/,
		);

		if (sessionMatch) {
			const sessionId = sessionMatch[1];

			await env.DB
				.prepare(`
					DELETE FROM sessions
					WHERE id = ?
				`)
				.bind(sessionId)
				.run();
		}
	}

	return new Response(
		JSON.stringify({
			ok: true,
		}),
		{
			status: 200,
			headers: {
				'Content-Type':
					'application/json; charset=utf-8',
				'Set-Cookie':
					'nug_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
			},
		},
	);
};