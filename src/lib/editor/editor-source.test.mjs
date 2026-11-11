import assert from 'node:assert/strict';
import test from 'node:test';
import {
	createEditorDocument,
	createEditorResult,
	getEditorFormat,
	requiresSourceMode,
	serializeEditorDocument,
} from './editor-source.ts';
import {
	createArticleEditorDocument,
	serializeArticleEditorDocument,
} from './adapters/article-content.ts';
import { preserveUntouchedMarkdown } from './editor-serialization.ts';
import {
	toWikiEditRequestContent,
	toWikiManagedDraftContent,
} from './adapters/wiki-source.ts';
import { parseAdmonitions, serializeAdmonition } from './blocks/admonition.ts';
import { parseCardGrids, serializeCardGrid } from './blocks/starlight-card-grid.ts';

test('unchanged source is returned byte-for-byte, including Japanese text and spacing', () => {
	const source = '\uFEFF---\r\ntitle: 日本語\r\n---\r\n\n  本文  \r\n';
	const document = createEditorDocument('guide', 'md', source);
	const result = createEditorResult(document, document.body, 'source');

	assert.equal(result.changed, false);
	assert.equal(serializeEditorDocument(document, result), source);
});

test('unmodified visual serialization does not replace the original body', () => {
	const source = '# 見出し\n\n段落  の空白\n';
	const document = createEditorDocument('guide', 'md', source);
	const milkdownSerialization = '# 見出し\n\n段落 の空白\n';
	const result = createEditorResult(document, milkdownSerialization, 'visual');

	assert.equal(result.changed, false);
	assert.equal(serializeEditorDocument(document, result), source);
});

test('frontmatter is separated from the body and preserved during reconstruction', () => {
	const frontmatter = '---\ntitle: 記事\ncustom: [raw, yaml]\n---\n';
	const document = createEditorDocument('news', 'md', `${frontmatter}本文\n`);
	const result = createEditorResult(document, `${document.body}追記\n`, 'source');

	assert.equal(document.frontmatterRaw, frontmatter);
	assert.equal(document.body, '本文\n');
	assert.equal(serializeEditorDocument(document, result), `${frontmatter}本文\n追記\n`);
});

test('body-only articles keep leading horizontal rules out of frontmatter', () => {
	const source = '---\ntitle: 日本語\n---\n本文\n';
	const document = createEditorDocument('news', 'md', source, { bodyOnly: true });
	const result = createEditorResult(document, document.body, 'source');

	assert.equal(document.frontmatterRaw, undefined);
	assert.equal(document.body, source);
	assert.equal(serializeEditorDocument(document, result), source);
});

test('MDX import statements remain untouched', () => {
	const source = "import Unknown from './unknown';\n\n本文\n";
	const document = createEditorDocument('wiki', 'mdx', source);
	const unchanged = createEditorResult(document, document.body, 'source');

	assert.equal(serializeEditorDocument(document, unchanged), source);
});

test('CardGrid and LinkCard markup remain untouched', () => {
	const source = [
		"import { CardGrid, LinkCard } from '@astrojs/starlight/components';",
		'',
		'<CardGrid>',
		'  <LinkCard title="日本語" href="/docs/" description="原文" />',
		'</CardGrid>',
		'',
	].join('\n');
	const document = createEditorDocument('wiki', 'mdx', source);
	const result = createEditorResult(document, `${document.body}末尾\n`, 'source');

	assert.equal(serializeEditorDocument(document, result), `${source}末尾\n`);
	assert.match(serializeEditorDocument(document, result), /^import \{ CardGrid, LinkCard \}/);
	assert.match(serializeEditorDocument(document, result), /<LinkCard title="日本語" href="\/docs\/" description="原文" \/>/);
});

test('unknown JSX is retained and triggers safe source mode', () => {
	const body = '<UnknownWidget>未知の本文</UnknownWidget>';
	const document = createEditorDocument('wiki', 'mdx', body);
	const result = createEditorResult(document, body, 'source');

	assert.equal(requiresSourceMode(body, 'mdx'), true);
	assert.equal(serializeEditorDocument(document, result), body);
});

test('JSX attributes and expressions are retained without conversion', () => {
	const body = [
		'<UnknownWidget label="日本語" custom={someValue}>',
		'  {calculate(value)}',
		'</UnknownWidget>',
	].join('\n');
	const document = createEditorDocument('wiki', 'mdx', body);
	const result = createEditorResult(document, body, 'source');

	assert.equal(serializeEditorDocument(document, result), body);
	assert.match(serializeEditorDocument(document, result), /custom=\{someValue\}/);
	assert.match(serializeEditorDocument(document, result), /\{calculate\(value\)\}/);
});

