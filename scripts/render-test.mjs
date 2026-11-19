import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The server smoke test cannot see the Vue app, and a template that touches a null computed blanks
// the whole page while every HTTP test still passes. Render the real component once through SSR:
// that evaluates the template with the initial state (no session, empty composer).
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const entry = join(root, "web", "ssr-entry.mjs");
const out = join(root, ".ssr-check");
const vite = join(root, "node_modules", "vite", "bin", "vite.js");

try {
	writeFileSync(
		entry,
		`import { createSSRApp } from "vue";\nimport { renderToString } from "vue/server-renderer";\nimport App from "./src/App.vue";\nimport MessageItem from "./src/MessageItem.vue";\n\nexport const render = () => renderToString(createSSRApp(App));\n\nexport const renderMessage = (content) =>\n\trenderToString(createSSRApp(MessageItem, { item: { kind: "assistant", message: { role: "assistant", content }, results: {} } }));\nexport const renderRow = (index) =>\n\trenderToString(createSSRApp(MessageItem, { item: { kind: "user", message: { role: "user", content: "row" }, results: {} }, "data-row": String(index) }));\n`,
	);
	execFileSync(process.execPath, [vite, "build", "--ssr", "ssr-entry.mjs", "--outDir", out, "--emptyOutDir"], {
		cwd: root,
		stdio: "pipe",
	});

	// Only what setup touches: the bridge token from the URL and the remembered sidebar state.
	globalThis.location = new URL("http://127.0.0.1:1234/?t=render-test");
	globalThis.localStorage = { getItem: () => null, setItem: () => {} };

	const { render, renderMessage, renderRow } = await import(pathToFileURL(join(out, "ssr-entry.js")).href);
	const html = await render();
	assert.match(html, /class="app/, "the app shell must render");
	assert.match(html, /class="transcript"/);
	assert.match(html, /class="composer"/, "the composer must render on a first, empty state");
	assert.match(html, /class="session-list"/);

	// the window looks rows up by [data-row], so the attribute must reach MessageItem's root div
	assert.match(await renderRow(7), /data-row="7"/);

	const thought = { type: "thinking", thinking: "look first" };
	const step = { type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } };

	// Thinking and tool calls sit inside one collapsed row, and the answer stays outside it.
	const worked = await renderMessage([thought, step, { type: "text", text: "the answer" }]);
	assert.match(worked, /class="process/, "a run of thinking and tool calls collapses");
	assert.match(worked, /Worked/);
	assert.match(worked, /1 tool · 1 thought/);
	assert.match(worked, /the answer/);
	assert.equal(worked.indexOf("the answer") > worked.indexOf("1 tool"), true, "the answer comes after the row");

	const plain = await renderMessage([{ type: "text", text: "just text" }]);
	assert.doesNotMatch(plain, /class="process/, "a text-only message gets no wrapper");

	console.log("render ok");
} finally {
	rmSync(entry, { force: true });
	if (existsSync(out)) rmSync(out, { recursive: true, force: true });
}
