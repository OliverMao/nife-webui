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

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, SessionManager, sessionEntryToContextMessages } from "nife-coding-agent";
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "nife-coding-agent";

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

/**
 * Image paste. The extension API already takes ImageContent blocks, so the bridge only has to
 * validate what the page posts: the same mime list nife uses for clipboard images, and nife's
 * own resize cap of 4.5MB of base64 (below the providers' 5MB per-image limit). web/src/paste.js
 * mirrors the numbers for early feedback; the checks live here too because the endpoint must not
 * trust the page.
 */
const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const MAX_IMAGES = 4;
const MAX_IMAGE_BASE64 = Math.floor(4.5 * 1024 * 1024);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
/** Four just-under-limit images plus the text. */
const PROMPT_MAX_BODY = MAX_IMAGES * MAX_IMAGE_BASE64 + 256 * 1024;

type ImageBlock = { type: "image"; mimeType: string; data: string };
type TextBlock = { type: "text"; text: string };

/**
 * Dropped non-image files. A browser drop never reveals the local path, so the page uploads the
 * bytes and gets one back: the prompt then carries the path and the agent reads it with a tool,
 * exactly like a terminal drop. Files live in the OS temp dir and are removed when this process
 * exits (plus a sweep of abandoned directories from crashed runs).
 */
const UPLOAD_ROOT = join(tmpdir(), "nife-webui");
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const UPLOAD_STALE_MS = 12 * 60 * 60 * 1000;

/** Directories to remove on exit, kept module-wide so a reloaded extension still cleans up. */
const trackedUploadDirs = new Set<string>();

function trackUploadDir(dir: string): void {
	trackedUploadDirs.add(dir);
	if (trackedUploadDirs.size !== 1) return;
	process.once("exit", () => {
		for (const path of trackedUploadDirs) rmSync(path, { recursive: true, force: true });
	});
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Remove upload dirs from earlier runs; a live pid keeps its files even when they are old. */
async function sweepUploads(): Promise<void> {
	const entries = await readdir(UPLOAD_ROOT).catch(() => [] as string[]);
	const cutoff = Date.now() - UPLOAD_STALE_MS;
	for (const name of entries) {
		const pid = Number(name.split("-")[0]);
		if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) continue;
		const path = join(UPLOAD_ROOT, name);
		try {
			if ((await stat(path)).mtimeMs < cutoff) await rm(path, { recursive: true, force: true });
		} catch {
			// another process may have removed it first
		}
	}
}

async function ensureUploadDir(b: Bridge): Promise<string> {
	if (b.uploadDir) return b.uploadDir;
	const dir = join(UPLOAD_ROOT, `${process.pid}-${b.token.slice(0, 8)}`);
	await mkdir(dir, { recursive: true });
	trackUploadDir(dir);
	b.uploadDir = dir;
	return dir;
}

/**
 * The name shown in the UI. The original is only a label, so it keeps unicode and spaces, loses any
 * directory parts, and is capped; nothing here reaches the filesystem.
 */
