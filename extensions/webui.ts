/**
 * nife-webui
 *
 * Serves the session that is currently running in this CLI process to a browser.
 * Same session object, same events, no second agent: the web page is another
 * screen on the running session, not a separate client of a second process.
 *
 * /webui        start (prints URL with token)
 * /webui off    stop
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, SessionManager } from "nife-coding-agent";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionUIContext,
} from "nife-coding-agent";

/** Whatever ctx.model is; the package does not export the model type itself. */
type AnyModel = NonNullable<ExtensionContext["model"]>;

// Built by `npm run build` (Vite). Extensions load TS through jiti, but the browser needs
// real files, so the Vue app is prebuilt instead of served from source.
const DIST_DIR = resolve(join(dirname(fileURLToPath(import.meta.url)), "..", "web", "dist"));
const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
	".map": "application/json; charset=utf-8",
};

type DialogKind = "confirm" | "select" | "input" | "editor";
type OriginalUI = Pick<ExtensionUIContext, "confirm" | "select" | "input" | "editor">;

interface Bridge {
	api: ExtensionAPI;
	ctx: ExtensionContext;
	/** Command-capable context: only present after /webui or a session switch. */
	command: ExtensionCommandContext | undefined;
	server: Server;
	port: number;
	token: string;
	clients: Set<ServerResponse>;
	pending: Map<string, (value: unknown) => void>;
	patchedUI: ExtensionUIContext | undefined;
	orig: OriginalUI | undefined;
	/** Subagent dispatches currently running, keyed by tool call id. */
	children: Map<string, { id: string; agent: string; count: number }>;
	/** Set once the browser tab was opened for this process, so /reload does not reopen it. */
	autoOpened: boolean;
}

// The factory runs again whenever a session is replaced (/new, /resume, /fork). Module state
// survives only if the loader reuses the module, so the bridge lives on globalThis: the server,
// port and token stay valid across session switches.
const store = globalThis as unknown as { __nifeWebui?: Bridge };
const PATCHED = Symbol.for("nife-webui.patched");

