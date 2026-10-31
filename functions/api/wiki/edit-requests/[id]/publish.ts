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

interface Env {
	DB: D1Database;
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
	type?: 'file' | 'dir' | 'symlink' | 'submodule';
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

interface WikiDraftRow {
	id: string;
	operation: 'create' | 'update' | 'delete';
	status: string;
	title: string;
	description: string;
	page_path: string;
	source_path: string;
	content: string;
	user_id: string;
	version: number;
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

function yamlString(value: string): string {
	return JSON.stringify(value);
}

function buildDraftMarkdown(draft: WikiDraftRow): string {
	if (draft.operation === 'create') {
		return `---\ntitle: ${yamlString(draft.title)}\ndescription: ${yamlString(draft.description)}\n---\n\n${draft.content}`;
	}

	const frontmatter = draft.content.match(
		/^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/,
	);
	if (!frontmatter) {
		return `---\ntitle: ${yamlString(draft.title)}\ndescription: ${yamlString(draft.description)}\n---\n\n${draft.content}`;
	}

	const values = new Map<string, string>();
	const lines = frontmatter[1].split(/\r?\n/);
	const preserved: string[] = [];
	for (const line of lines) {
		const match = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
		if (!match) {
			preserved.push(line);
			continue;
		}
		if (match[1] !== 'title' && match[1] !== 'description') {
			preserved.push(line);
		}
	}
	values.set('title', yamlString(draft.title));
	values.set('description', yamlString(draft.description));

	const updatedFrontmatter = [
		`title: ${values.get('title')}`,
		`description: ${values.get('description')}`,
		...preserved,
	].join('\n');
	return `---\n${updatedFrontmatter}\n---\n${draft.content.slice(frontmatter[0].length)}`;
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
		let managedDraft: WikiDraftRow | null = null;

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
			   2. GitHub token
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
			   3. Request ID
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
			   4. Edit request or shared draft
			------------------------------------------------ */

			let editRequest =
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
				managedDraft = await env.DB.prepare(`
					SELECT
						id,
						operation,
						status,
						title,
						description,
						page_path,
						source_path,
						content,
						updated_by AS user_id,
						version
					FROM wiki_drafts
					WHERE id = ?
					LIMIT 1
				`)
					.bind(editRequestId)
					.first<WikiDraftRow>();

				if (!managedDraft) {
					return json(
						{
							ok: false,
							error: 'Wiki request not found',
						},
						404,
					);
				}

				if (
					managedDraft.status !== 'draft' ||
					!/^src\/content\/docs\/docs\/[a-z0-9_/-]+\.(md|mdx)$/.test(managedDraft.source_path) ||
					managedDraft.source_path.split('/').includes('..')
				) {
					return json(
						{
							ok: false,
							error: 'Draft is not eligible for PR submission',
							status: managedDraft.status,
						},
						409,
					);
				}

				editRequest = {
					id: managedDraft.id,
					page_id: '',
					revision_id: '',
					base_revision_id: null,
					user_id: managedDraft.user_id,
					status: managedDraft.status,
					message: null,
					reviewer_id: null,
					review_comment: null,
					created_at: '',
					reviewed_at: null,
					page_path: managedDraft.page_path,
					page_title: managedDraft.title,
					source_path: managedDraft.source_path,
					published_revision_id: null,
				};
			}

			/* ------------------------------------------------
			   5. Request state
			------------------------------------------------ */

			if (managedDraft) {
				if (editRequest.status !== 'draft') {
					return json(
						{
							ok: false,
							error: 'Draft has already been submitted',
							status: editRequest.status,
						},
						409,
					);
				}
			} else if (editRequest.status !== 'approved' || user.role !== 'admin') {
				return json(
					{
						ok: false,
						error:
							'Only approved edit requests can be published by an administrator',
						status:
							editRequest.status,
					},
					403,
				);
			}

			/* ------------------------------------------------
			   6. Revision
			------------------------------------------------ */

			let revision =
				managedDraft
					? {
						id: managedDraft.id,
						page_id: '',
						revision_number: managedDraft.version,
						content: buildDraftMarkdown(managedDraft),
						editor_id: managedDraft.user_id,
						created_at: '',
					}
					:
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
				!managedDraft &&
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
			   7. Current published revision
			------------------------------------------------ */

			let publishedRevision:
				RevisionRow | null =
				null;

