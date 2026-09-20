/**
 * NUGBASE Guide Admonition
 *
 * Markdown:
 *
 * :::note[補足]
 * 内容
 * :::
 *
 * :::tip[おすすめ]
 * 内容
 * :::
 *
 * :::caution[注意]
 * 内容
 * :::
 *
 * :::danger[警告]
 * 内容
 * :::
 *
 * :::success[成功例]
 * 内容
 * :::
 */

const ADMONITION_TYPES = new Set([
	"note",
	"tip",
	"caution",
	"danger",
	"success",
]);

export default function remarkGuideAdmonition() {
	return function transformer(tree) {
		visit(tree);
	};

	function visit(node) {
		if (!node || !Array.isArray(node.children)) {
			return;
		}

		for (const child of node.children) {
			if (
				child.type === "containerDirective" &&
				ADMONITION_TYPES.has(child.name)
			) {
				transformAdmonition(child);
			}

			visit(child);
		}
	}

	function transformAdmonition(node) {
		const type = node.name;

		node.data ??= {};

		node.data.hName = "aside";

		node.data.hProperties = {
			className: [
				"guide-admonition",
				`guide-admonition-${type}`,
			],
			"data-admonition": type,
		};

		const label = node.label?.trim();

		if (label) {
			node.children.unshift({
				type: "paragraph",
				data: {
					hProperties: {
						className: ["guide-admonition-title"],
					},
				},
				children: [
					{
						type: "text",
						value: label,
					},
				],
			});
		}
	}
}