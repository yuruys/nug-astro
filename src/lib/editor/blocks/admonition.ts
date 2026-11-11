export type AdmonitionType = 'note' | 'tip' | 'caution' | 'danger';

export interface AdmonitionBlock {
	start: number;
	end: number;
	type: AdmonitionType;
	title: string;
	body: string;
	raw: string;
	dirty: boolean;
	deleted: boolean;
}

export interface ParsedAdmonitions {
	blocks: AdmonitionBlock[];
	invalid: boolean;
}

export function parseAdmonitions(markdown: string): ParsedAdmonitions {
	const lines: { text: string; start: number; end: number; newlineEnd: number }[] = [];
	const sourceLines = markdown.split('\n');
	let offset = 0;
	for (const [index, text] of sourceLines.entries()) {
		const start = offset;
		offset += text.length + (index < sourceLines.length - 1 ? 1 : 0);
		lines.push({ text, start, end: start + text.length, newlineEnd: offset });
	}

	const blocks: AdmonitionBlock[] = [];
	let invalid = false;
	let fenceCharacter = '';
	let fenceLength = 0;

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		const fence = line.text.match(/^ {0,3}(`{3,}|~{3,})/);
		if (fence) {
			const marker = fence[1];
			if (!fenceCharacter) {
				fenceCharacter = marker[0];
				fenceLength = marker.length;
			} else if (marker[0] === fenceCharacter && marker.length >= fenceLength) {
				fenceCharacter = '';
				fenceLength = 0;
			}
			continue;
		}
		if (fenceCharacter) continue;

		const opening = line.text.match(/^ {0,3}:::([A-Za-z][A-Za-z0-9_-]*)(?:\[([^\]\r\n]*)\])?[ \t]*$/);
		if (!opening) {
			if (/^ {0,3}:::+/.test(line.text)) invalid = true;
			continue;
		}

		let depth = 0;
		let nested = false;
		let closingIndex = -1;
		let innerFenceCharacter = '';
		let innerFenceLength = 0;
		for (let candidate = index + 1; candidate < lines.length; candidate += 1) {
			const candidateLine = lines[candidate];
			const candidateFence = candidateLine.text.match(/^ {0,3}(`{3,}|~{3,})/);
			if (candidateFence) {
				const marker = candidateFence[1];
				if (!innerFenceCharacter) {
					innerFenceCharacter = marker[0];
					innerFenceLength = marker.length;
				} else if (marker[0] === innerFenceCharacter && marker.length >= innerFenceLength) {
					innerFenceCharacter = '';
					innerFenceLength = 0;
				}
				continue;
			}
			if (innerFenceCharacter) continue;
			if (/^ {0,3}:::[ \t]*$/.test(candidateLine.text)) {
				if (depth === 0) {
					closingIndex = candidate;
					break;
				}
				depth -= 1;
				continue;
			}
			if (/^ {0,3}:::[A-Za-z][A-Za-z0-9_-]*(?:\[[^\]\r\n]*\])?[ \t]*$/.test(candidateLine.text)) {
				depth += 1;
				nested = true;
			}
		}

		if (closingIndex < 0) {
			invalid = true;
			break;
		}
		const type = opening[1];
		if (nested || !['note', 'tip', 'caution', 'danger'].includes(type)) {
			invalid = true;
		} else {
			const end = lines[closingIndex].end;
			blocks.push({
				start: line.start,
				end,
				type: type as AdmonitionType,
				title: opening[2] ?? '',
				body: markdown.slice(line.newlineEnd, lines[closingIndex].start),
				raw: markdown.slice(line.start, end),
				dirty: false,
				deleted: false,
			});
		}
		index = closingIndex;
	}

	return { blocks, invalid };
}

export function serializeAdmonition(block: AdmonitionBlock): string {
	if (!block.dirty) return block.raw;
	const body = block.body && !block.body.endsWith('\n') ? `${block.body}\n` : block.body;
	return `:::${block.type}${block.title ? `[${block.title}]` : ''}\n${body}:::`;
}
