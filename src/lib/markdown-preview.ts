import { marked } from 'marked';
import DOMPurify from 'dompurify';

function escapeHtml(value: unknown): string {
	return String(value ?? '')
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

function sanitizePreviewHref(value: unknown): string {
	const href = String(value ?? '').trim();

	if (!href) return '#';
	if (href.startsWith('/')) return href;
	if (href.startsWith('#')) return href;

	try {
		const url = new URL(href, window.location.origin);
		if (url.protocol === 'http:' || url.protocol === 'https:') {
			return url.href;
		}
	} catch {
		return '#';
	}

	return '#';
}

function renderStarlightLinkCard(attributes: string): string {
	const titleMatch = attributes.match(/title\s*=\s*["']([^"']*)["']/i);
	const hrefMatch = attributes.match(/href\s*=\s*["']([^"']*)["']/i);
	const descriptionMatch = attributes.match(/description\s*=\s*["']([^"']*)["']/i);

	const title = titleMatch?.[1]?.trim() || 'リンク';
	const href = sanitizePreviewHref(hrefMatch?.[1] || '#');
	const description = descriptionMatch?.[1]?.trim() || '';

	return `
<a class="starlight-link-card" href="${escapeHtml(href)}">
	<span class="starlight-link-card-title">${escapeHtml(title)}</span>
	${description ? `<span class="starlight-link-card-description">${escapeHtml(description)}</span>` : ''}
	<span class="starlight-link-card-arrow" aria-hidden="true">→</span>
</a>`;
}

function transformStarlightLinkCards(source: string): string {
	return source.replace(
		/<CardGrid\s*>\s*([\s\S]*?)\s*<\/CardGrid>/gi,
		(_match, body: string) => {
			const cards: string[] = [];
			const cardPattern = /<LinkCard\s+([\s\S]*?)\/\s*>/gi;
			let match: RegExpExecArray | null;

			while ((match = cardPattern.exec(body)) !== null) {
				cards.push(renderStarlightLinkCard(match[1]));
			}

			if (!cards.length) return '';
			return `\n<div class="starlight-card-grid">${cards.join('')}</div>\n`;
		},
	);
}

async function transformStarlightAdmonitions(source: string): Promise<string> {
	const pattern = /^\s*:::(note|tip|caution|danger)(?:\[([^\]]*)\])?\s*\n([\s\S]*?)^\s*:::\s*$/gim;
	const matches = [...source.matchAll(pattern)];
	const defaultTitles: Record<string, string> = {
		note: '注記',
		tip: 'ヒント',
		caution: '注意',
		danger: '警告',
	};

	for (const match of matches.reverse()) {
		const [fullMatch, type, label, body] = match;
		const start = match.index;

		if (start === undefined) continue;

		const title = label?.trim() || defaultTitles[type] || type;
		const renderedBody = await marked.parse(body.trim(), { gfm: true, breaks: false });
		const replacement = `
<div class="starlight-admonition starlight-admonition-${type}" data-admonition="${type}">
<div class="starlight-admonition-title">${escapeHtml(title)}</div>
<div class="starlight-admonition-body">
${renderedBody}
</div>
</div>
`;

		source = source.slice(0, start) + replacement + source.slice(start + fullMatch.length);
	}

	return source;
}

async function prepareStarlightPreview(source: string): Promise<string> {
	let prepared = String(source ?? '');

	prepared = prepared.replace(/^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '');
	// MDX import is omitted; MDX, JSX, and JavaScript are never evaluated in previews.
	prepared = prepared.replace(/^\s*import\s+[\s\S]*?from\s+["'][^"']+["']\s*;?\s*$/gim, '');
	prepared = transformStarlightLinkCards(prepared);
	prepared = await transformStarlightAdmonitions(prepared);
	return prepared;
}

export async function renderMarkdownPreview(source: string): Promise<string> {
	const previewSource = await prepareStarlightPreview(source);
	const renderedMarkdown = await marked.parse(previewSource, { gfm: true, breaks: false });
	return DOMPurify.sanitize(renderedMarkdown);
}
