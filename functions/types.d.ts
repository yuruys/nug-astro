/* =========================================================
 * NUGBACE Cloudflare Pages Functions Type Definitions
 * ---------------------------------------------------------
 * Wrangler generated runtime types are intentionally not used
 * here because they conflict with TypeScript's standard DOM
 * declarations in this project.
 *
 * These definitions cover the Cloudflare Pages Functions APIs
 * used by NUGBACE.
 * ========================================================= */


/* =========================================================
 * 01. Environment
 * ========================================================= */

interface Env {
	DB: D1Database;

	GOOGLE_CLIENT_ID: string;
	GOOGLE_CLIENT_SECRET: string;

	GITHUB_TOKEN: string;
	GITHUB_WEBHOOK_SECRET: string;
}


/* =========================================================
 * 02. Cloudflare D1
 * ========================================================= */

interface D1Database {
	prepare(
		query: string,
	): D1PreparedStatement;

	batch<T = unknown>(
		statements: D1PreparedStatement[],
	): Promise<T[]>;

	dump(): Promise<ArrayBuffer>;
}


interface D1PreparedStatement {
	bind(
		...values: unknown[]
	): D1PreparedStatement;

	/*
	 * NUGBACE の既存 Functions では first() を
	 * ジェネリック指定なしで使用している箇所がある。
	 *
	 * unknown のままだと:
	 *
	 *   user.role
	 *   page.id
	 *   editRequest.status
	 *
	 * などのプロパティアクセスができないため、
	 * 既存コードとの互換性を優先して any を既定値にする。
	 */
	first<T = any>(
		columnName?: string,
	): Promise<T | null>;

	/*
	 * all() も既存 Functions では型引数なしで使用しているため、
	 * first() と同様に any を既定値にする。
	 */
	all<T = any>(): Promise<D1Result<T>>;

	run(): Promise<D1ExecResult>;

	raw<T = any>(
		options?: {
			columnNames?: boolean;
		},
	): Promise<T[][]>;
}


interface D1Result<T = any> {
	results: T[];

	success: boolean;

	meta?: Record<string, unknown>;
}


interface D1ExecResult {
	success: boolean;

	meta?: Record<string, unknown>;
}


/* =========================================================
 * 03. Cloudflare Pages Function Context
 * ========================================================= */

interface PagesFunctionContext<
	Environment = Env,
	Params extends Record<string, string | undefined> =
		Record<string, string | undefined>,
> {
	request: Request;

	env: Environment;

	params: Params;

	data: Record<string, unknown>;

	waitUntil(
		promise: Promise<unknown>,
	): void;

	passThroughOnException(): void;

	next(): Promise<Response>;
}


/* =========================================================
 * 04. PagesFunction
 * ========================================================= */

type PagesFunction<
	Environment = Env,
	Params extends Record<string, string | undefined> =
		Record<string, string | undefined>,
> = (
	context: PagesFunctionContext<
		Environment,
		Params
	>,
) => Response | Promise<Response>;


/* =========================================================
 * 05. Astro App.Locals
 * ---------------------------------------------------------
 * Some existing NUGBACE Functions use:
 *
 *   locals.runtime.env
 *
 * This declaration keeps that structure available without
 * importing Cloudflare's generated runtime types.
 * ========================================================= */

declare namespace App {
	interface Locals {
		runtime: {
			env: Env;
		};
	}
}


/* =========================================================
 * 06. Cloudflare Env namespace
 * ---------------------------------------------------------
 * Some Cloudflare tooling expects Cloudflare.Env to exist.
 * ========================================================= */

declare namespace Cloudflare {
	interface Env extends globalThis.Env {}
}


/* =========================================================
 * 07. GitHub Pull Request Webhook
 * ========================================================= */

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
 * 08. Common API Response Helpers
 * ========================================================= */

interface ApiErrorResponse {
	ok: false;

	error: string;

	code?: string;
}


interface ApiSuccessResponse {
	ok: true;

	message?: string;

	[key: string]: unknown;
}


/* =========================================================
 * 09. GitHub API Types
 * ---------------------------------------------------------
 * Only the fields used by NUGBACE Functions are defined.
 * ========================================================= */

interface GitHubUser {
	login: string;

	id?: number;
}


interface GitHubRepository {
	full_name: string;

	default_branch?: string;
}


interface GitHubBranch {
	name: string;

	commit?: {
		sha?: string;
	};
}


interface GitHubGitRef {
	ref: string;

	node_id?: string;

	url?: string;

	object?: {
		sha?: string;

		type?: string;

		url?: string;
	};
}


interface GitHubContentFile {
	type?: string;

	name?: string;

	path?: string;

	sha?: string;

	size?: number;

	url?: string;

	html_url?: string;

	download_url?: string;

	content?: string;

	encoding?: string;
}


interface GitHubPullRequest {
	number: number;

	state?: string;

	title?: string;

	body?: string | null;

	head?: {
		ref?: string;

		sha?: string;

		repo?: {
			full_name?: string;
		};
	};

	base?: {
		ref?: string;

		sha?: string;

		repo?: {
			full_name?: string;
		};
	};

	html_url?: string;
}


/* =========================================================
 * 10. OAuth / Session
 * ========================================================= */

interface GoogleUserInfo {
	sub?: string;

	email?: string;

	email_verified?: boolean;

	name?: string;

	picture?: string;
}


interface SessionUser {
	id: string;

	email?: string | null;

	display_name?: string | null;

	role?: string;
}


/* =========================================================
 * 11. Optional GitHub API Error
 * ---------------------------------------------------------
 * GitHub API のエラーレスポンスを扱う Functions 用。
 * ========================================================= */

interface GitHubApiError {
	message?: string;

	documentation_url?: string;

	status?: string;
}