import vue from "@vitejs/plugin-vue";
import { defineConfig, type Plugin } from "vite";

/**
 * KaTeX ships every glyph in ttf, woff and woff2 and its stylesheet lists all three, which would put
 * 1.2 MB of fonts in the bundle for browsers that would only ever fetch the woff2. Everything this
 * page supports reads woff2, so the other two formats are dropped from the @font-face rules.
 */
const woff2Only = (): Plugin => ({
	name: "katex-woff2-only",
	enforce: "pre",
	transform(code, id) {
		if (!/katex[/\\].*\.css$/.test(id)) return null;
		return code.replace(/@font-face\s*{[^}]*}/g, (rule) => {
			const woff2 = rule.match(/url\(\s*["']?([^"')]+\.woff2)\s*["']?\s*\)/);
			if (!woff2) return rule;
			return rule.replace(/src\s*:[^;}]*/, `src: url(${woff2[1]}) format("woff2")`);
		});
	},
});

// WEBUI_TARGET=http://127.0.0.1:PORT npm run dev
// then open http://127.0.0.1:5173/?t=TOKEN with the token printed by /webui.
const target = process.env.WEBUI_TARGET;

export default defineConfig({
	root: "web",
	plugins: [vue(), woff2Only()],
	// Relative asset URLs: the bundle works at / and under a tunnel prefix (/t/<id>/) without
	// relying on the edge rewriting index.html.
	base: "./",
	build: { outDir: "dist", emptyOutDir: true },
	server: target ? { proxy: { "/api": { target, changeOrigin: true } } } : undefined,
});