function broadcast(b: Bridge, payload: unknown): void {
	const line = `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
	for (const client of b.clients) client.write(line);
}

function forward(payload: Record<string, unknown>): void {
	const b = store.__nifeWebui;
	if (b) broadcast(b, payload);
}

/** Ask the browser. Returns "tui" when no browser is attached so the caller falls back. */
function ask<T>(b: Bridge, kind: DialogKind, payload: Record<string, unknown>): Promise<T | "tui"> {
	if (b.clients.size === 0) return Promise.resolve("tui");
	const id = randomBytes(6).toString("hex");
	return new Promise<T | "tui">((done) => {
		b.pending.set(id, (value) => done(value as T | "tui"));
		broadcast(b, { type: "dialog", id, kind, ...payload });
	});
}

/**
 * All extensions in a session share one mutable ExtensionUIContext object
 * (Runner.setUIContext wraps it once, runner.uiContext is returned by every
 * ctx.ui getter). Wrapping the dialog methods here is what lets the browser
 * answer a prompt that another extension raised.
 */
function patchDialogs(ctx: ExtensionContext, b: Bridge): void {
	const ui = ctx.ui;
	if ((ui as ExtensionUIContext & { [PATCHED]?: boolean })[PATCHED]) return;

	const orig: OriginalUI = { confirm: ui.confirm, select: ui.select, input: ui.input, editor: ui.editor };
	(ui as ExtensionUIContext & { [PATCHED]?: boolean })[PATCHED] = true;
	b.patchedUI = ui;
	b.orig = orig;

	ui.confirm = async (title, message, opts) => {
		const answer = await ask<boolean>(b, "confirm", { title, message });
		return answer === "tui" ? orig.confirm(title, message, opts) : answer === true;
	};
	ui.select = async (title, options, opts) => {
		const answer = await ask<string>(b, "select", { title, options });
		return answer === "tui" ? orig.select(title, options, opts) : answer;
	};
	ui.input = async (title, placeholder, opts) => {
		const answer = await ask<string>(b, "input", { title, placeholder });
		return answer === "tui" ? orig.input(title, placeholder, opts) : answer;
	};
	ui.editor = async (title, prefill) => {
		const answer = await ask<string>(b, "editor", { title, prefill });
		return answer === "tui" ? orig.editor(title, prefill) : answer;
	};
}

function unpatchDialogs(b: Bridge): void {
	const ui = b.patchedUI;
	const orig = b.orig;
	if (!ui || !orig) return;
	ui.confirm = orig.confirm;
	ui.select = orig.select;
	ui.input = orig.input;
	ui.editor = orig.editor;
	delete (ui as ExtensionUIContext & { [PATCHED]?: boolean })[PATCHED];
	b.patchedUI = undefined;
	b.orig = undefined;
}

function send(res: ServerResponse, status: number, body: string | Buffer, type = "text/plain; charset=utf-8"): void {
	res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
	res.end(body);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size > 256 * 1024) throw new Error("body too large");
		chunks.push(chunk as Buffer);
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

const ALL_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Mirrors getSupportedThinkingLevels() from nife-ai, which is not part of the public
 * extension surface: non-reasoning models only allow "off", and xhigh/max need an explicit map.
 */
function supportedLevels(model: AnyModel | undefined): string[] {
	if (!model?.reasoning) return ["off"];
	const map = model.thinkingLevelMap as Record<string, string | null | undefined> | undefined;
	return ALL_LEVELS.filter((level) => {
		const mapped = map?.[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
}

function availableModels(ctx: ExtensionContext): AnyModel[] {
	const scoped = ctx.scopedModels.map((entry) => entry.model);
	return scoped.length > 0 ? scoped : ctx.modelRegistry.getAvailable();
}

/** System prompts and hidden extension messages are not conversation content. */
function isHiddenMessage(message: { role: string; display?: boolean }): boolean {
	return message.role === "system" || (message.role === "custom" && message.display === false);
}

function snapshot(b: Bridge): unknown {
	const ctx = b.ctx;
	const messages = ctx.sessionManager
		.getBranch()
		.filter((entry) => entry.type === "message")
		.map((entry) => entry.message)
		.filter((message) => !isHiddenMessage(message as { role: string; display?: boolean }));
	const model = ctx.model;
	const stats = {
		messages: messages.length,
		toolCalls: 0,
		subagents: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
	};
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const block of Array.isArray(message.content) ? message.content : []) {
				if (block?.type !== "toolCall") continue;
				stats.toolCalls += 1;
				if (block.name === "subagent") stats.subagents += 1;
			}
		}
		const usage = message.role === "assistant" || message.role === "toolResult" ? message.usage : undefined;
		if (usage) {
			stats.input += usage.input;
			stats.output += usage.output;
			stats.cacheRead += usage.cacheRead;
			stats.cacheWrite += usage.cacheWrite;
			stats.cost += usage.cost?.total ?? 0;
		}
	}
	return {
		sessionId: ctx.sessionManager.getSessionId(),
		sessionFile: ctx.sessionManager.getSessionFile(),
		name: b.api.getSessionName(),
		cwd: ctx.cwd,
		model: model ? { id: model.id, name: model.name, provider: model.provider } : null,
		thinkingLevel: ctx.thinkingLevel,
		thinkingLevels: supportedLevels(ctx.model),
		models: availableModels(ctx).map((model) => ({
			provider: model.provider,
			id: model.id,
			name: model.name,
		})),
		streaming: !ctx.isIdle(),
		usage: ctx.getContextUsage() ?? null,
		stats,
		subagents: [...b.children.values()],
		messages,
	};
}

async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
	const relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
	const file = resolve(DIST_DIR, relative);
	if (!file.startsWith(DIST_DIR + sep)) return send(res, 404, "not found");
	try {
		const body = await readFile(file);
		send(res, 200, body, CONTENT_TYPES[extname(file)] ?? "application/octet-stream");
	} catch {
		send(res, 404, "not found");
	}
}

async function listSessions(b: Bridge): Promise<unknown> {
	const sessions = await SessionManager.list(b.ctx.cwd);
	return {
		current: b.ctx.sessionManager.getSessionFile(),
		sessions: sessions.map((session) => ({
			path: session.path,
			id: session.id,
			name: session.name,
			cwd: session.cwd,
			modified: session.modified,
			messageCount: session.messageCount,
			firstMessage: session.firstMessage,
		})),
	};
}

/** Runs a session replacement and keeps the command context fresh for the next one. */
async function replaceSession(b: Bridge, run: (command: ExtensionCommandContext) => Promise<unknown>): Promise<void> {
	const command = b.command;
	if (!command) throw new Error("session control unavailable, run /webui in the terminal");
	await run(command);
	const fresh = b.command;
	if (fresh) {
		b.ctx = fresh;
		patchDialogs(fresh, b);
	}
	broadcast(b, { type: "session_switch" });
}

async function handle(b: Bridge, req: IncomingMessage, res: ServerResponse): Promise<void> {
	const url = new URL(req.url ?? "/", `http://127.0.0.1:${b.port}`);
	const path = url.pathname;

	// Static assets carry no session data and are requested without the token.
	if (req.method === "GET" && !path.startsWith("/api/")) return serveStatic(path, res);

	const origin = req.headers.origin;
	if (origin && origin !== `http://127.0.0.1:${b.port}`) return send(res, 403, "forbidden");
	if (url.searchParams.get("t") !== b.token) return send(res, 401, "bad token");

	if (req.method === "GET" && path === "/api/state") {
		return send(res, 200, JSON.stringify(snapshot(b)), "application/json");
	}

	if (req.method === "GET" && path === "/api/sessions") {
		return send(res, 200, JSON.stringify(await listSessions(b)), "application/json");
	}

	if (req.method === "GET" && path === "/api/events") {
		res.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-store",
			connection: "keep-alive",
		});
		res.write(": connected\n\n");
		b.clients.add(res);
		req.on("close", () => {
			b.clients.delete(res);
		});
		return;
	}

	if (req.method === "POST" && path === "/api/prompt") {
		const body = await readJson(req);
		const text = typeof body.text === "string" ? body.text.trim() : "";
		if (!text) return send(res, 400, "empty prompt");
		try {
			b.api.sendUserMessage(text, b.ctx.isIdle() ? undefined : { deliverAs: "steer" });
		} catch (error) {
			return send(res, 409, error instanceof Error ? error.message : "send failed");
		}
		return send(res, 200, "ok");
	}

	if (req.method === "POST" && path === "/api/abort") {
		b.ctx.abort();
		return send(res, 200, "ok");
	}

	if (req.method === "POST" && path === "/api/dialog") {
		const body = await readJson(req);
		const id = typeof body.id === "string" ? body.id : "";
		const resolve = b.pending.get(id);
		if (!resolve) return send(res, 404, "unknown dialog");
		b.pending.delete(id);
		resolve(body.value);
		return send(res, 200, "ok");
	}

	if (req.method === "POST" && path === "/api/model") {
		const body = await readJson(req);
		const provider = typeof body.provider === "string" ? body.provider : "";
		const id = typeof body.id === "string" ? body.id : "";
		const model = b.ctx.modelRegistry.find(provider, id);
		if (!model) return send(res, 404, "unknown model");
		const ok = await b.api.setModel(model as never);
		if (!ok) return send(res, 409, `no credentials for ${provider}/${id}`);
		broadcast(b, { type: "state_changed" });
		return send(res, 200, "ok");
	}

	if (req.method === "POST" && path === "/api/thinking") {
		const body = await readJson(req);
		const level = typeof body.level === "string" ? body.level : "";
		if (!ALL_LEVELS.includes(level)) return send(res, 400, "unknown level");
		b.api.setThinkingLevel(level as never);
		broadcast(b, { type: "state_changed" });
		return send(res, 200, "ok");
	}

	if (req.method === "POST" && path === "/api/resume") {
		const body = await readJson(req);
		const sessionPath = typeof body.path === "string" ? body.path : "";
		if (!sessionPath) return send(res, 400, "missing path");
		await replaceSession(b, (command) =>
			command.switchSession(sessionPath, {
				withSession: async (ctx) => {
					b.command = ctx;
				},
			}),
		);
		return send(res, 200, "ok");
	}

	if (req.method === "POST" && path === "/api/new") {
		await replaceSession(b, (command) =>
			command.newSession({
				withSession: async (ctx) => {
					b.command = ctx;
				},
			}),
		);
		return send(res, 200, "ok");
	}

	return send(res, 404, "not found");
}

