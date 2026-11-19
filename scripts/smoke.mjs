import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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
		// Mirrors agent-session.prompt(): a slash command with expandPromptTemplates runs the
		// command handler with a command context instead of queueing a user message.
		if (opts?.expandPromptTemplates && typeof text === "string" && text.startsWith("/")) {
			const name = text.slice(1).split(/\s+/)[0];
			const args = text.slice(1 + name.length).trim();
			const command = commands.get(name);
			if (command) void command.handler(args, ctx);
		}
	},
	getSessionName() {
		return "smoke";
	},
	getSettings() {
		return {};
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
const compactCalls = [];
let compactFail = false;

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
const branchEntries = [
	{ type: "message", id: "e0", parentId: null, timestamp: "t", message: { role: "system", content: "you are a helpful agent", timestamp: 0 } },
	{ type: "message", id: "e1", parentId: null, timestamp: "t", message },
	{ type: "message", id: "e2", parentId: "e1", timestamp: "t", message: assistant },
	{ type: "message", id: "e2", parentId: null, timestamp: "t", message: { role: "custom", customType: "hidden", content: "x", display: false, timestamp: 0 } },
];
// swappable so a test can put a compaction entry in front
let contextEntries = branchEntries;
const sessionManager = {
	getSessionId: () => "sess-1",
	getSessionFile: () => "/fake/current.jsonl",
	getBranch: () => branchEntries,
	buildContextEntries: () => contextEntries,
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
		input: ["text", "image"],
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
	compact(options) {
		compactCalls.push(options);
		if (compactFail) options?.onError?.(new Error("no tokens"));
		else options?.onComplete?.({});
	},
	isIdle: () => true,
	getContextUsage: () => ({ tokens: 48200, contextWindow: 200000, percent: 24.1 }),
	abort: () => notes.push("abort"),
	sessionManager,
};

mod.default(api);

// an abandoned upload dir (dead pid, old mtime) is swept at startup; a fresh one survives
const uploadRoot = join(tmpdir(), "nife-webui");
const staleUpload = join(uploadRoot, "999999-stale");
const freshUpload = join(uploadRoot, "999999-fresh");
mkdirSync(staleUpload, { recursive: true });
writeFileSync(join(staleUpload, "old.pdf"), "x");
utimesSync(staleUpload, new Date(0), new Date(0));
mkdirSync(freshUpload, { recursive: true });

for (const fn of handlers.get("session_start") ?? []) await fn({ reason: "startup" }, ctx);

await commands.get("webui").handler("", ctx);
const url = notes.find((n) => n.startsWith("notify:webui: "))?.slice("notify:webui: ".length);
assert.ok(url, "no url printed");
assert.equal(existsSync(staleUpload), false, "stale upload dir must be swept at startup");
assert.equal(existsSync(freshUpload), true, "recent upload dir must survive the sweep");
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

// compaction-aware transcript: the summary replaces the messages it squeezed out
contextEntries = [
	{ type: "compaction", id: "c1", parentId: null, timestamp: "t", summary: "earlier work", tokensBefore: 1234, firstKeptEntryId: "e4" },
	{ type: "message", id: "e4", parentId: "c1", timestamp: "t", message: { role: "user", content: "after the summary", timestamp: 1 } },
];
const compactedState = await (await fetch(`${base}api/state?t=${token}`)).json();
assert.deepEqual(compactedState.messages.map((entry) => entry.role), ["compactionSummary", "user"]);
assert.equal(compactedState.messages[0].summary, "earlier work");
contextEntries = branchEntries;


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

// a mid-turn prompt is refused instead of being steered into nife's own queue: the page owns the
// pending list, so it keeps the item and sends it after the turn settles
ctx.isIdle = () => false;
const busyPrompt = await fetch(`${base}api/prompt?t=${token}`, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ text: "later" }),
});
assert.equal(busyPrompt.status, 409);
assert.equal(await busyPrompt.text(), "busy");
assert.equal(sent.length, 1, "nothing reaches nife while it is busy");
ctx.isIdle = () => true;

