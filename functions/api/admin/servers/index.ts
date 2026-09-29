import { requireAdmin } from '../_auth';

type ServerRow = {
	id: number;
	slug: string;
	name: string;
	description: string | null;
	enabled: number;
	article_count: number;
	created_at: string;
	updated_at: string;
};

type CreateServerBody = {
	slug?: unknown;
	name?: unknown;
	description?: unknown;
};

export const onRequestGet: PagesFunction<Env> = async (context) => {
	try {
		const auth = await requireAdmin(context.request, context.env);

		if (!auth.ok) {
			return auth.response;
		}

		const result = await context.env.DB
			.prepare(
				`
					SELECT
						s.id,
						s.slug,
						s.name,
						s.description,
						s.enabled,
						COUNT(
							CASE
								WHEN a.status != 'deleted' THEN a.id
								ELSE NULL
							END
						) AS article_count,
						s.created_at,
						s.updated_at
					FROM servers AS s
					LEFT JOIN articles AS a
						ON a.server_id = s.id
					GROUP BY
						s.id,
						s.slug,
						s.name,
						s.description,
						s.enabled,
						s.created_at,
						s.updated_at
					ORDER BY s.name ASC, s.id ASC
				`,
			)
			.all<ServerRow>();

		return Response.json({
			ok: true,
			servers: result.results,
		});
	} catch (error) {
		console.error('Failed to fetch servers:', error);

		return Response.json(
			{
				ok: false,
				error: 'Internal server error',
			},
			{ status: 500 },
		);
	}
};

export const onRequestPost: PagesFunction<Env> = async (context) => {
	try {
		const auth = await requireAdmin(context.request, context.env);

		if (!auth.ok) {
			return auth.response;
		}

		let body: CreateServerBody;

		try {
			body = (await context.request.json()) as CreateServerBody;
		} catch {
			return Response.json(
				{
					ok: false,
					error: 'Invalid JSON',
				},
				{ status: 400 },
			);
		}

		if (typeof body.slug !== 'string') {
			return Response.json(
				{
					ok: false,
					error: 'slug is required',
				},
				{ status: 400 },
			);
		}

		if (typeof body.name !== 'string') {
			return Response.json(
				{
					ok: false,
					error: 'name is required',
				},
				{ status: 400 },
			);
		}

		const slug = body.slug.trim();
		const name = body.name.trim();

		if (!slug) {
			return Response.json(
				{
					ok: false,
					error: 'slug is required',
				},
				{ status: 400 },
			);
		}

		if (!name) {
			return Response.json(
				{
					ok: false,
					error: 'name is required',
				},
				{ status: 400 },
			);
		}

		let description: string | null = null;

		if (body.description !== undefined && body.description !== null) {
			if (typeof body.description !== 'string') {
				return Response.json(
					{
						ok: false,
						error: 'description must be a string',
					},
					{ status: 400 },
				);
			}

			description = body.description.trim() || null;
		}

		const now = new Date().toISOString();
		const auditLogId = crypto.randomUUID();

		try {
			await context.env.DB.batch([
				context.env.DB
					.prepare(
						`
							INSERT INTO servers (
								slug,
								name,
								description,
								enabled,
								created_at,
								updated_at
							)
							VALUES (?, ?, ?, 1, ?, ?)
						`,
					)
					.bind(
						slug,
						name,
						description,
						now,
						now,
					),

				context.env.DB
					.prepare(
						`
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
						`,
					)
					.bind(
						auditLogId,
						auth.user.id,
						'admin.server.create',
						'server',
						slug,
						JSON.stringify({
							slug,
							name,
						}),
						now,
					),
			]);
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error);

			if (
				message.includes('UNIQUE constraint failed') &&
				message.includes('servers.slug')
			) {
				return Response.json(
					{
						ok: false,
						error: 'A server with this slug already exists',
					},
					{ status: 409 },
				);
			}

			throw error;
		}

		const createdServer = await context.env.DB
			.prepare(
				`
					SELECT
						s.id,
						s.slug,
						s.name,
						s.description,
						s.enabled,
						COUNT(
							CASE
								WHEN a.status != 'deleted' THEN a.id
								ELSE NULL
							END
						) AS article_count,
						s.created_at,
						s.updated_at
					FROM servers AS s
					LEFT JOIN articles AS a
						ON a.server_id = s.id
					WHERE s.slug = ?
					GROUP BY
						s.id,
						s.slug,
						s.name,
						s.description,
						s.enabled,
						s.created_at,
						s.updated_at
					LIMIT 1
				`,
			)
			.bind(slug)
			.first<ServerRow>();

		if (!createdServer) {
			return Response.json(
				{
					ok: false,
					error: 'Failed to retrieve created server',
				},
				{ status: 500 },
			);
		}

		return Response.json(
			{
				ok: true,
				server: createdServer,
			},
			{ status: 201 },
		);
	} catch (error) {
		console.error('Failed to create server:', error);

		return Response.json(
			{
				ok: false,
				error: 'Internal server error',
			},
			{ status: 500 },
		);
	}
};