test('Starlight admonitions and code-fenced examples are handled conservatively', () => {
	assert.equal(requiresSourceMode(':::note\n保持\n:::\n', 'mdx'), true);
	assert.equal(requiresSourceMode('```mdx\n<UnknownWidget />\n```\n', 'mdx'), false);
});

test('LF line endings remain intact after an unrelated edit', () => {
	const source = '前\n\n変更対象\n\n後\n';
	const document = createEditorDocument('guide', 'md', source);
	const result = createEditorResult(document, document.body.replace('変更対象', '更新済み'), 'visual', { hasUserChanges: true });

	assert.equal(serializeEditorDocument(document, result), source.replace('変更対象', '更新済み'));
});

test('CRLF line endings remain intact after an unrelated edit', () => {
	const source = '前\n\n変更対象\n\n後\n'.replaceAll('\n', '\r\n');
	const document = createEditorDocument('guide', 'md', source);
	const result = createEditorResult(document, document.body.replace('変更対象', '更新済み'), 'visual', { hasUserChanges: true });

	assert.equal(serializeEditorDocument(document, result), source.replace('変更対象', '更新済み'));
});

test('UTF-8 BOM is retained', () => {
	const source = '\uFEFF本文';
	const document = createEditorDocument('guide', 'md', source);
	const result = createEditorResult(document, document.body, 'source');

	assert.equal(serializeEditorDocument(document, result), source);
});

test('the original final-newline state is retained', () => {
	const source = '前\n後\n';
	const document = createEditorDocument('guide', 'md', source);
	const result = createEditorResult(document, '前\n更新\n後', 'visual', { hasUserChanges: true });

	assert.equal(serializeEditorDocument(document, result), '前\n更新\n後\n');
});

test('a localized edit leaves unrelated source bytes unchanged', () => {
	const source = '先頭  \n\n対象文\n\n  末尾\n';
	const document = createEditorDocument('guide', 'md', source);
	const result = createEditorResult(document, document.body.replace('対象文', '変更文'), 'visual', { hasUserChanges: true });

	assert.equal(serializeEditorDocument(document, result), '先頭  \n\n変更文\n\n  末尾\n');
});

test('file extensions distinguish Markdown and MDX', () => {
	assert.equal(getEditorFormat('article.md'), 'md');
	assert.equal(getEditorFormat('docs/ARTICLE.MDX'), 'mdx');
	assert.throws(() => getEditorFormat('article.txt'), /Unsupported editor file format/);
});

test('Guide and News use the article adapter with the original format', () => {
	const guide = createArticleEditorDocument('guide', 'guide.md', 'Guide本文\n');
	const news = createArticleEditorDocument('news', 'news.mdx', 'News本文\n');
	const guideResult = createEditorResult(guide, guide.body, 'source');
	const newsResult = createEditorResult(news, news.body, 'source');

	assert.equal(guide.format, 'md');
	assert.equal(news.format, 'mdx');
	assert.equal(serializeArticleEditorDocument(guide, guideResult), 'Guide本文\n');
	assert.equal(serializeArticleEditorDocument(news, newsResult), 'News本文\n');
});

test('Wiki edit requests contain body only while managed drafts retain frontmatter', () => {
	const frontmatter = '---\ntitle: 管理用タイトル\n---\n';
	const document = createEditorDocument('wiki', 'mdx', `${frontmatter}本文\n`);
	const result = createEditorResult(document, `${document.body}変更\n`, 'source');

	assert.deepEqual(toWikiEditRequestContent(result), { body: '本文\n変更\n' });
	assert.deepEqual(toWikiManagedDraftContent(document, result), {
		source: `${frontmatter}本文\n変更\n`,
	});
});

test('source mode is the default safety classification for MDX extensions', () => {
	assert.equal(requiresSourceMode('import Widget from "./widget";\n', 'mdx'), true);
	assert.equal(requiresSourceMode('<UnknownWidget />\n', 'mdx'), true);
	assert.equal(requiresSourceMode('Plain **Markdown**\n', 'mdx'), false);
	assert.equal(requiresSourceMode('<UnknownWidget />\n', 'md'), false);
});

