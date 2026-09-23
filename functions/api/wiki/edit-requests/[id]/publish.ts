/*
 * NUGBACE Wiki Publish
 *
 * approved
 *   ↓
 * publishing
 *   ↓
 * GitHub branch
 *   ↓
 * GitHub Contents API
 *   ↓
 * Commit
 *   ↓
 * Pull Request
 *
 * Pull Request が main に Merge されるまで、
 * D1 の edit_request は publishing のまま。
 *
 * Cloudflare Pages Functions 用。
 */

/* =========================================================
   01. Function-local types
   ========================================================= */

interface D1PreparedStatementLike {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	bind(...values: any[]): D1PreparedStatementLike;

	first<T = Record<string, unknown>>(
		colName?: string,
	): Promise<T | null>;

	run(): Promise<{
		meta: {
			changes: number;
		};
	}>;

	all<T = Record<string, unknown>>(): Promise<{
		results: T[];
		meta: Record<string, unknown>;
	}>;
}

interface D1DatabaseLike {
	prepare(
		query: string,
	): D1PreparedStatementLike;

	batch(
		statements: D1PreparedStatementLike[],
	): Promise<unknown[]>;
}

interface Env {
	DB: D1DatabaseLike;
	GITHUB_TOKEN: string;
}

interface PagesFunctionContext {
	request: Request;
	env: Env;
	params: Record<string, string | string[]>;
}

interface SessionUser {
	session_id: string;
	user_id: string;
	display_name: string;
	role: string;
	expires_at: string;
}

interface EditRequestRow {
	id: string;
	page_id: string;
	revision_id: string;
	base_revision_id: string | null;
	user_id: string;
	status: string;
	message: string | null;
	reviewer_id: string | null;
	review_comment: string | null;
	created_at: string;
	reviewed_at: string | null;

	page_path: string;
	page_title: string;
	source_path: string;
	published_revision_id:
		| string
		| null;
}

interface RevisionRow {
	id: string;
	page_id: string;
	revision_number: number;
	content: string;
	editor_id: string;
	created_at: string;
}

interface GitHubBranchResponse {
	name?: string;

	commit?: {
		sha?: string;
		url?: string;
	};
}

interface GitHubFileResponse {
	name?: string;
	path?: string;
	sha?: string;
	html_url?: string;
}

interface GitHubCommitResponse {
	sha?: string;
	html_url?: string;
}

interface GitHubPullRequestResponse {
	number?: number;
	title?: string;
	state?: string;
	html_url?: string;

	head?: {
		ref?: string;
		sha?: string;
	};

	base?: {
		ref?: string;
		sha?: string;
	};
}

interface GitHubErrorResponse {
	message?: string;
	documentation_url?: string;
}

/* =========================================================
   02. Constants
   ========================================================= */

const GITHUB_OWNER =
	'yuruys';

const GITHUB_REPOSITORY =
	'nug-astro';

const GITHUB_BASE_BRANCH =
	'main';

/* =========================================================
   03. JSON helper
   ========================================================= */

function json(
	data: unknown,
	status = 200,
): Response {
	return new Response(
		JSON.stringify(data, null, 2),
		{
			status,
			headers: {
				'Content-Type':
					'application/json; charset=utf-8',
			},
		},
	);
}

/* =========================================================
   04. GitHub headers
   ========================================================= */

function githubHeaders(
	token: string,
): HeadersInit {
	return {
		Authorization:
			`Bearer ${token}`,

		Accept:
			'application/vnd.github+json',

		'X-GitHub-Api-Version':
			'2022-11-28',

		'User-Agent':
			'NUGBACE',
	};
}

/* =========================================================
   05. Session
   ========================================================= */

function getSessionId(
	request: Request,
): string | null {
	const cookie =
		request.headers.get(
			'Cookie',
		);

	if (!cookie) {
		return null;
	}

	const cookies =
		cookie.split(';');

	for (const item of cookies) {
		const [
			name,
			...valueParts
		] = item
			.trim()
			.split('=');

		const value =
			valueParts.join('=');

		if (
			name === 'nug_session' ||
			name === 'session' ||
			name === 'session_id'
		) {
			return decodeURIComponent(
				value,
			);
		}
	}

	return null;
}

