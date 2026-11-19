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

import { execFile, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
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
/** NIFE_WEBUI_DEBUG=1: log what arrived versus what the bridge routed (tunnel prefix debugging). */
const DEBUG = process.env.NIFE_WEBUI_DEBUG === "1";
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

/** Recents renders a title, not a transcript: a pasted log must not ride along in the payload. */
const SESSION_TITLE_MAX = 100;

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
	/** port -> public URL, for every port this bridge published (its own page included). */
	publicUrls: Map<number, string>;
	/** nifetun is holding the tunnel for the approval mail: no URL yet, but something is happening. */
	tunnelPending: boolean;
	/** Rebuilds since the client last worked, so a flapping tunnel cannot respawn forever. */
	tunnelRevives: number;
	/** An `up` is in flight: /webui, the heartbeat and the startup path must not stack them. */
	tunnelBusy: boolean;
	/** The handler of the module serving this bridge: /reload swaps it here so routing changes apply. */
	handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
	/** Waiting for the approval mail, so a tunnel that comes up later still gets announced. */
	tunnelTimer: ReturnType<typeof setTimeout> | undefined;
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

/**
 * A long session cannot travel in one response: the page would spend its load time parsing
 * megabytes of JSON and building the objects before it can paint anything. It gets a tail slice
 * instead and asks for the previous one as the reader scrolls up, so the cost of a page load stops
 * depending on how much was said earlier.
 */
const PAGE_MIN = 20;
const PAGE_MAX = 60;
const PAGE_BYTES = 400 * 1024;

/** Rough serialized size of a message; enough to keep a page inside the byte budget. */
function messageSize(message: { content?: unknown }): number {
	const content = message.content;
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 64;
	let size = 64;
	for (const block of content as Record<string, unknown>[]) {
		if (!block || typeof block !== "object") continue;
		if (typeof block.text === "string") size += block.text.length;
		else if (typeof block.thinking === "string") size += block.thinking.length;
		else if (typeof block.data === "string") size += block.data.length;
		else if (block.arguments) size += JSON.stringify(block.arguments).length;
	}
	return size;
}

/**
 * The page that ends at `end`. A page starts on a user message when it can, so a tool call is never
 * separated from the result the transcript pairs it with.
 */
function pageOf<T extends { role: string; content?: unknown }>(
	messages: T[],
	end: number,
): { messages: T[]; from: number } {
	let start = Math.min(end, messages.length);
	let bytes = 0;
	while (start > 0 && end - start < PAGE_MAX) {
		const size = messageSize(messages[start - 1]);
		// the minimum keeps a page useful even when a single tool result is huge
		if (end - start >= PAGE_MIN && bytes + size > PAGE_BYTES) break;
		bytes += size;
		start -= 1;
	}
	while (start > 0 && messages[start].role !== "user" && end - start < 500) start -= 1;
	return { messages: messages.slice(start, end), from: start };
}

/**
 * The rail needs every task in the session, not only the ones whose page is loaded, so the index
 * travels with the state: a message index plus a label, no content. Absolute indices are stable
 * when older pages are prepended, which is what makes "jump to task 3" work from a tail page.
 */
const TASK_MAX = 300;

function promptLabel(message: { content?: unknown }): string {
	const content = message.content;
	let raw = "";
	if (typeof content === "string") raw = content;
	else if (Array.isArray(content)) {
		for (const block of content as { type?: string; text?: string }[]) {
			if (block?.type === "text" && typeof block.text === "string") raw += `${block.text}\n`;
		}
	}
	const line = raw
		.split("\n")
		// dropped files ride along as marker lines; they are not what was asked
		.filter((part) => part.trim() && !part.trim().startsWith("[attached] "))
		.map((part) => part.trim().replace(/^#+\s*/, "").replace(/[`*]/g, ""))
		.find(Boolean);
	if (!line) return "attachment";
	return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}

function taskIndex(messages: { role: string; content?: unknown }[]): { index: number; label: string }[] {
	const tasks: { index: number; label: string }[] = [];
	for (let index = 0; index < messages.length; index += 1) {
		const message = messages[index];
		if (message.role !== "user") continue;
		tasks.push({ index, label: promptLabel(message) });
	}
	const trimmed = tasks.slice(-TASK_MAX);
	// The rail has to cover the whole transcript, or the top mark leaves rows above it that no mark
	// points at. After compaction the first row is the summary, not a prompt, so label it as such.
	const head = messages[0];
	// A session that starts on a prompt needs no extra mark: the first task already is the top.
	if (!head || head.role === "user") return trimmed;
	const label = head?.role === "compactionSummary" ? "Compacted context" : head?.role === "branchSummary" ? "Branch summary" : "Session start";
	return [{ index: 0, label }, ...trimmed];
}

/**
 * What the transcript shows: the whole active branch, not the compaction-aware context. Compaction
 * drops old messages from the model's context, but the reader still wants to scroll back through
 * them, so the session history stays complete and each compaction becomes a marker row in place.
 */
interface TranscriptMessage {
	role: string;
	display?: boolean;
	content?: unknown;
	summary?: string;
	tokensBefore?: number;
	timestamp?: string;
	customType?: string;
	usage?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost?: { total?: number };
	};
}

function contextMessages(b: Bridge): TranscriptMessage[] {
	const out: TranscriptMessage[] = [];
	for (const entry of b.ctx.sessionManager.getBranch()) {
		if (entry.type === "compaction") {
			// A row where the context was rewritten, so the missing messages are explained in place.
			out.push({
				role: "compactionMarker",
				summary: entry.summary,
				tokensBefore: entry.tokensBefore,
				timestamp: entry.timestamp,
			});
			continue;
		}
		for (const message of sessionEntryToContextMessages(entry)) {
			const row = message as unknown as TranscriptMessage;
			if (!isHiddenMessage(row)) out.push(row);
		}
	}
	return out;
}

function snapshot(b: Bridge, metaOnly = false): unknown {
	const ctx = b.ctx;
	const messages = contextMessages(b);
	const page = pageOf(messages, messages.length);
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
		// the footer button only exists when a tunnel can actually be made
		tunnelAvailable: hasTunnel(b.api),
		// the page shows the published port in the sidebar footer, or that approval is pending
		tunnel: tunnelState(b),
		// ports this session's own processes are listening on, offered in the footer
		services: listServices(b),
		// what the tunnel menu shows, already split and already without this page's own port
		ports: portRows(b),
		stats,
		subagents: [...b.children.values()],
		// the transcript reads `messages` and asks for older pages with `loadedFrom` as the cursor
		messages: metaOnly ? [] : page.messages,
		messageCount: messages.length,
		loadedFrom: page.from,
		tasks: taskIndex(messages),
	};
}

async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
	const relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
	const file = resolve(DIST_DIR, relative);
	if (!file.startsWith(DIST_DIR + sep)) return send(res, 404, `not found: ${pathname}`);
	try {
		const body = await readFile(file);
		send(res, 200, body, CONTENT_TYPES[extname(file)] ?? "application/octet-stream");
	} catch {
		send(res, 404, `not found: ${pathname}`);
	}
}