// proxy switch: nife fixes the proxy address at startup but undici re-reads NO_PROXY per request,
// so the page can drop to a direct connection and come back without restarting anything
process.env.HTTPS_PROXY = "http://127.0.0.1:7890";
delete process.env.NO_PROXY;
delete process.env.no_proxy;
const proxyPost = (body) =>
	fetch(`${base}api/proxy?t=${token}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
const bypassed = await proxyPost({ bypass: true });
assert.equal(bypassed.status, 200);
assert.equal((await bypassed.json()).bypassed, true);
assert.equal(process.env.NO_PROXY, "*", "the switch is NO_PROXY=*");
assert.equal(process.env.no_proxy, "*", "undici prefers the lowercase name, so both are set");
const proxyState = await (await fetch(`${base}api/state?t=${token}`)).json();
assert.deepEqual(proxyState.proxy, {
	configured: true,
	// only HTTPS_PROXY was set: http targets stay direct, exactly like undici resolves it
	http: null,
	https: "http://127.0.0.1:7890",
	bypassed: true,
	bypass: "*",
});
assert.equal((await proxyPost({ bypass: false })).status, 200);
assert.equal(process.env.NO_PROXY, undefined, "restoring deletes a name that was not set before");
assert.equal(process.env.no_proxy, undefined);
// an existing bypass list comes back exactly as it was, not as an empty string
process.env.HTTPS_PROXY = "http://127.0.0.1:7890";
process.env.NO_PROXY = "localhost,.corp";
await proxyPost({ bypass: true });
assert.equal(process.env.no_proxy, "*");
await proxyPost({ bypass: false });
assert.equal(process.env.NO_PROXY, "localhost,.corp");
assert.equal(process.env.no_proxy, undefined, "only the name that existed before is restored");
delete process.env.NO_PROXY;
delete process.env.HTTPS_PROXY;
assert.equal((await proxyPost({ bypass: true })).status, 409, "nothing to switch without a proxy");

// http and https are separate agents: HTTPS falls back to HTTP, never the other way round
process.env.HTTP_PROXY = "http://127.0.0.1:7890";
assert.deepEqual((await (await fetch(`${base}api/state?t=${token}`)).json()).proxy.http, "http://127.0.0.1:7890");
assert.deepEqual((await (await fetch(`${base}api/state?t=${token}`)).json()).proxy.https, "http://127.0.0.1:7890");
process.env.HTTPS_PROXY = "http://127.0.0.1:7891";
assert.equal((await (await fetch(`${base}api/state?t=${token}`)).json()).proxy.https, "http://127.0.0.1:7891");
delete process.env.HTTPS_PROXY;
delete process.env.HTTP_PROXY;
assert.equal((await proxyPost({ bypass: "yes" })).status, 400);

// compaction: the page waits for the outcome of the summarizing call
const compactPost = (body) =>
	fetch(`${base}api/compact?t=${token}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body ?? {}),
	});
assert.equal((await compactPost({ instructions: "keep the API notes" })).status, 200);
assert.equal(compactCalls.at(-1).customInstructions, "keep the API notes");
compactFail = true;
const failedCompact = await compactPost();
assert.equal(failedCompact.status, 409);
assert.equal(await failedCompact.text(), "no tokens");
compactFail = false;

