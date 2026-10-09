type PublicServer = {
	slug: string;
	name: string;
	description: string | null;
};

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
	try {
		const result = await env.DB
			.prepare(`
				SELECT slug, name, description
				FROM servers
				WHERE enabled = 1
				ORDER BY id ASC
			`)
			.all<PublicServer>();

		return Response.json(
			{
				ok: true,
				servers: result.results,
			},
			{
				headers: {
					'Cache-Control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=30',
				},
			},
		);
	} catch (error) {
		console.error('Failed to fetch public servers:', error);

		return Response.json(
			{
				ok: false,
				error: 'Internal server error',
			},
			{
				status: 500,
				headers: {
					'Cache-Control': 'no-store',
				},
			},
		);
	}
};