async function listSessions(b: Bridge): Promise<unknown> {
	// SessionManager.list parses only what was appended since the previous listing of these files.
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
			// Whitespace collapsed here, not in the page: a title is one line, whatever was pasted.
			firstMessage: session.firstMessage.replace(/\s+/g, " ").trim().slice(0, SESSION_TITLE_MAX),
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

/**
 * The path this bridge should answer, whatever the tunnel did to it.
 *
 * nifetun strips `/t/<id>` before forwarding and names what it stripped in `X-Forwarded-Prefix`,
 * but a request can also arrive with the mount still attached (a client that did not strip, an old
 * page that prefixes its own calls) or with a doubled slash. Both used to fall through to a 404 that
 * says nothing, so the prefix is removed here as well instead of trusting the edge.
 */
function routePath(req: IncomingMessage, pathname: string): { path: string; mount: string } {
	const header = req.headers["x-forwarded-prefix"];
	let mount = (typeof header === "string" ? header : "").replace(/\/+$/, "");
	let path = pathname.replace(/\/{2,}/g, "/");
	// An edge that does not strip (older nifetun, or `strip_prefix: false`) sends no header and leaves
	// /t/<id> on the path. Nothing else here starts with that shape, so the mount is readable from the
	// path itself; without it every request lands on a 404 that looks like a broken API.
	if (!mount) {
		const inferred = /^\/t\/[a-z0-9][a-z0-9_-]{0,63}(?=\/|$)/i.exec(path);
		if (inferred) mount = inferred[0];
	}
	// the mount can appear more than once when a page prefixed an already-prefixed request
	while (mount && (path === mount || path.startsWith(`${mount}/`))) path = path.slice(mount.length) || "/";
	return { path: path.startsWith("/") ? path : `/${path}`, mount };
}

async function handle(b: Bridge, req: IncomingMessage, res: ServerResponse): Promise<void> {
	// `new URL("//x/y")` parses as a scheme-relative host, so the leading slash is collapsed first:
	// a doubled slash must stay a path, not become a hostname.
	const url = new URL((req.url ?? "/").replace(/^\/+/, "/"), `http://127.0.0.1:${b.port}`);
	const { path, mount } = routePath(req, url.pathname);
	// NIFE_WEBUI_DEBUG=1 shows what a tunnel actually forwarded, prefix included.
	if (DEBUG && (mount || req.url !== path)) console.error(`webui ${req.method} ${req.url} -> ${path}`);

	// Static assets carry no session data and are requested without the token.
	if (req.method === "GET" && !path.startsWith("/api/")) return serveStatic(path, res);

	const origin = req.headers.origin;
	if (origin) {
		// Same origin wherever the page is served from: 127.0.0.1 directly, or the nifetun URL once
		// the port is published. Anything else is another site trying to drive this session.
		const host = req.headers.host ?? "";
		const sameOrigin = [
			`http://127.0.0.1:${b.port}`,
			`http://localhost:${b.port}`,
			`http://${host}`,
			`https://${host}`,
		];
		if (!sameOrigin.includes(origin)) return send(res, 403, "forbidden");
	}
	if (url.searchParams.get("t") !== b.token) return send(res, 401, "bad token");

	if (req.method === "GET" && path === "/api/state") {
		// the header refresh runs on every event and only reads counts: no reason to ship the page
		return send(res, 200, JSON.stringify(snapshot(b, url.searchParams.get("meta") === "1")), "application/json");
	}

	// one page of older messages, ending right before `before`
	// Publishing is the page's call (the "tunnel" button in the sidebar footer), not the bridge's:
	// an extension that quietly opened a public URL at startup was not what anyone asked for.
	if (req.method === "POST" && path === "/api/tunnel") {
		let body: Record<string, unknown>;
		try {
			body = await readJson(req, 1024);
		} catch (error) {
			return send(res, 400, error instanceof Error ? error.message : "bad body");
		}
		if (!hasTunnel(b.api)) return send(res, 409, "no tunnel extension in this session");
		if (body.action === "up") {
			const port = Number(body.port);
			await attachTunnel(b, [Number.isInteger(port) && port > 0 ? port : b.port]);
			return send(res, 200, JSON.stringify({ tunnel: tunnelState(b), ports: portRows(b) }), "application/json");
		}
		if (body.action === "down") {
			const port = Number(body.port);
			const target = Number.isInteger(port) && port > 0 ? port : b.port;
			// only this port: other tunnels of the same client belong to whatever else you were doing
			await tunnelRequest(b.api, { kind: "down", tunnels: [`127.0.0.1:${target}`] }, 10_000);
			b.publicUrls.delete(target);
			if (target === b.port) {
				clearTunnelTimer(b);
				b.tunnelPending = false;
				b.tunnelRevives = 0;
			}
			pushTunnel(b);
			return send(res, 200, JSON.stringify({ tunnel: tunnelState(b), ports: portRows(b) }), "application/json");
		}
		return send(res, 400, "action must be up or down");
	}

	if (req.method === "GET" && path === "/api/messages") {
		const before = Number(url.searchParams.get("before"));
		if (!Number.isInteger(before) || before <= 0) return send(res, 400, "before must be a positive index");
		const messages = contextMessages(b);
		const page = pageOf(messages, Math.min(before, messages.length));
		return send(res, 200, JSON.stringify({ messages: page.messages, from: page.from, total: messages.length }), "application/json");
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

	return send(res, 404, `not found: ${path}`);
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

/**
 * Tunnel (nifetun). The tunnel extension owns the client process; this extension only asks it, over
 * nife's event bus, to publish the webui port, and then prints the public URL. The trigger is the
 * same signal a person has: a /tunnel command in the session (or its tunnel_up tool). Without the
 * tunnel package nothing changes: the bridge stays on 127.0.0.1.
 */
/**
 * Services the session started: the ports that processes under this CLI are listening on. A dev
 * server, a preview, an API started with `bash` - those are what someone wants to hand out, and the
 * page can offer them instead of asking the user to find the port. Only the process tree counts, so
 * whatever else runs on the machine never shows up here.
 *
 * The scan is asynchronous and cached: `netstat` plus PowerShell on Windows takes about a second, and
 * a state request must never wait for it. Callers get the last list; a scan that changed something
 * broadcasts `services`.
 */
type Service = { port: number; cmd: string };

const SERVICES_TTL_MS = 3_000;
let servicesCache: { at: number; services: Service[] } | undefined;
let servicesScan: Promise<void> | undefined;

function listServices(b: Bridge): Service[] {
	// nothing to offer without nifetun, so nothing to scan for either
	if (!hasTunnel(b.api)) return [];
	const stale = !servicesCache || Date.now() - servicesCache.at > SERVICES_TTL_MS;
	if (stale && !servicesScan) {
		servicesScan = scanServices(b).finally(() => {
			servicesScan = undefined;
		});
	}
	return servicesCache?.services ?? [];
}

/** Force a fresh scan (a tool just finished and may have started a server). */
function refreshServices(b: Bridge): void {
	if (!hasTunnel(b.api)) return;
	servicesCache = undefined;
	void scanServices(b);
}

async function scanServices(b: Bridge): Promise<void> {
	let services: Service[];
	try {
		services = await detectServices(b.port);
	} catch {
		services = [];
	}
	const before = servicesCache?.services;
	if (before && sameServices(before, services)) {
		servicesCache = { at: Date.now(), services: before };
		return;
	}
	servicesCache = { at: Date.now(), services };
	broadcast(b, { type: "services", services, ports: portRows(b) });
}

const sameServices = (left: Service[], right: Service[]): boolean =>
	left.length === right.length && left.every((service, index) => service.port === right[index].port);

function detectServices(ownPort: number): Promise<Service[]> {
	if (process.platform === "linux") return Promise.resolve(detectProcServices(ownPort));
	if (process.platform === "darwin") return detectLsofServices(ownPort);
	return detectWindowsServices(ownPort);
}

function run(command: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(command, args, { maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
			if (error) reject(error);
			else resolve(stdout);
		});
	});
}

// ---------- Linux: /proc ----------

/** Listening port -> inode, from /proc/net/tcp{,6}; only loopback/any-address listeners can be tunneled. */
function listenInodes(): Map<number, number> {
	const out = new Map<number, number>();
	for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
		let text: string;
		try {
			text = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		for (const line of text.split("\n").slice(1)) {
			const cols = line.trim().split(/\s+/);
			if (cols.length < 10 || cols[3] !== "0A") continue; // 0A = LISTEN
			const [address, port] = cols[1].split(":");
			if (!isLoopbackBinding(address)) continue;
			const inode = Number(cols[9]);
			if (inode) out.set(inode, Number.parseInt(port, 16));
		}
	}
	return out;
}

/** `0100007F` (127.0.0.1), `00000000` (any), `::1` and `::` are reachable as 127.0.0.1. */
function isLoopbackBinding(address: string): boolean {
	const value = address.padStart(8, "0").toUpperCase();
	return value === "0100007F" || value === "00000000" || /^0{31}1$/.test(value) || /^0{32}$/.test(value);
}

function detectProcServices(ownPort: number): Service[] {
	const inodes = listenInodes();
	if (!inodes.size) return [];
	const tree = procTree(process.pid);
	const out: Service[] = [];
	for (const pid of tree) {
		if (pid === process.pid) continue;
		let fds: string[];
		try {
			fds = readdirSync(`/proc/${pid}/fd`);
		} catch {
			continue;
		}
		const found: number[] = [];
		for (const fd of fds) {
			let target: string;
			try {
				target = readlinkSync(`/proc/${pid}/fd/${fd}`);
			} catch {
				continue;
			}
			const match = /^socket:\[(\d+)\]$/.exec(target);
			const port = match ? inodes.get(Number(match[1])) : undefined;
			if (port && port !== ownPort && !found.includes(port)) found.push(port);
		}
		if (!found.length) continue;
		let cmd = "";
		try {
			cmd = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
		} catch {
			// gone already
		}
		for (const port of found) out.push({ port, cmd });
	}
	return sortServices(out);
}

/** `ppid` from /proc/<pid>/stat; the command name in parentheses may contain spaces and parens. */
function parentOf(pid: number): number | undefined {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		const ppid = Number(rest[1]);
		return Number.isInteger(ppid) ? ppid : undefined;
	} catch {
		return undefined;
	}
}

