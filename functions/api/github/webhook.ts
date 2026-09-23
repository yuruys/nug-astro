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

/* =========================================================
   JSON Response
   ========================================================= */

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

/* =========================================================
   Hexadecimal → Uint8Array
   ========================================================= */

function hexToBytes(hex: string): Uint8Array {
	if (
		!/^[0-9a-fA-F]+$/.test(hex) ||
		hex.length % 2 !== 0
	) {
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

/* =========================================================
   Constant-Time Comparison
   ========================================================= */

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

/* =========================================================
   GitHub Webhook Signature Verification
   ========================================================= */

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

	const expectedSignatureBuffer =
		await crypto.subtle.sign(
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

/* =========================================================
   POST /api/github/webhook
   ========================================================= */

export const onRequestPost = async ({
	request,
	env,
}: {
	request: Request;
	env: Env;
}): Promise<Response> => {
	/*
	 * -------------------------------------------------------
	 * 01. Webhook Secret確認
	 * -------------------------------------------------------
	 *
	 * pingも署名検証が必要なので、
	 * Secretだけは最初に確認する。
	 *
	 * D1はここでは確認しない。
	 * GitHubのping処理にはD1が不要だから。
	 */
	if (!env.GITHUB_WEBHOOK_SECRET) {
		return json(
			{
				ok: false,
				error:
					'GitHub webhook secret is not configured',
			},
			500,
		);
	}

	/*
	 * -------------------------------------------------------
	 * 02. GitHub Signature取得
	 * -------------------------------------------------------
	 */

	const signature = request.headers.get(
		'x-hub-signature-256',
	);

	if (!signature) {
		return json(
			{
				ok: false,
				error:
					'Missing GitHub webhook signature',
			},
			401,
		);
	}

	/*
	 * -------------------------------------------------------
	 * 03. Request Body取得
	 * -------------------------------------------------------
	 *
	 * GitHub署名は生のRequest Bodyに対して計算されている。
	 * JSON.parse()する前の文字列をそのまま使用する。
	 */

	const payloadText = await request.text();

	/*
	 * -------------------------------------------------------
	 * 04. Signature検証
	 * -------------------------------------------------------
	 */

	let validSignature = false;

	try {
		validSignature = await verifySignature(
			payloadText,
			signature,
			env.GITHUB_WEBHOOK_SECRET,
		);
	} catch (error) {
		console.error(
			'GitHub webhook signature verification failed:',
			error,
		);

		return json(
			{
				ok: false,
				error:
					'GitHub webhook signature verification failed',
			},
			500,
		);
	}

	if (!validSignature) {
		return json(
			{
				ok: false,
				error:
					'Invalid GitHub webhook signature',
			},
			401,
		);
	}

	/*
	 * -------------------------------------------------------
	 * 05. JSON Parse
	 * -------------------------------------------------------
	 */

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

	/*
	 * -------------------------------------------------------
	 * 06. GitHub Event判定
	 * -------------------------------------------------------
	 */

	const event = request.headers.get(
		'x-github-event',
	);

	/*
	 * -------------------------------------------------------
	 * 07. GitHub ping
	 * -------------------------------------------------------
	 *
	 * Webhook登録時・再送時などにGitHubから送られる。
	 *
	 * ここではD1を一切使用しない。
	 */
	if (event === 'ping') {
		return json({
			ok: true,
			message:
				'GitHub webhook ping received',
		});
	}

	/*
	 * -------------------------------------------------------
	 * 08. pull_request以外は無視
	 * -------------------------------------------------------
	 */

	if (event !== 'pull_request') {
		return json({
			ok: true,
			message:
				`Ignored GitHub event: ${
					event ?? 'unknown'
				}`,
		});
	}

	/*
	 * -------------------------------------------------------
	 * 09. pull_requestイベントではD1が必要
	 * -------------------------------------------------------
	 */

	if (!env.DB) {
		return json(
			{
				ok: false,
				error: 'Database is not configured',
			},
			500,
		);
	}

	/*
	 * -------------------------------------------------------
	 * 10. closedイベントだけ処理
	 * -------------------------------------------------------
	 */

	if (payload.action !== 'closed') {
		return json({
			ok: true,
			message:
				`Ignored pull_request action: ${
					payload.action ?? 'unknown'
				}`,
		});
	}

	/*
	 * -------------------------------------------------------
	 * 11. Mergeされているか確認
	 * -------------------------------------------------------
	 *
	 * closedでもmerged !== trueなら、
	 * 単純にPRが閉じられただけなので、
	 * D1の状態は変更しない。
	 */

	if (payload.pull_request?.merged !== true) {
		return json({
			ok: true,
			message:
				'Pull request was closed without being merged',
		});
	}

	/*
	 * -------------------------------------------------------
	 * 12. Repository確認
	 * -------------------------------------------------------
	 */

	const repository =
		payload.repository?.full_name;

	const expectedRepository =
		'yuruys/nug-astro';

	if (repository !== expectedRepository) {
		return json(
			{
				ok: false,
				error:
					'Unexpected GitHub repository',
			},
			400,
		);
	}

	/*
	 * -------------------------------------------------------
	 * 13. Pull Request情報取得
	 * -------------------------------------------------------
	 */

	const pullRequest =
		payload.pull_request;

	const headRepository =
		pullRequest.head?.repo?.full_name;

	const baseRepository =
		pullRequest.base?.repo?.full_name;

	const baseBranch =
		pullRequest.base?.ref;

	const branchName =
		pullRequest.head?.ref;

	/*
	 * -------------------------------------------------------
	 * 14. Head Repository確認
	 * -------------------------------------------------------
	 *
	 * 外部ForkからのPRを対象外にする。
	 */

	if (
		headRepository !==
		expectedRepository
	) {
		return json(
			{
				ok: false,
				error:
					'Unexpected pull request head repository',
			},
			400,
		);
	}

	/*
	 * -------------------------------------------------------
	 * 15. mainへのMergeか確認
	 * -------------------------------------------------------
	 */

	if (
		baseRepository !==
			expectedRepository ||
		baseBranch !== 'main'
	) {
		return json(
			{
				ok: false,
				error:
					'Pull request was not merged into main',
			},
			400,
		);
	}

	/*
	 * -------------------------------------------------------
	 * 16. NUGBACE Publish Branch確認
	 * -------------------------------------------------------
	 *
	 * Publish APIが作成するBranch:
	 *
	 * nugbase/publish/<editRequestId>
	 *
	 * これ以外の通常のGitHub PRは無視する。
	 */

	if (
		!branchName?.startsWith(
			'nugbase/publish/',
		)
	) {
		return json({
			ok: true,
			message:
				'Merged PR is not a NUGBASE publish request',
			branch:
				branchName ?? null,
		});
	}

	/*
	 * -------------------------------------------------------
	 * 17. Edit Request ID取得
	 * -------------------------------------------------------
	 */

	const editRequestId =
		branchName.slice(
			'nugbase/publish/'.length,
		);

	if (!editRequestId) {
		return json(
			{
				ok: false,
				error:
					'Missing edit request ID in branch name',
			},
			400,
		);
	}

	/*
	 * -------------------------------------------------------
	 * 18. D1からEdit Request取得
	 * -------------------------------------------------------
	 */

	const editRequest =
		await env.DB.prepare(
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
				error:
					'Edit request not found',
				editRequestId,
			},
			404,
		);
	}

	/*
	 * -------------------------------------------------------
	 * 19. 既にPublishedなら成功扱い
	 * -------------------------------------------------------
	 *
	 * GitHub Webhookは再送される可能性がある。
	 * そのためpublished済みなら冪等的に成功を返す。
	 */

	if (
		editRequest.status ===
		'published'
	) {
		return json({
			ok: true,
			message:
				'Edit request is already published',
			editRequestId,
			status: 'published',
		});
	}

	/*
	 * -------------------------------------------------------
	 * 20. publishing状態か確認
	 * -------------------------------------------------------
	 *
	 * Publish APIによって
	 *
	 * approved → publishing
	 *
	 * となったEdit Requestだけを
	 * publishedへ進める。
	 */

	if (
		editRequest.status !==
		'publishing'
	) {
		return json(
			{
				ok: false,
				error:
					'Edit request is not in publishing state',
				editRequestId,
				status:
					editRequest.status,
			},
			409,
		);
	}

	/*
	 * -------------------------------------------------------
	 * 21. Audit Metadata
	 * -------------------------------------------------------
	 */

	const now =
		new Date().toISOString();

	const pullRequestNumber =
		pullRequest.number ?? null;

	const mergeCommitSha =
		pullRequest.merge_commit_sha ??
		null;

	const auditMetadata =
		JSON.stringify({
			pull_request_number:
				pullRequestNumber,

			merge_commit_sha:
				mergeCommitSha,

			branch:
				branchName,

			repository,
		});

	/*
	 * -------------------------------------------------------
	 * 22. D1 Finalize
	 * -------------------------------------------------------
	 *
	 * 1. edit_request
	 *    publishing → published
	 *
	 * 2. wiki_pages
	 *    published_revision_id更新
	 *
	 * 3. audit_logs
	 *    published記録
	 *
	 * D1 batch()を使用するため、
	 * これらを1つのトランザクションとして処理する。
	 */

	try {
		await env.DB.batch([
			/*
			 * Edit Request
			 */
			env.DB.prepare(
				`
				UPDATE edit_requests
				SET
					status = 'published',
					reviewed_at =
						COALESCE(
							reviewed_at,
							?
						)
				WHERE id = ?
				  AND status = 'publishing'
				`,
			).bind(
				now,
				editRequestId,
			),

			/*
			 * Wiki Page
			 */
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

			/*
			 * Audit Log
			 */
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
				VALUES (
					?,
					NULL,
					?,
					?,
					?,
					?,
					?
				)
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

	/*
	 * -------------------------------------------------------
	 * 23. 完了
	 * -------------------------------------------------------
	 */

	return json({
		ok: true,
		message:
			'Edit request published successfully',

		editRequestId,

		status: 'published',

		pageId:
			editRequest.page_id,

		revisionId:
			editRequest.revision_id,

		pullRequestNumber,

		mergeCommitSha,
	});
};