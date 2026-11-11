import { requireAdmin } from '../../api/admin/_auth';

export const onRequestGet: PagesFunction<Env> = async (context) => {
	const auth = await requireAdmin(context.request, context.env);
	if (!auth.ok) {
		return new Response('このページは管理者専用です。管理者アカウントでログインしてください。', {
			status: auth.response.status,
			headers: {
				'Cache-Control': 'no-store',
				'Content-Type': 'text/plain; charset=utf-8',
			},
		});
	}

	return context.next();
};