function procTree(root: number): Set<number> {
	const parents = new Map<number, number>();
	for (const name of readdirSync("/proc")) {
		if (!/^\d+$/.test(name)) continue;
		const pid = Number(name);
		const ppid = parentOf(pid);
		if (ppid !== undefined) parents.set(pid, ppid);
	}
	return descend(root, parents);
}

/** pids that are `root` or descend from it. */
function descend(root: number, parents: Map<number, number>): Set<number> {
	const tree = new Set([root]);
	let grew = true;
	while (grew) {
		grew = false;
		for (const [pid, ppid] of parents) {
			if (tree.has(pid) || !tree.has(ppid)) continue;
			tree.add(pid);
			grew = true;
		}
	}
	return tree;
}

// ---------- macOS: lsof + ps ----------

async function detectLsofServices(ownPort: number): Promise<Service[]> {
	const [lsof, ps] = await Promise.all([
		run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"]),
		run("ps", ["-A", "-o", "pid=,ppid=,comm="]),
	]);
	const parents = new Map<number, number>();
	const named = new Map<number, string>();
	for (const line of ps.split("\n")) {
		const parts = line.trim().split(/\s+/);
		if (parts.length < 2 || !/^\d+$/.test(parts[0])) continue;
		parents.set(Number(parts[0]), Number(parts[1]));
		if (parts[2]) named.set(Number(parts[0]), parts[2].split("/").pop() ?? parts[2]);
	}
	const tree = descend(process.pid, parents);
	const out: Service[] = [];
	let pid = 0;
	let cmd = "";
	for (const line of lsof.split("\n")) {
		if (line.startsWith("p")) pid = Number(line.slice(1));
		else if (line.startsWith("c")) cmd = line.slice(1);
		else if (line.startsWith("n")) {
			const port = Number(line.slice(line.lastIndexOf(":") + 1));
			if (!pid || pid === process.pid || !tree.has(pid) || !port || port === ownPort) continue;
			out.push({ port, cmd: cmd || named.get(pid) || "" });
		}
	}
	return sortServices(out);
}

