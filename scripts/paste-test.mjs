import assert from "node:assert/strict";
import {
	IMAGE_MAX_BYTES,
	IMAGE_MAX_COUNT,
	PASTE_MAX_CHARS,
	expandPastes,
	imageFiles,
	imageMimeType,
	imageProblem,
	pasteMarker,
	readClipboard,
} from "../web/src/paste.js";

// short single-line clips stay inline
assert.equal(readClipboard("hello").large, false);
assert.equal(readClipboard("a\nb\nc").large, false);

// 11 lines crosses the TUI threshold, 10 does not
assert.equal(readClipboard(Array(10).fill("x").join("\n")).large, false);
assert.equal(readClipboard(Array(11).fill("x").join("\n")).large, true);

// chars only collapse above the char threshold
assert.equal(readClipboard("x".repeat(PASTE_MAX_CHARS)).large, false);
assert.equal(readClipboard("x".repeat(PASTE_MAX_CHARS + 1)).large, true);

// markers match the TUI wording
assert.deepEqual(pasteMarker(1, Array(48).fill("x").join("\n")), {
	text: Array(48).fill("x").join("\n"),
	marker: "[paste #1 +48 lines]",
});
assert.equal(pasteMarker(2, "y".repeat(1500)).marker, "[paste #2 1500 chars]");

// CRLF normalizes and tabs expand before counting
assert.equal(readClipboard("a\r\nb\rc").text, "a\nb\nc");
assert.equal(readClipboard("\tx").text, "    x");

// expansion is by id, unknown ids stay as typed, text around markers is preserved
const pastes = new Map([
	[1, "line1\nline2"],
	[2, "payload"],
]);
assert.equal(expandPastes("[paste #1 +2 lines] and [paste #2 7 chars]", pastes), "line1\nline2 and payload");
assert.equal(expandPastes("see [paste #9 +3 lines]", pastes), "see [paste #9 +3 lines]");
assert.equal(expandPastes("no markers", pastes), "no markers");

// clipboard items: only file-backed images attach, text and other files stay with the browser
assert.deepEqual(
	imageFiles([
		{ kind: "string", type: "text/plain" },
		{ kind: "file", type: "image/png" },
		{ kind: "file", type: "application/pdf" },
		{ kind: "file", type: "image/jpeg" },
	]).map((item) => item.type),
	["image/png", "image/jpeg"],
);
assert.deepEqual(imageFiles([]), []);
// bmp is droppable/pastable (nife attaches it) even though it is never sent as image/bmp
assert.equal(imageFiles([{ kind: "file", type: "image/bmp" }]).length, 1);

// drop/paste acceptance: what nife can attach, plus extension fallback when the desktop omits a type
assert.equal(imageMimeType({ type: "image/png", name: "a.png" }), "image/png");
assert.equal(imageMimeType({ type: "image/bmp", name: "a.bmp" }), "image/bmp");
assert.equal(imageMimeType({ type: "image/x-ms-bmp", name: "a.bmp" }), "image/bmp");
assert.equal(imageMimeType({ type: "", name: "Screenshot.BMP" }), "image/bmp");
assert.equal(imageMimeType({ type: "", name: "photo.jpeg" }), "image/jpeg");
assert.equal(imageMimeType({ type: "application/pdf", name: "a.pdf" }), null);
assert.equal(imageMimeType({ type: "", name: "notes.md" }), null);
assert.equal(imageMimeType({ type: "image/svg+xml", name: "a.svg" }), null);
// ...and the bridge still refuses bmp, because the browser converts it to png before sending
assert.match(imageProblem([{ mimeType: "image/bmp", data: "Qk0=" }]), /unsupported image type/);

// image blocks are accepted only when the bridge would accept them too
assert.equal(imageProblem([]), null);
assert.equal(imageProblem([{ mimeType: "image/png", data: "iVBORw0KGgo=" }]), null);
assert.match(imageProblem([{ mimeType: "image/svg+xml", data: "PHN2Zz4=" }]), /unsupported image type/);
assert.match(imageProblem([{ mimeType: "image/png", data: "not base64!" }]), /malformed image data/);
assert.match(imageProblem([{ mimeType: "image/png", data: "A".repeat(IMAGE_MAX_BYTES + 1) }]), /too large/);
assert.match(
	imageProblem(Array.from({ length: IMAGE_MAX_COUNT + 1 }, () => ({ mimeType: "image/png", data: "AAAA" }))),
	/at most/,
);

console.log("paste ok");
