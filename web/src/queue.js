// UI-level task queue. nife has its own steer/followUp queue that injects into the *running* turn;
// this one is deliberately dumber: the next task is sent as a new message only after the previous
// turn settled, so what the user typed stays a separate turn.
import { attachedLine } from "./files.js";

export const QUEUE_MAX_ITEMS = 20;
export const QUEUE_MAX_IMAGE_BYTES = 40 * 1024 * 1024;
export const QUEUE_PREVIEW_CHARS = 120;

export function imageBytes(images) {
	return (images ?? []).reduce((total, image) => total + (image?.data?.length ?? 0), 0);
}

/** Why this item cannot be queued, or null when it fits. */
export function queueProblem(queue, item) {
	if (queue.length >= QUEUE_MAX_ITEMS) return `queue is full (${QUEUE_MAX_ITEMS})`;
	const used = queue.reduce((total, entry) => total + imageBytes(entry.images), 0);
	if (used + imageBytes(item.images) > QUEUE_MAX_IMAGE_BYTES) return "queued images would exceed 40MB";
	return null;
}

/** One-line preview for the queue row: newlines and runs of spaces collapse, long text truncates. */
export function previewOf(text, max = QUEUE_PREVIEW_CHARS) {
	const line = (text ?? "").replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** "2 images · 1 file", or "" when the item is text only. */
export function metaOf(item) {
	const parts = [];
	const images = item.images?.length ?? 0;
	if (images > 0) parts.push(`${images} image${images === 1 ? "" : "s"}`);
	const files = item.files?.length ?? 0;
	if (files > 0) parts.push(`${files} file${files === 1 ? "" : "s"}`);
	return parts.join(" · ");
}

/** The prompt body for a queued item: typed text plus one marker line per dropped file. */
export function promptTextOf(item) {
	return [item.text, ...(item.files ?? []).map((file) => attachedLine(file))].filter(Boolean).join("\n\n");
}