			if (
				!managedDraft &&
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
						  AND page_id = ?
						LIMIT 1
					`)
						.bind(
							editRequest.published_revision_id,
							editRequest.page_id,
						)
						.first<RevisionRow>();
			}

			/* ------------------------------------------------
			   9. Prevent identical publish
			------------------------------------------------ */

			if (
				!managedDraft &&
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
			   8. Claim request to prevent duplicate submission
			------------------------------------------------ */

			const updateResult = managedDraft
				? await env.DB.prepare(`
					UPDATE wiki_drafts
					SET status = 'publishing'
					WHERE id = ? AND status = 'draft' AND version = ?
				`)
					.bind(editRequestId, managedDraft.version)
					.run()
				: await env.DB.prepare(`
					UPDATE edit_requests
					SET status = 'publishing'
					WHERE id = ? AND status = 'approved'
				`)
					.bind(editRequestId)
					.run();

			if (
				updateResult.meta?.changes !==
				1
			) {
				return json(
					{
						ok: false,
						error:
							'Request could not be moved to publishing',
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

			const sourcePath = String(editRequest.source_path);
			const encodedSourcePath = sourcePath
				.split('/')
				.map((segment) => encodeURIComponent(segment))
				.join('/');
			const operation = managedDraft?.operation ?? 'update';

			if (managedDraft) {
				const mainFileResponse = await fetch(
					`${apiBase}/contents/${encodedSourcePath}?ref=${encodeURIComponent(GITHUB_BASE_BRANCH)}`,
					{ method: 'GET', headers },
				);
				if (
					(operation === 'create' && mainFileResponse.ok) ||
					(operation !== 'create' && mainFileResponse.status === 404)
				) {
					throw new Error(`GitHub main branch file state conflicts with the ${operation} request`);
				}
				if (!mainFileResponse.ok && mainFileResponse.status !== 404) {
					const message = await getGitHubError(mainFileResponse);
					throw new Error(`GitHub main branch file lookup failed: ${mainFileResponse.status} ${message ?? ''}`);
				}
				if (mainFileResponse.ok) {
					const mainFile = await mainFileResponse.json() as GitHubFileResponse;
					if (mainFile.type !== 'file' || mainFile.path !== sourcePath || !mainFile.sha) {
						throw new Error('GitHub main branch returned an unexpected target file');
					}
				}
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

				if (
					managedDraft &&
					(fileData.type !== 'file' || fileData.path !== sourcePath || !fileData.sha)
				) {
					throw new Error('GitHub branch returned an unexpected target file');
				}
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

			if (managedDraft && operation !== 'create' && !existingFileSha) {
				throw new Error(`GitHub target file is missing for the ${operation} request`);
			}

			/* ------------------------------------------------
			   16. Write MD/MDX
			------------------------------------------------ */

			const commitMessage =
				`content: ${operation} ${editRequest.page_path} (revision ${revision.revision_number})`;
			const writeResponse = operation === 'delete'
				? await fetch(
					`${apiBase}/contents/${encodedSourcePath}`,
					{
						method: 'DELETE',
						headers: {
							...headers,
							'Content-Type': 'application/json',
						},
						body: JSON.stringify({
							message: commitMessage,
							sha: existingFileSha,
							branch: branchName,
						}),
					},
				)
				: await fetch(
					`${apiBase}/contents/${encodedSourcePath}`,
					{
						method: 'PUT',
						headers: {
							...headers,
							'Content-Type': 'application/json',
						},
						body: JSON.stringify({
							message: commitMessage,
							content: encodeBase64(String(revision.content)),
							branch: branchName,
							...(existingFileSha ? { sha: existingFileSha } : {}),
						}),
					},
				);

			const writeData = await writeResponse.json() as
				| {
					content?: GitHubFileResponse;
					commit?: GitHubCommitResponse;
					message?: string;
				}
				| GitHubErrorResponse;

			if (!writeResponse.ok) {
				throw new Error(
					`GitHub file ${operation} failed: ${writeResponse.status} ${writeData.message ?? ''}`,
				);
			}

			const fileData = writeData as {
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

			if (managedDraft) {
				const savedDraft = await env.DB.prepare(`
					UPDATE wiki_drafts
					SET
						status = 'pending',
						submitted_content = ?,
						github_pr_number = ?,
						github_pr_url = ?,
						github_pr_state = ?,
						updated_at = ?
					WHERE id = ? AND status = 'publishing'
				`)
					.bind(
						String(revision.content),
						pullRequest?.number ?? null,
						pullRequest?.html_url ?? null,
						pullRequest?.state ?? 'open',
						new Date().toISOString(),
						editRequestId,
					)
					.run();

				if (savedDraft.meta?.changes !== 1) {
					throw new Error('Draft PR status could not be saved');
				}
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
					managedDraft
						? 'wiki.draft.github_pr'
						: 'wiki.edit_request.github_publish',
					managedDraft ? 'wiki_draft' : 'edit_request',
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

			const updatedEditRequest = managedDraft
				? null
				:
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

			const updatedDraft = managedDraft
				? await env.DB.prepare(`
					SELECT
						id, operation, status, title, description,
						page_path, source_path, content, updated_by AS user_id,
						created_by, updated_by, created_at, updated_at,
						version, github_pr_number, github_pr_url, github_pr_state
					FROM wiki_drafts
					WHERE id = ?
					LIMIT 1
				`)
					.bind(editRequestId)
					.first()
				: null;

			/* ------------------------------------------------
			   21. Success
			------------------------------------------------ */

			return json({
				ok: true,

				message:
					'GitHub branch, commit, and pull request created',

				editRequest:
					updatedEditRequest,

				draft:
					updatedDraft,

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
					if (managedDraft) {
						await env.DB.prepare(`
							UPDATE wiki_drafts
							SET status = 'draft'
							WHERE id = ? AND status = 'publishing'
						`)
							.bind(editRequestId)
							.run();
					} else {
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
					}

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
							managedDraft
								? 'wiki.draft.github_pr_failed'
								: 'wiki.edit_request.publish_failed',
							managedDraft ? 'wiki_draft' : 'edit_request',
							editRequestId,
							JSON.stringify({
								error:
									error instanceof Error
										? error.message
										: String(error),

								statusRestored:
									managedDraft ? 'draft' : 'approved',
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