async function getSessionUser(
	request: Request,
	env: Env,
): Promise<SessionUser | null> {
	const sessionId =
		getSessionId(request);

	if (!sessionId) {
		return null;
	}

	const session =
		await env.DB.prepare(`
			SELECT
				s.id AS session_id,
				s.user_id,
				s.expires_at,
				u.display_name,
				u.role
			FROM sessions s
			INNER JOIN users u
				ON u.id = s.user_id
			WHERE s.id = ?
			  AND s.expires_at >
					datetime('now')
			LIMIT 1
		`)
			.bind(sessionId)
			.first<SessionUser>();

	return session ?? null;
}

/* =========================================================
   06. Base64
   ========================================================= */

function uint8ArrayToBase64(
	bytes: Uint8Array,
): string {
	let binary = '';

	const chunkSize =
		0x8000;

	for (
		let i = 0;
		i < bytes.length;
		i += chunkSize
	) {
		const chunk =
			bytes.subarray(
				i,
				Math.min(
					i + chunkSize,
					bytes.length,
				),
			);

		binary +=
			String.fromCharCode(
				...chunk,
			);
	}

	return btoa(binary);
}

function encodeBase64(
	value: string,
): string {
	const bytes =
		new TextEncoder().encode(
			value,
		);

	return uint8ArrayToBase64(
		bytes,
	);
}

/* =========================================================
   07. GitHub error helper
   ========================================================= */

async function getGitHubError(
	response: Response,
): Promise<string | undefined> {
	try {
		const data =
			(await response.json()) as
				GitHubErrorResponse;

		return data.message;
	} catch {
		return undefined;
	}
}

/* =========================================================
   08. Cloudflare Pages Function
   ========================================================= */

