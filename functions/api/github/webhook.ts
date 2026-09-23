interface Env {
	DB: D1Database;
	GITHUB_WEBHOOK_SECRET: string;
}

interface PullRequestPayload {
	action?: string;

	repository?: {
		full_name?: string;
	};

	pull_request?: {
		number?: number;
		merged?: boolean;
		merge_commit_sha?: string | null;

		head?: {
			ref?: string;
			sha?: string;
			repo?: {
				full_name?: string;
			};
		};

		base?: {
			ref?: string;
			repo?: {
				full_name?: string;
			};
		};
	};
}

function json(
	data: unknown,
	status = 200,
	headers: Record<string, string> = {},
): Response {
	return new Response(JSON.stringify(data, null, 2), {
		status,
		headers: {
			'Content-Type': 'application/json; charset=utf-8',
			...headers,
		},
	});
}

function hexToBytes(hex: string): Uint8Array {
	if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
		throw new Error('Invalid hexadecimal signature.');
	}

	const bytes = new Uint8Array(hex.length / 2);

	for (let i = 0; i < bytes.length; i++) {
		bytes[i] = Number.parseInt(
			hex.slice(i * 2, i * 2 + 2),
			16,
		);
	}

	return bytes;
}

function constantTimeEqual(
	a: Uint8Array,
	b: Uint8Array,
): boolean {
	if (a.length !== b.length) {
		return false;
	}

	let result = 0;

	for (let i = 0; i < a.length; i++) {
		result |= a[i] ^ b[i];
	}

	return result === 0;
}

async function verifySignature(
	payload: string,
	signatureHeader: string,
	secret: string,
): Promise<boolean> {
	if (!signatureHeader.startsWith('sha256=')) {
		return false;
	}

	const signatureHex = signatureHeader.slice(
		'sha256='.length,
	);

	let providedSignature: Uint8Array;

	try {
		providedSignature = hexToBytes(signatureHex);
	} catch {
		return false;
	}

	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{
			name: 'HMAC',
			hash: 'SHA-256',
		},
		false,
		['sign'],
	);

	const expectedSignatureBuffer = await crypto.subtle.sign(
		'HMAC',
		key,
		new TextEncoder().encode(payload),
	);

	const expectedSignature = new Uint8Array(
		expectedSignatureBuffer,
	);

	return constantTimeEqual(
		providedSignature,
		expectedSignature,
	);
}

