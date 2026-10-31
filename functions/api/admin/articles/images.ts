import { requireAdmin } from '../_auth';

const GITHUB_API = 'https://api.github.com/repos/yuruys/nug-astro';
const GITHUB_BRANCH = 'main';
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;

type ImageFormat = {
	extension: 'jpg' | 'png' | 'gif' | 'webp';
};

function json(data: unknown, status = 200): Response {
	return Response.json(data, { status });
}

function detectImageFormat(bytes: Uint8Array): ImageFormat | null {
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		return { extension: 'jpg' };
	}
	if (
		bytes.length >= 8
		&& bytes[0] === 0x89
		&& bytes[1] === 0x50
		&& bytes[2] === 0x4e
		&& bytes[3] === 0x47
		&& bytes[4] === 0x0d
		&& bytes[5] === 0x0a
		&& bytes[6] === 0x1a
		&& bytes[7] === 0x0a
	) {
		return { extension: 'png' };
	}
	if (
		bytes.length >= 6
		&& bytes[0] === 0x47
		&& bytes[1] === 0x49
		&& bytes[2] === 0x46
		&& bytes[3] === 0x38
		&& (bytes[4] === 0x37 || bytes[4] === 0x39)
		&& bytes[5] === 0x61
	) {
		return { extension: 'gif' };
	}
	if (
		bytes.length >= 12
		&& bytes[0] === 0x52
		&& bytes[1] === 0x49
		&& bytes[2] === 0x46
		&& bytes[3] === 0x46
		&& bytes[8] === 0x57
		&& bytes[9] === 0x45
		&& bytes[10] === 0x42
		&& bytes[11] === 0x50
	) {
		return { extension: 'webp' };
	}
	return null;
}

function encodeBase64(bytes: Uint8Array): string {
	let binary = '';
	for (let offset = 0; offset < bytes.length; offset += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
	}
	return btoa(binary);
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
	const auth = await requireAdmin(context.request, context.env);
	if (!auth.ok) return auth.response;

	const contentLength = Number(context.request.headers.get('Content-Length'));
	if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_SIZE + 64 * 1024) {
		return json({ ok: false, error: '画像は5MB以下にしてください。' }, 413);
	}

	let form: FormData;
	try {
		form = await context.request.formData();
	} catch {
		return json({ ok: false, error: '画像ファイルを読み取れませんでした。' }, 400);
	}
	const file = form.get('file');
	if (!(file instanceof File)) return json({ ok: false, error: '画像ファイルを選択してください。' }, 400);
	if (file.size === 0) return json({ ok: false, error: '空のファイルはアップロードできません。' }, 400);
	if (file.size > MAX_IMAGE_SIZE) return json({ ok: false, error: '画像は5MB以下にしてください。' }, 413);

	let bytes: Uint8Array;
	try {
		bytes = new Uint8Array(await file.arrayBuffer());
	} catch (error) {
		console.error('Failed to read article image upload:', error);
		return json({ ok: false, error: '画像ファイルを読み取れませんでした。' }, 400);
	}
	const format = detectImageFormat(bytes);
	if (!format) return json({ ok: false, error: 'JPEG、PNG、GIF、WebP形式の画像を選択してください。' }, 415);
	if (!context.env.GITHUB_TOKEN) return json({ ok: false, error: 'GitHub連携が設定されていません。' }, 500);

	const imagePath = `public/images/articles/${crypto.randomUUID()}.${format.extension}`;
	try {
		const response = await fetch(`${GITHUB_API}/contents/${imagePath}`, {
			method: 'PUT',
			headers: {
				Authorization: `Bearer ${context.env.GITHUB_TOKEN}`,
				Accept: 'application/vnd.github+json',
				'X-GitHub-Api-Version': '2022-11-28',
				'User-Agent': 'NUGBASE',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				message: 'content: add article image',
				content: encodeBase64(bytes),
				branch: GITHUB_BRANCH,
			}),
			signal: AbortSignal.timeout(20_000),
		});
		if (!response.ok) {
			console.error(`GitHub article image upload failed (${response.status}):`, (await response.text()).slice(0, 200));
			return json({ ok: false, error: 'GitHubへの画像保存に失敗しました。' }, 502);
		}
	} catch (error) {
		console.error('GitHub article image upload failed:', error);
		return json({ ok: false, error: 'GitHubへの画像保存結果を確認できませんでした。' }, 502);
	}

	return json({
		ok: true,
		url: `/${imagePath.slice('public/'.length)}`,
	});
};
