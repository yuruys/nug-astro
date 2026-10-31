// @ts-check
import { defineConfig } from 'astro/config';

import starlight from '@astrojs/starlight';
import sitemap from '@astrojs/sitemap';

import remarkGuideAdmonition from './src/plugins/remark-guide-admonition.mjs';


export default defineConfig({
	site: 'https://yuruport.com',

	// Astro Dev Toolbarを非表示にする
	devToolbar: {
		enabled: false,
	},

	// ========================================
	// Markdown
	// ========================================

	markdown: {
		remarkPlugins: [
			remarkGuideAdmonition,
		],
	},

	// ========================================
	// Integrations
	// ========================================

	integrations: [
			 sitemap({
       	 filter: (page) => {
            	const pathname = new URL(page).pathname;

	            return !['/admin', '/account', '/wiki'].some(
	                (prefix) =>
	                    pathname === prefix ||
	                    pathname.startsWith(`${prefix}/`),
	            );
	        },
	    }),

		starlight({
			title: 'ゆるぽーと',

			customCss: [
				'./src/styles/starlight.css',
			],

			components: {
				Header: './src/components/layout/Header.astro',
				Head: './src/components/layout/StarlightHead.astro',
				ThemeProvider: './src/components/layout/NugThemeProvider.astro',
			},

			sidebar: [
				{
					label: 'サーバー',
					items: [{ autogenerate: { directory: 'docs/servers' } }],
				},
				{
					label: 'プラグイン',
					items: [{ autogenerate: { directory: 'docs/plugins' } }],
				},
				{
					label: 'Mod',
					items: [{ autogenerate: { directory: 'docs/mods' } }],
				},
			],
		}),
	],
});