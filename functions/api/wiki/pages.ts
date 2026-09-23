interface Env {
	DB: D1Database;
}

export const onRequestGet: PagesFunction<Env> = async ({
	env,
	request,
}) => {
	try {
		const url = new URL(request.url);
		const path = url.searchParams.get('path');

		if (path) {
			const result = await env.DB.prepare(`
				SELECT
					p.path,
					p.title,
					p.source_path,
					r.revision_number,
					r.content,
					r.created_at AS revision_created_at
				FROM wiki_pages p
				LEFT JOIN wiki_revisions r
					ON r.id = p.published_revision_id
				WHERE p.path = ?
				LIMIT 1
			`)
				.bind(path)
				.first();

			if (!result) {
				return Response.json(
					{
						ok: false,
						error: 'Wiki page not found',
					},
					{ status: 404 }
				);
			}

			return Response.json({
				ok: true,
				page: result,
			});
		}

		const result = await env.DB.prepare(`
			SELECT
				p.path,
				p.title,
				p.source_path,
				r.revision_number,
				r.created_at AS revision_created_at
			FROM wiki_pages p
			LEFT JOIN wiki_revisions r
				ON r.id = p.published_revision_id
			ORDER BY p.path ASC
		`).all();

		return Response.json({
			ok: true,
			pages: result.results,
		});
	} catch (error) {
		console.error('Wiki pages API error:', error);

		return Response.json(
			{
				ok: false,
				error: 'Internal server error',
			},
			{ status: 500 }
		);
	}
};