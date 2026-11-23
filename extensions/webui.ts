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
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, rmSync, type Dirent } from "node:fs";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { mkdir, open, readdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, SessionManager, sessionEntryToContextMessages, type SessionInfo } from "nife-coding-agent";
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
	".mjs": "text/javascript; charset=utf-8",
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
/** Four just-under-limit images plus typed text and Chat's inlined files. */
const PROMPT_MAX_BODY = MAX_IMAGES * MAX_IMAGE_BASE64 + 2 * 1024 * 1024;

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
/** Full-text search: enough context to recognise the hit, bounded so a broad query stays cheap. */
const SEARCH_QUERY_MAX = 200;
const SEARCH_RESULT_MAX = 40;
const SEARCH_MATCH_MAX = 6;

/**
 * Nife's chat-mode prompt. Chat workspace sessions declare no tools and use this prompt; the
 * workspace is a property of the session file, not a flag inside one conversation.
 */
const CHAT_SYSTEM_PROMPT = `You are a helpful conversation assistant. You are in chat mode and have no access to any tools: you cannot read or write files, run commands, browse the web, or take any other actions. Answer the user's questions using only your own knowledge and reasoning. Be clear, concise, and direct, and let the user know when a question would be better answered if tools were available.`;
/**
 * Web UI sessions are global on purpose: the page is a project switcher, so its list is not scoped
 * to the directory nife happened to start in. A session header carries the project cwd, which lets
 * `switchSession` rebuild the runtime (and its tools) for that directory.
 */
const WEBUI_DATA_DIR = join(dirname(getAgentDir()), "webui");
const WORK_SESSION_DIR = join(WEBUI_DATA_DIR, "work");
const CHAT_SESSION_DIR = join(WEBUI_DATA_DIR, "chat");
/** Old Chat sessions lived under each project's nife session directory. Keep reading them. */
const LEGACY_CHAT_DIR = "webui-chat";
/** New sessions start here unless the page picks another project directory. */
const PROJECTS_ROOT = join(dirname(getAgentDir()), "project");
/** Upper bound on the folders one directory read returns to the picker. */
const BROWSE_DIR_MAX = 200;
/**
 * Temp locations are sandbox runs (tests, throwaway agents), never projects: their sessions stay
 * out of every list and the files are removed the moment a scan reads them. The OS temp dir and
 * TMPDIR/TEMP/TMP cover Windows (%LOCALAPPDATA%\Temp, C:\Windows\Temp) and the Unix roots; a
 * drive letter or "/" on its own is dropped, so one bad value cannot match every session.
 */
function tempRoots(): string[] {
	const raw: (string | undefined)[] = [tmpdir(), process.env.TMPDIR, process.env.TEMP, process.env.TMP];
	if (process.platform === "win32") {
		if (process.env.SystemRoot) raw.push(join(process.env.SystemRoot, "Temp"));
		if (process.env.LOCALAPPDATA) raw.push(join(process.env.LOCALAPPDATA, "Temp"));
	} else {
		raw.push("/tmp", "/var/tmp", "/private/tmp");
	}
	const roots = new Set<string>();
	for (const value of raw) {
		const clean = String(value ?? "").trim();
		if (!clean) continue;
		// no trailing separator: comparisons add their own, and "/" or "C:\" alone is too broad
		const root = resolve(clean).replace(/[\\/]+$/, "");
		if (!root || /^[A-Za-z]:$/.test(root)) continue;
		roots.add(root);
	}
	return [...roots];
}

const TEMP_ROOTS = tempRoots();
/** Any path segment with one of these names is a temp folder, on every platform: tmp, TMP, Temp. */
const TEMP_SEGMENTS = new Set(["tmp", "temp"]);
/** Session file format written by nife 0.4.x. SessionManager.open migrates older versions. */
const SESSION_VERSION = 3;
type Workspace = "work" | "chat";

/** A project's session files, discovered from headers only. Full transcripts stay lazy. */
interface SessionRef {
	path: string;
	cwd: string;
	modified: Date;
	/** A header-only New Work / New Chat placeholder is not a Recents row. */
	hasMessage: boolean;
}

interface ProjectGroupInfo {
	cwd: string;
	name: string;
	count: number;
	modified: Date;
	current: boolean;
}

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
	/**
	 * Session file the page already knows exists. A new conversation gets its file only when the
	 * first prompt is persisted, so the sidebar needs one `sessions_changed` at that moment.
	 */
	persistedFile: string | undefined;
	/** Session ids whose automatic title was attempted, so a failure does not retry every turn. */
	titleTried: Set<string>;
	/** Last active session per workspace + project while this bridge lives. */
	workspaceFiles: Record<string, string>;
	/** Header-only project index, shared by the sidebar's groups. */
	sessionIndexCache: Partial<Record<Workspace, { at: number; refs: SessionRef[] }>>;
	/** Fully parsed sessions, but only for a project the reader expanded. */
	projectSessionCache: Record<string, { at: number; sessions: SessionInfo[] }>;
	/**
	 * Session directory this process started in. It keeps per-project sessions from the old layout
	 * visible after the page moves the runtime into the global web-ui directories.
	 */
	legacyWorkDir: string | undefined;
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

function hasMessages(ctx: ExtensionContext): boolean {
	return ctx.sessionManager.getEntries().some((entry) => entry.type === "message");
}

/** Windows compares paths case-insensitively (`C:\Users\X` is `c:\users\x`); POSIX does not. */
const pathKey = (value: string): string => {
	const clean = resolve(value);
	return process.platform === "win32" ? clean.toLowerCase() : clean;
};
const samePath = (left: string, right: string): boolean => pathKey(left) === pathKey(right);
const workspaceKey = (workspace: Workspace, cwd: string): string => `${workspace}\n${pathKey(cwd)}`;

/** The project session directory behind a session dir, also when an old Chat dir is passed in. */
function legacyWorkDirOf(sessionDir: string): string {
	return basename(sessionDir).toLowerCase() === LEGACY_CHAT_DIR ? dirname(sessionDir) : sessionDir;
}

function currentWorkspace(b: Bridge): Workspace {
	const file = b.ctx.sessionManager.getSessionFile();
	if (!file) return "work";
	const path = resolve(file);
	const chat = resolve(CHAT_SESSION_DIR);
	if (path === chat || path.startsWith(chat + sep)) return "chat";
	// Old Chat sessions sit under <project session dir>/webui-chat.
	return basename(dirname(path)).toLowerCase() === LEGACY_CHAT_DIR ? "chat" : "work";
}

