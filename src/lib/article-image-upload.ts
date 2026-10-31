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

	button.addEventListener('click', () => {
		if (!uploading) input.click();
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
			const offset = editor.selectionStart;
			const prefix = offset > 0 && editor.value[offset - 1] !== '\n' ? '\n' : '';
			const markdown = `${prefix}![${altText}](${result.url})\n`;
			editor.value = `${editor.value.slice(0, offset)}${markdown}${editor.value.slice(offset)}`;
			editor.focus();
			editor.setSelectionRange(offset + markdown.length, offset + markdown.length);
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
