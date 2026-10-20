import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
	getDiscordCredentials,
	getArticleDetails,
	getPushChanges,
	parseFrontmatter,
	parseGitNameStatus,
} from "./notify-discord.mjs";

const siteUrl = "https://yuruport.com";

function runGit(directory, args, input) {
	const result = spawnSync("git", args, {
		cwd: directory,
		encoding: "utf8",
		input,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`Git command failed: ${result.stderr}`);
	}
	return result.stdout;
}

function commitFiles(directory, files, message) {
	for (const [path, contents] of Object.entries(files)) {
		const filePath = join(directory, path);
		mkdirSync(dirname(filePath), { recursive: true });
		writeFileSync(filePath, contents);
	}
	runGit(directory, ["add", "--all"]);
	runGit(directory, ["commit", "-m", message]);
	return runGit(directory, ["rev-parse", "HEAD"]).trim();
}

test("parses added, modified, and deleted git paths without quoting filenames", () => {
	assert.deepEqual(
		parseGitNameStatus("A\0src/content/guide/new article.md\0M\0src/content/news/update.md\0D\0src/content/tool/removed.md\0"),
		[
			{ status: "A", path: "src/content/guide/new article.md" },
			{ status: "M", path: "src/content/news/update.md" },
			{ status: "D", path: "src/content/tool/removed.md" },
		],
	);
});

test("detects article changes across all commits in an initial push", () => {
	const directory = mkdtempSync(join(tmpdir(), "notify-discord-"));
	try {
		runGit(directory, ["init", "-q"]);
		runGit(directory, ["config", "user.name", "Notification Test"]);
		runGit(directory, ["config", "user.email", "notification-test@example.invalid"]);

		commitFiles(directory, {
			"src/content/guide/first.md": "First guide",
		}, "Add guide");
		const beforeNormalPush = commitFiles(directory, {
			"src/content/news/second.md": "Second article",
			"src/styles/site.css": "body {}",
		}, "Add news and unrelated style");

		const initialPushChanges = getPushChanges({
			GITHUB_EVENT_BEFORE: "0".repeat(40),
			GITHUB_SHA: beforeNormalPush,
		}, (args, input) => runGit(directory, args, input));
		assert.deepEqual(initialPushChanges, [
			{ status: "A", path: "src/content/guide/first.md" },
			{ status: "A", path: "src/content/news/second.md" },
			{ status: "A", path: "src/styles/site.css" },
		]);

		const normalPushHead = commitFiles(directory, {
			"src/content/guide/first.md": "Updated guide",
		}, "Update guide");
		const normalPushChanges = getPushChanges({
			GITHUB_EVENT_BEFORE: beforeNormalPush,
			GITHUB_SHA: normalPushHead,
		}, (args, input) => runGit(directory, args, input));
		assert.deepEqual(normalPushChanges, [
			{ status: "M", path: "src/content/guide/first.md" },
		]);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("maps guide, Wiki, news, and tool articles to their Astro routes", () => {
	assert.equal(
		getArticleDetails("src/content/guide/nekozouneko-cho/001.md", "A", siteUrl).url,
		"https://yuruport.com/guide/nekozouneko-cho/001/",
	);
	assert.equal(
		getArticleDetails("src/content/docs/docs/plugins/lands/index.md", "M", siteUrl).url,
		"https://yuruport.com/docs/plugins/lands/",
	);
	assert.equal(
		getArticleDetails("src/content/news/server-update.md", "M", siteUrl).url,
		"https://yuruport.com/news/server-update/",
	);
	assert.equal(
		getArticleDetails("src/content/tool/lands.md", "A", siteUrl).url,
		"https://yuruport.com/tool/lands/",
	);
});

test("distinguishes new articles and edits, and ignores deletions and non-articles", () => {
	assert.equal(getArticleDetails("src/content/guide/new.md", "A", siteUrl).kind, "新規公開");
	assert.equal(getArticleDetails("src/content/guide/existing.md", "M", siteUrl).kind, "更新");
	assert.equal(getArticleDetails("src/content/guide/removed.md", "D", siteUrl), null);
	assert.equal(getArticleDetails("src/content/guide/index.md", "M", siteUrl), null);
	assert.equal(getArticleDetails("src/content/guide/cover.png", "A", siteUrl), null);
	assert.equal(getArticleDetails("src/styles/site.css", "M", siteUrl), null);
	assert.equal(getArticleDetails("src/content/tool/index.md", "M", siteUrl), null);
});

test("reads notification metadata from frontmatter", () => {
	assert.deepEqual(
		parseFrontmatter([
			"---",
			'title: "タイトル: 更新情報"',
			"description: >-",
			"  1行目の概要",
			"  2行目の概要",
			"category: お知らせ",
			"---",
			"",
			"本文",
		].join("\n")),
		{
			title: "タイトル: 更新情報",
			description: "1行目の概要 2行目の概要",
			category: "お知らせ",
		},
	);
});

test("reports missing Discord secrets by name without exposing values", () => {
	assert.throws(
		() => getDiscordCredentials({ DISCORD_CHANNEL_ID: "123456789012345678" }),
		/Missing required GitHub Actions secret: DISCORD_BOT_TOKEN\./,
	);
	assert.throws(
		() => getDiscordCredentials({ DISCORD_BOT_TOKEN: "token-value" }),
		/Missing required GitHub Actions secret: DISCORD_CHANNEL_ID\./,
	);
	assert.throws(
		() => getDiscordCredentials({
			DISCORD_BOT_TOKEN: "token-value",
			DISCORD_CHANNEL_ID: "not-a-channel",
		}),
		/DISCORD_CHANNEL_ID must contain a Discord channel ID\./,
	);
});
