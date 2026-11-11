export interface LinkCardData {
	title: string;
	href: string;
	description: string;
	raw?: string;
	dirty?: boolean;
}

export interface CardGridBlock {
	start: number;
	end: number;
	raw: string;
	openingTag: string;
	closingTag: string;
	leadingWhitespace: string;
	separators: string[];
	trailingWhitespace: string;
	cards: LinkCardData[];
	dirty: boolean;
	deleted: boolean;
}

export interface ParsedCardGrids {
	blocks: CardGridBlock[];
	invalid: boolean;
}

function decodeJsxAttribute(value: string): string | undefined {
	let invalidEntity = false;
	const decoded = value.replace(/&([^;]+);/g, (entity, name: string) => {
		const named: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };
		if (name in named) return named[name];
		const numeric = name.startsWith('#x')
			? Number.parseInt(name.slice(2), 16)
			: name.startsWith('#')
				? Number.parseInt(name.slice(1), 10)
				: Number.NaN;
		if (Number.isInteger(numeric) && numeric >= 0 && numeric <= 0x10ffff) {
			return String.fromCodePoint(numeric);
		}
		invalidEntity = true;
		return entity;
	});
	return invalidEntity ? undefined : decoded;
}

function parseLinkCardAttributes(source: string): LinkCardData | undefined {
	const values: Partial<LinkCardData> = {};
	let cursor = 0;
	while (cursor < source.length) {
		while (/\s/.test(source[cursor] ?? '') && cursor < source.length) cursor += 1;
		if (cursor === source.length) break;
		const name = source.slice(cursor).match(/^[A-Za-z][A-Za-z0-9_-]*/)?.[0];
		if (!name || !['title', 'href', 'description'].includes(name)) return undefined;
		cursor += name.length;
		while (/\s/.test(source[cursor] ?? '') && cursor < source.length) cursor += 1;
		if (source[cursor] !== '=') return undefined;
		cursor += 1;
		while (/\s/.test(source[cursor] ?? '') && cursor < source.length) cursor += 1;
		if (source[cursor] !== '"') return undefined;
		cursor += 1;
		const valueStart = cursor;
		while (cursor < source.length && source[cursor] !== '"') {
			if (source[cursor] === '\\') return undefined;
			cursor += 1;
		}
		if (cursor === source.length) return undefined;
		const value = decodeJsxAttribute(source.slice(valueStart, cursor));
		if (value === undefined || name in values) return undefined;
		values[name as 'title' | 'href' | 'description'] = value;
		cursor += 1;
	}
	if (values.title === undefined || values.href === undefined || values.description === undefined) return undefined;
	return { title: values.title, href: values.href, description: values.description };
}

export function parseCardGrids(markdown: string): ParsedCardGrids {
	const lines = markdown.split('\n');
	let fenceCharacter = '';
	let fenceLength = 0;
	const maskedLines = lines.map((line) => {
		const fence = line.match(/^ {0,3}(`{3,}|~{3,})/);
		if (fence) {
			const marker = fence[1];
			if (!fenceCharacter) {
				fenceCharacter = marker[0];
				fenceLength = marker.length;
			} else if (marker[0] === fenceCharacter && marker.length >= fenceLength) {
				fenceCharacter = '';
				fenceLength = 0;
			}
			return line.replace(/[^\r\n]/g, ' ');
		}
		const result = fenceCharacter ? line.replace(/[^\r\n]/g, ' ') : line;
		return result;
	});
	const searchable = maskedLines.join('\n');
	const blocks: CardGridBlock[] = [];
	const pattern = /<CardGrid\s*>([\s\S]*?)<\/CardGrid\s*>/g;
	let invalid = false;
	let previousGridEnd = 0;
	for (const match of searchable.matchAll(pattern)) {
		const start = match.index ?? 0;
		const end = start + match[0].length;
		if (searchable.slice(previousGridEnd, start).includes('<CardGrid')) invalid = true;
		previousGridEnd = end;
		const originalMatch = markdown.slice(start, end);
		const body = originalMatch.match(/^<CardGrid\s*>([\s\S]*?)<\/CardGrid\s*>$/)?.[1] ?? '';
		const openingEnd = originalMatch.indexOf('>') + 1;
		const closingStart = originalMatch.lastIndexOf('</CardGrid');
		const cardPattern = /<LinkCard\b([^<>]*?)\/\s*>/g;
		const cards: LinkCardData[] = [];
		const separators: string[] = [];
		let cursor = 0;
		for (const cardMatch of body.matchAll(cardPattern)) {
			const cardStart = cardMatch.index ?? 0;
			if (body.slice(cursor, cardStart).trim()) invalid = true;
			const attributes = parseLinkCardAttributes(cardMatch[1]);
			if (!attributes) invalid = true;
			else cards.push({ ...attributes, raw: cardMatch[0], dirty: false });
			if (cards.length > 1) separators.push(body.slice(cursor, cardStart));
			cursor = cardStart + cardMatch[0].length;
		}
		if (body.slice(cursor).trim()) invalid = true;
		const leadingWhitespace = cards.length ? body.slice(0, body.indexOf('<LinkCard')) : '';
		blocks.push({
			start,
			end,
			raw: originalMatch,
			openingTag: originalMatch.slice(0, openingEnd),
			closingTag: originalMatch.slice(closingStart),
			leadingWhitespace,
			separators,
			trailingWhitespace: cards.length ? body.slice(cursor) : body,
			cards,
			dirty: false,
			deleted: false,
		});
	}
	const openingCount = [...searchable.matchAll(/<CardGrid\s*>/g)].length;
	const closingCount = [...searchable.matchAll(/<\/CardGrid\s*>/g)].length;
	const linkCardCount = [...searchable.matchAll(/<LinkCard\b/g)].length;
	if (
		openingCount !== closingCount ||
		openingCount !== blocks.length ||
		linkCardCount !== blocks.reduce((count, block) => count + block.cards.length, 0)
	) {
		invalid = true;
	}
	if (/<\/?CardGrid\b/.test(searchable) && blocks.length === 0) invalid = true;
	if (/<\/?LinkCard\b/.test(searchable) && blocks.length === 0) invalid = true;
	return { blocks, invalid };
}

function escapeJsxAttribute(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/"/g, '&quot;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/\r\n?|\n/g, '&#10;');
}

export function serializeCardGrid(block: CardGridBlock): string {
	if (!block.dirty) return block.raw;
	let body = block.leadingWhitespace;
	for (const [index, card] of block.cards.entries()) {
		if (index > 0) body += block.separators[index - 1] ?? '\n\n';
		body += card.dirty
			? `<LinkCard\n\ttitle="${escapeJsxAttribute(card.title)}"\n\thref="${escapeJsxAttribute(card.href)}"\n\tdescription="${escapeJsxAttribute(card.description)}"\n/>`
			: card.raw ?? '';
	}
	body += block.trailingWhitespace;
	return `${block.openingTag}${body}${block.closingTag}`;
}