function workspaceDir(b: Bridge, workspace: Workspace): string {
	return workspace === "chat" ? CHAT_SESSION_DIR : WORK_SESSION_DIR;
}

/** Remember the live session before a switch, so an empty New Work is not lost. */
function rememberCurrent(b: Bridge): void {
	const file = b.ctx.sessionManager.getSessionFile();
	if (file) b.workspaceFiles[workspaceKey(currentWorkspace(b), b.ctx.cwd)] = file;
}

/** A header-only session file: enough for switchSession, invisible in Recents until it has a message. */
async function writeSessionHeader(path: string, cwd: string): Promise<void> {
	// nife names files `<timestamp>_<session-id>.jsonl`; keep the header id in step with it.
	const name = basename(path);
	const at = name.lastIndexOf("_");
	const id = (at >= 0 ? name.slice(at + 1, -".jsonl".length) : "") || randomUUID();
	const header = { type: "session", version: SESSION_VERSION, id, timestamp: new Date().toISOString(), cwd };
	await mkdir(dirname(path), { recursive: true });
	try {
		await writeFile(path, `${JSON.stringify(header)}\n`, { encoding: "utf8", flag: "wx" });
	} catch (error) {
		// Another process created it between existsSync and here; keep its contents.
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
}

async function createSessionFile(dir: string, cwd: string): Promise<string> {
	const timestamp = new Date().toISOString();
	const path = join(dir, `${timestamp.replace(/[:.]/g, "-")}_${randomUUID()}.jsonl`);
	await writeSessionHeader(path, cwd);
	return path;
}

/** The session the selector should land on for this project: last active, recent, or a fresh one. */
async function workspaceSessionPath(b: Bridge, workspace: Workspace, cwd: string): Promise<string> {
	const remembered = b.workspaceFiles[workspaceKey(workspace, cwd)];
	if (remembered) {
		if (existsSync(remembered)) return remembered;
		// nife only writes a new session on its first message. We already left that manager behind, so
		// writing the header now lets the selector return to the same empty New Work / New Chat.
		await writeSessionHeader(remembered, cwd);
		return remembered;
	}
	const sessions = await projectSessionsForCwd(b, workspace, cwd);
	const recent = sessions.find((session) => session.messageCount > 0);
	return recent?.path ?? createSessionFile(workspaceDir(b, workspace), cwd);
}

/** Move the runtime to the other workspace's session, keeping the current project directory. */
async function switchWorkspace(b: Bridge, target: Workspace): Promise<SwitchOutcome> {
	if (target === currentWorkspace(b)) return { ok: true };
	if (!b.ctx.isIdle()) return { ok: false, message: "stop the current turn first" };
	const file = b.ctx.sessionManager.getSessionFile();
	// `--no-session` has no directory to switch between; do not quietly create files on disk.
	if (!file) return { ok: false, message: "workspaces need a saved session" };
	const cwd = b.ctx.cwd;
	rememberCurrent(b);
	const path = await workspaceSessionPath(b, target, cwd);
	const outcome = await requestSwitch(b, `resume ${path}`);
	if (outcome.ok) {
		b.workspaceFiles[workspaceKey(target, cwd)] = path;
		broadcast(b, { type: "session_switch" });
	}
	return outcome;
}

/** Create a header for a project and move the runtime there. */
async function createAndSwitch(
	b: Bridge,
	workspace: Workspace,
	cwd: string,
): Promise<SwitchOutcome & { path?: string }> {
	if (!b.ctx.isIdle()) return { ok: false, message: "stop the current turn first" };
	rememberCurrent(b);
	const path = await createSessionFile(workspaceDir(b, workspace), cwd);
	const outcome = await requestSwitch(b, `resume ${path}`);
	if (!outcome.ok) {
		await rm(path, { force: true }).catch(() => {});
		return outcome;
	}
	b.workspaceFiles[workspaceKey(workspace, cwd)] = path;
	broadcast(b, { type: "session_switch" });
	return { ...outcome, path };
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

/**
 * The session entry a message was just written to. nife fires `message_end` before it persists the
 * message, so nothing carries the id at the time the event reaches an extension - but the page needs
 * it to offer "edit and rerun" on a prompt the reader just sent (before this, the pencil only showed
 * up after a reload, because only a snapshot carried ids).
 */
function entryIdOfMessage(b: Bridge, message: unknown): string | undefined {
	// a prompt was appended at the leaf a moment ago: the id is within the last few entries
	const tail = b.ctx.sessionManager.getBranch().slice(-8);
	let newest: { id: string; message: unknown } | undefined;
	for (let index = tail.length - 1; index >= 0; index -= 1) {
		const entry = tail[index];
		if (entry.type !== "message") continue;
		if (entry.message === message) return entry.id;
		newest ??= { id: entry.id, message: entry.message };
	}
	// the manager may hold a copy rather than the event's object: compare with the newest message,
	// which is the one just written (a prompt can be large, so this runs at most once)
	if (newest && sameMessageContent(newest.message, message)) return newest.id;
	return undefined;
}

function sameMessageContent(left: unknown, right: unknown): boolean {
	const a = left as { role?: string; content?: unknown } | undefined;
	const b = right as { role?: string; content?: unknown } | undefined;
	if (!a || !b || a.role !== b.role) return false;
	try {
		return JSON.stringify(a.content) === JSON.stringify(b.content);
	} catch {
		return false;
	}
}

/**
 * Tell every open tab which entry a prompt just landed in. Persistence happens a microtask after the
 * extension handler returns, so the lookup is retried briefly rather than guessed.
 */
function announceMessageEntry(b: Bridge, message: unknown): void {
	const role = (message as { role?: string } | undefined)?.role;
	// only prompts can be edited, so nothing else is worth an id on the wire
	if (role !== "user") return;
	announceSessionFile(b);
	const attempt = (left: number) => {
		if (store.__nifeWebui !== b) return;
		const entryId = entryIdOfMessage(b, message);
		if (entryId) {
			broadcast(b, { type: "entry_id", entryId });
			return;
		}
		if (left > 0) setTimeout(() => attempt(left - 1), 60);
	};
	setTimeout(() => attempt(4), 0);
}

/** A new session file is created with its first prompt, a microtask after `message_end`. Tell the
 * page to reload the sidebar once it is actually on disk; every later prompt reuses the same file. */
function announceSessionFile(b: Bridge, left = 5): void {
	if (store.__nifeWebui !== b) return;
	const file = b.ctx.sessionManager.getSessionFile();
	if (file && file !== b.persistedFile && existsSync(file)) {
		b.persistedFile = file;
		invalidateSessions(b);
		broadcast(b, { type: "sessions_changed" });
		return;
	}
	// Persistence happens after the extension handler returns; retry briefly instead of guessing.
	if (left > 0) setTimeout(() => announceSessionFile(b, left - 1), 80);
}

/** Keep a model-written title on one line and strip the wrappers models like to add. */
function cleanTitle(value: string): string {
	const first = value.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
	let title = first.replace(/\s+/g, " ").trim();
	title = title.replace(/^(?:title|session title|标题|会话标题)\s*[:：]\s*/i, "");
	title = title.replace(/^["'“”‘’`#*\s-]+|["'“”‘’`#*\s]+$/g, "");
	title = title.replace(/[。.!！?？,，;；:：]+$/g, "");
	return title.slice(0, 60).trim();
}

/**
 * Name a conversation with the model once, after its first turn settles. The session file's
 * `session_info` entry is the same one a manual rename writes, so the sidebar, search and terminal
 * all see the title. A failed call leaves the first-prompt fallback in place.
 */
async function autoTitle(b: Bridge): Promise<void> {
	if (!b.ctx.isIdle()) return;
	const manager = b.ctx.sessionManager;
	const id = manager.getSessionId();
	if (b.titleTried.has(id) || manager.getSessionName()) return;
	const model = b.ctx.model;
	if (!model) return;
	const messages = contextMessages(b);
	const user = messages.find((message) => message.role === "user");
	if (!user) return;
	const reply = messages.find((message) => message.role === "assistant" && searchableText(message).trim());
	const prompt = searchableText(user).replace(/\s+/g, " ").trim().slice(0, 2000);
	if (!prompt) return;
	const answer = reply ? searchableText(reply).replace(/\s+/g, " ").trim().slice(0, 2000) : "";
	b.titleTried.add(id);
	const source = [`用户: ${prompt}`, answer ? `助手: ${answer}` : ""].filter(Boolean).join("\n\n");
	try {
		const result = await b.ctx.modelRegistry
			.streamSimple(
				model,
				{
					systemPrompt:
						"You name chat conversations. Reply with a short title only, in the same language as the conversation, " +
						"at most 8 words or 20 Chinese characters. No quotes, no trailing punctuation, no explanation.",
					messages: [
						{
							role: "user",
							content: [{ type: "text", text: `Summarize this conversation as a title:\n\n${source}` }],
							timestamp: Date.now(),
						},
					],
				},
				{ maxTokens: 128, temperature: 0.2, cacheRetention: "none", timeoutMs: 20_000 },
			)
			.result();
		// The live context may have moved on while the title request ran: never name a different session.
		if (b.ctx.sessionManager.getSessionId() !== id || b.ctx.sessionManager.getSessionName()) return;
		const title = cleanTitle(searchableText(result));
		if (!title) return;
		b.api.setSessionName(title);
		invalidateSessions(b);
		broadcast(b, { type: "sessions_changed" });
	} catch {
		// Cosmetic: the first-message fallback is still a usable name.
	}
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
 * A "Worked" row is closed by default, so its content does not belong in the first page: a thought
 * stays a marker, a tool call keeps its name and a truncated copy of its arguments (enough for the
 * label under the row), a tool result keeps only its error flag. Expanding the row asks for the real
 * messages. On a session full of tool output this is the difference between a page of small markers
 * and a page of megabytes nobody asked to see yet.
 */
const STEP_ARG_MAX = 160;
const STEP_ARG_DEPTH = 2;
const STEP_RANGE_MAX = 400;

/** Deep copy of a tool's arguments with every string cut to a label's length. */
function slimValue(value: unknown, depth: number): unknown {
	if (typeof value === "string") return value.length > STEP_ARG_MAX ? `${value.slice(0, STEP_ARG_MAX)}…` : value;
	if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
	if (depth >= STEP_ARG_DEPTH) return Array.isArray(value) ? value.slice(0, 1) : {};
	if (Array.isArray(value)) return value.map((entry) => slimValue(entry, depth + 1));
	if (typeof value !== "object") return undefined;
	const out: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) out[key] = slimValue(entry, depth + 1);
	return out;
}

function slimMessage(message: TranscriptMessage): TranscriptMessage {
	if (message.role === "toolResult") {
		const empty = !message.content || (Array.isArray(message.content) && message.content.length === 0);
		if (empty) return message;
		return { role: message.role, toolCallId: message.toolCallId, isError: message.isError, trimmed: true };
	}
	if (!Array.isArray(message.content)) return message;
	let changed = false;
	const content = (message.content as Record<string, unknown>[]).map((block) => {
		if (block?.type === "thinking") {
			changed = true;
			return { type: "thinking" };
		}
		if (block?.type !== "toolCall") return block;
		changed = true;
		return { type: "toolCall", id: block.id, name: block.name, arguments: slimValue(block.arguments ?? {}, 0) };
	});
	return changed ? { ...message, content, trimmed: true } : message;
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
	/**
	 * Session entry this row came from. The tree navigator works in entry ids and nothing else, so a
	 * prompt row carries its own id (and its parent's) for the page's "edit and rerun" action.
	 */
	entryId?: string;
	parentId?: string | null;
	/** set when the payload dropped the reasoning / output the collapsed row keeps hidden */
	trimmed?: boolean;
	toolCallId?: string;
	isError?: boolean;
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
			// copied, not mutated: these objects belong to the session, not to one response
			if (!isHiddenMessage(row)) out.push({ ...row, entryId: entry.id, parentId: entry.parentId ?? null });
		}
	}
	return out;
}

/** The footer numbers: counts and token totals over the whole branch. */
function statsOf(messages: TranscriptMessage[]) {
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
	return stats;
}

/**
 * Refresh just the footer while a turn runs. A tool loop can take minutes and several steps, and the
 * whole snapshot is neither needed nor wanted then - but the counts must not freeze until it settles.
 */
function broadcastStats(b: Bridge): void {
	broadcast(b, {
		type: "stats",
		stats: statsOf(contextMessages(b)),
		usage: b.ctx.getContextUsage() ?? null,
	});
}

function snapshot(b: Bridge, metaOnly = false): unknown {
	const ctx = b.ctx;
	const messages = contextMessages(b);
	const page = pageOf(messages, messages.length);
	const model = ctx.model;
	const stats = statsOf(messages);
	return {
		sessionId: ctx.sessionManager.getSessionId(),
		sessionFile: ctx.sessionManager.getSessionFile(),
		name: b.api.getSessionName(),
		cwd: ctx.cwd,
		model: model ? { id: model.id, name: model.name, provider: model.provider } : null,
		thinkingLevel: ctx.thinkingLevel,
		thinkingLevels: supportedLevels(ctx.model),
		mode: currentWorkspace(b),
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
		// the transcript reads `messages` and asks for older pages with `loadedFrom` as the cursor;
		// the reasoning inside a collapsed row arrives when that row is opened
		messages: metaOnly ? [] : page.messages.map(slimMessage),
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

const SESSION_CACHE_MS = 2500;
const INDEX_CACHE_MS = 4000;

function invalidateSessions(b: Bridge): void {
	b.sessionIndexCache = {};
	b.projectSessionCache = {};
}

/** Bounded concurrency: a large session tree should not open hundreds of descriptors at once. */
async function mapLimit<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
	const out: R[] = [];
	for (let index = 0; index < items.length; index += limit) {
		out.push(...(await Promise.all(items.slice(index, index + limit).map(run))));
	}
	return out;
}

/** Read only the session header: project discovery must not parse every old transcript. */
async function readSessionRef(path: string): Promise<SessionRef | null> {
	try {
		const handle = await open(path, "r");
		try {
			const info = await handle.stat();
			if (!info.isFile()) return null;
			const buffer = Buffer.alloc(64 * 1024);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
			const chunk = buffer.subarray(0, bytesRead);
			const newline = chunk.indexOf(0x0a);
			const first = chunk.toString("utf8", 0, newline < 0 ? bytesRead : newline);
			const header = JSON.parse(first) as { type?: string; cwd?: unknown };
			if (header.type !== "session") return null;
			let hasMessage = false;
			for (const line of chunk.toString("utf8").split("\n")) {
				if (!line.trim()) continue;
				try {
					if ((JSON.parse(line) as { type?: string }).type === "message") {
						hasMessage = true;
						break;
					}
				} catch {
					// malformed line: the full parser will decide later
				}
			}
			// A first message beyond the 64KB probe (huge system prompt) is still a real session.
			if (!hasMessage && info.size > bytesRead) hasMessage = true;
			return {
				path,
				cwd: typeof header.cwd === "string" ? header.cwd : "",
				modified: info.mtime,
				hasMessage,
			};
		} finally {
			await handle.close();
		}
	} catch {
		return null;
	}
}

async function sessionRefsIn(dir: string): Promise<SessionRef[]> {
	let entries: Dirent[];
	try {
		entries = (await readdir(dir, { withFileTypes: true })) as Dirent[];
	} catch {
		return [];
	}
	const files = entries
		.filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".jsonl"))
		.map((entry) => join(dir, entry.name));
	const refs = await mapLimit(files, 24, readSessionRef);
	return refs.filter((ref): ref is SessionRef => ref !== null);
}

/** Every project nife knows about, plus global web-ui stores, without reading transcript bodies. */
async function nifeSessionDirs(): Promise<string[]> {
	try {
		const root = join(getAgentDir(), "sessions");
		const entries = await readdir(root, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
			.map((entry) => join(root, entry.name));
	} catch {
		return [];
	}
}

async function workspaceRefs(b: Bridge, workspace: Workspace): Promise<SessionRef[]> {
	const cached = b.sessionIndexCache[workspace];
	if (cached && Date.now() - cached.at < INDEX_CACHE_MS) return cached.refs;
	const dirs = new Set<string>();
	const add = (dir: string) => dirs.add(resolve(dir));
	const currentDir = b.ctx.sessionManager.getSessionDir();
	if (workspace === "work") {
		add(WORK_SESSION_DIR);
		if (b.legacyWorkDir) add(b.legacyWorkDir);
		if (currentWorkspace(b) === "work" && currentDir) add(currentDir);
		for (const dir of await nifeSessionDirs()) add(dir);
	} else {
		add(CHAT_SESSION_DIR);
		if (b.legacyWorkDir) add(join(b.legacyWorkDir, LEGACY_CHAT_DIR));
		if (currentDir) {
			if (basename(currentDir).toLowerCase() === LEGACY_CHAT_DIR) add(currentDir);
			else add(join(currentDir, LEGACY_CHAT_DIR));
		}
		for (const dir of await nifeSessionDirs()) add(join(dir, LEGACY_CHAT_DIR));
	}
	const groups = await mapLimit([...dirs], 8, sessionRefsIn);
	const live = b.ctx.sessionManager.getSessionFile();
	const livePath = live ? resolve(live) : "";
	const byPath = new Map<string, SessionRef>();
	let dropped = false;
	for (const ref of groups.flat()) {
		// A session whose project or file lives under a temp path is a throwaway run: forget the row
		// and delete the file, so neither this scan nor the next one has to look at it again. The
		// session this process is running is never deleted, even when it happens to live there.
		if (isTempPath(ref.cwd) || isTempPath(ref.path)) {
			if (resolve(ref.path) !== livePath) {
				await rm(ref.path, { force: true }).catch(() => {});
				dropped = true;
			}
			for (const [key, path] of Object.entries(b.workspaceFiles)) {
				if (path === ref.path) delete b.workspaceFiles[key];
			}
			continue;
		}
		byPath.set(ref.path, ref);
	}
	// The per-project cache may still hold the sessions that were just removed with their files.
	if (dropped) b.projectSessionCache = {};
	const refs = [...byPath.values()].sort((left, right) => right.modified.getTime() - left.modified.getTime());
	b.sessionIndexCache[workspace] = { at: Date.now(), refs };
	return refs;
}

/** A path under a temp root or with a tmp/temp segment: a sandbox run, not a workspace. */
function isTempPath(value: string): boolean {
	const clean = String(value || "").trim();
	if (!clean) return false;
	const probe = resolve(clean).toLowerCase();
	if (
		TEMP_ROOTS.some((root) => {
			const base = root.toLowerCase();
			return probe === base || probe.startsWith(`${base}/`) || probe.startsWith(`${base}\\`);
		})
	) {
		return true;
	}
	// Case-insensitive on purpose: Windows writes "Temp\", TMPDIR setups write "tmp/".
	return probe.split(/[\\/]+/).some((segment) => TEMP_SEGMENTS.has(segment));
}

function projectGroups(b: Bridge, refs: SessionRef[]): ProjectGroupInfo[] {
	const groups = new Map<string, ProjectGroupInfo>();
	for (const ref of refs) {
		if (!ref.hasMessage) continue;
		// group by the comparable path, but keep the spelling the session recorded: the page passes
		// that `cwd` back when it asks for one project's rows
		const key = ref.cwd ? pathKey(ref.cwd) : "";
		let group = groups.get(key);
		if (!group) {
			group = { cwd: ref.cwd || "", name: ref.cwd ? basename(ref.cwd) || ref.cwd : "Unknown project", count: 0, modified: ref.modified, current: Boolean(ref.cwd) && samePath(ref.cwd, b.ctx.cwd) };
			groups.set(key, group);
		}
		group.count += 1;
		if (ref.modified.getTime() > group.modified.getTime()) group.modified = ref.modified;
	}
	const list = [...groups.values()];
	const current = list.findIndex((group) => group.current);
	if (current > 0) list.unshift(list.splice(current, 1)[0]);
	return list.sort((left, right) => (right.current ? 1 : 0) - (left.current ? 1 : 0) || right.modified.getTime() - left.modified.getTime());
}

/** Parse one full session, but only after its project group was expanded. */
async function sessionInfoFromPath(path: string): Promise<SessionInfo | null> {
	try {
		const info = await stat(path);
		const manager = SessionManager.open(path);
		const header = manager.getHeader();
		if (!header) return null;
		let messageCount = 0;
		let firstMessage = "";
		const texts: string[] = [];
		for (const entry of manager.getEntries()) {
			if (entry.type !== "message") continue;
			messageCount += 1;
			for (const message of sessionEntryToContextMessages(entry)) {
				const role = (message as { role?: string }).role;
				if (role !== "user" && role !== "assistant") continue;
				const text = searchableText(message);
				if (!text) continue;
				texts.push(text);
				if (!firstMessage && role === "user") firstMessage = text;
			}
		}
		const created = new Date(header.timestamp);
		return {
			path,
			id: manager.getSessionId(),
			cwd: manager.getCwd(),
			name: manager.getSessionName(),
			parentSessionPath: header.parentSession,
			created: Number.isNaN(created.getTime()) ? info.mtime : created,
			modified: info.mtime,
			messageCount,
			firstMessage: firstMessage || "(no messages)",
			allMessagesText: texts.join(" "),
		};
	} catch {
		return null;
	}
}

async function projectSessionsForCwd(b: Bridge, workspace: Workspace, cwd: string): Promise<SessionInfo[]> {
	const key = `${workspace}\n${cwd}`;
	const cached = b.projectSessionCache[key];
	if (cached && Date.now() - cached.at < SESSION_CACHE_MS) return cached.sessions;
	const refs = (await workspaceRefs(b, workspace)).filter(
		(ref) => ref.hasMessage && (cwd ? samePath(ref.cwd, cwd) : ref.cwd === ""),
	);
	const infos = await mapLimit(refs, 8, (ref) => sessionInfoFromPath(ref.path));
	const sessions = infos
		.filter((session): session is SessionInfo => session !== null && session.messageCount > 0)
		.sort((left, right) => right.modified.getTime() - left.modified.getTime());
	b.projectSessionCache[key] = { at: Date.now(), sessions };
	return sessions;
}

/** Every known session path; delete/rename validation should not parse transcripts. */
async function allSessionPaths(b: Bridge): Promise<Set<string>> {
	const [work, chat] = await Promise.all([workspaceRefs(b, "work"), workspaceRefs(b, "chat")]);
	return new Set([...work, ...chat].map((ref) => ref.path));
}

/** `~` is the user's home; relative names are resolved from the current project, not this process. */
function projectPath(b: Bridge, value: string): string {
	const input = value.trim();
	if (!input) return PROJECTS_ROOT;
	if (input === "~") return homedir();
	if (input.startsWith("~/") || input.startsWith("~\\")) return resolve(homedir(), input.slice(2));
	return resolve(b.ctx.cwd || PROJECTS_ROOT, input);
}

/** The new-session picker: the default root, its child projects, and projects with history. */
async function listProjects(b: Bridge) {
	const found = new Map<string, { path: string; name: string; kind: "default" | "project" | "current" | "recent" }>();
	const add = (path: string, kind: "default" | "project" | "current" | "recent") => {
		if (!path) return;
		const clean = resolve(path);
		const existing = found.get(clean);
		if (existing) {
			if (kind === "current") existing.kind = "current";
			return;
		}
		found.set(clean, { path: clean, name: basename(clean) || clean, kind });
	};
	add(PROJECTS_ROOT, "default");
	try {
		const children = (await readdir(PROJECTS_ROOT, { withFileTypes: true }))
			.filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && !entry.name.startsWith("."))
			.map((entry) => join(PROJECTS_ROOT, entry.name))
			.sort((left, right) => left.localeCompare(right));
		for (const child of children) add(child, "project");
	} catch {
		// the default root appears on first use
	}
	if (b.ctx.cwd && !isTempPath(b.ctx.cwd)) add(b.ctx.cwd, "current");
	try {
		const [work, chat] = await Promise.all([workspaceRefs(b, "work"), workspaceRefs(b, "chat")]);
		const recent = [...work, ...chat].sort((left, right) => right.modified.getTime() - left.modified.getTime());
		for (const ref of recent) if (ref.cwd && ref.hasMessage) add(ref.cwd, "recent");
	} catch {
		// the picker still works with the default path and the current project
	}
	return { default: PROJECTS_ROOT, projects: [...found.values()] };
}

/** Sidebar metadata: every project, but no transcript bodies. */
async function listGroups(b: Bridge): Promise<unknown> {
	const refs = await workspaceRefs(b, currentWorkspace(b));
	const groups = projectGroups(b, refs);
	// Only projects with a saved conversation are listed. The current project is not injected as an
	// empty group: a New Work / New Chat still has no row, and deleting a workspace has to remove it
	// from the sidebar right away instead of leaving its name behind with "No sessions". The group
	// comes back with the first message, because that message is what puts a row in it.
	return {
		current: b.ctx.cwd,
		currentFile: b.ctx.sessionManager.getSessionFile(),
		mode: currentWorkspace(b),
		groups,
	};
}

async function listSessions(b: Bridge, cwd: string): Promise<unknown> {
	// Header-only sessions are the empty target of a workspace switch; they join Recents with their
	// first message, not before.
	const sessions = await projectSessionsForCwd(b, currentWorkspace(b), cwd);
	return {
		current: b.ctx.sessionManager.getSessionFile(),
		cwd,
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

/** The text a conversation search can match: prose, not thinking blocks, tool arguments or images. */
function searchableText(message: unknown): string {
	const content = (message as { content?: unknown } | undefined)?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content as Record<string, unknown>[]) {
		if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n");
}

/** One snippet per matching message, with a little context around the first hit. */
function searchMatches(rows: { entryId: string; message: unknown }[], query: string) {
	const matches: { entryId: string; role: string; text: string }[] = [];
	for (const row of rows) {
		const role = (row.message as { role?: string } | undefined)?.role;
		if (role !== "user" && role !== "assistant") continue;
		const text = searchableText(row.message);
		if (!text) continue;
		const at = text.toLowerCase().indexOf(query);
		if (at < 0) continue;
		const start = Math.max(0, at - 60);
		const end = Math.min(text.length, at + query.length + 120);
		const snippet = `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}`;
		matches.push({ entryId: row.entryId, role, text: snippet });
		if (matches.length >= SEARCH_MATCH_MAX) break;
	}
	return matches;
}

/**
 * Deleting a session mirrors the TUI selector: prefer the `trash` CLI so the file is recoverable,
 * fall back to unlink. Only paths that SessionManager lists for a project are ever passed here.
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
			resolve({ ok: false, message: "the session did not answer in time" });
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
 * Move the leaf back to a prompt of the current branch. `navigateTree` lives on the command
 * context, so this goes through the same internal command the session switches use. No branch
 * summary: the page edits and resends the prompt, which is what the branch is for.
 */
function requestTree(b: Bridge, entryId: string): Promise<SwitchOutcome> {
	return requestSwitch(b, ["tree", entryId].join(" "));
}

/** Wait until the session grew a leaf past `before`: the just-sent prompt is persisted by then. */
async function waitForLeafChange(b: Bridge, before: string | null, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline && b.ctx.sessionManager.getLeafId() === before) {
		await new Promise((done) => setTimeout(done, 25));
	}
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
		return send(
			res,
			200,
			JSON.stringify({ messages: page.messages.map(slimMessage), from: page.from, total: messages.length }),
			"application/json",
		);
	}

	// the real messages behind a collapsed row, from what the model thought to what the tool printed
	if (req.method === "GET" && path === "/api/steps") {
		const from = Number(url.searchParams.get("from"));
		const to = Number(url.searchParams.get("to"));
		if (!Number.isInteger(from) || from < 0) return send(res, 400, "from must be a message index");
		const end = Math.min(Number.isInteger(to) ? to : from, from + STEP_RANGE_MAX - 1);
		const messages = contextMessages(b);
		const start = Math.min(from, messages.length);
		let stop = Math.min(Math.max(end + 1, start), messages.length);
		// a tool result is its own message right after the call that produced it, and the row only
		// knows the call: keep walking while the results still belong to what was asked for
		while (stop < messages.length && messages[stop].role === "toolResult") stop += 1;
		return send(res, 200, JSON.stringify({ messages: messages.slice(start, stop), from: start }), "application/json");
	}

	if (req.method === "GET" && path === "/api/projects") {
		return send(res, 200, JSON.stringify(await listProjects(b)), "application/json");
	}

	/**
	 * Directory browser for the new-session picker: one level of subdirectories per request, so the
	 * picker works without typing a path. Hidden entries are skipped, symlinks only when they point
	 * at a directory, and an unreadable path answers 400 with the text the picker shows.
	 */
	if (req.method === "GET" && path === "/api/dirs") {
		const target = projectPath(b, url.searchParams.get("path") ?? "~");
		try {
			if (!(await stat(target)).isDirectory()) return send(res, 400, `不是文件夹：${target}`);
		} catch {
			return send(res, 400, `无法打开：${target}`);
		}
		const entries = await readdir(target, { withFileTypes: true }).catch(() => [] as Dirent[]);
		const dirs: { name: string; path: string }[] = [];
		for (const entry of entries) {
			// A home directory can be huge; the picker scrolls instead of reading everything.
			if (dirs.length >= BROWSE_DIR_MAX) break;
			if (entry.name.startsWith(".")) continue;
			const child = join(target, entry.name);
			if (entry.isDirectory()) {
				dirs.push({ name: entry.name, path: child });
				continue;
			}
			if (!entry.isSymbolicLink()) continue;
			const linked = await stat(child).catch(() => null);
			if (linked?.isDirectory()) dirs.push({ name: entry.name, path: child });
		}
		dirs.sort((left, right) => left.name.localeCompare(right.name, "zh"));
		const parent = dirname(target);
		return send(
			res,
			200,
			JSON.stringify({ path: target, parent: parent === target ? null : parent, home: homedir(), dirs }),
			"application/json",
		);
	}

	if (req.method === "GET" && path === "/api/groups") {
		return send(res, 200, JSON.stringify(await listGroups(b)), "application/json");
	}

	if (req.method === "GET" && path === "/api/sessions") {
		const cwd = url.searchParams.get("cwd");
		return send(res, 200, JSON.stringify(await listSessions(b, cwd ?? b.ctx.cwd)), "application/json");
	}

	// Full-text search across this project's conversations. `SessionManager.list` already read every
	// file for the sidebar, so its allMessagesText filters the cheap way; only sessions that can hit
	// are opened again for snippets and entry ids.
	if (req.method === "GET" && path === "/api/search") {
		const raw = (url.searchParams.get("q") ?? "").trim();
		if (!raw) return send(res, 200, JSON.stringify({ results: [] }), "application/json");
		if (raw.length > SEARCH_QUERY_MAX) return send(res, 400, "query too long");
		const query = raw.toLowerCase();
		const refs = await workspaceRefs(b, currentWorkspace(b));
		const results: unknown[] = [];
		for (const ref of refs) {
			if (!ref.hasMessage) continue;
			const session = await sessionInfoFromPath(ref.path);
			if (!session || session.messageCount === 0 || !session.allMessagesText.toLowerCase().includes(query)) continue;
			let manager: SessionManager;
			try {
				manager = SessionManager.open(session.path);
			} catch {
				continue;
			}
			const rows: { entryId: string; message: unknown }[] = [];
			for (const entry of manager.getBranch()) {
				for (const message of sessionEntryToContextMessages(entry)) rows.push({ entryId: entry.id, message });
			}
			const matches = searchMatches(rows, query);
			if (matches.length === 0) continue;
			results.push({
				path: session.path,
				id: session.id,
				name: session.name,
				cwd: session.cwd,
				modified: session.modified,
				firstMessage: session.firstMessage.replace(/\s+/g, " ").trim().slice(0, SESSION_TITLE_MAX),
				matches,
			});
			if (results.length >= SEARCH_RESULT_MAX) break;
		}
		return send(res, 200, JSON.stringify({ results }), "application/json");
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

	if (req.method === "POST" && path === "/api/mode") {
		const body = await readJson(req, 1024);
		if (body.mode !== "work" && body.mode !== "chat") return send(res, 400, "mode must be work or chat");
		const outcome = await switchWorkspace(b, body.mode);
		if (!outcome.ok) return send(res, 409, outcome.message ?? "switch failed");
		return send(res, 200, JSON.stringify({ mode: currentWorkspace(b) }), "application/json");
	}

	if (req.method === "POST" && path === "/api/resume") {
		const body = await readJson(req);
		const sessionPath = typeof body.path === "string" ? body.path : "";
		if (!sessionPath) return send(res, 400, "missing path");
		rememberCurrent(b);
		const outcome = await requestSwitch(b, `resume ${sessionPath}`);
		if (!outcome.ok) return send(res, 409, outcome.message ?? "switch failed");
		broadcast(b, { type: "session_switch" });
		return send(res, 200, "ok");
	}

	if (req.method === "POST" && path === "/api/delete") {
		const body = await readJson(req);
		// One row from the menu posts `path`; multi-select posts the whole `paths` list so the batch
		// is validated (and the active session is left) before any file is removed.
		const requested = Array.isArray(body.paths) ? body.paths : [body.path];
		const targets = [...new Set(requested.filter((entry): entry is string => typeof entry === "string" && entry.length > 0))];
		if (targets.length === 0) return send(res, 400, "missing path");
		// Never delete arbitrary paths: every target has to be a session either workspace lists.
		const known = await allSessionPaths(b);
		if (targets.some((target) => !known.has(target))) return send(res, 404, "unknown session");
		const active = b.ctx.sessionManager.getSessionFile();
		if (active && targets.includes(active)) {
			// The active session can go too, but not while it is being written to. Move the runtime to
			// a fresh session in the same project first, then remove the old file.
			if (!b.ctx.isIdle()) return send(res, 409, "stop the current turn first");
			const outcome = await createAndSwitch(b, currentWorkspace(b), b.ctx.cwd);
			if (!outcome.ok) return send(res, 409, outcome.message ?? "switch failed");
		}
		const methods: string[] = [];
		for (const target of targets) {
			const result = await deleteSessionFile(target);
			for (const [key, path] of Object.entries(b.workspaceFiles)) {
				if (path === target) delete b.workspaceFiles[key];
			}
			if (!result.ok) {
				// Earlier targets in a batch are already gone; let every tab refresh instead of
				// leaving rows that no longer exist on disk.
				invalidateSessions(b);
				broadcast(b, { type: "sessions_changed" });
				return send(res, 500, result.error ?? "delete failed");
			}
			methods.push(result.method);
		}
		invalidateSessions(b);
		broadcast(b, { type: "sessions_changed" });
		return send(res, 200, JSON.stringify({ methods }));
	}

	if (req.method === "POST" && path === "/api/rename") {
		const body = await readJson(req);
		const target = typeof body.path === "string" ? body.path : "";
		const name = typeof body.name === "string" ? body.name.replace(/[\r\n]+/g, " ").trim() : "";
		if (!target) return send(res, 400, "missing path");
		if (name.length > 200) return send(res, 400, "name too long");
		// Same rule as delete: only a session either workspace lists can be renamed.
		const known = (await allSessionPaths(b)).has(target);
		if (!known) return send(res, 404, "unknown session");
		if (target === b.ctx.sessionManager.getSessionFile()) {
			// Goes through the live session so its own event updates every attached page.
			b.api.setSessionName(name);
		} else {
			// Not running: append the same session_info entry the live path writes.
			SessionManager.open(target).appendSessionInfo(name);
		}
		invalidateSessions(b);
		broadcast(b, { type: "sessions_changed" });
		return send(res, 200, "ok");
	}

	if (req.method === "POST" && path === "/api/new") {
		const body = await readJson(req, 16 * 1024);
		if (!b.ctx.isIdle()) return send(res, 409, "stop the current turn first");
		const mode: Workspace = body.mode === "chat" ? "chat" : body.mode === "work" ? "work" : currentWorkspace(b);
		const cwd = projectPath(b, typeof body.cwd === "string" ? body.cwd : "");
		try {
			await mkdir(cwd, { recursive: true });
			if (!(await stat(cwd)).isDirectory()) return send(res, 400, "working directory is not a directory");
		} catch (error) {
			return send(res, 400, `could not use ${cwd}: ${error instanceof Error ? error.message : "not a directory"}`);
		}
		const outcome = await createAndSwitch(b, mode, cwd);
		if (!outcome.ok) return send(res, 409, outcome.message ?? "switch failed");
		return send(res, 200, JSON.stringify({ path: outcome.path, cwd, mode }), "application/json");
	}

	/**
	 * Edit and rerun: move the leaf to the parent of a prompt on the current branch, exactly like
	 * `/tree` selecting a user message. The page does the rest - it puts the prompt back in the
	 * composer and posts it again when the reader sends, which appends it as a new branch.
	 */
	if (req.method === "POST" && path === "/api/tree") {
		const body = await readJson(req);
		const entryId = typeof body.entryId === "string" ? body.entryId : "";
		if (!entryId) return send(res, 400, "missing entryId");
		// Only a prompt the transcript shows can be rerun: the entry has to be a user message on the
		// current branch, which is exactly what the page offers the button for.
		const target = contextMessages(b).find((message) => message.entryId === entryId);
		if (!target) return send(res, 404, "unknown entry");
		if (target.role !== "user") return send(res, 400, "only a prompt can be rerun");
		const outcome = await requestTree(b, entryId);
		if (!outcome.ok) return send(res, 409, outcome.message ?? "navigation failed");
		// every open tab is now reading a different branch
		broadcast(b, { type: "session_tree" });
		return send(res, 200, "ok");
	}

	/**
	 * Retry: regenerate the answer to a prompt. The leaf moves to that prompt's parent and the prompt
	 * is sent again exactly as it was recorded - same text, same images, same `[attached]` markers -
	 * so the branch keeps one prompt and gets a fresh answer, which is what "retry" means.
	 */
	if (req.method === "POST" && path === "/api/retry") {
		const body = await readJson(req);
		const entryId = typeof body.entryId === "string" ? body.entryId : "";
		if (!entryId) return send(res, 400, "missing entryId");
		if (!b.ctx.isIdle()) return send(res, 409, "stop the current turn first");
		const target = contextMessages(b).find((message) => message.entryId === entryId);
		if (!target) return send(res, 404, "unknown entry");
		if (target.role !== "user") return send(res, 400, "only a prompt can be retried");
		const outcome = await requestTree(b, entryId);
		if (!outcome.ok) return send(res, 409, outcome.message ?? "navigation failed");
		// Broadcast only once the prompt is in the session: a page that reloads the truncated branch
		// must find it there, or a tab that already received the `message_end` would either lose the
		// row or show it twice depending on which response landed first.
		const parent = b.ctx.sessionManager.getLeafId();
		try {
			// the recorded content, not a rebuilt string: images ride along untouched
			b.api.sendUserMessage(target.content as string | (TextBlock | ImageBlock)[]);
			await waitForLeafChange(b, parent, 2_000);
		} catch (error) {
			return send(res, 409, error instanceof Error ? error.message : "send failed");
		}
		broadcast(b, { type: "session_tree" });
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
	const sessionFile = ctx.sessionManager.getSessionFile();
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
		persistedFile: sessionFile && existsSync(sessionFile) && hasMessages(ctx) ? sessionFile : undefined,
		titleTried: new Set(),
		workspaceFiles: {},
		sessionIndexCache: {},
		projectSessionCache: {},
		legacyWorkDir: legacyWorkDirOf(ctx.sessionManager.getSessionDir()),
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
			// Keep the rest of a resume argument byte-for-byte: a project directory may contain
			// repeated spaces, which splitting and joining would collapse.
			const trimmed = args.trim();
			const at = trimmed.search(/\s/);
			const kind = at < 0 ? trimmed : trimmed.slice(0, at);
			const rest = at < 0 ? "" : trimmed.slice(at + 1);
			try {
				if (kind === "resume") {
					const sessionPath = rest;
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
				if (kind === "tree") {
					const [entryId] = rest.split(/\s+/);
					if (!entryId) throw new Error("missing entry id");
					// nife's own navigateTree puts the prompt into the terminal editor as well, so both screens
					// end up showing the same message ready to be edited
					const result = await ctx.navigateTree(entryId);
					settle(result.cancelled ? { ok: false, message: "navigation cancelled" } : { ok: true });
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
		// A fresh session has a file path before its first prompt, but no file on disk yet. An empty
		// header-only session also waits for its first message before it belongs in Recents.
		const file = ctx.sessionManager.getSessionFile();
		b.persistedFile = file && existsSync(file) && hasMessages(ctx) ? file : undefined;
		patchDialogs(ctx, b);
		// /reload keeps the bridge (globalThis) but not this module's fields, and it drops the timer
		// that watched the tunnel: fill both back in instead of leaving a dead public URL behind.
		b.handle = (req, res) => handle(b, req, res);
		b.publicUrls ??= new Map();
		b.tunnelPending ??= false;
		b.tunnelRevives ??= 0;
		b.tunnelBusy ??= false;
		b.titleTried ??= new Set();
		b.workspaceFiles ??= {};
		b.sessionIndexCache ??= {};
		b.projectSessionCache ??= {};
		invalidateSessions(b);
		b.legacyWorkDir ??= legacyWorkDirOf(ctx.sessionManager.getSessionDir());
		if (b.publicUrls.size) scheduleTunnel(b, TUNNEL_HEARTBEAT_MS);
		const workspace = currentWorkspace(b);
		if (file) b.workspaceFiles[workspaceKey(workspace, ctx.cwd)] = file;
		// Chat workspace sessions never declare tools. Work sessions get nife's defaults from the
		// fresh runtime created by switchSession/newSession.
		if (workspace === "chat") b.api.setActiveTools([]);
		broadcast(b, { type: "session_start", reason: event.reason });
		broadcast(b, { type: "mode_changed", mode: workspace });
	});

	api.on("before_agent_start", () => {
		const b = store.__nifeWebui;
		if (!b || currentWorkspace(b) !== "chat") return;
		// A terminal /chat toggle or reload must not put tools back into the chat workspace.
		if (b.api.getActiveTools().length > 0) b.api.setActiveTools([]);
		return { systemPrompt: CHAT_SYSTEM_PROMPT };
	});

	// Do not stop on session_shutdown: the bridge outlives /new, /resume and /fork.
	api.on("message_start", (event) => {
		// The system prompt is re-appended at every branch point, and hidden extension messages are not
		// conversation content: a snapshot drops them, so the live stream must not deliver them either
		// (a forwarded system message used to show up as a stray "Note (system)" row until a reload).
		if (isHiddenMessage(event.message)) return;
		forward({ type: "message_start", message: event.message });
	});
	api.on("message_update", (event) => {
		// Send only the delta: event.message is cumulative and would grow O(n^2) on the wire.
		forward({ type: "message_update", delta: event.assistantMessageEvent });
	});
	api.on("message_end", (event) => {
		const b = store.__nifeWebui;
		if (!isHiddenMessage(event.message)) forward({ type: "message_end", message: event.message });
		if (b) announceMessageEntry(b, event.message);
	});
	api.on("agent_start", () => {
		forward({ type: "agent_start" });
	});
	api.on("agent_settled", (event) => {
		// `aborted` matters to the page: an interrupted turn is a deliberate stop, and the UI queue
		// must hold the next task instead of starting it.
		forward({ type: "agent_settled", aborted: Boolean(event?.aborted) });
		// Name the conversation once, after the first completed turn. It is a separate model call,
		// never part of the session transcript.
		const b = store.__nifeWebui;
		if (b) void autoTitle(b);
	});
	api.on("turn_end", () => {
		// One step (assistant message + its tool results) is committed: the footer can move now.
		const b = store.__nifeWebui;
		if (b) broadcastStats(b);
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