type Prefs = { auto: boolean };

function prefsPath(): string {
	return join(getAgentDir(), "webui.json");
}

async function loadPrefs(): Promise<Prefs> {
	try {
		const raw = JSON.parse(await readFile(prefsPath(), "utf8")) as { auto?: unknown };
		return { auto: raw.auto !== false };
	} catch {
		return { auto: true };
	}
}

async function savePrefs(prefs: Prefs): Promise<void> {
	await mkdir(getAgentDir(), { recursive: true });
	await writeFile(prefsPath(), `${JSON.stringify(prefs, null, 2)}\n`, "utf8");
}

function webuiUrl(b: Bridge): string {
	return `http://127.0.0.1:${b.port}/?t=${b.token}`;
}

/** Hand the URL to the desktop. Failures are expected on headless machines: the URL is printed too. */
function openBrowser(url: string): void {
	const [command, ...prefix] =
		process.platform === "win32"
			? ["cmd", "/c", "start", ""]
			: process.platform === "darwin"
				? ["open"]
				: [process.env.BROWSER?.trim() || "xdg-open"];
	if (!command) return;
	try {
		const child = spawn(command, [...prefix, url], { detached: true, stdio: "ignore" });
		child.on("error", () => {});
		child.unref();
	} catch {
		// ignore: the printed URL is the fallback
	}
}

