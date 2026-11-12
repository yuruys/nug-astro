import { Crepe } from '@milkdown/crepe';
import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/classic.css';

export interface MarkdownSurface {
	getMarkdown(): string;
	destroy(): Promise<void>;
}

/**
 * Mounts the reusable Markdown visual editor without binding it to an app's
 * content model, storage API, authentication, or publishing workflow.
 */
export async function mountMarkdownSurface(
	root: HTMLElement,
	markdown: string,
	onMarkdownUpdate: () => void,
): Promise<MarkdownSurface> {
	const crepe = new Crepe({
		root,
		defaultValue: markdown,
		features: {
			[Crepe.Feature.Toolbar]: true,
			[Crepe.Feature.ImageBlock]: false,
		},
	});

	crepe.on((listener) => listener.markdownUpdated(onMarkdownUpdate));
	await crepe.create();

	return {
		getMarkdown: () => crepe.getMarkdown(),
		destroy: async () => {
			await crepe.destroy();
		},
	};
}