function sanitizeFileName(name: string): string {
	const base = name.split(/[\\/]/).pop() ?? "";
	const cleaned = base.replace(/[\u0000-\u001f\u007f<>:"|?*]+/g, " ").replace(/^\.+/, "").trim();
	return cleaned.slice(0, 80) || "file";
}

/**
 * Stored names are generated, never taken from the request: the user's name cannot pick a path, a
 * length, a collision or a suffix that some tool later interprets. Only a harmless extension is
 * carried over so external commands still infer the type from the path.
 */
function storedFileName(displayName: string): string {
	const extension = extname(displayName).toLowerCase();
	return `${randomBytes(8).toString("hex")}${/^\.[a-z0-9]{1,8}$/.test(extension) ? extension : ""}`;
}

/** Image blocks from the request, or a message saying why they were rejected. */
function parseImages(value: unknown): ImageBlock[] | string {
	if (value === undefined) return [];
	if (!Array.isArray(value)) return "images must be an array";
	if (value.length > MAX_IMAGES) return `at most ${MAX_IMAGES} images per message`;
	const blocks: ImageBlock[] = [];
	for (const entry of value) {
		const image = (entry ?? {}) as { mimeType?: unknown; data?: unknown };
		const mimeType = typeof image.mimeType === "string" ? image.mimeType : "";
		const data = typeof image.data === "string" ? image.data : "";
		if (!IMAGE_MIME_TYPES.includes(mimeType)) return `unsupported image type ${mimeType || "(none)"}`;
		if (!BASE64.test(data)) return "malformed image data";
		if (data.length > MAX_IMAGE_BASE64) return "image is too large (limit 4.5MB)";
		blocks.push({ type: "image", mimeType, data });
	}
	return blocks;
}

interface Bridge {
	api: ExtensionAPI;
	ctx: ExtensionContext;
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
	/** Resolver for the session switch currently in flight, settled by the webui-session command. */
	switchRequest: ((outcome: SwitchOutcome) => void) | undefined;
	/** Uploaded drop target for this bridge; created on first drop, removed when the process exits. */
	uploadDir: string | undefined;
	/** no_proxy values saved when the page switched the proxy off, so it can be restored. */
	proxyBypassSaved: { lower: string | undefined; upper: string | undefined } | undefined;
}

interface SwitchOutcome {
	ok: boolean;
	message?: string;
}

/**
 * Session control (switchSession/newSession) only exists on ExtensionCommandContext, which the
 * runtime hands to command handlers. The bridge is started from session_start, where there is
 * only an ExtensionContext, so it dispatches its own command and lets the runtime build the
 * command context instead of trying to hold one.
 */
const SWITCH_COMMAND = "webui-session";

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

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size > limit) throw new Error("body too large");
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage, limit = 256 * 1024): Promise<Record<string, unknown>> {
	return JSON.parse((await readBody(req, limit)).toString("utf8")) as Record<string, unknown>;
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

/**
 * Proxy switch. nife builds its HTTP agent once, at startup (EnvHttpProxyAgent in
 * core/http-dispatcher.ts), so the proxy address cannot change while the process runs - but undici
 * re-reads NO_PROXY for every request and `*` means "never proxy". That makes the bypass list the
 * one lever a running session can pull: the page can stop relaying through the proxy and start
 * again, without touching nife internals.
 */
/**
 * undici keeps two agents: http_proxy for http targets and https_proxy for https targets, and
 * https only falls back to the http one when it is not set itself (the reverse is not true, so
 * "https only" leaves plain http direct). Report both resolved values.
 */
const proxyEnv = () => {
	const http = process.env.http_proxy ?? process.env.HTTP_PROXY;
	const https = process.env.https_proxy ?? process.env.HTTPS_PROXY ?? http;
	return {
		http,
		https,
		bypass: process.env.no_proxy ?? process.env.NO_PROXY ?? "",
	};
};

function proxyState(b: Bridge) {
	const env = proxyEnv();
	// Built once at startup, so these are what the running session relays through.
	return {
		configured: env.http !== undefined || env.https !== undefined,
		http: env.http ?? null,
		https: env.https ?? null,
		bypassed: b.proxyBypassSaved !== undefined,
		bypass: env.bypass,
	};
}

function setProxyBypass(b: Bridge, bypass: boolean): void {
	if (bypass) {
		if (b.proxyBypassSaved === undefined) {
			b.proxyBypassSaved = { lower: process.env.no_proxy, upper: process.env.NO_PROXY };
		}
		process.env.no_proxy = "*";
		process.env.NO_PROXY = "*";
		return;
	}
	const saved = b.proxyBypassSaved;
	if (saved === undefined) return;
	for (const [key, value] of [
		["no_proxy", saved.lower],
		["NO_PROXY", saved.upper],
	] as const) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	b.proxyBypassSaved = undefined;
}

function snapshot(b: Bridge): unknown {
	const ctx = b.ctx;
	// buildContextEntries() is what the TUI renders: it starts at the newest compaction, so a
	// summary replaces the messages it squeezed out instead of showing the whole old branch.
	const messages = ctx.sessionManager
		.buildContextEntries()
		.flatMap((entry) => sessionEntryToContextMessages(entry))
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
		proxy: proxyState(b),
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

/**
 * Deleting a session mirrors the TUI selector: prefer the `trash` CLI so the file is recoverable,
 * fall back to unlink. Only paths that SessionManager lists for this cwd are ever passed here.
 */
async function deleteSessionFile(
	sessionPath: string,
): Promise<{ ok: boolean; method: "trash" | "unlink"; error?: string }> {
	const args = sessionPath.startsWith("-") ? ["--", sessionPath] : [sessionPath];
	const trashed = spawnSync("trash", args, { encoding: "utf-8" });
	if (trashed.status === 0 || !existsSync(sessionPath)) return { ok: true, method: "trash" };
	try {
		await unlink(sessionPath);
		return { ok: true, method: "unlink" };
	} catch (error) {
		return { ok: false, method: "unlink", error: error instanceof Error ? error.message : "delete failed" };
	}
}

function requestSwitch(b: Bridge, args: string): Promise<SwitchOutcome> {
	if (!b.ctx.isIdle()) return Promise.resolve({ ok: false, message: "stop the current turn first" });
	const api = b.api;
	return new Promise<SwitchOutcome>((resolve) => {
		const timer = setTimeout(() => {
			if (b.switchRequest === settle) b.switchRequest = undefined;
			resolve({ ok: false, message: "session switch timed out" });
		}, 120_000);
		const settle = (outcome: SwitchOutcome) => {
			clearTimeout(timer);
			resolve(outcome);
		};
		b.switchRequest = settle;
		// Dispatch through the runtime so the command handler receives a real command context.
		api.sendUserMessage(`/${SWITCH_COMMAND} ${args}`, { expandPromptTemplates: true });
	});
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
		let body: Record<string, unknown>;
		try {
			body = await readJson(req, PROMPT_MAX_BODY);
		} catch (error) {
			const message = error instanceof Error ? error.message : "bad body";
			return send(res, message === "body too large" ? 413 : 400, message);
		}
		const text = typeof body.text === "string" ? body.text.trim() : "";
		const images = parseImages(body.images);
		if (typeof images === "string") return send(res, 400, images);
		if (!text && images.length === 0) return send(res, 400, "empty prompt");
		if (images.length > 0 && !b.ctx.model?.input?.includes("image")) {
			return send(res, 409, `${b.ctx.model?.id ?? "this model"} does not accept images`);
		}
		// The page owns the pending queue. Never deliverAs "steer": that would inject the prompt into
		// nife's own mid-turn queue, so the browser strip and the session would disagree about what is
		// still waiting. A busy session is a 409 and the page keeps the item, sending it after the
		// turn settles.
		if (!b.ctx.isIdle()) return send(res, 409, "busy");
		// Text-only prompts stay a string so slash commands and prompt templates keep working.
		const content: string | (TextBlock | ImageBlock)[] =
			images.length === 0 ? text : text ? [{ type: "text", text }, ...images] : images;
		try {
			b.api.sendUserMessage(content);
		} catch (error) {
			return send(res, 409, error instanceof Error ? error.message : "send failed");
		}
		return send(res, 200, "ok");
	}

	if (req.method === "POST" && path === "/api/upload") {
		const header = req.headers["x-file-name"];
		let name = "file";
		if (typeof header === "string" && header) {
			try {
				name = sanitizeFileName(decodeURIComponent(header));
			} catch {
				// a malformed escape is not worth a different status: sanitize the raw header
				name = sanitizeFileName(header);
			}
		}
		let bytes: Buffer;
		try {
			bytes = await readBody(req, MAX_UPLOAD_BYTES);
		} catch (error) {
			const message = error instanceof Error ? error.message : "bad upload";
			return send(res, message === "body too large" ? 413 : 400, message);
		}
		if (bytes.length === 0) return send(res, 400, "empty file");
		try {
			const dir = await ensureUploadDir(b);
			const file = join(dir, storedFileName(name));
			await writeFile(file, bytes);
			return send(res, 200, JSON.stringify({ path: file, name }), "application/json");
		} catch (error) {
			return send(res, 500, error instanceof Error ? error.message : "upload failed");
		}
	}

	if (req.method === "POST" && path === "/api/compact") {
		let body: Record<string, unknown>;
		try {
			body = await readJson(req);
		} catch {
			body = {};
		}
		const instructions = typeof body.instructions === "string" ? body.instructions.trim() : "";
		// compact() is fire-and-forget by design, so wrap its callbacks in a promise the page can wait on.
		const outcome = await new Promise<{ ok: boolean; message: string }>((done) => {
			const timer = setTimeout(() => done({ ok: false, message: "compaction timed out" }), 300_000);
			const settle = (result: { ok: boolean; message: string }) => {
				clearTimeout(timer);
				done(result);
			};
			try {
				b.ctx.compact({
					customInstructions: instructions || undefined,
					onComplete: () => settle({ ok: true, message: "ok" }),
					onError: (error) => settle({ ok: false, message: error.message }),
				});
			} catch (error) {
				settle({ ok: false, message: error instanceof Error ? error.message : "compaction failed" });
			}
		});
		if (!outcome.ok) return send(res, 409, outcome.message);
		return send(res, 200, "ok");
	}

	if (req.method === "POST" && path === "/api/proxy") {
		let body: Record<string, unknown>;
		try {
			body = await readJson(req, 1024);
		} catch (error) {
			const message = error instanceof Error ? error.message : "bad body";
			return send(res, message === "body too large" ? 413 : 400, message);
		}
		if (typeof body.bypass !== "boolean") return send(res, 400, "bypass must be a boolean");
		if (body.bypass && !proxyState(b).configured) return send(res, 409, "this session was started without a proxy");
		setProxyBypass(b, body.bypass);
		return send(res, 200, JSON.stringify(proxyState(b)), "application/json");
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
		const outcome = await requestSwitch(b, `resume ${sessionPath}`);
		if (!outcome.ok) return send(res, 409, outcome.message ?? "switch failed");
		broadcast(b, { type: "session_switch" });
		return send(res, 200, "ok");
	}

	if (req.method === "POST" && path === "/api/delete") {
		const body = await readJson(req);
		const target = typeof body.path === "string" ? body.path : "";
		if (!target) return send(res, 400, "missing path");
		if (target === b.ctx.sessionManager.getSessionFile()) return send(res, 409, "cannot delete the active session");
		// Never delete arbitrary paths: the target has to be a session this project lists.
		const known = (await SessionManager.list(b.ctx.cwd)).some((session) => session.path === target);
		if (!known) return send(res, 404, "unknown session");
		const result = await deleteSessionFile(target);
		if (!result.ok) return send(res, 500, result.error ?? "delete failed");
		broadcast(b, { type: "sessions_changed" });
		return send(res, 200, result.method);
	}

	if (req.method === "POST" && path === "/api/new") {
		const outcome = await requestSwitch(b, "new");
		if (!outcome.ok) return send(res, 409, outcome.message ?? "switch failed");
		broadcast(b, { type: "session_switch" });
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

async function start(api: ExtensionAPI, ctx: ExtensionContext): Promise<Bridge> {
	// Abandoned upload dirs from crashed runs would otherwise accumulate in the temp dir.
	await sweepUploads();
	const token = randomBytes(16).toString("hex");
	const server = createServer();
	const b: Bridge = {
		api,
		ctx,
		server,
		port: 0,
		token,
		clients: new Set(),
		pending: new Map(),
		patchedUI: undefined,
		orig: undefined,
		children: new Map(),
		autoOpened: false,
		switchRequest: undefined,
		uploadDir: undefined,
		proxyBypassSaved: undefined,
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
			patchDialogs(ctx, b);
			ctx.ui.notify(`webui: ${webuiUrl(b)}`, "info");
		},
	});

	api.registerCommand(SWITCH_COMMAND, {
		description: "Internal: session switching for the web UI",
		handler: async (args, ctx) => {
			const b = store.__nifeWebui;
			const settle = (outcome: SwitchOutcome) => {
				if (!b) return;
				const request = b.switchRequest;
				b.switchRequest = undefined;
				request?.(outcome);
			};
			const [kind, ...rest] = args.trim().split(/\s+/);
			try {
				if (kind === "resume") {
					const sessionPath = rest.join(" ");
					if (!sessionPath) throw new Error("missing session path");
					const result = await ctx.switchSession(sessionPath);
					settle(result.cancelled ? { ok: false, message: "switch cancelled" } : { ok: true });
					return;
				}
				if (kind === "new") {
					const result = await ctx.newSession();
					settle(result.cancelled ? { ok: false, message: "new session cancelled" } : { ok: true });
					return;
				}
				throw new Error(`unknown switch kind: ${kind || "none"}`);
			} catch (error) {
				settle({ ok: false, message: error instanceof Error ? error.message : "switch failed" });
			}
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
	api.on("agent_settled", (event) => {
		// `aborted` matters to the page: an interrupted turn is a deliberate stop, and the UI queue
		// must hold the next task instead of starting it.
		forward({ type: "agent_settled", aborted: Boolean(event?.aborted) });
	});
	// Threshold and overflow compaction happen without a click; the page needs to know either way.
	api.on("session_before_compact", (event) => {
		forward({ type: "compaction_start", reason: event.reason });
	});
	api.on("session_compact", (event) => {
		forward({ type: "compaction_end", ok: true, reason: event.reason });
	});
	api.on("session_compact_failed", (event) => {
		forward({ type: "compaction_end", ok: false, reason: event.reason, message: event.errorMessage });
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
