// @ts-check
import { defineConfig } from 'astro/config';

import starlight from '@astrojs/starlight';

export default defineConfig({
	integrations: [
		starlight({
			title: 'NUGBASE Wiki',

			customCss: [
				'./src/styles/starlight.css',
			],

			components: {
				Header: './src/components/StarlightHeader.astro',
				ThemeProvider: './src/components/NugThemeProvider.astro',
			},

			sidebar: [
				{
					label: 'サーバー',
					items: [
						{ label: 'サーバー一覧', link: '/docs/servers/' },
						{ label: 'NEarth', link: '/docs/servers/nearth/' },
						{ label: 'Life', link: '/docs/servers/life/' },
						{ label: 'Cho', link: '/docs/servers/cho/' },
					],
				},
				{
					label: 'プラグイン',
					items: [
						{
							label: 'Lands',
							items: [
								{ label: '概要', link: '/docs/plugins/lands/' },
								{ label: 'コマンド', link: '/docs/plugins/lands/commands/' },
								{ label: '権限・役職', link: '/docs/plugins/lands/roles/' },
								{ label: '外交', link: '/docs/plugins/lands/diplomacy/' },
								{ label: '維持費', link: '/docs/plugins/lands/upkeep/' },
							],
						},
						{
							label: 'QuickShop',
							items: [
								{ label: '概要', link: '/docs/plugins/quickshop/' },
								{ label: 'コマンド', link: '/docs/plugins/quickshop/commands/' },
							],
						},
						{
							label: 'Jobs',
							items: [
								{ label: '概要', link: '/docs/plugins/jobs/' },
								{ label: '職業', link: '/docs/plugins/jobs/professions/' },
							],
						},
						{
							label: 'mcMMO',
							items: [
								{ label: '概要', link: '/docs/plugins/mcmmo/' },
								{ label: 'Mining', link: '/docs/plugins/mcmmo/mining/' },
								{ label: 'Woodcutting', link: '/docs/plugins/mcmmo/woodcutting/' },
								{ label: 'Excavation', link: '/docs/plugins/mcmmo/excavation/' },
								{ label: 'Fishing', link: '/docs/plugins/mcmmo/fishing/' },
								{ label: 'Herbalism', link: '/docs/plugins/mcmmo/herbalism/' },
								{ label: 'Swords', link: '/docs/plugins/mcmmo/swords/' },
								{ label: 'Axes', link: '/docs/plugins/mcmmo/axes/' },
								{ label: 'Archery', link: '/docs/plugins/mcmmo/archery/' },
								{ label: 'Acrobatics', link: '/docs/plugins/mcmmo/acrobatics/' },
							],
						},
						{
							label: 'Bolt',
							items: [
								{ label: '概要', link: '/docs/plugins/bolt/' },
								{ label: 'コマンド', link: '/docs/plugins/bolt/commands/' },
							],
						},
						{
							label: 'PlayerGuard',
							items: [
								{ label: '概要', link: '/docs/plugins/playerguard/' },
								{ label: 'コマンド', link: '/docs/plugins/playerguard/commands/' },
							],
						},
						{
							label: 'LWC',
							items: [
								{ label: '概要', link: '/docs/plugins/lwc/' },
								{ label: 'コマンド', link: '/docs/plugins/lwc/commands/' },
							],
						},
					],
				},
				{
					label: 'Mod',
					items: [
						{ label: '使用可能なMod', link: '/docs/mods/allowed-mods/' },
					],
				},
			],
		}),
	],
});