// images are forwarded as ImageContent blocks after the text block
const png = Buffer.from("not really a png").toString("base64");
const promptWith = (body) =>
	fetch(`${base}api/prompt?t=${token}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
assert.equal((await promptWith({ text: " look ", images: [{ mimeType: "image/png", data: png }] })).status, 200);
assert.deepEqual(sent.at(-1).text, [
	{ type: "text", text: "look" },
	{ type: "image", mimeType: "image/png", data: png },
]);
// an image on its own is a valid prompt
assert.equal((await promptWith({ images: [{ mimeType: "image/jpeg", data: png }] })).status, 200);
assert.deepEqual(sent.at(-1).text, [{ type: "image", mimeType: "image/jpeg", data: png }]);
// empty stays a 400, and bad images never reach the session
assert.equal((await promptWith({ text: "  " })).status, 400);
assert.equal((await promptWith({ text: "x", images: [{ mimeType: "image/svg+xml", data: png }] })).status, 400);
assert.equal((await promptWith({ text: "x", images: [{ mimeType: "image/png", data: "not base64!" }] })).status, 400);
assert.equal((await promptWith({ text: "x", images: [{ mimeType: "image/png", data: "A".repeat(4.5 * 1024 * 1024 + 1) }] })).status, 400);
assert.equal((await promptWith({ text: "x", images: "nope" })).status, 400);
// a text-only model refuses images instead of sending something the provider would reject
ctx.model = { ...ctx.model, input: ["text"] };
assert.equal((await promptWith({ text: "x" })).status, 200, "text still works");
assert.deepEqual(sent.at(-1).text, "x");
assert.equal((await promptWith({ text: "x", images: [{ mimeType: "image/png", data: png }] })).status, 409);
assert.deepEqual(sent.at(-1).text, "x", "rejected images are not sent");
ctx.model = { ...ctx.model, input: ["text", "image"] };

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

// uploads: a dropped non-image becomes a temp file whose path is handed back to the page
const uploadBody = Buffer.from("%PDF-1.4 not really a pdf");
const uploaded = await fetch(`${base}api/upload?t=${token}`, {
	method: "POST",
	headers: { "content-type": "application/pdf", "x-file-name": encodeURIComponent("../报告 v1.pdf") },
	body: uploadBody,
});
assert.equal(uploaded.status, 200);
const upload = await uploaded.json();
const uploadPath = upload.path;
assert.equal(upload.name, "报告 v1.pdf", "the original name comes back as a label only");
assert.ok(uploadPath.startsWith(join(tmpdir(), "nife-webui")), "upload lands in the temp dir");
assert.match(uploadPath, /\/[0-9a-f]{16}\.pdf$/, "stored name is generated");
assert.ok(!uploadPath.includes("报告"), "the user name never reaches the filesystem");
assert.equal(dirname(dirname(uploadPath)), join(tmpdir(), "nife-webui"));
assert.deepEqual(readFileSync(uploadPath), uploadBody);
assert.equal(existsSync(uploadPath), true);
// the same display name twice yields two generated paths and no overwrite
const again = await fetch(`${base}api/upload?t=${token}`, {
	method: "POST",
	headers: { "x-file-name": encodeURIComponent("报告 v1.pdf") },
	body: "second",
});
const second = await again.json();
assert.notEqual(second.path, uploadPath);
assert.equal(second.name, upload.name);
assert.match(second.path, /\/[0-9a-f]{16}\.pdf$/);
assert.equal(readFileSync(uploadPath, "utf8"), uploadBody.toString());
// a traversal-y name stays a label: the file is still written into the same upload dir
const traversal = await (
	await fetch(`${base}api/upload?t=${token}`, {
		method: "POST",
		headers: { "x-file-name": encodeURIComponent("../../etc/pass wd.sh") },
		body: "#!/bin/sh",
	})
).json();
assert.equal(traversal.name, "pass wd.sh");
assert.equal(dirname(traversal.path), dirname(uploadPath));
assert.match(traversal.path, /\/[0-9a-f]{16}\.sh$/);
// names with a malformed escape still work, and an empty body is refused
const weird = await fetch(`${base}api/upload?t=${token}`, { method: "POST", headers: { "x-file-name": "%E0%A4%A" }, body: "x" });
assert.equal(weird.status, 200);
assert.equal(existsSync((await weird.json()).path), true);
assert.equal((await fetch(`${base}api/upload?t=${token}`, { method: "POST", body: "" })).status, 400);
assert.equal((await fetch(`${base}api/upload?t=nope`, { method: "POST", body: "x" })).status, 401);

// session list
const listed = await (await fetch(`${base}api/sessions?t=${token}`)).json();
assert.equal(listed.sessions.length, 1);
assert.equal(listed.sessions[0].path, "/fake/old.jsonl");

// delete: only listed sessions can go, never the active one, and the file really disappears
const doomed = join(tmpdir(), `nife-webui-delete-${process.pid}.jsonl`);
writeFileSync(doomed, '{"type":"session"}\n');
const deleteSession = (path) =>
	fetch(`${base}api/delete?t=${token}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ path }),
	});
assert.equal((await deleteSession(doomed)).status, 404, "an unlisted path must not be deletable");
assert.equal(existsSync(doomed), true);
process.env.NIFE_SMOKE_SESSION = doomed;
assert.equal((await deleteSession("/fake/current.jsonl")).status, 409, "the active session stays put");
assert.equal((await deleteSession("/tmp/not-a-session.txt")).status, 404);
assert.equal((await deleteSession("")).status, 400);
const removed = await deleteSession(doomed);
assert.equal(removed.status, 200);
assert.match(await removed.text(), /^(trash|unlink)$/);
assert.equal(existsSync(doomed), false, "the session file is gone");
delete process.env.NIFE_SMOKE_SESSION;