function start(api: ExtensionAPI, ctx: ExtensionContext): Promise<Bridge> {
	const token = randomBytes(16).toString("hex");
	const server = createServer();
	const b: Bridge = {
		api,
		ctx,
		command: undefined,
		server,
		port: 0,
		token,
		clients: new Set(),
		pending: new Map(),
		patchedUI: undefined,
		orig: undefined,
		children: new Map(),
		autoOpened: false,
	};

	server.on("request", (req, res) => {
		void handle(b, req, res).catch((error: unknown) => {
			send(res, 500, error instanceof Error ? error.message : "internal error");
		});
	});

	return new Promise<Bridge>((done, fail) => {
		server.once("error", fail);
		server.listen(0, "127.0.0.1", () => {
			b.port = (server.address() as AddressInfo).port;
			store.__nifeWebui = b;
			done(b);
		});
	});
}

function stop(): void {
	const b = store.__nifeWebui;
	if (!b) return;
	store.__nifeWebui = undefined;
	unpatchDialogs(b);
	for (const resolve of b.pending.values()) resolve(undefined);
	b.pending.clear();
	for (const client of b.clients) client.end();
	b.clients.clear();
	b.server.close();
	b.server.closeAllConnections();
}

export default function webui(api: ExtensionAPI) {
	api.registerCommand("webui", {
		description: "Serve this session in the browser. /webui off stops it, /webui auto on|off autostarts",
		handler: async (args, ctx) => {
			const [sub, value] = args.trim().split(/\s+/);
			if (sub === "off") {
				stop();
				ctx.ui.notify("webui stopped", "info");
				return;
			}
			if (sub === "auto") {
				const prefs = await loadPrefs();
				if (value !== "on" && value !== "off") {
					ctx.ui.notify(`webui autostart is ${prefs.auto ? "on" : "off"}`, "info");
					return;
				}
				await savePrefs({ auto: value === "on" });
				ctx.ui.notify(`webui autostart ${value}`, "info");
				return;
			}
			let b = store.__nifeWebui;
			if (!b) {
				b = await start(api, ctx);
			}
			b.api = api;
			b.ctx = ctx;
			b.command = ctx;
			patchDialogs(ctx, b);
			ctx.ui.notify(`webui: ${webuiUrl(b)}`, "info");
		},
	});

	api.on("session_start", async (event, ctx) => {
		// Autostart only for a real interactive launch: subagents and --print runs are headless,
		// and /reload, /new, /resume, /fork must not open a second tab.
		if (event.reason === "startup" && ctx.mode === "tui" && process.env.NIFE_WEBUI !== "0") {
			if (!store.__nifeWebui && (await loadPrefs()).auto) {
				try {
					const started = await start(api, ctx);
					ctx.ui.notify(`webui: ${webuiUrl(started)}`, "info");
					if (!started.autoOpened) {
						started.autoOpened = true;
						openBrowser(webuiUrl(started));
					}
				} catch (error) {
					ctx.ui.notify(`webui: failed to start (${error instanceof Error ? error.message : "unknown"})`, "error");
				}
			}
		}
		const b = store.__nifeWebui;
		if (!b) return;
		// New session: same bridge, same port and token, rebound to the live context.
		b.api = api;
		b.ctx = ctx;
		patchDialogs(ctx, b);
		broadcast(b, { type: "session_start", reason: event.reason });
	});

	// Do not stop on session_shutdown: the bridge outlives /new, /resume and /fork.
	api.on("message_start", (event) => {
		forward({ type: "message_start", message: event.message });
	});
	api.on("message_update", (event) => {
		// Send only the delta: event.message is cumulative and would grow O(n^2) on the wire.
		forward({ type: "message_update", delta: event.assistantMessageEvent });
	});
	api.on("message_end", (event) => {
		forward({ type: "message_end", message: event.message });
	});
	api.on("agent_start", () => {
		forward({ type: "agent_start" });
	});
	api.on("agent_settled", () => {
		forward({ type: "agent_settled" });
	});
	api.on("session_info_changed", (event) => {
		forward({ type: "session_info_changed", name: event.name });
	});
	api.on("thinking_level_select", (event) => {
		forward({ type: "thinking_level_changed", level: event.level });
	});
	api.on("tool_execution_start", (event) => {
		forward({
			type: "tool_execution_start",
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			args: event.args,
		});
		const b = store.__nifeWebui;
		if (!b || event.toolName !== "subagent") return;
		const args = (event.args ?? {}) as Record<string, unknown>;
		b.children.set(event.toolCallId, {
			id: event.toolCallId,
			agent: typeof args.agent === "string" ? args.agent : "",
			count: Array.isArray(args.tasks) ? args.tasks.length : Array.isArray(args.chain) ? args.chain.length : 1,
		});
		broadcast(b, { type: "subagents", running: [...b.children.values()] });
	});
	api.on("tool_execution_end", (event) => {
		forward({
			type: "tool_execution_end",
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			isError: event.isError,
		});
		const b = store.__nifeWebui;
		if (!b || !b.children.delete(event.toolCallId)) return;
		broadcast(b, { type: "subagents", running: [...b.children.values()] });
	});
}
