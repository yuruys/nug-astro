import type { EditorDocument, EditorResult } from '../editor-types.ts';
import { createEditorDocument, getEditorFormat, serializeEditorDocument } from '../editor-source.ts';

export type ArticleContentType = 'guide' | 'news';

export function createArticleEditorDocument<TContentType extends ArticleContentType>(
	contentType: TContentType,
	filePath: string,
	source: string,
): EditorDocument<TContentType> {
	return createEditorDocument(contentType, getEditorFormat(filePath), source);
}

export function serializeArticleEditorDocument(
	document: EditorDocument<ArticleContentType>,
	result: EditorResult,
): string {
	return serializeEditorDocument(document, result);
}