// ---------- Windows: netstat -ano + PowerShell ----------

/**
 * `netstat -ano` lists the listening sockets with their owning pid; `Get-CimInstance Win32_Process`
 * lists every process with its parent, which is what turns "what is listening" into "what this CLI
 * started". Both are one call each, wrapped here so a missing or restricted shell just yields [].
 */
async function detectWindowsServices(ownPort: number): Promise<Service[]> {
	const [netstat, table] = await Promise.all([
		run("netstat", ["-ano"]),
		run("powershell", [
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			"Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId) $($_.Name)\" }",
		]),
	]);
	const parents = new Map<number, number>();
	const named = new Map<number, string>();
	for (const line of table.split(/\r?\n/)) {
		const parts = line.trim().split(/\s+/);
		if (parts.length < 3 || !/^\d+$/.test(parts[0])) continue;
		parents.set(Number(parts[0]), Number(parts[1]));
		named.set(Number(parts[0]), parts[2]);
	}
	if (!parents.size) return [];
	const tree = descend(process.pid, parents);
	const out: Service[] = [];
	for (const line of netstat.split(/\r?\n/)) {
		const cols = line.trim().split(/\s+/);
		if (cols.length < 5 || cols[0].toUpperCase() !== "TCP" || cols[3] !== "LISTENING") continue;
		const address = cols[1].slice(0, cols[1].lastIndexOf(":"));
		if (!isWindowsLoopback(address)) continue;
		const port = Number(cols[1].slice(cols[1].lastIndexOf(":") + 1));
		const pid = Number(cols[4]);
		if (!port || !pid || pid === process.pid || !tree.has(pid) || port === ownPort) continue;
		out.push({ port, cmd: (named.get(pid) ?? "").replace(/\.exe$/i, "") });
	}
	return sortServices(out);
}

