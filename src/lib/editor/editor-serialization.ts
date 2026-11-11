interface MarkdownBlock {
	start: number;
	end: number;
	raw: string;
	signature: string;
}

function tableCells(line: string): string[] {
	let value = line.trim();
	if (value.startsWith('|')) value = value.slice(1);
	if (value.endsWith('|')) value = value.slice(0, -1);
	const cells: string[] = [];
	let cell = '';
	let escaped = false;
	for (const character of value) {
		if (character === '|' && !escaped) {
			cells.push(cell.trim());
			cell = '';
		} else {
			cell += character;
		}
		escaped = character === '\\' && !escaped;
		if (character !== '\\') escaped = false;
	}
	cells.push(cell.trim());
	return cells;
}

function getLines(value: string) {
	const lines: { text: string; start: number; end: number }[] = [];
	let offset = 0;
	for (const text of value.split('\n')) {
		lines.push({ text, start: offset, end: offset + text.length });
		offset += text.length + 1;
	}
	return lines;
}

function tableBlocks(value: string): MarkdownBlock[] {
	const lines = getLines(value);
	const blocks: MarkdownBlock[] = [];
	for (let index = 0; index + 1 < lines.length; index += 1) {
		const header = tableCells(lines[index].text);
		const separator = tableCells(lines[index + 1].text);
		if (
			!lines[index].text.includes('|') ||
			header.length !== separator.length ||
			!separator.every((cell) => /^:?-+:?$/.test(cell))
		) {
			continue;
		}
		const rows = [header];
		let endIndex = index + 1;
		while (endIndex + 1 < lines.length && lines[endIndex + 1].text.includes('|')) {
			endIndex += 1;
			rows.push(tableCells(lines[endIndex].text));
		}
		const start = lines[index].start;
		const end = lines[endIndex].end;
		blocks.push({
			start,
			end,
			raw: value.slice(start, end),
			signature: JSON.stringify(rows),
		});
		index = endIndex;
	}
	return blocks;
}

function listBlocks(value: string): MarkdownBlock[] {
	const lines = getLines(value);
	const blocks: MarkdownBlock[] = [];
	const marker = /^\s*(?:[-+*]|\d+[.)])\s+(.+)$/;
	for (let index = 0; index < lines.length; index += 1) {
		if (!marker.test(lines[index].text)) continue;
		const items: string[] = [];
		const start = lines[index].start;
		let endIndex = index;
		while (endIndex < lines.length && marker.test(lines[endIndex].text)) {
			const match = lines[endIndex].text.match(marker);
			items.push(match?.[1].trim() ?? '');
			endIndex += 1;
		}
		const end = lines[endIndex - 1].end;
		blocks.push({
			start,
			end,
			raw: value.slice(start, end),
			signature: JSON.stringify(items),
		});
		index = endIndex - 1;
	}
	return blocks;
}

function paragraphBlocks(value: string): MarkdownBlock[] {
	const lines = getLines(value);
	const blocks: MarkdownBlock[] = [];
	const blockStart = /^\s*(?:#{1,6}\s|>|`{3,}|~{3,}|:::+|(?:[-+*]|\d+[.)])\s|<\/?[A-Za-z][A-Za-z0-9.-]*(?:\s|\/?>)|(?:\*\s*){3,}|(?:-\s*){3,})/;
	for (let index = 0; index < lines.length;) {
		if (!lines[index].text.trim() || blockStart.test(lines[index].text)) {
			index += 1;
			continue;
		}
		const startIndex = index;
		while (
			index < lines.length &&
			lines[index].text.trim() &&
			!blockStart.test(lines[index].text)
		) {
			index += 1;
		}
		const start = lines[startIndex].start;
		const end = lines[index - 1].end;
		const raw = value.slice(start, end);
		blocks.push({ start, end, raw, signature: raw.replace(/\s+/g, ' ').trim() });
	}
	return blocks;
}

function restoreUnchangedImages(original: string, edited: string): string {
	const imagePattern = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+(['"])[^)\r\n]*\3)?\)/g;
	const originals = new Map<string, string[]>();
	for (const match of original.matchAll(imagePattern)) {
		const destination = match[2].replace(/^<|>$/g, '');
		const queue = originals.get(destination) ?? [];
		queue.push(match[0]);
		originals.set(destination, queue);
	}

	const replacements: { start: number; end: number; value: string }[] = [];
	for (const match of edited.matchAll(imagePattern)) {
		const destination = match[2].replace(/^<|>$/g, '');
		const originalImage = originals.get(destination)?.shift();
		if (!originalImage || originalImage === match[0]) continue;
		const start = match.index ?? 0;
		replacements.push({ start, end: start + match[0].length, value: originalImage });
	}
	let output = edited;
	for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
		output = output.slice(0, replacement.start) + replacement.value + output.slice(replacement.end);
	}
	return output;
}

function restoreEquivalentBlocks(original: string, edited: string, getBlocks: (value: string) => MarkdownBlock[]): string {
	const originalBlocks = getBlocks(original);
	const queues = new Map<string, MarkdownBlock[]>();
	for (const block of originalBlocks) {
		const queue = queues.get(block.signature) ?? [];
		queue.push(block);
		queues.set(block.signature, queue);
	}

	const replacements: { start: number; end: number; value: string }[] = [];
	for (const block of getBlocks(edited)) {
		const originalBlock = queues.get(block.signature)?.shift();
		if (originalBlock && originalBlock.raw !== block.raw) {
			replacements.push({ start: block.start, end: block.end, value: originalBlock.raw });
		}
	}
	let output = edited;
	for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
		output = output.slice(0, replacement.start) + replacement.value + output.slice(replacement.end);
	}
	return output;
}

export function preserveUntouchedMarkdown(original: string, edited: string): string {
	const source = original.replace(/\r\n?/g, '\n');
	const serialized = restoreUnchangedImages(source, edited.replace(/\r\n?/g, '\n'));
	const withTables = restoreEquivalentBlocks(source, serialized, tableBlocks);
	const withLists = restoreEquivalentBlocks(source, withTables, listBlocks);
	return restoreEquivalentBlocks(source, withLists, paragraphBlocks);
}
