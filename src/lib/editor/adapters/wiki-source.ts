import type { EditorDocument, EditorResult } from '../editor-types.ts';
import { serializeEditorDocument } from '../editor-source.ts';

export interface WikiEditRequestContent {
	body: string;
}

export interface WikiManagedDraftContent {
	source: string;
}

export function toWikiEditRequestContent(result: EditorResult): WikiEditRequestContent {
	return { body: result.body };
}

export function toWikiManagedDraftContent(
	document: EditorDocument<'wiki'>,
	result: EditorResult,
): WikiManagedDraftContent {
	return { source: serializeEditorDocument(document, result) };
}