function isWindowsLoopback(address: string): boolean {
	const value = address.replace(/^\[|\]$/g, "").toLowerCase();
	return value === "0.0.0.0" || value === "127.0.0.1" || value === "::" || value === "::1";
}

/** pids under this CLI, deepest first: that is what a shutdown has to take down. */
function descendantPids(): number[] {
	if (process.platform === "linux") return [...procTree(process.pid)].filter((pid) => pid !== process.pid).reverse();
	const command =
		process.platform === "darwin"
			? ["ps", ["-A", "-o", "pid=,ppid="]]
			: [
					"powershell",
					[
						"-NoProfile",
						"-NonInteractive",
						"-Command",
						'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
					],
				];
	const result = spawnSync(command[0] as string, command[1] as string[], { encoding: "utf8" });
	if (result.status !== 0 || !result.stdout) return [];
	const parents = new Map<number, number>();
	for (const line of result.stdout.split(/\r?\n/)) {
		const parts = line.trim().split(/\s+/);
		if (parts.length < 2 || !/^\d+$/.test(parts[0])) continue;
		parents.set(Number(parts[0]), Number(parts[1]));
	}
	return [...descend(process.pid, parents)].filter((pid) => pid !== process.pid).reverse();
}

/**
 * The CLI is going away: the servers it started go with it, otherwise every quit leaves a dev server
 * behind on a port nobody remembers. A reload or a session switch keeps them - the process, and the
 * tunnels on it, are still there.
 */
function killServices(): void {
	for (const pid of descendantPids()) {
		try {
			process.kill(pid);
		} catch {
			// already gone
		}
	}
}

/** One row per port (a server often has several sockets on the same one), smallest first. */
function sortServices(services: Service[]): Service[] {
	const byPort = new Map<number, Service>();
	for (const service of services) if (!byPort.has(service.port)) byPort.set(service.port, service);
	return [...byPort.values()].sort((left, right) => left.port - right.port).slice(0, 8);
}

