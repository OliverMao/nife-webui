import assert from "node:assert/strict";

// Requires a nife checkout (any version) only for its bundled jiti, so the TS extension
// can be imported without a build step. Point NIFE_DIR at your checkout.
const nifeDir = process.env.NIFE_DIR ?? "/root/nife";
const { createJiti } = await import(`${nifeDir}/node_modules/jiti/lib/jiti.mjs`);

const stub = new URL("./stub-nife.mjs", import.meta.url).pathname;
const jiti = createJiti(import.meta.url, { alias: { "nife-coding-agent": stub } });
const mod = await jiti.import(new URL("../extensions/webui.ts", import.meta.url).pathname);

const handlers = new Map();
const commands = new Map();
const sent = [];
const notes = [];

const api = {
	on(name, fn) {
		handlers.set(name, [...(handlers.get(name) ?? []), fn]);
	},
	registerCommand(name, def) {
		commands.set(name, def);
	},
	sendUserMessage(text, opts) {
		sent.push({ text, opts });
	},
	getSessionName() {
		return "smoke";
	},
	async setModel(model) {
		picked.model = model;
		return true;
	},
	setThinkingLevel(level) {
		picked.thinking = level;
	},
};
const picked = {};

const message = { role: "user", content: "hello", timestamp: Date.now() };
const assistant = {
	role: "assistant",
	content: [
		{ type: "text", text: "hi" },
		{ type: "toolCall", id: "sc1", name: "subagent", arguments: { agent: "explorer", task: "look around" } },
	],
	usage: {
		input: 100,
		output: 20,
		cacheRead: 50,
		cacheWrite: 5,
		totalTokens: 175,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0042 },
	},
	stopReason: "toolUse",
	timestamp: Date.now(),
};
const sessionManager = {
	getSessionId: () => "sess-1",
	getSessionFile: () => "/fake/current.jsonl",
	getBranch: () => [
		{ type: "message", id: "e0", parentId: null, timestamp: "t", message: { role: "system", content: "you are a helpful agent", timestamp: 0 } },
		{ type: "message", id: "e1", parentId: null, timestamp: "t", message },
		{ type: "message", id: "e2", parentId: "e1", timestamp: "t", message: assistant },
		{ type: "message", id: "e2", parentId: null, timestamp: "t", message: { role: "custom", customType: "hidden", content: "x", display: false, timestamp: 0 } },
	],
};
const ui = {
	confirm: async (title, msg) => {
		notes.push(`tui-confirm:${title}:${msg}`);
		return true;
	},
	select: async (title) => {
		notes.push(`tui-select:${title}`);
		return "b";
	},
	input: async (title) => {
		notes.push(`tui-input:${title}`);
		return "tui-value";
	},
	editor: async () => "tui-editor",
	notify: (msg) => notes.push(`notify:${msg}`),
};
const switched = [];
const freshCtx = () => ({ ...ctx, ui, sessionManager: { ...sessionManager, getSessionId: () => "sess-2" } });

const ctx = {
	switchSession: async (path, options) => {
		switched.push(path);
		await options?.withSession?.(freshCtx());
		return { cancelled: false };
	},
	newSession: async (options) => {
		switched.push("<new>");
		await options?.withSession?.(freshCtx());
		return { cancelled: false };
	},
	ui,
	cwd: "/tmp",
	model: {
		id: "test-model",
		name: "Test",
		provider: "fake",
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh" },
	},
	scopedModels: [],
	modelRegistry: {
		getAvailable: () => [
			{ id: "test-model", name: "Test", provider: "fake", reasoning: true },
			{ id: "other-model", name: "Other", provider: "fake2", reasoning: false },
		],
		find: (provider, id) =>
			provider === "fake2" && id === "other-model"
				? { id: "other-model", name: "Other", provider: "fake2", reasoning: false }
				: undefined,
	},
	thinkingLevel: "off",
	isIdle: () => true,
	getContextUsage: () => ({ tokens: 48200, contextWindow: 200000, percent: 24.1 }),
	abort: () => notes.push("abort"),
	sessionManager,
};

mod.default(api);
for (const fn of handlers.get("session_start") ?? []) await fn({ reason: "startup" }, ctx);

await commands.get("webui").handler("", ctx);
const url = notes.find((n) => n.startsWith("notify:webui: "))?.slice("notify:webui: ".length);
assert.ok(url, "no url printed");
const token = new URL(url).searchParams.get("t");
const base = url.split("?")[0];

