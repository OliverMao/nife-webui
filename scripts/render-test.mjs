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
		`import { createSSRApp } from "vue";\nimport { renderToString } from "vue/server-renderer";\nimport App from "./src/App.vue";\n\nexport const render = () => renderToString(createSSRApp(App));\n`,
	);
	execFileSync(process.execPath, [vite, "build", "--ssr", "ssr-entry.mjs", "--outDir", out, "--emptyOutDir"], {
		cwd: root,
		stdio: "pipe",
	});

	// Only what setup touches: the bridge token from the URL and the remembered sidebar state.
	globalThis.location = new URL("http://127.0.0.1:1234/?t=render-test");
	globalThis.localStorage = { getItem: () => null, setItem: () => {} };

	const { render } = await import(pathToFileURL(join(out, "ssr-entry.js")).href);
	const html = await render();
	assert.match(html, /class="app/, "the app shell must render");
	assert.match(html, /class="transcript"/);
	assert.match(html, /class="composer"/, "the composer must render on a first, empty state");
	assert.match(html, /class="session-list"/);
	console.log("render ok");
} finally {
	rmSync(entry, { force: true });
	if (existsSync(out)) rmSync(out, { recursive: true, force: true });
}
