import assert from "node:assert/strict";
import { countItems, failedTool, groupBlocks, groupItems, isProcessItem, stepLabel } from "../web/src/transcript.js";

const thinking = (text) => ({ type: "thinking", thinking: text });
const toolCall = (id) => ({ type: "toolCall", id, name: "bash", arguments: { command: "ls" } });
const text = (t) => ({ type: "text", text: t });
const assistant = (content, extra = {}) => ({
	kind: "assistant",
	message: { role: "assistant", content },
	results: {},
	...extra,
});

// A message that only thinks or only runs a tool is process; the answer itself is not.
assert.equal(isProcessItem(assistant([thinking("hm")])), true);
assert.equal(isProcessItem(assistant([toolCall("a")])), true);
assert.equal(isProcessItem(assistant([thinking("hm"), toolCall("a")])), true);
assert.equal(isProcessItem(assistant([text("here is the answer")])), false);
assert.equal(isProcessItem(assistant([thinking("hm"), toolCall("a"), text("answer")])), false, "text wins");
assert.equal(isProcessItem(assistant([text("   ")])), false, "whitespace is not an answer either way");
assert.equal(isProcessItem(assistant([thinking("hm"), { type: "image", data: "x", mimeType: "image/png" }])), false);
assert.equal(isProcessItem(assistant([text("oops")], { message: { role: "assistant", content: [], errorMessage: "boom" } })), false);
assert.equal(isProcessItem({ kind: "result", message: { toolName: "bash" }, results: {} }), true);
assert.equal(isProcessItem({ kind: "user", message: { role: "user", content: "hi" }, results: {} }), false);

// Runs of process items collapse into one row; the answers stay outside.
const user = { kind: "user", message: { role: "user", content: "do it" }, results: {} };
const rows = groupItems([
	user,
	assistant([thinking("plan")]),
	assistant([toolCall("a")]),
	assistant([toolCall("b")]),
	assistant([text("done")]),
	assistant([toolCall("c")]),
]);
assert.equal(rows.length, 4, "user, one collapsed run, the answer, then a lone step");
assert.equal(rows[1].kind, "process");
assert.equal(rows[1].steps.length, 3);
assert.equal(stepLabel(rows[1].counts), "2 tools · 1 thought");
assert.equal(rows[2].kind, "assistant");
assert.equal(rows[3].kind, "assistant", "a single step keeps its own row");

// Orphan tool results count as tools and join the run in front of them.
const orphan = { kind: "result", message: { toolName: "grep" }, results: {} };
const withOrphan = groupItems([assistant([toolCall("a")]), orphan]);
assert.equal(withOrphan.length, 1);
assert.equal(stepLabel(withOrphan[0].counts), "2 tools");

// Inside one message: adjacent thinking/tool blocks collapse, text stays out.
const segments = groupBlocks([
	thinking("plan"),
	toolCall("a"),
	text("The answer."),
	toolCall("b"),
	text("More."),
]);
assert.equal(segments.length, 4);
assert.equal(segments[0].kind, "process");
assert.equal(stepLabel(segments[0].counts), "1 tool · 1 thought");
assert.equal(segments[1].block.type, "text");
assert.equal(segments[2].kind, "block", "a lone block is not wrapped");
assert.equal(segments[3].block.text, "More.");

// failedTool is what turns a collapsed row amber
assert.equal(failedTool([toolCall("a")], { a: { isError: true } }), true);
assert.equal(failedTool([toolCall("a")], { a: { isError: false } }), false);
assert.equal(failedTool([thinking("x")], {}), false);

// A text message without process blocks produces no wrapper at all.
assert.deepEqual(
	groupBlocks([text("hello")]).map((s) => s.kind),
	["block"],
);

// Counting is per block, and images or unknown blocks are ignored.
assert.deepEqual(countItems([assistant([thinking("a"), toolCall("b"), toolCall("c")]), orphan]), {
	tools: 3,
	thoughts: 1,
	failed: false,
});
assert.deepEqual(countItems([]), { tools: 0, thoughts: 0, failed: false });

// A failure inside the collapsed row must be visible from the outside.
const failedCall = {
	kind: "assistant",
	message: { role: "assistant", content: [toolCall("x")] },
	results: { x: { isError: true, content: [] } },
};
assert.equal(countItems([assistant([toolCall("a")]), failedCall]).failed, true);
assert.equal(countItems([{ kind: "result", message: { toolName: "grep", isError: true }, results: {} }]).failed, true);
assert.equal(countItems([failedCall]).failed, true);

console.log("transcript ok");
