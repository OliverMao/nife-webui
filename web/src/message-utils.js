import { renderMarkdown } from "./markdown.js";

const htmlCache = new WeakMap();

/** Markdown is rendered once per block; committed blocks never change. */
export const mdOf = (block) => {
	let cached = htmlCache.get(block);
	if (cached === undefined) {
		cached = renderMarkdown(block.text);
		htmlCache.set(block, cached);
	}
	return cached;
};

export const blocksOf = (message) => (Array.isArray(message.content) ? message.content : []);

export const imagesOf = (content) => (Array.isArray(content) ? content.filter((b) => b?.type === "image") : []);

export const dataUrl = (image) => `data:${image.mimeType};base64,${image.data}`;

export const textOf = (content) => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b) => b?.type === "text")
		.map((b) => b.text)
		.join("\n");
};

const VERBS = {
	bash: "Ran",
	read: "Read",
	write: "Wrote",
	edit: "Edited",
	grep: "Searched",
	find: "Listed",
	ls: "Listed",
	web_search: "Searched web",
	web_fetch: "Fetched",
	subagent: "Delegated",
};
const ARG_KEYS = ["command", "file_path", "path", "pattern", "query", "url", "prompt"];

export const toolLabel = (block) => VERBS[block.name] ?? block.name;

export const toolArg = (block) => {
	const args = block.arguments ?? {};
	if (block.name === "subagent") {
		const first = Array.isArray(args.tasks) ? args.tasks[0] : Array.isArray(args.chain) ? args.chain[0] : undefined;
		const agent = typeof args.agent === "string" ? args.agent : (first?.agent ?? "");
		const task = typeof args.task === "string" ? args.task : (first?.task ?? "");
		const label = [agent, task].filter(Boolean).join(" · ");
		const extra = Array.isArray(args.tasks) ? args.tasks.length - 1 : Array.isArray(args.chain) ? args.chain.length - 1 : 0;
		const text = extra > 0 ? `${label} (+${extra})` : label;
		return text.length > 90 ? `${text.slice(0, 90)}…` : text;
	}
	const key = ARG_KEYS.find((k) => typeof args[k] === "string");
	if (!key) return "";
	const value = args[key].trim().replace(/\s+/g, " ");
	return value.length > 90 ? `${value.slice(0, 90)}…` : value;
};