export const onRequestPost = async ({
	request,
	env,
}: {
	request: Request;
	env: Env;
}): Promise<Response> => {
	if (!env.DB) {
		return json(
			{
				ok: false,
				error: 'Database is not configured',
			},
			500,
		);
	}

	if (!env.GITHUB_WEBHOOK_SECRET) {
		return json(
			{
				ok: false,
				error: 'GitHub webhook secret is not configured',
			},
			500,
		);
	}

	const signature = request.headers.get(
		'x-hub-signature-256',
	);

	if (!signature) {
		return json(
			{
				ok: false,
				error: 'Missing GitHub webhook signature',
			},
			401,
		);
	}

	const payloadText = await request.text();

	const validSignature = await verifySignature(
		payloadText,
		signature,
		env.GITHUB_WEBHOOK_SECRET,
	);

	if (!validSignature) {
		return json(
			{
				ok: false,
				error: 'Invalid GitHub webhook signature',
			},
			401,
		);
	}

	let payload: PullRequestPayload;

	try {
		payload = JSON.parse(
			payloadText,
		) as PullRequestPayload;
	} catch {
		return json(
			{
				ok: false,
				error: 'Invalid JSON payload',
			},
			400,
		);
	}

	const event = request.headers.get(
		'x-github-event',
	);

	/*
	 * GitHub webhook registration時に送られるping。
	 * Secretの検証まで通っていれば正常。
	 */
	if (event === 'ping') {
		return json({
			ok: true,
			message: 'GitHub webhook ping received',
		});
	}

	/*
	 * pull_request以外のイベントは無視。
	 */
	if (event !== 'pull_request') {
		return json({
			ok: true,
			message: `Ignored GitHub event: ${event ?? 'unknown'}`,
		});
	}

	/*
	 * PRがclosedされたイベントだけ処理。
	 */
	if (payload.action !== 'closed') {
		return json({
			ok: true,
			message: `Ignored pull_request action: ${
				payload.action ?? 'unknown'
			}`,
		});
	}

	/*
	 * closedでもmergeされていない場合は、
	 * D1の状態を変更しない。
	 */
	if (payload.pull_request?.merged !== true) {
		return json({
			ok: true,
			message: 'Pull request was closed without being merged',
		});
	}

	/*
	 * 対象リポジトリを厳密に確認。
	 */
	const repository = payload.repository?.full_name;
	const expectedRepository = 'yuruys/nug-astro';

	if (repository !== expectedRepository) {
		return json(
			{
				ok: false,
				error: 'Unexpected GitHub repository',
			},
			400,
		);
	}

	const pullRequest = payload.pull_request;

	const headRepository =
		pullRequest.head?.repo?.full_name;

	const baseRepository =
		pullRequest.base?.repo?.full_name;

	const baseBranch =
		pullRequest.base?.ref;

	const branchName =
		pullRequest.head?.ref;

	/*
	 * PRのhead側も同じリポジトリであることを確認。
	 */
	if (headRepository !== expectedRepository) {
		return json(
			{
				ok: false,
				error: 'Unexpected pull request head repository',
			},
			400,
		);
	}

	/*
	 * mainへのmergeだけを対象にする。
	 */
	if (
		baseRepository !== expectedRepository ||
		baseBranch !== 'main'
	) {
		return json(
			{
				ok: false,
				error: 'Pull request was not merged into main',
			},
			400,
		);
	}

	/*
	 * NUGBACEのPublish APIが作成した
	 * nugbase/publish/<editRequestId>
	 * というブランチだけを対象にする。
	 */
	if (!branchName?.startsWith('nugbase/publish/')) {
		return json({
			ok: true,
			message:
				'Merged PR is not a NUGBASE publish request',
			branch: branchName ?? null,
		});
	}

	const editRequestId = branchName.slice(
		'nugbase/publish/'.length,
	);

	if (!editRequestId) {
		return json(
			{
				ok: false,
				error: 'Missing edit request ID in branch name',
			},
			400,
		);
	}

	/*
	 * D1から対象Edit Requestを取得。
	 */
	const editRequest = await env.DB.prepare(
		`
		SELECT
			id,
			page_id,
			revision_id,
			status
		FROM edit_requests
		WHERE id = ?
		`,
	)
		.bind(editRequestId)
		.first<{
			id: string;
			page_id: string;
			revision_id: string;
			status: string;
		}>();

	if (!editRequest) {
		return json(
			{
				ok: false,
				error: 'Edit request not found',
				editRequestId,
			},
			404,
		);
	}

	/*
	 * Webhookは再送される可能性があるため、
	 * published済みなら成功として扱う。
	 */
	if (editRequest.status === 'published') {
		return json({
			ok: true,
			message: 'Edit request is already published',
			editRequestId,
			status: 'published',
		});
	}

	/*
	 * Publish APIでpublishingになっているものだけ
	 * publishedへ進める。
	 */
	if (editRequest.status !== 'publishing') {
		return json(
			{
				ok: false,
				error:
					'Edit request is not in publishing state',
				editRequestId,
				status: editRequest.status,
			},
			409,
		);
	}

	const now = new Date().toISOString();

	const pullRequestNumber =
		pullRequest.number ?? null;

	const mergeCommitSha =
		pullRequest.merge_commit_sha ?? null;

	const auditMetadata = JSON.stringify({
		pull_request_number: pullRequestNumber,
		merge_commit_sha: mergeCommitSha,
		branch: branchName,
		repository,
	});

	/*
	 * D1を一括更新。
	 *
	 * 1. edit_request → published
	 * 2. wiki_page → published_revision_id更新
	 * 3. audit_logsへ記録
	 */
	try {
		await env.DB.batch([
			env.DB.prepare(
				`
				UPDATE edit_requests
				SET
					status = 'published',
					reviewed_at = COALESCE(reviewed_at, ?)
				WHERE id = ?
				  AND status = 'publishing'
				`,
			).bind(
				now,
				editRequestId,
			),

			env.DB.prepare(
				`
				UPDATE wiki_pages
				SET
					published_revision_id = ?,
					updated_at = ?
				WHERE id = ?
				`,
			).bind(
				editRequest.revision_id,
				now,
				editRequest.page_id,
			),

			env.DB.prepare(
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
				VALUES (?, NULL, ?, ?, ?, ?, ?)
				`,
			).bind(
				crypto.randomUUID(),
				'wiki.edit_request.published',
				'edit_request',
				editRequestId,
				auditMetadata,
				now,
			),
		]);
	} catch (error) {
		console.error(
			'Failed to finalize published edit request:',
			error,
		);

		return json(
			{
				ok: false,
				error:
					'Failed to finalize published edit request',
			},
			500,
		);
	}

	return json({
		ok: true,
		message: 'Edit request published successfully',
		editRequestId,
		status: 'published',
		pageId: editRequest.page_id,
		revisionId: editRequest.revision_id,
		pullRequestNumber,
		mergeCommitSha,
	});
};