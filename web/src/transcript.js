import { blocksOf } from "./message-utils.js";

// Everything that is not the answer itself: what the model thought and what it ran. Grouping these
// runs keeps the transcript readable for people who do not care how the answer was produced; the
// blocks stay expandable, so nothing is lost.

export const isProcessBlock = (block) => block?.type === "thinking" || block?.type === "toolCall";

/** An assistant message that carries no answer: only thinking and/or tool calls. */
export const isProcessItem = (item) => {
	if (item.kind === "result") return true;
	if (item.kind !== "assistant" || item.message?.errorMessage) return false;
	const blocks = blocksOf(item.message);
	if (blocks.length === 0) return false;
	// whitespace-only text blocks are model noise, not output
	const output = blocks.some((block) => (block?.type === "text" && block.text?.trim()) || block?.type === "image");
	return !output && blocks.some(isProcessBlock);
};

export const countSteps = (blocks) => {
	let tools = 0;
	let thoughts = 0;
	for (const block of blocks) {
		if (block?.type === "toolCall") tools += 1;
		else if (block?.type === "thinking") thoughts += 1;
	}
	return { tools, thoughts };
};

/** A failed tool call hides inside the collapsed row, so the row itself has to warn about it. */
export const failedTool = (blocks, results) =>
	blocks.some((block) => block?.type === "toolCall" && results?.[block.id]?.isError);

export const countItems = (items) => {
	let tools = 0;
	let thoughts = 0;
	let failed = false;
	for (const item of items) {
		// an orphan result has no tool call block of its own
		if (item.kind === "result") {
			tools += 1;
			failed ||= Boolean(item.message?.isError);
			continue;
		}
		const counted = countSteps(blocksOf(item.message));
		tools += counted.tools;
		thoughts += counted.thoughts;
		failed ||= failedTool(blocksOf(item.message), item.results);
	}
	return { tools, thoughts, failed };
};

export const stepLabel = ({ tools, thoughts }) => {
	const parts = [];
	if (tools > 0) parts.push(`${tools} tool${tools === 1 ? "" : "s"}`);
	if (thoughts > 0) parts.push(`${thoughts} thought${thoughts === 1 ? "" : "s"}`);
	return parts.join(" · ");
};

/** Runs of two or more process-only items become one collapsed row; singles stay as they are. */
export const groupItems = (items) => {
	const rows = [];
	let run = [];
	const flush = () => {
		if (run.length > 1) rows.push({ kind: "process", steps: run, counts: countItems(run) });
		else rows.push(...run);
		run = [];
	};
	for (const item of items) {
		if (isProcessItem(item)) {
			run.push(item);
			continue;
		}
		flush();
		rows.push(item);
	}
	flush();
	return rows;
};

/** Same idea inside one message: adjacent thinking/tool blocks collapse together, text does not. */
export const groupBlocks = (blocks) => {
	const segments = [];
	let run = [];
	const flush = () => {
		if (run.length > 1) segments.push({ kind: "process", blocks: run, counts: countSteps(run) });
		else if (run.length === 1) segments.push({ kind: "block", block: run[0] });
		run = [];
	};
	for (const block of blocks) {
		if (isProcessBlock(block)) {
			run.push(block);
			continue;
		}
		flush();
		segments.push({ kind: "block", block });
	}
	flush();
	return segments;
};