const TUNNEL_REQUEST = "nifetun:request";
const TUNNEL_REPLY = "nifetun:reply";
/** `up` waits for the edge to assign an id, which can sit behind an approval email. */
const TUNNEL_UP_TIMEOUT = 40_000;
/** Waiting for the approval mail: fast enough to feel automatic. */
const TUNNEL_POLL_MS = 4_000;
/** Published: how often to notice that the client carrying our port died. */
const TUNNEL_HEARTBEAT_MS = 20_000;
/** Rebuilds before the page stops offering a public URL. */
const TUNNEL_REVIVE_TRIES = 5;

type TunnelEntry = { url: string; local: string };
type TunnelInstance = { name?: string; pid?: number; alive?: boolean; tunnels?: string[]; entries?: TunnelEntry[] };
type TunnelReply = {
	ok?: boolean;
	error?: string;
	urls?: string[];
	entries?: TunnelEntry[];
	instances?: TunnelInstance[];
	pending?: boolean;
};

/** Is a tunnel available? Same signal as a human's: the /tunnel command, or its tool. */
function hasTunnel(api: ExtensionAPI): boolean {
	try {
		return (
			api.getCommands().some((command) => command.name === "tunnel" && command.source === "extension") ||
			api.getAllTools().some((tool) => tool.name === "tunnel_up")
		);
	} catch {
		// asked before the runtime was bound
		return false;
	}
}

/** Ask nifetun to act, and wait for the reply with the same id. A tunnel without the event API never answers. */
function tunnelRequest(api: ExtensionAPI, payload: Record<string, unknown>, timeoutMs: number): Promise<TunnelReply> {
	return new Promise((resolve) => {
		const id = randomBytes(6).toString("hex");
		let timer: ReturnType<typeof setTimeout> | undefined;
		let off: (() => void) | undefined;
		const settle = (reply: TunnelReply) => {
			if (timer) clearTimeout(timer);
			off?.();
			resolve(reply);
		};
		timer = setTimeout(() => settle({ ok: false, error: "nifetun did not answer" }), timeoutMs);
		off = api.events.on(TUNNEL_REPLY, (raw) => {
			const reply = raw as (TunnelReply & { id?: unknown }) | undefined;
			if (!reply || reply.id !== id) return;
			settle(reply);
		});
		api.events.emit(TUNNEL_REQUEST, { id, ...payload });
	});
}

/** The public URL nifetun assigned to this port (the `->` side of each entry names the local end). */
function tunnelUrlForPort(reply: TunnelReply, port: number): string {
	const names = [`127.0.0.1:${port}`, `localhost:${port}`, String(port)];
	for (const entry of reply.entries ?? []) {
		if (names.includes(entry.local)) return entry.url;
	}
	return "";
}

/** The token is this bridge's capability: a public URL is only useful printed with it. */
function withToken(url: string, token: string): string {
	try {
		const parsed = new URL(url);
		parsed.searchParams.set("t", token);
		return parsed.toString();
	} catch {
		return url;
	}
}

/**
 * What the footer shows: the URL of this page (or "waiting"), the way home, and every port this bridge
 * has published - the page itself plus whatever services the user asked for.
 */
function tunnelState(b: Bridge): {
	url: string;
	localUrl: string;
	port: number;
	pending: boolean;
	local: string;
	entries: { port: number; url: string; local: string }[];
} | null {
	const entries = [...b.publicUrls].map(([port, url]) => ({
		port,
		// the token belongs to this bridge: another service must not receive it in its query string
		url: port === b.port ? withToken(url, b.token) : url,
		local: `127.0.0.1:${port}`,
	}));
	if (!entries.length && !b.tunnelPending) return null;
	return {
		url: entries.find((entry) => entry.port === b.port)?.url ?? "",
		// the page needs the way home: disconnecting from the public URL cannot be done over the
		// tunnel it is tearing down
		localUrl: webuiUrl(b),
		port: b.port,
		pending: b.tunnelPending,
		local: `127.0.0.1:${b.port}`,
		entries,
	};
}

/**
 * The ports the menu lists, decided here and nowhere else: `server` for what this session is
 * listening on, `custom` for what the reader typed in. The bridge's own port is filtered out before
 * anything leaves this function, so no client-side rule can put it back on screen.
 */
function portRows(b: Bridge): { port: number; url: string; kind: "server" | "custom"; cmd: string }[] {
	if (!hasTunnel(b.api)) return [];
	const rows = new Map<number, { port: number; url: string; kind: "server" | "custom"; cmd: string }>();
	for (const service of listServices(b)) {
		if (service.port === b.port) continue;
		rows.set(service.port, {
			port: service.port,
			url: b.publicUrls.get(service.port) ?? "",
			kind: "server",
			cmd: service.cmd,
		});
	}
	for (const [port, url] of b.publicUrls) {
		if (port === b.port || rows.has(port)) continue;
		rows.set(port, { port, url, kind: "custom", cmd: "" });
	}
	return [...rows.values()].sort((left, right) => left.port - right.port);
}

