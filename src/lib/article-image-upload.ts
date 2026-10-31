type UploadResult = {
	ok?: boolean;
	error?: string;
	url?: string;
};

export function setupArticleImageUpload(
	editor: HTMLTextAreaElement,
	button: HTMLButtonElement,
	input: HTMLInputElement,
	status: HTMLElement,
): { isUploading: () => boolean } {
	let uploading = false;
	let selectionStart = editor.selectionStart;

	button.addEventListener('click', () => {
		if (!uploading) {
			selectionStart = editor.selectionStart;
			input.click();
		}
	});

	input.addEventListener('change', async () => {
		const file = input.files?.[0];
		if (!file || uploading) return;

		uploading = true;
		button.disabled = true;
		status.textContent = '画像をアップロードしています…';
		try {
			const form = new FormData();
			form.append('file', file, file.name);
			const response = await fetch('/api/admin/articles/images', {
				method: 'POST',
				credentials: 'same-origin',
				body: form,
			});
			let result: UploadResult = {};
			try {
				result = await response.json() as UploadResult;
			} catch {
				// Use the HTTP status when the server response is not JSON.
			}
			if (!response.ok || !result.ok) {
				if (response.status === 401) throw new Error('未認証です。管理者として再ログインしてください。');
				if (response.status === 403) throw new Error('画像をアップロードする権限がありません。');
				throw new Error(result.error || `画像のアップロードに失敗しました（${response.status}）。`);
			}
			if (!result.url || !result.url.startsWith('/images/articles/')) {
				throw new Error('アップロード応答の画像パスが不正です。');
			}

			const altText = file.name
				.replace(/\.[^.]+$/, '')
				.replaceAll('\\', '\\\\')
				.replaceAll(']', '\\]')
				.replace(/[\r\n]/g, ' ')
				.trim() || '記事画像';
			const offset = selectionStart;
			const before = editor.value.slice(0, offset);
			const after = editor.value.slice(offset);
			const prefix = !before || before.endsWith('\n\n')
				? ''
				: before.endsWith('\n')
					? '\n'
					: '\n\n';
			const suffix = !after || after.startsWith('\n\n')
				? ''
				: after.startsWith('\n')
					? '\n'
					: '\n\n';
			const markdown = `![${altText}](${result.url})`;
			const insertion = `${prefix}${markdown}${suffix}`;
			editor.value = `${before}${insertion}${after}`;
			editor.focus();
			const cursor = offset + insertion.length;
			editor.setSelectionRange(cursor, cursor);
			editor.dispatchEvent(new Event('input', { bubbles: true }));
			status.textContent = '画像を本文に挿入しました。';
		} catch (error) {
			status.textContent = error instanceof Error ? error.message : '画像のアップロードに失敗しました。';
		} finally {
			uploading = false;
			button.disabled = false;
			input.value = '';
		}
	});

	return { isUploading: () => uploading };
}