test('supported admonitions parse and only serialize an edited block', () => {
	const source = '先頭  \n\n:::note[補足]\n原文の本文\n:::\n\n末尾\n';
	const parsed = parseAdmonitions(source);
	assert.equal(parsed.invalid, false);
	assert.equal(parsed.blocks.length, 1);
	parsed.blocks[0].title = '更新';
	parsed.blocks[0].dirty = true;
	assert.equal(
		source.slice(0, parsed.blocks[0].start) + serializeAdmonition(parsed.blocks[0]) + source.slice(parsed.blocks[0].end),
		'先頭  \n\n:::note[更新]\n原文の本文\n:::\n\n末尾\n',
	);
});

test('nested and unknown admonitions are rejected for visual editing', () => {
	assert.equal(parseAdmonitions(':::unknown\n本文\n:::\n').invalid, true);
	assert.equal(parseAdmonitions(':::note\n:::tip\n内側\n:::\n:::\n').invalid, true);
	assert.equal(parseAdmonitions('```md\n:::note\n:::\n```\n').invalid, false);
});

test('LinkCard attributes are strictly parsed and raw markup is kept until edited', () => {
	const source = '<CardGrid>\n  <LinkCard description="説明" href="/docs/" title="日本語" />\n</CardGrid>';
	const parsed = parseCardGrids(source);
	assert.equal(parsed.invalid, false);
	assert.equal(parsed.blocks.length, 1);
	assert.equal(serializeCardGrid(parsed.blocks[0]), source);
	assert.equal(parseCardGrids('<CardGrid><LinkCard title="x" href="/" description="y" custom={x} /></CardGrid>').invalid, true);
});

test('CardGrid serializer escapes edits while leaving fenced examples untouched', () => {
	const source = [
		'```mdx',
		'<CardGrid><LinkCard title="sample" href="/" description="example" /></CardGrid>',
		'```',
		'<CardGrid>\n  <LinkCard description="keep spacing" href="/other/" title="unchanged" />\n  <LinkCard title="original" href="/" description="description" />\n</CardGrid>',
	].join('\n');
	const parsed = parseCardGrids(source);
	assert.equal(parsed.invalid, false);
	assert.equal(parsed.blocks.length, 1);
	parsed.blocks[0].cards[1].title = '更新 "済み"';
	parsed.blocks[0].cards[1].dirty = true;
	parsed.blocks[0].dirty = true;
	const updated = source.slice(0, parsed.blocks[0].start) +
		serializeCardGrid(parsed.blocks[0]) +
		source.slice(parsed.blocks[0].end);
	assert.match(updated, /<CardGrid><LinkCard title="sample"/);
	assert.match(updated, /title="更新 &quot;済み&quot;"/);
	assert.match(updated, /\n  <LinkCard description="keep spacing" href="\/other\/" title="unchanged" \/>\n  <LinkCard/);
});

test('visual serialization keeps unchanged table and list source formatting', () => {
	const original = [
		'前の文章',
		'',
		'- ひとつ',
		'- ふたつ',
		'',
		'| 項目 | 値 |',
		'| --- | --- |',
		'| Milkdown | 有効 |',
		'',
		'変更前',
	].join('\n');
	const milkdown = [
		'前の文章',
		'',
		'* ひとつ',
		'* ふたつ',
		'',
		'| 項目 | 値 |',
		'| -------- | -- |',
		'| Milkdown | 有効 |',
		'',
		'変更後',
	].join('\n');
	assert.equal(
		preserveUntouchedMarkdown(original, milkdown),
		milkdown.replace('* ひとつ\n* ふたつ', '- ひとつ\n- ふたつ')
			.replace('| 項目 | 値 |\n| -------- | -- |\n| Milkdown | 有効 |', '| 項目 | 値 |\n| --- | --- |\n| Milkdown | 有効 |'),
	);
});

test('visual serialization retains spacing in unchanged paragraphs', () => {
	const original = '# 見出し\n\n原文の  空白は保持\n\n変更前\n';
	const edited = '# 見出し\n\n原文の 空白は保持\n\n変更後\n';
	assert.equal(
		preserveUntouchedMarkdown(original, edited),
		'# 見出し\n\n原文の  空白は保持\n\n変更後\n',
	);
});

test('visual serialization retains the original image markup when its URL is unchanged', () => {
	const original = '本文\n\n![画像の説明](/images/example.webp)\n';
	const edited = '変更後の本文\n\n![1.00](/images/example.webp)\n';
	assert.equal(
		preserveUntouchedMarkdown(original, edited),
		'変更後の本文\n\n![画像の説明](/images/example.webp)\n',
	);
});
