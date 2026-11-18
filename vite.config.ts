import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

// WEBUI_TARGET=http://127.0.0.1:PORT npm run dev
// then open http://127.0.0.1:5173/?t=TOKEN with the token printed by /webui.
const target = process.env.WEBUI_TARGET;

export default defineConfig({
	root: "web",
	plugins: [vue()],
	build: { outDir: "dist", emptyOutDir: true },
	server: target ? { proxy: { "/api": { target, changeOrigin: true } } } : undefined,
});
