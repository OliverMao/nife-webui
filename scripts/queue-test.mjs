import assert from "node:assert/strict";
import {
	QUEUE_MAX_ITEMS,
	imageBytes,
	metaOf,
	previewOf,
	promptTextOf,
	queueProblem,
} from "../web/src/queue.js";

const item = (extra = {}) => ({ text: "hi", images: [], files: [], ...extra });

assert.equal(queueProblem([], item()), null);
assert.equal(
	queueProblem(Array.from({ length: QUEUE_MAX_ITEMS }, () => item()), item()),
	`queue is full (${QUEUE_MAX_ITEMS})`,
);

// 40MB of base64 across the whole queue, not per item
const big = (mb) => item({ images: [{ data: "A".repeat(mb * 1024 * 1024) }] });
assert.equal(queueProblem([], big(39)), null);
assert.match(queueProblem([big(30)], big(15)), /40MB/);
assert.equal(imageBytes([{ data: "AAAA" }, { data: "AA" }, {}]), 6);
assert.equal(imageBytes(undefined), 0);

// rows are one line: whitespace collapses, long text truncates with an ellipsis
assert.equal(previewOf("  a\n\n b\tc  "), "a b c");
assert.equal(previewOf(undefined), "");
assert.equal(previewOf("x".repeat(200)).length, 121);
assert.equal(metaOf(item()), "");
assert.equal(metaOf(item({ images: [{}, {}], files: [{}] })), "2 images · 1 file");
assert.equal(metaOf(item({ images: [{}] })), "1 image");
assert.equal(metaOf(item({ files: [{}, {}, {}] })), "3 files");

// the prompt body is exactly what an immediate send would have produced
assert.equal(promptTextOf(item({ text: "look" })), "look");
assert.equal(
	promptTextOf(item({ text: "look", files: [{ name: "a.pdf", path: "/tmp/nife-webui/1-abc/a1.pdf" }] })),
	'look\n\n[attached] {"name":"a.pdf","path":"/tmp/nife-webui/1-abc/a1.pdf"}',
);
assert.equal(
	promptTextOf(item({ text: "", files: [{ name: "a.pdf", path: "/tmp/a1.pdf" }] })),
	'[attached] {"name":"a.pdf","path":"/tmp/a1.pdf"}',
);

console.log("queue ok");