// static + state
const page = await fetch(url);
assert.equal(page.status, 200);
assert.match(page.headers.get("content-type") ?? "", /text\/html/, "index.html must be served as HTML");
const html = await page.text();
assert.match(html, /id="app"/);
const script = html.match(/src="([^"]+\.js)"/)?.[1];
assert.ok(script, "no script tag in built index.html");
const asset = await fetch(base.replace(/\/$/, "") + script);
assert.equal(asset.status, 200);
assert.match(asset.headers.get("content-type") ?? "", /javascript/);
assert.match(await asset.text(), /createApp|createElementVNode|__vite/, "asset is not the built bundle");
assert.equal((await fetch(`${base}..%2Fpackage.json`)).status, 404, "encoded path traversal must be blocked");
const state = await (await fetch(`${base}api/state?t=${token}`)).json();
assert.equal(state.sessionId, "sess-1");
// system prompts and hidden custom messages never reach the browser
assert.equal(state.messages.length, 2);
assert.equal(state.messages[0].role, "user");
assert.deepEqual(state.stats, {
	messages: 2,
	toolCalls: 1,
	subagents: 1,
	input: 100,
	output: 20,
	cacheRead: 50,
	cacheWrite: 5,
	cost: 0.0042,
});
assert.deepEqual(state.subagents, []);
assert.equal(state.model.id, "test-model");
assert.equal(state.usage.percent, 24.1);


// auth
assert.equal((await fetch(`${base}api/state?t=nope`)).status, 401);
assert.equal((await fetch(`${base}api/state?t=nope`, { headers: { origin: "http://evil.example" } })).status, 403);

// prompt
assert.equal((await fetch(`${base}api/prompt?t=${token}`, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ text: " hi " }),
})).status, 200);
assert.deepEqual(sent[0], { text: "hi", opts: undefined });

// models + thinking levels ride along in the snapshot
// xhigh is enabled by thinkingLevelMap, max is not mapped so it is dropped
assert.deepEqual(state.thinkingLevels, ["off", "minimal", "low", "medium", "high", "xhigh"]);
assert.equal(state.models.length, 2);

assert.equal((await fetch(`${base}api/model?t=${token}`, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ provider: "fake", id: "nope" }),
})).status, 404);

assert.equal((await fetch(`${base}api/model?t=${token}`, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ provider: "fake2", id: "other-model" }),
})).status, 200);
assert.equal(picked.model.id, "other-model");

assert.equal((await fetch(`${base}api/thinking?t=${token}`, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ level: "high" }),
})).status, 200);
assert.equal(picked.thinking, "high");
assert.equal((await fetch(`${base}api/thinking?t=${token}`, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ level: "bogus" }),
})).status, 400);

// session list
const listed = await (await fetch(`${base}api/sessions?t=${token}`)).json();
assert.equal(listed.sessions.length, 1);
assert.equal(listed.sessions[0].path, "/fake/old.jsonl");

// resume + new keep the same bridge (port/token) and rebind the command context
assert.equal((await fetch(`${base}api/resume?t=${token}`, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ path: "/fake/old.jsonl" }),
})).status, 200);
assert.deepEqual(switched, ["/fake/old.jsonl"]);
assert.equal((await fetch(`${base}api/new?t=${token}`, { method: "POST" })).status, 200);
assert.deepEqual(switched, ["/fake/old.jsonl", "<new>"]);
assert.equal((await fetch(`${base}api/state?t=${token}`)).status, 200, "bridge survives session replacement");

// streaming event forwarded as delta only
for (const fn of handlers.get("message_update") ?? []) {
	await fn({ message: { role: "assistant", content: [] }, assistantMessageEvent: { type: "text_delta", delta: "hi", contentIndex: 0, partial: {} } }, ctx);
}

// dialog intercept: browser is attached -> answer comes from POST
const sse = await fetch(`${base}api/events?t=${token}`);
const reader = sse.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
const nextEvent = async () => {
	while (!buffer.includes("\n\n")) {
		const { value, done } = await reader.read();
		if (done) throw new Error("sse closed");
		buffer += decoder.decode(value, { stream: true });
	}
	const idx = buffer.indexOf("\n\n");
	const chunk = buffer.slice(0, idx);
	buffer = buffer.slice(idx + 2);
	const data = chunk.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6));
	return data.length ? JSON.parse(data.join("\n")) : undefined;
};

const confirmPromise = ctx.ui.confirm("Allow?", "run rm -rf?");
await new Promise((r) => setTimeout(r, 50));
let dialog;
while (!(dialog = await nextEvent())) {}
assert.equal(dialog.type, "dialog");
assert.equal(dialog.kind, "confirm");
await fetch(`${base}api/dialog?t=${token}`, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ id: dialog.id, value: false }),
});
assert.equal(await confirmPromise, false);
assert.equal(notes.some((n) => n.startsWith("tui-confirm")), false, "web answer must not fall through to tui");

// no browser attached -> falls back to terminal dialog
reader.cancel();
await new Promise((r) => setTimeout(r, 50));
assert.equal(await ctx.ui.confirm("Allow?", "again?"), true);
assert.ok(notes.some((n) => n.startsWith("tui-confirm:Allow?:again?")));

// a session switch is not a shutdown: the bridge must still answer
for (const fn of handlers.get("session_start") ?? []) await fn({ reason: "resume" }, ctx);
assert.equal((await fetch(`${base}api/state?t=${token}`)).status, 200);

// explicit stop unpatches and closes the port
await commands.get("webui").handler("off", ctx);
assert.equal(await ctx.ui.select("pick"), "b");
await assert.rejects(fetch(`${base}api/state?t=${token}`));

console.log("smoke ok");
process.exit(0);