// resume + new go through the dispatched webui-session command; the bridge keeps port/token
assert.equal((await fetch(`${base}api/resume?t=${token}`, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ path: "/fake/old.jsonl" }),
})).status, 200);
assert.deepEqual(switched, ["/fake/old.jsonl"]);
assert.equal((await fetch(`${base}api/new?t=${token}`, { method: "POST" })).status, 200);
assert.deepEqual(switched, ["/fake/old.jsonl", "<new>"]);
assert.deepEqual(
	sent.filter((entry) => typeof entry.text === "string" && entry.text.startsWith("/webui-session")).map((entry) => entry.text),
	["/webui-session resume /fake/old.jsonl", "/webui-session new"],
);

// a streaming turn refuses the switch instead of queueing it mid-turn
ctx.isIdle = () => false;
assert.equal((await fetch(`${base}api/resume?t=${token}`, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ path: "/fake/old.jsonl" }),
})).status, 409);
ctx.isIdle = () => true;
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

// compaction events are forwarded too, so threshold compaction is visible without a click
for (const fn of handlers.get("session_compact") ?? []) {
	await fn({ type: "session_compact", reason: "threshold" }, ctx);
}
let compactionEvent;
for (let attempt = 0; attempt < 10 && !compactionEvent; attempt += 1) {
	const event = await nextEvent();
	if (event?.type === "compaction_end") compactionEvent = event;
}
assert.deepEqual(compactionEvent, { type: "compaction_end", ok: true, reason: "threshold" });

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

// autostart: a plain interactive launch starts the server and hands the url to the browser once
const agentDir = join(tmpdir(), `nife-webui-smoke-${process.pid}`);
mkdirSync(agentDir, { recursive: true });
process.env.NIFE_CODING_AGENT_DIR = agentDir;
const openedFile = join(agentDir, "opened.txt");
const hookScript = join(agentDir, "browser.sh");
writeFileSync(hookScript, `#!/bin/sh\nprintf '%s' "$1" >> '${openedFile}'\n`, { mode: 0o755 });
process.env.BROWSER = hookScript;

notes.length = 0;
const tuiCtx = { ...ctx, mode: "tui" };
for (const fn of handlers.get("session_start") ?? []) await fn({ reason: "startup" }, tuiCtx);
const autoUrl = notes.find((n) => n.startsWith("notify:webui: "))?.slice("notify:webui: ".length);
assert.ok(autoUrl, "autostart must print the url");
assert.equal((await fetch(autoUrl)).status, 200);
for (let i = 0; i < 60 && !existsSync(openedFile); i++) await new Promise((r) => setTimeout(r, 25));
assert.equal(readFileSync(openedFile, "utf8").trim(), autoUrl, "browser gets the printed url");

// a reload reuses the process: no second tab, no second server
notes.length = 0;
for (const fn of handlers.get("session_start") ?? []) await fn({ reason: "reload" }, tuiCtx);
assert.equal(notes.filter((n) => n.startsWith("notify:webui")).length, 0);
assert.equal(readFileSync(openedFile, "utf8").trim(), autoUrl);

// headless modes (subagents, --print) never autostart
await commands.get("webui").handler("off", tuiCtx);
notes.length = 0;
for (const fn of handlers.get("session_start") ?? []) await fn({ reason: "startup" }, { ...ctx, mode: "print" });
assert.equal(notes.filter((n) => n.startsWith("notify:webui")).length, 0);

// /webui auto off persists and blocks the next launch
await commands.get("webui").handler("auto off", tuiCtx);
assert.ok(notes.includes("notify:webui autostart off"));
assert.deepEqual(JSON.parse(readFileSync(join(agentDir, "webui.json"), "utf8")), { auto: false });
notes.length = 0;
for (const fn of handlers.get("session_start") ?? []) await fn({ reason: "startup" }, tuiCtx);
assert.equal(notes.filter((n) => n.startsWith("notify:webui: ")).length, 0, "auto off must not start");
await commands.get("webui").handler("auto", tuiCtx);
assert.ok(notes.includes("notify:webui autostart is off"));

rmSync(freshUpload, { recursive: true, force: true });
console.log("smoke ok");
process.exit(0);