function pushTunnel(b: Bridge): void {
	broadcast(b, { type: "tunnel", tunnel: tunnelState(b), ports: portRows(b) });
}

/** Take every `local -> url` nifetun reported and keep the ones for ports we asked about. */
function adoptEntries(b: Bridge, entries: TunnelEntry[] | undefined): Map<number, string> {
	const fresh = new Map<number, string>();
	for (const entry of entries ?? []) {
		const port = Number(entry.local.slice(entry.local.lastIndexOf(":") + 1));
		if (!Number.isInteger(port) || port <= 0) continue;
		fresh.set(port, entry.url);
		b.publicUrls.set(port, entry.url);
	}
	return fresh;
}

/** Announce every new public URL in the terminal and in the page. */
function publishTunnel(b: Bridge, reply: TunnelReply): void {
	const fresh = adoptEntries(b, reply.entries);
	b.tunnelPending = false;
	pushTunnel(b);
	for (const [port, url] of fresh) {
		if (port === b.port) b.ctx.ui.notify(`webui public: ${withToken(url, b.token)}`, "info");
		else b.ctx.ui.notify(`webui public: 127.0.0.1:${port} -> ${url}`, "info");
	}
	// published does not mean alive: keep an eye on the client that carries the ports
	scheduleTunnel(b, TUNNEL_HEARTBEAT_MS);
}

/** No URL yet: say so instead of leaving the terminal silent for the minutes an approval takes. */
function pendingTunnel(b: Bridge): void {
	if (b.tunnelPending) return;
	b.tunnelPending = true;
	pushTunnel(b);
	b.ctx.ui.notify(`webui: waiting for tunnel approval for 127.0.0.1:${b.port} (check your mail)`, "info");
}

/**
 * Publish a port through nifetun (this page's port plus whatever the user picked in the footer). The
 * first connection on a machine waits for an approval email, so a pending reply keeps asking: the URL
 * shows up on its own once someone clicks it.
 */
async function attachTunnel(b: Bridge, ports: number[]): Promise<void> {
	// pending means an approval is in flight: a second `up` would restart the client for nothing
	if (b.tunnelBusy || b.tunnelPending || store.__nifeWebui !== b || !hasTunnel(b.api)) return;
	// exactly the ports asked for: publishing a service must not drag this page's token with it
	const wanted = [...new Set(ports)].filter((port) => port > 0);
	if (!wanted.length) return;
	b.tunnelBusy = true;
	try {
		await requestTunnel(b, wanted);
	} finally {
		b.tunnelBusy = false;
	}
}

async function requestTunnel(b: Bridge, ports: number[]): Promise<void> {
	// Say something before asking: the first start spawns a client and can sit for seconds.
	b.ctx.ui.notify(
		`webui: publishing ${ports.map((port) => `127.0.0.1:${port}`).join(", ")} through nifetun…`,
		"info",
	);
	const reply = await tunnelRequest(
		b.api,
		{ kind: "up", tunnels: ports.map((port) => `127.0.0.1:${port}`) },
		TUNNEL_UP_TIMEOUT,
	);
	if (store.__nifeWebui !== b) return; // stopped while the tunnel was starting
	if (ports.some((port) => tunnelUrlForPort(reply, port))) return publishTunnel(b, reply);
	// no answer at all: the tunnel extension has no event API (or was unloaded), polling will not help
	if (!reply.ok) return;
	pendingTunnel(b);
	scheduleTunnel(b, TUNNEL_POLL_MS);
}

/** Is one of nifetun's live clients carrying this port? */
function tunnelAlive(reply: TunnelReply, port: number): boolean {
	const names = [`127.0.0.1:${port}`, `localhost:${port}`, String(port)];
	for (const instance of reply.instances ?? []) {
		if (instance.alive && (instance.tunnels ?? []).some((tunnel) => names.includes(tunnel))) return true;
	}
	return false;
}

function clearTunnelTimer(b: Bridge): void {
	if (!b.tunnelTimer) return;
	clearTimeout(b.tunnelTimer);
	b.tunnelTimer = undefined;
}

function scheduleTunnel(b: Bridge, delay: number): void {
	if (b.tunnelTimer) return;
	b.tunnelTimer = setTimeout(() => void tunnelTick(b).catch(() => {}), delay);
	b.tunnelTimer.unref?.();
}

/**
 * The tunnel lives in another process, so the bridge keeps asking: while the approval is pending, and
 * then every so often to notice that the client is gone. A dead client used to leave the page pointing
 * at a 404 that looked like a broken API.
 */
