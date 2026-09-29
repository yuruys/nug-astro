import { requireAdmin } from '../../_auth';

type ServerRow = {
	id: number;
	slug: string;
	name: string;
	description: string | null;
	enabled: number;
	created_at: string;
	updated_at: string;
};

type UpdateServerBody = {
	name?: unknown;
	description?: unknown;
	enabled?: unknown;
};

export const onRequestPut: PagesFunction<Env> = async (context) => {
	try {
		const auth = await requireAdmin(context.request, context.env);

		if (!auth.ok) {
			return auth.response;
		}

		const id = Number(context.params.id);

		if (!Number.isInteger(id) || id <= 0) {
			return Response.json(
				{
					ok: false,
					error: 'Invalid server id',
				},
				{ status: 400 },
			);
		}

		let body: UpdateServerBody;

		try {
			body = (await context.request.json()) as UpdateServerBody;
		} catch {
			return Response.json(
				{
					ok: false,
					error: 'Invalid JSON',
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

		const name = body.name.trim();

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

		let enabled = 1;

		if (body.enabled !== undefined) {
			if (
				body.enabled !== 0 &&
				body.enabled !== 1 &&
				body.enabled !== false &&
				body.enabled !== true
			) {
				return Response.json(
					{
						ok: false,
						error: 'enabled must be a boolean or 0/1',
					},
					{ status: 400 },
				);
			}

			enabled =
				body.enabled === true || body.enabled === 1
					? 1
					: 0;
		}

		const currentServer = await context.env.DB
			.prepare(
				`
					SELECT
						id,
						slug,
						name,
						description,
						enabled,
						created_at,
						updated_at
					FROM servers
					WHERE id = ?
					LIMIT 1
				`,
			)
			.bind(id)
			.first<ServerRow>();

		if (!currentServer) {
			return Response.json(
				{
					ok: false,
					error: 'Server not found',
				},
				{ status: 404 },
			);
		}

		const now = new Date().toISOString();
		const auditLogId = crypto.randomUUID();

		await context.env.DB.batch([
			context.env.DB
				.prepare(
					`
						UPDATE servers
						SET
							name = ?,
							description = ?,
							enabled = ?,
							updated_at = ?
						WHERE id = ?
					`,
				)
				.bind(
					name,
					description,
					enabled,
					now,
					id,
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
					'admin.server.update',
					'server',
					String(id),
					JSON.stringify({
						id,
						slug: currentServer.slug,
						before: {
							name: currentServer.name,
							description: currentServer.description,
							enabled: currentServer.enabled,
						},
						after: {
							name,
							description,
							enabled,
						},
					}),
					now,
				),
		]);

		const updatedServer = await context.env.DB
			.prepare(
				`
					SELECT
						id,
						slug,
						name,
						description,
						enabled,
						created_at,
						updated_at
					FROM servers
					WHERE id = ?
					LIMIT 1
				`,
			)
			.bind(id)
			.first<ServerRow>();

		if (!updatedServer) {
			return Response.json(
				{
					ok: false,
					error: 'Failed to retrieve updated server',
				},
				{ status: 500 },
			);
		}

		return Response.json({
			ok: true,
			server: updatedServer,
		});
	} catch (error) {
		console.error('Failed to update server:', error);

		return Response.json(
			{
				ok: false,
				error: 'Internal server error',
			},
			{ status: 500 },
		);
	}
};