export const onRequestPost =
	async ({
		env,
		request,
		params,
	}: PagesFunctionContext): Promise<Response> => {
		let editRequestId:
			| string
			| null = null;

		let currentUserId:
			| string
			| null = null;

		try {
			/* ------------------------------------------------
			   1. Authentication
			------------------------------------------------ */

			const user =
				await getSessionUser(
					request,
					env,
				);

			if (!user) {
				return json(
					{
						ok: false,
						error:
							'Unauthorized',
					},
					401,
				);
			}

			currentUserId =
				user.user_id;

			/* ------------------------------------------------
			   2. Admin only
			------------------------------------------------ */

			if (
				user.role !==
				'admin'
			) {
				return json(
					{
						ok: false,
						error:
							'Forbidden',
					},
					403,
				);
			}

			/* ------------------------------------------------
			   3. GitHub token
			------------------------------------------------ */

			if (!env.GITHUB_TOKEN) {
				return json(
					{
						ok: false,
						error:
							'GitHub integration is not configured',
					},
					500,
				);
			}

			/* ------------------------------------------------
			   4. Edit request ID
			------------------------------------------------ */

			const rawId =
				params.id;

			editRequestId =
				typeof rawId ===
				'string'
					? rawId
					: null;

			if (!editRequestId) {
				return json(
					{
						ok: false,
						error:
							'Edit request ID is required',
					},
					400,
				);
			}

			/* ------------------------------------------------
			   5. Edit request
			------------------------------------------------ */

			const editRequest =
				await env.DB.prepare(`
					SELECT
						er.id,
						er.page_id,
						er.revision_id,
						er.base_revision_id,
						er.user_id,
						er.status,
						er.message,
						er.reviewer_id,
						er.review_comment,
						er.created_at,
						er.reviewed_at,

						p.path AS page_path,
						p.title AS page_title,
						p.source_path,
						p.published_revision_id

					FROM edit_requests er

					INNER JOIN wiki_pages p
						ON p.id = er.page_id

					WHERE er.id = ?

					LIMIT 1
				`)
					.bind(
						editRequestId,
					)
					.first<EditRequestRow>();

			if (!editRequest) {
				return json(
					{
						ok: false,
						error:
							'Edit request not found',
					},
					404,
				);
			}

			/* ------------------------------------------------
			   6. approved only
			------------------------------------------------ */

			if (
				editRequest.status !==
				'approved'
			) {
				return json(
					{
						ok: false,
						error:
							'Only approved edit requests can be published',
						status:
							editRequest.status,
					},
					400,
				);
			}

			/* ------------------------------------------------
			   7. Revision
			------------------------------------------------ */

			const revision =
				await env.DB.prepare(`
					SELECT
						id,
						page_id,
						revision_number,
						content,
						editor_id,
						created_at
					FROM wiki_revisions
					WHERE id = ?
					LIMIT 1
				`)
					.bind(
						editRequest.revision_id,
					)
					.first<RevisionRow>();

			if (!revision) {
				return json(
					{
						ok: false,
						error:
							'Revision not found',
					},
					404,
				);
			}

			if (
				revision.page_id !==
				editRequest.page_id
			) {
				return json(
					{
						ok: false,
						error:
							'Revision does not belong to the requested page',
					},
					409,
				);
			}

			/* ------------------------------------------------
			   8. Current published revision
			------------------------------------------------ */

			let publishedRevision:
				RevisionRow | null =
				null;

			if (
				editRequest.published_revision_id
			) {
				publishedRevision =
					await env.DB.prepare(`
						SELECT
							id,
							page_id,
							revision_number,
							content,
							editor_id,
							created_at
						FROM wiki_revisions
						WHERE id = ?
						LIMIT 1
					`)
						.bind(
							editRequest.published_revision_id,
						)
						.first<RevisionRow>();
			}

			/* ------------------------------------------------
			   9. Prevent identical publish
			------------------------------------------------ */

			if (
				publishedRevision &&
				publishedRevision.content ===
					revision.content
			) {
				return json(
					{
						ok: false,
						error:
							'The requested revision is already identical to the published revision',
					},
					409,
				);
			}

			/* ------------------------------------------------
			   10. approved → publishing
			------------------------------------------------ */

			const updateResult =
				await env.DB.prepare(`
					UPDATE edit_requests
					SET
						status = 'publishing'
					WHERE id = ?
					  AND status = 'approved'
				`)
					.bind(
						editRequestId,
					)
					.run();

			if (
				updateResult.meta.changes !==
				1
			) {
				return json(
					{
						ok: false,
						error:
							'Edit request could not be moved to publishing',
					},
					409,
				);
			}

			/* ------------------------------------------------
			   11. Audit: publish_start
			------------------------------------------------ */

			await env.DB.prepare(`
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
			`)
				.bind(
					crypto.randomUUID(),
					user.user_id,
					'wiki.edit_request.publish_start',
					'edit_request',
					editRequestId,
					JSON.stringify({
						previousStatus:
							'approved',
						newStatus:
							'publishing',
						pagePath:
							editRequest.page_path,
						sourcePath:
							editRequest.source_path,
						revisionId:
							revision.id,
						revisionNumber:
							revision.revision_number,
					}),
					new Date().toISOString(),
				)
				.run();

			/* ------------------------------------------------
			   12. GitHub configuration
			------------------------------------------------ */

			const branchName =
				`nugbase/publish/${editRequestId}`;

			const apiBase =
				`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPOSITORY}`;

			const headers =
				githubHeaders(
					env.GITHUB_TOKEN,
				);

			/* ------------------------------------------------
			   13. main branch
			------------------------------------------------ */

			const mainResponse =
				await fetch(
					`${apiBase}/branches/${GITHUB_BASE_BRANCH}`,
					{
						method: 'GET',
						headers,
					},
				);

			if (!mainResponse.ok) {
				const message =
					await getGitHubError(
						mainResponse,
					);

				throw new Error(
					`GitHub main branch lookup failed: ${mainResponse.status} ${message ?? ''}`,
				);
			}

			const mainData =
				(await mainResponse.json()) as
					GitHubBranchResponse;

			const mainSha =
				mainData.commit?.sha;

			if (!mainSha) {
				throw new Error(
					'GitHub main branch SHA was not returned',
				);
			}

			/* ------------------------------------------------
			   14. Publish branch
			------------------------------------------------ */

			const branchLookupResponse =
				await fetch(
					`${apiBase}/branches/${encodeURIComponent(branchName)}`,
					{
						method: 'GET',
						headers,
					},
				);

			let branchCreated =
				false;

			if (
				branchLookupResponse.status ===
				404
			) {
				const refResponse =
					await fetch(
						`${apiBase}/git/refs`,
						{
							method: 'POST',
							headers: {
								...headers,
								'Content-Type':
									'application/json',
							},
							body: JSON.stringify({
								ref:
									`refs/heads/${branchName}`,
								sha:
									mainSha,
							}),
						},
					);

				if (!refResponse.ok) {
					const message =
						await getGitHubError(
							refResponse,
						);

					throw new Error(
						`GitHub branch creation failed: ${refResponse.status} ${message ?? ''}`,
					);
				}

				branchCreated =
					true;
			} else if (
				!branchLookupResponse.ok
			) {
				const message =
					await getGitHubError(
						branchLookupResponse,
					);

				throw new Error(
					`GitHub branch lookup failed: ${branchLookupResponse.status} ${message ?? ''}`,
				);
			}

			/* ------------------------------------------------
			   15. Source file
			------------------------------------------------ */

			const sourcePath =
				String(
					editRequest.source_path,
				);

			const encodedSourcePath =
				sourcePath
					.split('/')
					.map(
						segment =>
							encodeURIComponent(
								segment,
							),
					)
					.join('/');

			const fileResponse =
				await fetch(
					`${apiBase}/contents/${encodedSourcePath}?ref=${encodeURIComponent(branchName)}`,
					{
						method: 'GET',
						headers,
					},
				);

			let existingFileSha:
				| string
				| undefined;

			if (fileResponse.ok) {
				const fileData =
					(await fileResponse.json()) as
						GitHubFileResponse;

				existingFileSha =
					fileData.sha;
			} else if (
				fileResponse.status !==
				404
			) {
				const message =
					await getGitHubError(
						fileResponse,
					);

				throw new Error(
					`GitHub target file lookup failed: ${fileResponse.status} ${message ?? ''}`,
				);
			}

			/* ------------------------------------------------
			   16. Write MD/MDX
			------------------------------------------------ */

			const content =
				String(
					revision.content,
				);

			const encodedContent =
				encodeBase64(
					content,
				);

			const putBody: Record<
				string,
				unknown
			> = {
				message:
					`content: update ${editRequest.page_path} (revision ${revision.revision_number})`,
				content:
					encodedContent,
				branch:
					branchName,
			};

			if (existingFileSha) {
				putBody.sha =
					existingFileSha;
			}

			const putResponse =
				await fetch(
					`${apiBase}/contents/${encodedSourcePath}`,
					{
						method: 'PUT',
						headers: {
							...headers,
							'Content-Type':
								'application/json',
						},
						body:
							JSON.stringify(
								putBody,
							),
					},
				);

			const putData =
				(await putResponse.json()) as
					| {
							content?: GitHubFileResponse;
							commit?: GitHubCommitResponse;
					  }
					| GitHubErrorResponse;

			if (!putResponse.ok) {
				const errorData =
					putData as
						GitHubErrorResponse;

				throw new Error(
					`GitHub file update failed: ${putResponse.status} ${errorData.message ?? ''}`,
				);
			}

			const fileData =
				putData as {
					content?: GitHubFileResponse;
					commit?: GitHubCommitResponse;
				};

			/* ------------------------------------------------
			   17. Existing PR
			------------------------------------------------ */

			const pullsResponse =
				await fetch(
					`${apiBase}/pulls?state=open&head=${encodeURIComponent(`${GITHUB_OWNER}:${branchName}`)}&base=${encodeURIComponent(GITHUB_BASE_BRANCH)}`,
					{
						method: 'GET',
						headers,
					},
				);

			if (!pullsResponse.ok) {
				const message =
					await getGitHubError(
						pullsResponse,
					);

				throw new Error(
					`GitHub pull request lookup failed: ${pullsResponse.status} ${message ?? ''}`,
				);
			}

			const existingPullRequests =
				(await pullsResponse.json()) as
					GitHubPullRequestResponse[];

			let pullRequest:
				| GitHubPullRequestResponse
				| undefined;

			let pullRequestCreated =
				false;

			/* ------------------------------------------------
			   18. Create or reuse PR
			------------------------------------------------ */

			if (
				existingPullRequests.length >
				0
			) {
				pullRequest =
					existingPullRequests[0];
			} else {
				const pullResponse =
					await fetch(
						`${apiBase}/pulls`,
						{
							method: 'POST',
							headers: {
								...headers,
								'Content-Type':
									'application/json',
							},
							body: JSON.stringify({
								title:
									`content: ${editRequest.page_title}`,

								head:
									branchName,

								base:
									GITHUB_BASE_BRANCH,

								body: [
									'NUGBACE Wiki publish request.',
									'',
									`- Edit request: ${editRequestId}`,
									`- Page: ${editRequest.page_path}`,
									`- Source: ${sourcePath}`,
									`- Revision: ${revision.revision_number}`,
									'',
									'This Pull Request was created automatically by NUGBACE.',
								].join('\n'),
							}),
						},
					);

				const pullData =
					(await pullResponse.json()) as
						| GitHubPullRequestResponse
						| GitHubErrorResponse;

				if (!pullResponse.ok) {
					const errorData =
						pullData as
							GitHubErrorResponse;

					throw new Error(
						`GitHub pull request creation failed: ${pullResponse.status} ${errorData.message ?? ''}`,
					);
				}

				pullRequest =
					pullData as
						GitHubPullRequestResponse;

				pullRequestCreated =
					true;
			}

			/* ------------------------------------------------
			   19. Audit: GitHub publish
			------------------------------------------------ */

			await env.DB.prepare(`
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
			`)
				.bind(
					crypto.randomUUID(),
					user.user_id,
					'wiki.edit_request.github_publish',
					'edit_request',
					editRequestId,
					JSON.stringify({
						branch:
							branchName,

						branchCreated,

						sourcePath,

						revisionId:
							revision.id,

						revisionNumber:
							revision.revision_number,

						commitSha:
							fileData.commit?.sha,

						commitUrl:
							fileData.commit?.html_url,

						pullRequestNumber:
							pullRequest?.number,

						pullRequestUrl:
							pullRequest?.html_url,

						pullRequestCreated,
					}),
					new Date().toISOString(),
				)
				.run();

			/* ------------------------------------------------
			   20. Updated request
			------------------------------------------------ */

			const updatedEditRequest =
				await env.DB.prepare(`
					SELECT
						er.id,
						er.page_id,
						er.revision_id,
						er.base_revision_id,
						er.user_id,
						er.status,
						er.message,
						er.reviewer_id,
						er.review_comment,
						er.created_at,
						er.reviewed_at,

						p.path AS page_path,
						p.title AS page_title,
						p.source_path,
						p.published_revision_id

					FROM edit_requests er

					INNER JOIN wiki_pages p
						ON p.id = er.page_id

					WHERE er.id = ?

					LIMIT 1
				`)
					.bind(
						editRequestId,
					)
					.first<EditRequestRow>();

			/* ------------------------------------------------
			   21. Success
			------------------------------------------------ */

			return json({
				ok: true,

				message:
					'GitHub branch, commit, and pull request created',

				editRequest:
					updatedEditRequest,

				revision,

				publishedRevision,

				github: {
					owner:
						GITHUB_OWNER,

					repository:
						GITHUB_REPOSITORY,

					baseBranch:
						GITHUB_BASE_BRANCH,

					branch:
						branchName,

					branchCreated,

					sourcePath,

					commit: {
						sha:
							fileData.commit?.sha,

						html_url:
							fileData.commit?.html_url,
					},

					pullRequest: {
						number:
							pullRequest?.number,

						title:
							pullRequest?.title,

						state:
							pullRequest?.state,

						html_url:
							pullRequest?.html_url,

						head:
							pullRequest?.head,

						base:
							pullRequest?.base,

						created:
							pullRequestCreated,
					},
				},
			});
		} catch (error) {
			/* ------------------------------------------------
			   22. Error recovery
			------------------------------------------------ */

			console.error(
				'Wiki edit request GitHub publish error:',
				error,
			);

			if (editRequestId) {
				try {
					await env.DB.prepare(`
						UPDATE edit_requests
						SET
							status = 'approved'
						WHERE id = ?
						  AND status = 'publishing'
					`)
						.bind(
							editRequestId,
						)
						.run();

					await env.DB.prepare(`
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
					`)
						.bind(
							crypto.randomUUID(),
							currentUserId,
							'wiki.edit_request.publish_failed',
							'edit_request',
							editRequestId,
							JSON.stringify({
								error:
									error instanceof Error
										? error.message
										: String(error),

								statusRestored:
									'approved',
							}),
							new Date().toISOString(),
						)
						.run();
				} catch (
					recoveryError
				) {
					console.error(
						'Failed to restore edit request status:',
						recoveryError,
					);
				}
			}

			return json(
				{
					ok: false,
					error:
						'GitHub publish failed',
					message:
						error instanceof Error
							? error.message
							: String(error),
				},
				502,
			);
		}
	};