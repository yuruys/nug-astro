// @ts-check
import { defineConfig } from 'astro/config';

import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
	integrations: [
		starlight({
			title: 'NUGBASE Wiki',

			customCss: [
				'./src/styles/starlight.css',
			],

			components: {
				Header: './src/components/StarlightHeader.astro',
			},
		}),
	],
});