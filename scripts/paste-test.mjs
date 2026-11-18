import assert from "node:assert/strict";
import { PASTE_MAX_CHARS, expandPastes, pasteMarker, readClipboard } from "../web/src/paste.js";

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

console.log("paste ok");
