import { onRequestPost as submitWikiRequest } from '../../edit-requests/[id]/publish';

export const onRequestPost: PagesFunction<Env> = async (context) => {
	const id = context.params.id;
	if (!id) {
		return Response.json(
			{ ok: false, error: '下書きIDが必要です。' },
			{ status: 400 },
		);
	}

	return submitWikiRequest({
		request: context.request,
		env: context.env,
		params: { id },
	});
};
