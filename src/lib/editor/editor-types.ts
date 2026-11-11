export type EditorContentType = 'guide' | 'news' | 'wiki';
export type EditorFormat = 'md' | 'mdx';
export type EditorMode = 'source' | 'visual';

export interface EditorDocument<TContentType extends EditorContentType = EditorContentType> {
	contentType: TContentType;
	format: EditorFormat;
	body: string;
	originalBody: string;
	frontmatterRaw?: string;
	originalSource?: string;
	sourceHasBom?: boolean;
}

export interface EditorResult {
	body: string;
	changed: boolean;
	mode: EditorMode;
}
