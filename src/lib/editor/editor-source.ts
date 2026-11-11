import type { EditorContentType, EditorDocument, EditorFormat, EditorMode, EditorResult } from './editor-types.ts';

const FRONTMATTER_PATTERN = /^---[ \t]*(?:\r\n|\n|\r)[\s\S]*?(?:\r\n|\n|\r)---[ \t]*(?:(?:\r\n|\n|\r)|$)/;

export function getEditorFormat(filePath: string): EditorFormat {
	const fileName = filePath.split(/[\\/]/).pop()?.toLowerCase() ?? '';
	if (fileName.endsWith('.mdx')) return 'mdx';
	if (fileName.endsWith('.md')) return 'md';
	throw new Error(`Unsupported editor file format: ${filePath}`);
}

export function createEditorDocument<TContentType extends EditorContentType>(
	contentType: TContentType,
	format: EditorFormat,
	source: string,
	options: { bodyOnly?: boolean } = {},
): EditorDocument<TContentType> {
	const sourceHasBom = source.startsWith('\uFEFF');
	const sourceWithoutBom = sourceHasBom ? source.slice(1) : source;
	const frontmatterRaw = options.bodyOnly ? undefined : sourceWithoutBom.match(FRONTMATTER_PATTERN)?.[0];
	const body = frontmatterRaw === undefined ? sourceWithoutBom : sourceWithoutBom.slice(frontmatterRaw.length);

	return {
		contentType,
		format,
		body,
		originalBody: body,
		...(frontmatterRaw === undefined ? {} : { frontmatterRaw }),
		originalSource: source,
		sourceHasBom,
	};
}

function normalizeNewlines(value: string): string {
	return value.replace(/\r\n|\r/g, '\n');
}

function newlineSequence(value: string): string {
	return value.match(/\r\n|\n|\r/)?.[0] ?? '\n';
}

function toCanonicalText(value: string): { text: string; rawOffsets: number[] } {
	let text = '';
	const rawOffsets = [0];

	for (let index = 0; index < value.length;) {
		if (value[index] === '\r' && value[index + 1] === '\n') {
			text += '\n';
			index += 2;
		} else {
			text += value[index];
			index += 1;
		}
		rawOffsets.push(index);
	}

	return { text, rawOffsets };
}

function preserveTrailingNewlines(original: string, edited: string): string {
	const trailingNewlines = original.match(/\n*$/)?.[0] ?? '';
	return `${edited.replace(/\n*$/, '')}${trailingNewlines}`;
}

function preserveUntouchedSource(original: string, edited: string): string {
	const originalCanonical = toCanonicalText(original);
	const editedCanonical = toCanonicalText(edited);
	const editedText = preserveTrailingNewlines(originalCanonical.text, editedCanonical.text);

	if (editedText === originalCanonical.text) return original;

	let prefixLength = 0;
	while (
		prefixLength < originalCanonical.text.length &&
		prefixLength < editedText.length &&
		originalCanonical.text[prefixLength] === editedText[prefixLength]
	) {
		prefixLength += 1;
	}

	let suffixLength = 0;
	while (
		suffixLength < originalCanonical.text.length - prefixLength &&
		suffixLength < editedText.length - prefixLength &&
		originalCanonical.text[originalCanonical.text.length - suffixLength - 1] ===
			editedText[editedText.length - suffixLength - 1]
	) {
		suffixLength += 1;
	}

	const originalStart = originalCanonical.rawOffsets[prefixLength];
	const originalEnd = originalCanonical.rawOffsets[originalCanonical.text.length - suffixLength];
	const replacement = editedText.slice(prefixLength, editedText.length - suffixLength)
		.replace(/\n/g, newlineSequence(original));

	return original.slice(0, originalStart) + replacement + original.slice(originalEnd);
}

export function createEditorResult(
	document: EditorDocument,
	editedBody: string,
	mode: EditorMode,
	options: { hasUserChanges?: boolean } = {},
): EditorResult {
	const hasUserChanges = options.hasUserChanges ?? mode === 'source';
	const body = hasUserChanges
		? preserveUntouchedSource(document.originalBody, editedBody)
		: document.originalBody;
	return {
		body,
		changed: body !== document.originalBody,
		mode,
	};
}

export function serializeEditorDocument(document: EditorDocument, result: EditorResult): string {
	if (!result.changed || result.body === document.originalBody) {
		if (document.originalSource !== undefined) return document.originalSource;
	}

	const bom = document.sourceHasBom ? '\uFEFF' : '';
	return `${bom}${document.frontmatterRaw ?? ''}${result.body}`;
}

export function requiresSourceMode(body: string, format: EditorFormat): boolean {
	if (format !== 'mdx') return false;

	let inFence = false;
	for (const line of normalizeNewlines(body).split('\n')) {
		if (/^\s*(```|~~~)/.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;
		if (/^\s*(?:import|export)\s/.test(line)) return true;
		if (/^\s*:::+/.test(line)) return true;
		if (/<\/?[A-Za-z][A-Za-z0-9.-]*(?:\s|\/?>)/.test(line)) return true;
		if (/[{}]/.test(line)) return true;
	}

	return false;
}
