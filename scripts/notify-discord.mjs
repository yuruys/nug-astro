import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");

const collections = {
	guide: { label: "攻略ガイド", prefix: "/guide", extension: ".md" },
	docs: { label: "Wiki", prefix: "", extensions: [".md", ".mdx"] },
	news: { label: "ニュース", prefix: "/news", extension: ".md" },
	tool: { label: "ツール", prefix: "/tool", extension: ".md" },
};

export function parseGitNameStatus(output) {
	const fields = output.split("\0");
	const changes = [];

	for (let index = 0; index < fields.length;) {
		const status = fields[index++];
		if (!status) continue;

		const code = status[0];
		if (code === "R" || code === "C") {
			index++;
			const path = fields[index++];
			if (path) changes.push({ status: code, path });
			continue;
		}

		const path = fields[index++];
		if (path) changes.push({ status: code, path });
	}

	return changes;
}

export function getArticleDetails(filePath, status, siteUrl) {
	const normalizedPath = filePath.replaceAll("\\", "/");
	const match = /^src\/content\/(guide|docs|news|tool)\/(.+)$/.exec(normalizedPath);
	if (!match) return null;

	const [, collectionName, relativePath] = match;
	const config = collections[collectionName];
	const extension = relativePath.slice(relativePath.lastIndexOf("."));
	const allowedExtensions = config.extensions ?? [config.extension];
	if (!allowedExtensions.includes(extension)) return null;

	const id = relativePath.slice(0, -extension.length);
	if (collectionName !== "docs" && id === "index") return null;
	if (status !== "A" && status !== "M") return null;

	const urlPath = collectionName === "docs"
		? `/${id.replace(/\/index$/, "")}/`
		: `${config.prefix}/${id}/`;

	return {
		path: normalizedPath,
		kind: status === "A" ? "新規公開" : "更新",
		collection: config.label,
		url: new URL(urlPath, siteUrl).href,
		titleFallback: id.split("/").at(-1),
	};
}

export function parseFrontmatter(source) {
	const frontmatter = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
	if (!frontmatter) return {};

	const lines = frontmatter[1].split(/\r?\n/);
	const values = {};

	for (let index = 0; index < lines.length; index++) {
		const match = /^([A-Za-z][\w-]*):(?:[ \t]*(.*))?$/.exec(lines[index]);
		if (!match || !["title", "description", "category"].includes(match[1])) continue;

		const [, key, rawValue = ""] = match;
		if (/^[|>][+-]?$/.test(rawValue.trim())) {
			const blockLines = [];
			while (index + 1 < lines.length && (/^\s/.test(lines[index + 1]) || !lines[index + 1].trim())) {
				blockLines.push(lines[++index].trim());
			}
			values[key] = rawValue.trim().startsWith("|")
				? blockLines.join("\n")
				: blockLines.join(" ");
			continue;
		}

		values[key] = parseYamlString(rawValue);
	}

	return values;
}

export function getDiscordCredentials(environment) {
	const token = environment.DISCORD_BOT_TOKEN?.trim();
	const channelId = environment.DISCORD_CHANNEL_ID?.trim();
	if (!token) throw new Error("Missing required GitHub Actions secret: DISCORD_BOT_TOKEN.");
	if (!channelId) throw new Error("Missing required GitHub Actions secret: DISCORD_CHANNEL_ID.");
	if (!/^\d+$/.test(channelId)) throw new Error("DISCORD_CHANNEL_ID must contain a Discord channel ID.");
	return { token, channelId };
}

function parseYamlString(rawValue) {
	const value = rawValue.trim();
	if (value.startsWith('"') && value.endsWith('"')) {
		try {
			return JSON.parse(value);
		} catch {
			return value.slice(1, -1);
		}
	}
	if (value.startsWith("'") && value.endsWith("'")) {
		return value.slice(1, -1).replaceAll("''", "'");
	}
	return value.replace(/\s+#.*$/, "").trim();
}

function getSummary(source, description) {
	if (description) return description;

	const body = source.replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "").trim();
	const paragraph = body.split(/\r?\n\s*\r?\n/)
		.find((part) => part.trim() && !part.trim().startsWith(":::"));
	if (!paragraph) return "概要なし";

	return paragraph
		.replace(/^#{1,6}\s+/gm, "")
		.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		.replace(/[*_`~]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 400) || "概要なし";
}

function getSiteUrl(configSource) {
	const match = /^\s*site:\s*(['"])(https?:\/\/[^'"]+)\1\s*,?\s*$/m.exec(configSource);
	if (!match) {
		throw new Error("Could not determine the public site URL from astro.config.mjs.");
	}
	return match[2];
}

function runGit(args, input) {
	const result = spawnSync("git", args, {
		cwd: repositoryRoot,
		encoding: "utf8",
		input,
		maxBuffer: 10 * 1024 * 1024,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`Git could not read the push changes (exit ${result.status}).`);
	}
	return result.stdout;
}

export function getPushChanges(environment = process.env, gitCommand = runGit) {
	const before = environment.GITHUB_EVENT_BEFORE;
	const head = environment.GITHUB_SHA;
	if (!head) throw new Error("GITHUB_SHA is required to inspect pushed changes.");

	if (!before || /^0+$/.test(before)) {
		const emptyTree = gitCommand(["hash-object", "-t", "tree", "--stdin"], "").trim();
		return parseGitNameStatus(gitCommand([
			"diff", "--name-status", "-z", "--no-renames", emptyTree, head,
		]));
	}

	return parseGitNameStatus(gitCommand([
		"diff", "--name-status", "-z", "--no-renames", before, head,
	]));
}

function createMessage(article, metadata, source) {
	const title = (metadata.title || article.titleFallback).slice(0, 256);
	const category = (metadata.category || article.collection).slice(0, 100);
	const summary = getSummary(source, metadata.description).slice(0, 400);
	return [
		`**【${article.kind}】${article.collection}**`,
		`**タイトル:** ${title}`,
		`**概要:** ${summary}`,
		`**カテゴリ:** ${category}`,
		`**公開URL:** <${article.url}>`,
	].join("\n");
}

async function sendDiscordMessage(token, channelId, content, articlePath) {
	const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
		method: "POST",
		headers: {
			Authorization: `Bot ${token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			content,
			allowed_mentions: { parse: [] },
		}),
	});

	if (!response.ok) {
		throw new Error(`Discord API returned HTTP ${response.status} while notifying about ${articlePath}.`);
	}
}

async function main() {
	const configSource = await readFile(resolve(repositoryRoot, "astro.config.mjs"), "utf8");
	const siteUrl = getSiteUrl(configSource);
	const articles = getPushChanges(process.env)
		.map(({ path, status }) => getArticleDetails(path, status, siteUrl))
		.filter(Boolean);

	if (articles.length === 0) {
		console.log("No publishable article changes detected.");
		return;
	}

	const { token, channelId } = getDiscordCredentials(process.env);

	for (const article of articles) {
		const source = await readFile(resolve(repositoryRoot, article.path), "utf8");
		const metadata = parseFrontmatter(source);
		await sendDiscordMessage(token, channelId, createMessage(article, metadata, source), article.path);
		console.log(`Sent ${article.kind} notification for ${article.path}.`);
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : "Discord notification failed.");
		process.exitCode = 1;
	});
}
