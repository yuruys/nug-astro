import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";


/* ========================================
   Wiki
======================================== */

const wiki = defineCollection({

	loader: glob({
		pattern: "**/*.md",
		base: "./src/content/wiki",
	}),

	schema: z.object({

		title: z.string(),

		description: z.string().optional(),

		category: z.string().optional(),

		icon: z.string().optional(),

		order: z.number().optional(),

	}),

});


/* ========================================
   News
======================================== */

const news = defineCollection({

	loader: glob({
		pattern: "**/*.md",
		base: "./src/content/news",
	}),

	schema: z.object({

		title: z.string(),

		description: z.string().optional(),

		category: z.string().optional(),

		icon: z.string().optional(),

		date: z.coerce.date().optional(),

		order: z.number().optional(),

	}),

});


/* ========================================
   Tool
======================================== */

const tool = defineCollection({

	loader: glob({
		pattern: "**/*.md",
		base: "./src/content/tool",
	}),

	schema: z.object({

		title: z.string(),

		description: z.string().optional(),

		category: z.string().optional(),

		icon: z.string().optional(),

		order: z.number().optional(),

	}),

});


/* ========================================
   Collections
======================================== */

export const collections = {

	wiki,

	news,

	tool,

};