async function tunnelTick(b: Bridge): Promise<void> {
	b.tunnelTimer = undefined;
	if (store.__nifeWebui !== b) return;
	const reply = await tunnelRequest(b.api, { kind: "status" }, 10_000);
	if (store.__nifeWebui !== b) return;
	if (!reply.ok) {
		// nobody answered: the tunnel extension is gone, so stop offering URLs that cannot work
		b.publicUrls.clear();
		b.tunnelPending = false;
		pushTunnel(b);
		return;
	}

	adoptEntries(b, reply.entries);
	const mine = b.publicUrls.get(b.port) ?? "";
	if (mine) {
		b.tunnelRevives = 0;
		if (tunnelUrlForPort(reply, b.port) !== mine) {
			// the edge handed out a new URL (a rebuilt client can do that): adopt it and show it
			b.publicUrls.set(b.port, tunnelUrlForPort(reply, b.port));
			pushTunnel(b);
		}
		return scheduleTunnel(b, TUNNEL_HEARTBEAT_MS);
	}
	// alive but no URL yet: the approval mail has not been clicked
	if (tunnelAlive(reply, b.port)) return scheduleTunnel(b, TUNNEL_POLL_MS);

	// nothing is carrying the ports any more: drop the dead links before trying to rebuild them
	const missing = [...b.publicUrls.keys()];
	b.publicUrls.clear();
	pushTunnel(b);
	b.tunnelRevives += 1;
	if (b.tunnelRevives > TUNNEL_REVIVE_TRIES) {
		b.tunnelPending = false;
		pushTunnel(b);
		b.ctx.ui.notify(`webui: tunnel for 127.0.0.1:${b.port} is gone (nifetun stopped answering)`, "warning");
		return;
	}
	b.ctx.ui.notify(
		`webui: tunnel dropped, republishing ${missing.map((port) => `127.0.0.1:${port}`).join(", ")} (${b.tunnelRevives}/${TUNNEL_REVIVE_TRIES})`,
		"warning",
	);
	await attachTunnel(b, missing);
	scheduleTunnel(b, TUNNEL_POLL_MS);
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
		publicUrls: new Map(),
		tunnelPending: false,
		tunnelRevives: 0,
		tunnelBusy: false,
		tunnelTimer: undefined,
		// `b` is only read when a request arrives, after the literal is assigned
		handle: (req, res) => handle(b, req, res),
	};

	server.on("request", (req, res) => {
		// Read through the bridge: a reloaded module replaces `handle`, so routing fixes apply without
		// restarting the port (the listener itself belongs to whichever module created the server).
		void b.handle(req, res).catch((error: unknown) => {
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
	clearTunnelTimer(b);
	unpatchDialogs(b);
	for (const resolve of b.pending.values()) resolve(undefined);
	b.pending.clear();
	for (const client of b.clients) client.end();
	b.clients.clear();
	b.server.close();
	b.server.closeAllConnections();
}

export default function webui(api: ExtensionAPI) {
	// One synchronous hook for the whole process: /reload rebuilds the module, not the exit path.
	const INSTALLED = Symbol.for("nife-webui.services-exit");
	const flags = globalThis as unknown as Record<symbol, boolean>;
	if (!flags[INSTALLED]) {
		flags[INSTALLED] = true;
		process.on("exit", killServices);
	}
	api.on("session_shutdown", (event) => {
		if (event.reason === "quit") killServices();
	});

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
			b.handle = (req, res) => handle(b, req, res);
			patchDialogs(ctx, b);
			ctx.ui.notify(`webui: ${webuiUrl(b)}`, "info");
			for (const [port, url] of b.publicUrls) {
				ctx.ui.notify(
					`webui public: ${port === b.port ? withToken(url, b.token) : `${url} (127.0.0.1:${port})`}`,
					"info",
				);
			}
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
		// /reload keeps the bridge (globalThis) but not this module's fields, and it drops the timer
		// that watched the tunnel: fill both back in instead of leaving a dead public URL behind.
		b.handle = (req, res) => handle(b, req, res);
		b.publicUrls ??= new Map();
		b.tunnelPending ??= false;
		b.tunnelRevives ??= 0;
		b.tunnelBusy ??= false;
		if (b.publicUrls.size) scheduleTunnel(b, TUNNEL_HEARTBEAT_MS);
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
		// a command that just finished may have started a server: offer it in the footer, a moment
		// later so the port is bound by the time /proc is read
		const timer = setTimeout(() => {
			const bridge = store.__nifeWebui;
			if (bridge) refreshServices(bridge);
		}, 700);
		timer.unref?.();
		const b = store.__nifeWebui;
		if (!b || !b.children.delete(event.toolCallId)) return;
		broadcast(b, { type: "subagents", running: [...b.children.values()] });
	});
}
