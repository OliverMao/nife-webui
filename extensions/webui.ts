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
import { mkdir, open, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, hostname, tmpdir, userInfo } from "node:os";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, SessionManager, sessionEntryToContextMessages, type SessionInfo } from "nife-coding-agent";
import {
	buildSessionProjection,
	calculateContextTokens,
	createAgentSession,
	DefaultResourceLoader,
	estimateTokens,
	ModelRuntime,
	SettingsManager,
	type AgentSession,
	type ContextUsage,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionUIContext,
} from "nife-coding-agent";
import {
	deleteHost,
	findHost,
	hostsFile,
	readHosts,
	remoteLabel,
	sshArgs,
	sshTarget,
	upsertHost,
	VALID_ALIAS,
	type HostEntry,
} from "./ssh/hosts.ts";
import { RemoteHost, type HostProfile } from "./ssh/transport.ts";
import { remotePrompt, remoteToolDefinitions, remoteToolNames, shellQuote } from "./ssh/tools.ts";

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
	/** The ssh device this session ran on, when it is not this machine. */
	device?: string;
	modified: Date;
	/** A header-only New Work / New Chat placeholder is not a Recents row. */
	hasMessage: boolean;
}

interface ProjectGroupInfo {
	cwd: string;
	device?: string;
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
	/**
	 * Background runtimes, one per session the page opened that is not the terminal's session. Each is
	 * an in-process AgentSession with its own loop, so switching the page to another conversation no
	 * longer stops the turn that was running. Keyed by sid; `workersByPath` keeps "one runtime per
	 * session file".
	 */
	workers: Map<string, Worker>;
	workersByPath: Map<string, string>;
	/** Session the page is looking at: "host" (the terminal's) or a worker sid. */
	viewSid: string;
	/** Partial assistant text of the host session, so re-attaching mid-turn renders what is streaming. */
	hostLive: { text: string; thinking: string } | null;
	/** The terminal session's run state, so its sidebar row shows the same dot as a background one. */
	hostRunning?: boolean;
	hostDone?: boolean;
	/** Shared auth/model catalogue for workers; created on the first background run. */
	modelRuntime?: Promise<ModelRuntime>;
	/**
	 * One ssh connection per device, shared by every conversation that runs on it: the helper is
	 * streamed per connection, so opening a second one for a second conversation would pay for the
	 * same handshake twice and leave two shells idling on the device.
	 */
	remotes: Map<string, RemoteHost>;
	/** What each device turned out to be, asked once per process (OpenWrt is not Debian). */
	remoteProfiles: Map<string, HostProfile>;
	/** Last connection attempt per device, so the list can say "connected, 276ms" or "failed". */
	remoteStatus: Map<string, { at: number; ms?: number; error?: string }>;
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
/**
 * A project is a path *and* the machine it is on: `/etc` on two routers is two projects, and merging
 * them would put another device's conversations under this one's label.
 */
const projectKey = (device: string | undefined, cwd: string): string => `${device ?? ""}\n${pathKey(cwd)}`;
const workspaceKey = (workspace: Workspace, cwd: string, device?: string): string =>
	`${workspace}\n${projectKey(device, cwd)}`;

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
async function writeSessionHeader(path: string, cwd: string, device?: string): Promise<void> {
	// nife names files `<timestamp>_<session-id>.jsonl`; keep the header id in step with it.
	const name = basename(path);
	const at = name.lastIndexOf("_");
	const id = (at >= 0 ? name.slice(at + 1, -".jsonl".length) : "") || randomUUID();
	// `webui.device` is the only record of "this conversation runs on that machine": the cwd stays the
	// real remote path, so every tool, every path in the transcript and every project label is honest.
	const header = {
		type: "session",
		version: SESSION_VERSION,
		id,
		timestamp: new Date().toISOString(),
		cwd,
		...(device ? { webui: { device } } : {}),
	};
	await mkdir(dirname(path), { recursive: true });
	try {
		await writeFile(path, `${JSON.stringify(header)}\n`, { encoding: "utf8", flag: "wx" });
	} catch (error) {
		// Another process created it between existsSync and here; keep its contents.
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
}

async function createSessionFile(dir: string, cwd: string, device?: string): Promise<string> {
	const timestamp = new Date().toISOString();
	const path = join(dir, `${timestamp.replace(/[:.]/g, "-")}_${randomUUID()}.jsonl`);
	await writeSessionHeader(path, cwd, device);
	return path;
}

/** The session the selector should land on for this project: last active, recent, or a fresh one. */
async function workspaceSessionPath(b: Bridge, workspace: Workspace, cwd: string, device?: string): Promise<string> {
	const remembered = b.workspaceFiles[workspaceKey(workspace, cwd, device)];
	if (remembered) {
		if (existsSync(remembered)) return remembered;
		// nife only writes a new session on its first message. We already left that manager behind, so
		// writing the header now lets the selector return to the same empty New Work / New Chat.
		await writeSessionHeader(remembered, cwd);
		return remembered;
	}
	const sessions = await projectSessionsForCwd(b, workspace, cwd, device);
	const recent = sessions.find((session) => session.messageCount > 0);
	return recent?.path ?? createSessionFile(workspaceDir(b, workspace), cwd);
}

/** Create a header for a project and move the runtime there. */
async function createAndSwitch(
	b: Bridge,
	workspace: Workspace,
	cwd: string,
	device?: string,
): Promise<SwitchOutcome & { path?: string }> {
	if (!b.ctx.isIdle()) return { ok: false, message: "stop the current turn first" };
	rememberCurrent(b);
	const path = await createSessionFile(workspaceDir(b, workspace), cwd, device);
	const outcome = await requestSwitch(b, `resume ${path}`);
	if (!outcome.ok) {
		await rm(path, { force: true }).catch(() => {});
		return outcome;
	}
	b.workspaceFiles[workspaceKey(workspace, cwd, device)] = path;
	broadcast(b, { type: "session_switch" });
	return { ...outcome, path };
}

/** Host-session events carry their sid, so a page reading a background session ignores them. */
function forward(payload: Record<string, unknown>): void {
	const b = store.__nifeWebui;
	if (!b) return;
	broadcast(b, { sid: "host", path: b.ctx.sessionManager.getSessionFile() ?? undefined, ...payload });
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
			broadcast(b, { type: "entry_id", entryId, sid: "host", path: b.ctx.sessionManager.getSessionFile() ?? undefined });
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

async function suggestTitle(b: Bridge, model: AnyModel, messages: TranscriptMessage[]): Promise<string> {
	const user = messages.find((message) => message.role === "user");
	if (!user) return "";
	const reply = messages.find((message) => message.role === "assistant" && searchableText(message).trim());
	const prompt = searchableText(user).replace(/\s+/g, " ").trim().slice(0, 2000);
	if (!prompt) return "";
	const answer = reply ? searchableText(reply).replace(/\s+/g, " ").trim().slice(0, 2000) : "";
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
		return cleanTitle(searchableText(result));
	} catch {
		// Cosmetic: the first-message fallback is still a usable name.
		return "";
	}
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
	b.titleTried.add(id);
	const title = await suggestTitle(b, model, contextMessages(manager));
	// The live context may have moved on while the title request ran: never name a different session.
	if (!title || manager.getSessionId() !== id || manager.getSessionName()) return;
	b.api.setSessionName(title);
	invalidateSessions(b);
	broadcast(b, { type: "sessions_changed" });
}

/** Same naming rule for a background session, written through the worker's own manager. */
async function autoTitleWorker(b: Bridge, worker: Worker): Promise<void> {
	if (worker.running || worker.titleTried) return;
	const id = worker.manager.getSessionId();
	if (worker.manager.getSessionName()) return;
	const model = worker.session?.model;
	if (!model) return;
	worker.titleTried = true;
	const title = await suggestTitle(b, model, contextMessages(worker.manager));
	if (!title || worker.manager.getSessionId() !== id || worker.manager.getSessionName()) return;
	worker.manager.appendSessionInfo(title);
	invalidateSessions(b);
	broadcast(b, { type: "sessions_changed" });
	broadcastStatus(b, worker);
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

function contextMessages(manager: TargetManager): TranscriptMessage[] {
	const out: TranscriptMessage[] = [];
	for (const entry of manager.getBranch()) {
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
 * Background runtimes. The host session is the terminal's; every other conversation the page opens
 * gets its own in-process AgentSession, so switching the page to another session no longer stops the
 * turn that was running. No child processes and no tmux: the pool lives in this Node process and
 * dies with it, exactly like a terminal session would.
 */
const MAX_WORKERS = 3;
/** An idle background runtime keeps its tools and model warm; after this it is disposed and rebuilt
 * on the next visit (the session file is the source of truth). */
const WORKER_IDLE_MS = 30 * 60 * 1000;
/** This extension must not be loaded a second time inside a worker: one page, one server. */
const WEBUI_MODULE = fileURLToPath(import.meta.url);

interface Worker {
	sid: string;
	cwd: string;
	/** ssh device alias, when this conversation runs on another machine. */
	device?: string;
	workspace: Workspace;
	manager: SessionManager;
	/** Session file. A worker is always created from a real file (a new one gets its header first). */
	path: string;
	session?: AgentSession;
	opening?: Promise<{ ok: true; session: AgentSession } | { ok: false; message: string }>;
	unsub?: () => void;
	running: boolean;
	/** The turn finished while the page was looking at another session: the sidebar shows a dot. */
	done: boolean;
	/** Partial assistant text, so switching back mid-turn renders what is streaming. */
	live: { text: string; thinking: string } | null;
	lastUsed: number;
	titleTried: boolean;
}

/** A request is about the terminal's session or about one background runtime. */
type Target = { kind: "host"; sid: "host" } | { kind: "worker"; sid: string; worker: Worker };

type TargetManager = Pick<SessionManager, "getBranch" | "getSessionFile" | "getSessionId" | "getSessionName" | "getCwd">;

function hostFile(b: Bridge): string | undefined {
	return b.ctx.sessionManager.getSessionFile() ?? undefined;
}

function workerName(w: Worker): string {
	return w.manager.getSessionName() || basename(w.cwd) || w.cwd;
}

function targetOf(b: Bridge, raw: unknown): Target | undefined {
	const sid = typeof raw === "string" && raw ? raw : "host";
	if (sid === "host") return { kind: "host", sid: "host" };
	const worker = b.workers.get(sid);
	if (!worker) return undefined;
	worker.lastUsed = Date.now();
	return { kind: "worker", sid, worker };
}

const targetManager = (b: Bridge, t: Target): TargetManager =>
	t.kind === "host" ? b.ctx.sessionManager : t.worker.manager;
const targetCwd = (b: Bridge, t: Target): string => (t.kind === "host" ? b.ctx.cwd : t.worker.cwd);
const targetRunning = (b: Bridge, t: Target): boolean =>
	t.kind === "host" ? !b.ctx.isIdle() : t.worker.running;
const targetWorkspace = (b: Bridge, t: Target): Workspace =>
	t.kind === "host" ? currentWorkspace(b) : t.worker.workspace;
const targetModel = (b: Bridge, t: Target): AnyModel | undefined =>
	t.kind === "host"
		? b.ctx.model
		: // before the runtime exists the session only records a model after a switch; fall back to
			// the one this process is using, which is what a fresh runtime would restore
			t.worker.session?.model ?? entryModel(b, t.worker.manager) ?? b.ctx.model;
const targetThinking = (b: Bridge, t: Target): string =>
	t.kind === "host"
		? String(b.ctx.thinkingLevel ?? "off")
		: String(
				t.worker.session?.thinkingLevel ?? entryThinking(t.worker.manager) ?? b.ctx.thinkingLevel ?? "off",
			);
const targetUsage = (b: Bridge, t: Target): ContextUsage | null => {
	if (t.kind === "host") return b.ctx.getContextUsage() ?? null;
	if (t.worker.session) return t.worker.session.getContextUsage() ?? null;
	return estimatedUsage(t.worker.manager, targetModel(b, t));
};

/**
 * Context usage for an attached session whose runtime is not up yet (or failed to start): the same
 * numbers nife reports, taken from the session projection - the last assistant's usage plus the
 * estimate of everything after it. Recomputed once the runtime exists.
 */
function estimatedUsage(manager: TargetManager, model: AnyModel | undefined): ContextUsage | null {
	const contextWindow = model?.contextWindow ?? 0;
	if (!model || contextWindow <= 0) return null;
	const messages = buildSessionProjection(manager.getBranch()).messages as {
		role?: string;
		stopReason?: string;
		usage?: unknown;
	}[];
	let tokens = 0;
	let measured = -1;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message.role !== "assistant" || !message.usage) continue;
		// aborted/error responses never carry the request's context size
		if (message.stopReason === "aborted" || message.stopReason === "error") continue;
		const used = calculateContextTokens(message.usage as never);
		if (used <= 0) continue;
		tokens = used;
		measured = index;
		break;
	}
	if (measured < 0) {
		for (const message of messages) tokens += estimateTokens(message as never);
	} else {
		for (let index = measured + 1; index < messages.length; index += 1) {
			tokens += estimateTokens(messages[index] as never);
		}
	}
	return { tokens, contextWindow, percent: (tokens / contextWindow) * 100 };
}

/** The model a session was last switched to, for a worker whose runtime is not built yet. */
function entryModel(b: Bridge, manager: TargetManager): AnyModel | undefined {
	const branch = manager.getBranch();
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index] as { type?: string; provider?: string; modelId?: string };
		if (entry?.type !== "model_change" || !entry.provider || !entry.modelId) continue;
		return b.ctx.modelRegistry.find(entry.provider, entry.modelId) as AnyModel | undefined;
	}
	return undefined;
}

function entryThinking(manager: TargetManager): string | undefined {
	const branch = manager.getBranch();
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index] as { type?: string; thinkingLevel?: string };
		if (entry?.type === "thinking_level_change" && entry.thinkingLevel) return entry.thinkingLevel;
	}
	return undefined;
}

/** The session the page is looking at: what the sidebar marks as current and what a new turn joins. */
function viewedTarget(b: Bridge): Target {
	return targetOf(b, b.viewSid) ?? { kind: "host", sid: "host" };
}

function broadcastStatus(b: Bridge, worker: Worker): void {
	broadcast(b, {
		type: "session_status",
		sid: worker.sid,
		path: worker.path,
		cwd: worker.cwd,
		name: workerName(worker),
		running: worker.running,
		done: worker.done,
	});
}

function hostStatus(b: Bridge): void {
	const path = hostFile(b);
	if (!path) return;
	broadcast(b, {
		type: "session_status",
		sid: "host",
		path,
		cwd: b.ctx.cwd,
		name: b.api.getSessionName(),
		running: b.hostRunning ?? !b.ctx.isIdle(),
		done: b.hostDone === true,
	});
}

function focusSession(b: Bridge, sid: string): void {
	b.viewSid = sid;
	const worker = b.workers.get(sid);
	if (worker) {
		worker.done = false;
		broadcastStatus(b, worker);
		return;
	}
	b.hostDone = false;
	if (sid === "host") hostStatus(b);
}

function disposeWorker(b: Bridge, worker: Worker): void {
	b.workers.delete(worker.sid);
	if (b.workersByPath.get(pathKey(worker.path)) === worker.sid) b.workersByPath.delete(pathKey(worker.path));
	try {
		worker.unsub?.();
	} catch {
		// the session is going away; a failing unsubscribe must not keep it alive
	}
	try {
		worker.session?.dispose();
	} catch {
		// same: dispose is best effort
	}
	if (b.viewSid === worker.sid) focusSession(b, "host");
}

/** Oldest idle worker, or undefined when every slot is busy (or the page is looking at it). */
function evictable(b: Bridge): Worker | undefined {
	const idle = [...b.workers.values()].filter(
		(worker) => !worker.running && !worker.opening && worker.sid !== b.viewSid,
	);
	return idle.sort((left, right) => left.lastUsed - right.lastUsed)[0];
}

/** Drop runtimes nobody is using: their session files are the history, the memory is not. */
function sweepWorkers(b: Bridge): void {
	const now = Date.now();
	for (const worker of [...b.workers.values()]) {
		if (worker.running || worker.opening || worker.sid === b.viewSid) continue;
		if (now - worker.lastUsed < WORKER_IDLE_MS) continue;
		disposeWorker(b, worker);
	}
}

type AttachOutcome = { ok: true; sid: string } | { ok: false; message: string };

/** Point the page at a session, creating a background runtime when it is not the terminal's. */
function attachSession(b: Bridge, rawPath: string): AttachOutcome {
	if (!rawPath) return { ok: false, message: "missing path" };
	const path = resolve(rawPath);
	const host = hostFile(b);
	if (host && samePath(host, path)) {
		focusSession(b, "host");
		return { ok: true, sid: "host" };
	}
	const known = b.workersByPath.get(pathKey(path));
	if (known && b.workers.has(known)) {
		focusSession(b, known);
		return { ok: true, sid: known };
	}
	if (!existsSync(path)) return { ok: false, message: "session file not found" };
	if (b.workers.size >= MAX_WORKERS) {
		const victim = evictable(b);
		if (!victim) return { ok: false, message: `${MAX_WORKERS} 个会话已经在后台运行，先等一个结束再打开别的` };
		disposeWorker(b, victim);
	}
	let manager: SessionManager;
	try {
		manager = SessionManager.open(path);
	} catch (error) {
		return { ok: false, message: error instanceof Error ? error.message : "could not open session" };
	}
	// The header is read raw on purpose: `SessionManager.getCwd()` resolves the path against this
	// process, which turns `ssh://router/etc` into `.../ssh:/router/etc` and loses the device.
	const header = manager.getHeader() as { cwd?: unknown; webui?: { device?: unknown } } | undefined;
	const recorded = typeof header?.cwd === "string" && header.cwd ? header.cwd : manager.getCwd();
	const device = typeof header?.webui?.device === "string" ? header.webui.device : undefined;
	const worker: Worker = {
		sid: randomUUID(),
		cwd: recorded,
		...(device ? { device } : {}),
		workspace: workspaceOfFile(path),
		manager,
		path,
		running: false,
		done: false,
		live: null,
		lastUsed: Date.now(),
		titleTried: false,
	};
	b.workers.set(worker.sid, worker);
	b.workersByPath.set(pathKey(path), worker.sid);
	focusSession(b, worker.sid);
	// Build the runtime in the background: the transcript is readable at once, and the composer gets
	// the session's own model, thinking level and context usage a moment later. Failure is quiet -
	// the page still reads the file, and the fallbacks above keep the header sane.
	void ensureWorkerSession(b, worker).then((opened) => {
		if (opened.ok) broadcast(b, { type: "state_changed", sid: worker.sid });
	});
	return { ok: true, sid: worker.sid };
}

/** Work or Chat, read from where the session file lives (the layout the sidebar already uses). */
function workspaceOfFile(path: string): Workspace {
	const clean = resolve(path);
	const chat = resolve(CHAT_SESSION_DIR);
	if (clean === chat || clean.startsWith(chat + sep)) return "chat";
	return basename(dirname(clean)).toLowerCase() === LEGACY_CHAT_DIR ? "chat" : "work";
}

/** Create a header for a new conversation and attach it as a background runtime. */
async function createAttachedSession(
	b: Bridge,
	workspace: Workspace,
	cwd: string,
	device?: string,
): Promise<AttachOutcome & { path?: string; cwd?: string; workspace?: Workspace }> {
	const path = await createSessionFile(workspaceDir(b, workspace), cwd, device);
	const outcome = attachSession(b, path);
	if (!outcome.ok) return outcome;
	b.workspaceFiles[workspaceKey(workspace, cwd, device)] = path;
	return { ...outcome, path, cwd, workspace };
}

/**
 * The connection for one device, opened on first use and shared by every conversation on it.
 * An alias that is not in the device list is a session from another machine or an edited config:
 * it fails loudly here, once, rather than as a confusing "connection closed" inside a turn.
 */
function remoteConnection(b: Bridge, alias: string): RemoteHost {
	const known = b.remotes.get(alias);
	if (known) return known;
	const entry = findHost(alias);
	if (!entry) throw new Error(`unknown device: ${alias} (not in ${hostsFile()} or ~/.ssh/config)`);
	const host = new RemoteHost(entry.alias, sshArgs(entry));
	b.remotes.set(alias, host);
	return host;
}

/**
 * The prompt block that tells the model where it is. Appended, never replacing: skills, personas and
 * the project's own AGENTS.md still apply - only the tools behind them changed.
 */
function remoteExtensionFor(alias: string, path: string, profile?: HostProfile) {
	return {
		name: "webui-remote",
		factory: (api: ExtensionAPI) => {
			api.on("before_agent_start", (event) => ({
				systemPrompt: `${event.systemPrompt}\n\n${remotePrompt(alias, path, profile)}`,
			}));
		},
	};
}

/** Ask once per process what a device is; a probe failure must not break the session. */
async function deviceProfile(b: Bridge, host: RemoteHost): Promise<HostProfile | undefined> {
	const cached = b.remoteProfiles.get(host.alias);
	if (cached) return cached;
	try {
		const profile = await host.probe();
		b.remoteProfiles.set(host.alias, profile);
		return profile;
	} catch {
		return undefined;
	}
}

function workerModelRuntime(b: Bridge): Promise<ModelRuntime> {
	b.modelRuntime ??= ModelRuntime.create();
	return b.modelRuntime;
}

/**
 * The UI a background extension talks to. Dialogs go to the browser with the session attached, so a
 * confirmation raised by a background run names the conversation it belongs to; the terminal-only
 * surfaces are no-ops because nobody is watching that runtime.
 */
function workerUI(b: Bridge, worker: Worker): ExtensionUIContext {
	const tag = () => ({ sid: worker.sid, path: worker.path, workerName: workerName(worker) });
	const base: Record<string, unknown> = {
		confirm: async (title: string, message: string) => {
			const answer = await ask<boolean>(b, "confirm", { title, message, ...tag() });
			return answer === true;
		},
		select: async (title: string, options: string[]) => {
			const answer = await ask<string>(b, "select", { title, options, ...tag() });
			return answer === "tui" ? undefined : answer;
		},
		input: async (title: string, placeholder?: string) => {
			const answer = await ask<string>(b, "input", { title, placeholder, ...tag() });
			return answer === "tui" ? undefined : answer;
		},
		editor: async (title: string, prefill?: string) => {
			const answer = await ask<string>(b, "editor", { title, prefill, ...tag() });
			return answer === "tui" ? undefined : answer;
		},
		notify: (message: string, level?: string) => {
			broadcast(b, { type: "notice", text: message, level: level ?? "info", ...tag() });
		},
		onTerminalInput: () => () => {},
		getEditorText: () => "",
		getEditorComponent: () => undefined,
		getToolsExpanded: () => false,
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "background sessions have no terminal theme" }),
		custom: async () => undefined,
	};
	return new Proxy(base, {
		get(target, property) {
			if (property in target) return target[property as string];
			return () => {};
		},
	}) as unknown as ExtensionUIContext;
}

/** Chat sessions never declare tools and use nife's chat prompt, same rule as the host session. */
const CHAT_EXTENSION = {
	name: "webui-chat",
	factory: (api: ExtensionAPI) => {
		api.on("before_agent_start", () => ({ systemPrompt: CHAT_SYSTEM_PROMPT }));
	},
};

/** Build the runtime for a worker: settings, extensions, tools and model, all from its own project. */
function openWorkerSession(
	b: Bridge,
	worker: Worker,
): Promise<{ ok: true; session: AgentSession } | { ok: false; message: string }> {
	worker.opening ??= (async () => {
		try {
			const agentDir = getAgentDir();
			// A remote conversation records `ssh://router/etc` as its cwd: that is what makes the
			// transcript self-describing (a re-attach knows it is remote) and what gives the sidebar
			// one project per device path. The device's own path is what the tools work in.
			const remote = worker.device ? { alias: worker.device, path: worker.cwd } : null;
			const remoteHost = remote ? remoteConnection(b, remote.alias) : undefined;
			const profile = remoteHost ? await deviceProfile(b, remoteHost) : undefined;
			const remoteExtension = remote && remoteHost ? remoteExtensionFor(remoteHost.alias, remote.path, profile) : undefined;
			const settingsManager = SettingsManager.create(worker.cwd, agentDir);
			const loader = new DefaultResourceLoader({
				cwd: worker.cwd,
				agentDir,
				settingsManager,
				// one webui server per process: the copy inside a worker would race for the port
				extensionsOverride: (base) => ({
					...base,
					extensions: base.extensions.filter((extension) => resolve(extension.resolvedPath) !== WEBUI_MODULE),
				}),
				extensionFactories:
					worker.workspace === "chat" ? [CHAT_EXTENSION] : remoteExtension ? [remoteExtension] : undefined,
			});
			await loader.reload();
			const modelRuntime = await workerModelRuntime(b);
			const { session } = await createAgentSession({
				cwd: worker.cwd,
				agentDir,
				settingsManager,
				modelRuntime,
				sessionManager: worker.manager,
				resourceLoader: loader,
				noTools: worker.workspace === "chat" ? "all" : undefined,
				// On a device, nife's tools are the device's tools: same definitions, ssh operations.
				// Everything else (grep, find, subagent) would quietly run on this machine instead.
				customTools:
					remote && remoteHost ? remoteToolDefinitions(remoteHost, remote.path, profile?.tools ?? []) : undefined,
				tools: remote ? [...remoteToolNames] : undefined,
			});
			await session.bindExtensions({
				uiContext: workerUI(b, worker),
				mode: "rpc",
				abortHandler: () => void session.abort(),
			});
			worker.session = session;
			worker.unsub = session.subscribe((event) => workerEvent(b, worker, event));
			return { ok: true as const, session };
		} catch (error) {
			return { ok: false as const, message: error instanceof Error ? error.message : "could not start the session" };
		}
	})().finally(() => {
		worker.opening = undefined;
	});
	return worker.opening;
}

async function ensureWorkerSession(
	b: Bridge,
	worker: Worker,
): Promise<{ ok: true; session: AgentSession } | { ok: false; message: string }> {
	if (worker.session) return { ok: true, session: worker.session };
	return await openWorkerSession(b, worker);
}

/** Forward a background runtime's events to the page, tagged with the session they belong to. */
function workerEvent(b: Bridge, worker: Worker, event: { type: string } & Record<string, unknown>): void {
	const base = { sid: worker.sid, path: worker.path };
	const push = (payload: Record<string, unknown>) => broadcast(b, { ...base, ...payload });
	switch (event.type) {
		case "message_start": {
			const message = event.message as { role?: string; display?: boolean } | undefined;
			if (!message || isHiddenMessage(message as never)) return;
			if (message.role === "assistant") worker.live = { text: "", thinking: "" };
			push({ type: "message_start", message });
			break;
		}
		case "message_update": {
			const delta = event.assistantMessageEvent as Record<string, unknown> | undefined;
			if (worker.live && delta) {
				if (delta.type === "text_delta") worker.live.text += String(delta.delta ?? "");
				else if (delta.type === "thinking_delta") worker.live.thinking += String(delta.delta ?? "");
				else if (delta.type === "error") {
					const error = delta.error as { errorMessage?: string } | undefined;
					worker.live.text += `\n${error?.errorMessage ?? "request failed"}`;
				}
			}
			push({ type: "message_update", delta });
			break;
		}
		case "message_end": {
			const message = event.message as { role?: string; display?: boolean } | undefined;
			if (!message) return;
			if (!isHiddenMessage(message as never)) push({ type: "message_end", message });
			break;
		}
		case "entry_appended": {
			const entry = event.entry as { id?: string; type?: string; message?: { role?: string } } | undefined;
			if (entry?.type === "message" && entry.message?.role === "user" && entry.id) {
				push({ type: "entry_id", entryId: entry.id });
			}
			break;
		}
		case "agent_start":
			worker.running = true;
			worker.done = false;
			push({ type: "agent_start" });
			broadcastStatus(b, worker);
			break;
		case "agent_settled":
			worker.running = false;
			worker.live = null;
			worker.lastUsed = Date.now();
			worker.done = b.viewSid !== worker.sid;
			push({ type: "agent_settled", aborted: Boolean(event.aborted) });
			invalidateSessions(b);
			broadcastStatus(b, worker);
			void autoTitleWorker(b, worker);
			break;
		case "turn_end":
			broadcastStats(b, { kind: "worker", sid: worker.sid, worker });
			break;
		case "session_before_compact":
			push({ type: "compaction_start", reason: event.reason });
			break;
		case "session_compact":
			push({ type: "compaction_end", ok: true, reason: event.reason });
			break;
		case "session_compact_failed":
			push({ type: "compaction_end", ok: false, reason: event.reason, message: event.errorMessage });
			break;
		case "session_info_changed":
			push({ type: "session_info_changed", name: event.name });
			broadcastStatus(b, worker);
			break;
		case "thinking_level_changed":
			push({ type: "thinking_level_changed", level: event.level });
			break;
		case "tool_execution_start":
			push({
				type: "tool_execution_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
			});
			break;
		case "tool_execution_end":
			push({
				type: "tool_execution_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				isError: event.isError,
			});
			break;
		default:
			break;
	}
}

/** Send one prompt into a background runtime; the page queues its own sends while `running`. */
async function promptWorker(
	b: Bridge,
	worker: Worker,
	text: string,
	images: ImageBlock[],
): Promise<{ ok: true } | { ok: false; message: string }> {
	if (worker.running) return { ok: false, message: "busy" };
	// The model check needs the runtime, and a worker is built on its first prompt anyway.
	const opened = await ensureWorkerSession(b, worker);
	if (!opened.ok) return { ok: false, message: opened.message };
	const model = opened.session.model;
	if (images.length > 0 && !model?.input?.includes("image")) {
		return { ok: false, message: `${model?.id ?? "this model"} does not accept images` };
	}
	worker.running = true;
	worker.done = false;
	broadcastStatus(b, worker);
	try {
		// Not awaited: the response returns as soon as the prompt is accepted, and the events stream.
		void opened.session
			.prompt(text, images.length > 0 ? { images: images as never } : undefined)
			.catch((error: unknown) => {
				worker.running = false;
				worker.live = null;
				broadcast(b, {
					type: "agent_settled",
					sid: worker.sid,
					path: worker.path,
					aborted: false,
				});
				broadcast(b, {
					type: "notice",
					text: error instanceof Error ? error.message : "prompt failed",
					level: "error",
					sid: worker.sid,
					path: worker.path,
				});
				broadcastStatus(b, worker);
			});
	} catch (error) {
		worker.running = false;
		broadcastStatus(b, worker);
		return { ok: false, message: error instanceof Error ? error.message : "send failed" };
	}
	return { ok: true };
}

/**
 * Refresh just the footer while a turn runs. A tool loop can take minutes and several steps, and the
 * whole snapshot is neither needed nor wanted then - but the counts must not freeze until it settles.
 */
function broadcastStats(b: Bridge, target: Target): void {
	broadcast(b, {
		type: "stats",
		sid: target.sid,
		stats: statsOf(contextMessages(targetManager(b, target))),
		usage: targetUsage(b, target),
	});
}

/**
 * The model manager. nife keeps every model in models.json (its catalog is no longer built in), so
 * the page lists and edits that file: rows are the composed catalog, a models entry is edited in
 * place, anything else lands in modelOverrides, and deleting removes whichever of the two exist.
 * `modelRegistry.refresh()` re-reads the file; the page then displays the refreshed objects. Only
 * the four base rates of `cost` are touched, so pricing tiers always survive.
 */
const modelsJsonPath = (): string => join(getAgentDir(), "models.json");

/** The APIs a hand-written provider may declare (models.json's own `api` vocabulary). */
const MODEL_APIS = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"];

type ModelsRoot = Record<string, any> & { providers?: Record<string, any> };
type ModelCostRates = { input: number; output: number; cacheRead: number; cacheWrite: number };
type ModelCostTier = ModelCostRates & { inputTokensAbove: number };
type ModelPatch = {
	name?: string;
	reasoning?: boolean;
	input?: ("text" | "image")[];
	contextWindow?: number;
	maxTokens?: number;
	cost?: Partial<ModelCostRates> & { tiers?: ModelCostTier[] };
	// endpoint of one models entry; null means "inherit from the provider"
	baseUrl?: string | null;
	api?: string | null;
	// the object-valued fields; null (or {}) deletes the key
	thinkingLevelMap?: Record<string, string | null> | null;
	inputLimits?: Record<string, any> | null;
	promptCache?: Record<string, any> | null;
	samplingParams?: Record<string, unknown> | null;
	samplingParamsByThinkingLevel?: Record<string, any> | null;
	headers?: Record<string, string> | null;
	compat?: Record<string, any> | null;
};

/** The keys models.json accepts under a model, as objects written whole. */
const MODEL_OBJECT_FIELDS = [
	"thinkingLevelMap",
	"inputLimits",
	"promptCache",
	"samplingParams",
	"samplingParamsByThinkingLevel",
	"headers",
	"compat",
] as const;

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * Read models.json. A missing file is not an error (the manager creates it); an unparseable one is,
 * so a broken file is never silently rewritten. `content` is kept for the rollback path.
 */
async function readModelsJson(): Promise<{ root: ModelsRoot | null; content: string | null; error?: string }> {
	const file = modelsJsonPath();
	let content: string;
	try {
		content = await readFile(file, "utf-8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { root: null, content: null };
		return {
			root: null,
			content: null,
			error: `could not read ${file}: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	try {
		const parsed = JSON.parse(content.replace(/^\uFEFF/, ""));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return { root: null, content, error: `${file} must contain an object with a "providers" entry.` };
		}
		return { root: parsed as ModelsRoot, content };
	} catch (error) {
		return {
			root: null,
			content,
			error: `${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}. Fix it manually.`,
		};
	}
}

/** Write models.json atomically: a failed write never leaves a half-written catalog behind. */
async function writeModelsJson(root: ModelsRoot): Promise<void> {
	const file = modelsJsonPath();
	await mkdir(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	await writeFile(tmp, `${JSON.stringify(root, null, 2)}\n`, "utf-8");
	await rename(tmp, file);
}

/**
 * Write, reload the catalog, and undo the write when this provider fails to compose. nife validates
 * models.json as a whole, so one bad entry would otherwise empty the whole catalog - the rollback
 * keeps the previous file and the error text goes back to the page.
 */
async function saveCatalog(b: Bridge, root: ModelsRoot, original: string | null, provider: string): Promise<string | null> {
	const file = modelsJsonPath();
	// An existing broken entry in the same file must not block saving another row: compare the
	// error text before and after and only report what this write introduced. The baseline is read
	// after a refresh, so the file - not the last in-memory catalog - decides what "before" means.
	await b.ctx.modelRegistry.refresh({ allowNetwork: false }).catch(() => undefined);
	const baseline = catalogErrors(b);
	await writeModelsJson(root);
	const failure = await catalogFailure(b, provider, baseline);
	if (!failure) return null;
	if (original === null) await rm(file, { force: true });
	else {
		const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
		await writeFile(tmp, original, "utf-8");
		await rename(tmp, file);
	}
	await b.ctx.modelRegistry.refresh({ allowNetwork: false }).catch(() => undefined);
	return failure;
}

/** Section-wise error text, without the availability noise a catalog refresh can carry. */
function catalogErrors(b: Bridge): Set<string> {
	const text = b.ctx.modelRegistry.getError() ?? "";
	return new Set(
		text
			.split("\n\n")
			.map((line) => line.trim())
			.filter((line) => line && !line.startsWith("Availability refresh:")),
	);
}

/** What this write broke: a refresh error for the provider, or a new catalog error section. */
async function catalogFailure(b: Bridge, provider: string, baseline: Set<string>): Promise<string | null> {
	const result = await b.ctx.modelRegistry.refresh({ allowNetwork: false }).catch((error: unknown) => ({
		errors: new Map([[provider, error instanceof Error ? error : new Error(String(error))]]),
	}));
	const providerError = result.errors?.get(provider);
	if (providerError) return providerError.message;
	const fresh = [...catalogErrors(b)].filter((line) => !baseline.has(line));
	return fresh[0] ?? null;
}

/** Where the model currently lives in models.json, so an edit or a delete lands in the right place. */
function findModelEntry(
	root: ModelsRoot,
	provider: string,
	id: string,
): { kind: "models" | "overrides" | "none"; providerEntry?: Record<string, any>; entry?: Record<string, any> } {
	const providerEntry =
		root.providers?.[provider] && typeof root.providers[provider] === "object" ? root.providers[provider] : undefined;
	if (!providerEntry) return { kind: "none" };
	const models = Array.isArray(providerEntry.models) ? providerEntry.models : [];
	const entry = models.find((candidate: any) => candidate && typeof candidate === "object" && candidate.id === id);
	if (entry) return { kind: "models", providerEntry, entry };
	const overrides = providerEntry.modelOverrides;
	if (overrides && typeof overrides === "object" && !Array.isArray(overrides)) {
		const override = overrides[id];
		if (override && typeof override === "object") return { kind: "overrides", providerEntry, entry: override };
	}
	return { kind: "none", providerEntry };
}

/**
 * Persist a patch against one model. models.json models are edited in place (they are the catalog
 * entry); anything else lands in modelOverrides, which nife applies on top of the provider's
 * catalog (built-in or extension-registered alike).
 */
function writeModelFields(entry: Record<string, any>, patch: ModelPatch, withEndpoint: boolean): void {
	if (patch.name !== undefined) entry.name = patch.name;
	if (patch.reasoning !== undefined) entry.reasoning = patch.reasoning;
	if (patch.input !== undefined) entry.input = patch.input;
	if (patch.contextWindow !== undefined) entry.contextWindow = patch.contextWindow;
	if (patch.maxTokens !== undefined) entry.maxTokens = patch.maxTokens;
	for (const key of MODEL_OBJECT_FIELDS) {
		const value = patch[key];
		if (value === undefined) continue;
		if (value && Object.keys(value).length > 0) entry[key] = value;
		else delete entry[key];
	}
	if (patch.cost !== undefined) {
		const existing = entry.cost && typeof entry.cost === "object" ? entry.cost : {};
		const { tiers, ...rates } = patch.cost;
		// the four base rates are merged so a form that only knows them cannot drop a tier list
		const cost: Record<string, any> = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...existing, ...rates };
		if (tiers !== undefined) {
			if (tiers.length > 0) cost.tiers = tiers;
			else delete cost.tiers;
		}
		entry.cost = cost;
	}
	if (withEndpoint) {
		if (patch.baseUrl !== undefined) {
			if (patch.baseUrl) entry.baseUrl = patch.baseUrl;
			else delete entry.baseUrl;
		}
		if (patch.api !== undefined) {
			if (patch.api) entry.api = patch.api;
			else delete entry.api;
		}
	}
}

function applyModelPatch(root: ModelsRoot, provider: string, id: string, patch: ModelPatch): "models" | "overrides" {
	const providers = (root.providers ??= {});
	const source = findModelEntry(root, provider, id);
	if (source.kind === "models" && source.entry) {
		writeModelFields(source.entry, patch, true);
		return "models";
	}
	const providerEntry = source.providerEntry ?? (providers[provider] = {});
	const overrides = (providerEntry.modelOverrides ??= {});
	const existing = overrides[id] && typeof overrides[id] === "object" ? overrides[id] : undefined;
	const merged: Record<string, any> = { ...(existing ?? {}) };
	// a modelOverrides entry has no baseUrl/api of its own - the provider owns those
	writeModelFields(merged, patch, false);
	overrides[id] = merged;
	return "overrides";
}

/** Remove a models entry and an override in one go; the row then really disappears. */
function removeModel(root: ModelsRoot, provider: string, id: string): boolean {
	const providerEntry = root.providers?.[provider];
	if (!providerEntry || typeof providerEntry !== "object") return false;
	let removed = false;
	if (Array.isArray(providerEntry.models)) {
		const kept = providerEntry.models.filter((candidate: any) => !(candidate && typeof candidate === "object" && candidate.id === id));
		if (kept.length !== providerEntry.models.length) {
			providerEntry.models = kept;
			removed = true;
		}
	}
	const overrides = providerEntry.modelOverrides;
	if (overrides && typeof overrides === "object" && !Array.isArray(overrides) && id in overrides) {
		delete overrides[id];
		removed = true;
	}
	return removed;
}

/**
 * Drop the scaffolding a delete leaves behind. An empty `models: []` or `{}` provider fails
 * models.json validation, which would empty the whole catalog - so those keys go too.
 */
function pruneProvider(root: ModelsRoot, provider: string): void {
	const providers = root.providers;
	const providerEntry = providers?.[provider];
	if (!providers || !providerEntry || typeof providerEntry !== "object") return;
	if (Array.isArray(providerEntry.models) && providerEntry.models.length === 0) delete providerEntry.models;
	const overrides = providerEntry.modelOverrides;
	if (overrides && typeof overrides === "object" && !Array.isArray(overrides) && Object.keys(overrides).length === 0) {
		delete providerEntry.modelOverrides;
	}
	if (Object.keys(providerEntry).length === 0) delete providers[provider];
}

/** The current target's model, re-read from the catalog: a models.json edit changes the object. */
function displayModel(b: Bridge, target: Target): AnyModel | undefined {
	const model = targetModel(b, target);
	if (!model) return undefined;
	return (b.ctx.modelRegistry.find(model.provider, model.id) as AnyModel | undefined) ?? model;
}

function costOf(model: AnyModel): Record<string, number> {
	const cost = (model.cost ?? {}) as Record<string, any>;
	return {
		input: Number(cost.input) || 0,
		output: Number(cost.output) || 0,
		cacheRead: Number(cost.cacheRead) || 0,
		cacheWrite: Number(cost.cacheWrite) || 0,
	};
}

/** One row of the manager: the composed model plus where (and whether) it is stored. */
function modelRow(root: ModelsRoot | null, b: Bridge, model: AnyModel, current: AnyModel | undefined): Record<string, unknown> {
	const stored = root ? findModelEntry(root, model.provider, model.id) : { kind: "none" as const };
	const entry = stored.kind === "models" ? stored.entry : undefined;
	const providerEntry = root?.providers?.[model.provider] as Record<string, any> | undefined;
	return {
		provider: model.provider,
		id: model.id,
		name: model.name ?? model.id,
		reasoning: Boolean(model.reasoning),
		input: Array.isArray(model.input) && model.input.length > 0 ? model.input : ["text"],
		contextWindow: Number(model.contextWindow) || 0,
		maxTokens: Number(model.maxTokens) || 0,
		cost: costOf(model),
		source: stored.kind,
		// what the entry itself declares (empty = inherited), and the endpoint the composer resolved
		baseUrl: typeof entry?.baseUrl === "string" ? entry.baseUrl : "",
		api: typeof entry?.api === "string" ? entry.api : "",
		endpoint: typeof (model as any).baseUrl === "string" ? (model as any).baseUrl : "",
		// where the resolved endpoint comes from: a models entry's own baseUrl wins over its provider's
		// (modelFromJson), while an inherited model always takes the provider's (applyModelsJson)
		endpointSource:
			stored.kind === "models" && typeof entry?.baseUrl === "string" && entry.baseUrl
				? "model"
				: typeof providerEntry?.baseUrl === "string" && providerEntry.baseUrl
					? "provider"
					: "inherited",
		available: b.ctx.modelRegistry.hasConfiguredAuth(model),
		current: current?.provider === model.provider && current?.id === model.id,
		// the raw entries this row was built from: the form edits these, not its own idea of them
		entry: entry ? structuredClone(entry) : null,
		override:
			stored.kind === "overrides" && stored.entry ? structuredClone(stored.entry) : null,
		// which optional blocks the entry carries, so a row can say what it configures
		blocks: entry ? MODEL_OBJECT_FIELDS.filter((key) => entry[key] !== undefined) : [],
	};
}

/**
 * The manager's read: every composed model (not only the credentialed ones - a row with no key yet
 * must stay visible so it can be finished or removed) plus the providers a new row can join.
 */
async function modelsPayload(b: Bridge, target: Target | null): Promise<Record<string, unknown>> {
	const { root, error } = await readModelsJson();
	const current = target ? displayModel(b, target) : undefined;
	const models = b.ctx.modelRegistry
		.getAll()
		.map((model) => modelRow(root, b, model as AnyModel, current))
		.sort(
			(left, right) =>
				Number(right.current) - Number(left.current) ||
				String(left.provider).localeCompare(String(right.provider)) ||
				String(left.name ?? left.id).localeCompare(String(right.name ?? right.id)),
		);
	const providers = new Map<string, Record<string, unknown>>();
	for (const [id, entry] of Object.entries(root?.providers ?? {})) {
		if (!entry || typeof entry !== "object") continue;
		providers.set(id, providerPayload(id, entry as Record<string, any>, models));
	}
	for (const model of models) {
		const id = String(model.provider);
		if (providers.has(id)) continue;
		providers.set(id, {
			id,
			defined: false,
			api: null,
			baseUrl: "",
			hasKey: false,
			models: 0,
			overrides: 0,
			entry: null,
		});
	}
	return {
		models,
		providers: [...providers.values()].sort((left, right) =>
			String(left.id).localeCompare(String(right.id)),
		),
		path: modelsJsonPath(),
		writable: !error,
		warning: error,
	};
}

/** One provider in the manager: the entry itself (without its key), and what hangs off it. */
function providerPayload(id: string, entry: Record<string, any>, models: Record<string, any>[]): Record<string, unknown> {
	const { apiKey, models: modelList, modelOverrides, ...rest } = entry;
	return {
		id,
		defined: true,
		api: typeof entry.api === "string" ? entry.api : null,
		baseUrl: typeof entry.baseUrl === "string" ? entry.baseUrl : "",
		hasKey: typeof apiKey === "string" && apiKey.length > 0,
		models: Array.isArray(modelList) ? modelList.length : 0,
		overrides:
			modelOverrides && typeof modelOverrides === "object" && !Array.isArray(modelOverrides)
				? Object.keys(modelOverrides).length
				: 0,
		// the composable fields, so the provider form starts from the file instead of from guesses
		entry: structuredClone(rest),
		rows: models.filter((model) => model.provider === id).length,
	};
}

function readProviderId(value: unknown): { id: string; error?: string } {
	if (typeof value !== "string") return { id: "", error: "provider must be a string" };
	const id = value.trim();
	if (!id) return { id, error: "provider cannot be empty" };
	if (id.length > 100) return { id, error: "provider is too long (100 characters max)" };
	if (/[\s/\\]/.test(id)) return { id, error: "provider cannot contain spaces or slashes" };
	return { id };
}

function readModelId(value: unknown): { id: string; error?: string } {
	if (typeof value !== "string") return { id: "", error: "id must be a string" };
	const id = value.trim();
	if (!id) return { id, error: "id cannot be empty" };
	if (id.length > 200) return { id, error: "id is too long (200 characters max)" };
	if (/[\u0000-\u001f\u007f]/.test(id)) return { id, error: "id cannot contain control characters" };
	return { id };
}

function readModelPatch(body: Record<string, unknown>): { patch: ModelPatch; error?: string } {
	const patch: ModelPatch = {};
	if (body.name !== undefined) {
		if (typeof body.name !== "string") return { patch, error: "name must be a string" };
		const name = body.name.trim();
		if (!name) return { patch, error: "name cannot be empty" };
		if (name.length > 200) return { patch, error: "name is too long (200 characters max)" };
		patch.name = name;
	}
	if (body.reasoning !== undefined) {
		if (typeof body.reasoning !== "boolean") return { patch, error: "reasoning must be a boolean" };
		patch.reasoning = body.reasoning;
	}
	if (body.input !== undefined) {
		if (!Array.isArray(body.input) || body.input.some((entry) => entry !== "text" && entry !== "image")) {
			return { patch, error: "input must be a mix of text and image" };
		}
		const input: ("text" | "image")[] = ["text"];
		if (body.input.includes("image")) input.push("image");
		patch.input = input;
	}
	if (body.contextWindow !== undefined) {
		const value = readTokenCount(body.contextWindow);
		if (value === undefined) return { patch, error: "context window must be a number, at least 1" };
		patch.contextWindow = value;
	}
	if (body.maxTokens !== undefined) {
		const value = readTokenCount(body.maxTokens);
		if (value === undefined) return { patch, error: "max tokens must be a number, at least 1" };
		patch.maxTokens = value;
	}
	if (body.baseUrl !== undefined) {
		const baseUrl = readBaseUrl(body.baseUrl);
		if (baseUrl.error) return { patch, error: baseUrl.error };
		patch.baseUrl = baseUrl.value;
	}
	if (body.api !== undefined) {
		const api = readApi(body.api);
		if (api.error) return { patch, error: api.error };
		patch.api = api.value;
	}
	if (body.cost !== undefined) {
		if (typeof body.cost !== "object" || body.cost === null || Array.isArray(body.cost)) return { patch, error: "cost must be an object" };
		const cost: ModelPatch["cost"] = {};
		for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
			const raw = (body.cost as Record<string, unknown>)[key];
			if (raw === undefined) continue;
			const value = typeof raw === "string" && raw.trim() ? Number(raw) : raw;
			if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
				return { patch, error: `cost.${key} must be a number, at least 0` };
			}
			cost[key] = value;
		}
		const rawTiers = (body.cost as Record<string, unknown>).tiers;
		if (rawTiers !== undefined) {
			if (!Array.isArray(rawTiers)) return { patch, error: "cost.tiers must be an array" };
			const tiers: ModelCostTier[] = [];
			for (const [index, rawTier] of rawTiers.entries()) {
				if (!rawTier || typeof rawTier !== "object" || Array.isArray(rawTier)) {
					return { patch, error: `cost.tiers[${index}] must be an object` };
				}
				const tier = rawTier as Record<string, unknown>;
				const above = readTokenCount(tier.inputTokensAbove);
				if (above === undefined) return { patch, error: `cost.tiers[${index}].inputTokensAbove must be a number, at least 1` };
				const rates: ModelCostTier = { inputTokensAbove: above, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
				for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
					const value = typeof tier[key] === "string" && String(tier[key]).trim() ? Number(tier[key]) : (tier[key] ?? 0);
					if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
						return { patch, error: `cost.tiers[${index}].${key} must be a number, at least 0` };
					}
					rates[key] = value;
				}
				tiers.push(rates);
			}
			cost.tiers = tiers;
		}
		if (Object.keys(cost).length > 0) patch.cost = cost;
	}
	// thinkingLevelMap is a fixed set of levels, each a string or null (null hides the level)
	if (body.thinkingLevelMap !== undefined) {
		const raw = body.thinkingLevelMap;
		if (raw === null) {
			patch.thinkingLevelMap = null;
		} else {
			if (typeof raw !== "object" || Array.isArray(raw)) return { patch, error: "thinking levels must be an object" };
			const map: Record<string, string | null> = {};
			for (const [level, value] of Object.entries(raw as Record<string, unknown>)) {
				if (!(THINKING_LEVELS as readonly string[]).includes(level)) {
					return { patch, error: `unknown thinking level "${level}"` };
				}
				if (value === null || value === "") {
					map[level] = null;
					continue;
				}
				if (typeof value !== "string") return { patch, error: `thinking level ${level} must be a string or null` };
				map[level] = value.trim();
			}
			patch.thinkingLevelMap = map;
		}
	}
	if (body.inputLimits !== undefined) {
		const limits = readObject(body.inputLimits, "input limits");
		if (limits.error) return { patch, error: limits.error };
		patch.inputLimits = limits.value;
	}
	if (body.promptCache !== undefined) {
		const cache = readObject(body.promptCache, "prompt cache");
		if (cache.error) return { patch, error: cache.error };
		for (const [key, value] of Object.entries(cache.value ?? {})) {
			if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
				return { patch, error: `prompt cache ${key} must be a positive number` };
			}
		}
		patch.promptCache = cache.value;
	}
	if (body.samplingParams !== undefined) {
		const sampling = readObject(body.samplingParams, "sampling params");
		if (sampling.error) return { patch, error: sampling.error };
		patch.samplingParams = sampling.value;
	}
	if (body.samplingParamsByThinkingLevel !== undefined) {
		const sampling = readObject(body.samplingParamsByThinkingLevel, "sampling params per thinking level");
		if (sampling.error) return { patch, error: sampling.error };
		for (const level of Object.keys(sampling.value ?? {})) {
			if (!(THINKING_LEVELS as readonly string[]).includes(level)) {
				return { patch, error: `unknown thinking level "${level}"` };
			}
		}
		patch.samplingParamsByThinkingLevel = sampling.value;
	}
	if (body.headers !== undefined) {
		const headers = readObject(body.headers, "headers");
		if (headers.error) return { patch, error: headers.error };
		for (const [key, value] of Object.entries(headers.value ?? {})) {
			if (typeof value !== "string") return { patch, error: `header ${key} must be a string` };
		}
		patch.headers = headers.value as Record<string, string> | null;
	}
	if (body.compat !== undefined) {
		const compat = readObject(body.compat, "compat");
		if (compat.error) return { patch, error: compat.error };
		patch.compat = compat.value;
	}
	return { patch };
}

/** A JSON object sent by the form; null or {} both mean "this key goes away". */
function readObject(raw: unknown, label: string): { value: Record<string, any> | null; error?: string } {
	if (raw === null) return { value: null };
	if (typeof raw !== "object" || Array.isArray(raw)) return { value: null, error: `${label} must be an object` };
	const entries = Object.entries(raw as Record<string, unknown>).filter(([, value]) => value !== undefined);
	if (entries.length === 0) return { value: null };
	return { value: Object.fromEntries(entries) };
}

/**
 * An endpoint URL from the form: empty means "inherit", and anything else must be http(s) - nife
 * would otherwise build a client for a URL that cannot work. Returned as null so the caller can
 * delete the key instead of writing "".
 */
function readBaseUrl(raw: unknown): { value: string | null; error?: string } {
	if (raw === null) return { value: null };
	if (typeof raw !== "string") return { value: null, error: "base URL must be a string" };
	const baseUrl = raw.trim();
	if (!baseUrl) return { value: null };
	if (!/^https?:\/\//i.test(baseUrl)) return { value: null, error: "base URL must start with http:// or https://" };
	if (/\s/.test(baseUrl)) return { value: null, error: "base URL cannot contain spaces" };
	return { value: baseUrl };
}

/** The API an entry may declare; empty means "inherit from the provider". */
function readApi(raw: unknown): { value: string | null; error?: string } {
	if (raw === null) return { value: null };
	if (typeof raw !== "string") return { value: null, error: "api must be a string" };
	const api = raw.trim();
	if (!api) return { value: null };
	// the four common APIs are offered by the form, but models.json accepts any name
	if (!/^[\w.-]+$/.test(api)) return { value: null, error: "api must be a name like openai-completions" };
	if (api.length > 60) return { value: null, error: "api is too long (60 characters max)" };
	return { value: api };
}

/** A token count from a number or a numeric string; undefined when it is not a positive integer. */
function readTokenCount(raw: unknown): number | undefined {
	const value = typeof raw === "string" && raw.trim() ? Number(raw) : raw;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return undefined;
	return Math.round(value);
}

/** A brand-new models.json entry, filled with nife's documented defaults where the form is empty. */
function modelEntryFromForm(id: string, patch: ModelPatch): Record<string, any> {
	return {
		id,
		name: patch.name ?? id,
		reasoning: patch.reasoning ?? false,
		input: patch.input ?? ["text"],
		contextWindow: patch.contextWindow ?? 128000,
		maxTokens: patch.maxTokens ?? 16384,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...(patch.cost ?? {}) },
		...(patch.baseUrl ? { baseUrl: patch.baseUrl } : {}),
		...(patch.api ? { api: patch.api } : {}),
	};
}

function snapshot(b: Bridge, target: Target, metaOnly = false): unknown {
	const manager = targetManager(b, target);
	const messages = contextMessages(manager);
	const page = pageOf(messages, messages.length);
	const model = displayModel(b, target);
	const stats = statsOf(messages);
	return {
		sid: target.sid,
		kind: target.kind,
		machine: MACHINE,
		sessionId: manager.getSessionId(),
		sessionFile: manager.getSessionFile(),
		name: target.kind === "host" ? b.api.getSessionName() : workerName(target.worker),
		cwd: targetCwd(b, target),
		// The page shows the device chip and the tab names the machine the conversation runs on; the
		// cwd itself stays the real remote path, so nothing in the transcript has to be translated.
		remote: target.kind === "worker" && target.worker.device ? { alias: target.worker.device, path: targetCwd(b, target) } : null,
		model: model ? { id: model.id, name: model.name, provider: model.provider } : null,
		thinkingLevel: targetThinking(b, target),
		thinkingLevels: supportedLevels(model),
		mode: targetWorkspace(b, target),
		models: (target.kind === "host" ? availableModels(b.ctx) : b.ctx.modelRegistry.getAvailable()).map((model) => ({
			provider: model.provider,
			id: model.id,
			name: model.name,
		})),
		streaming: targetRunning(b, target),
		// What a background conversation can actually do. A device session has fewer tools than a local
		// one, and saying so is cheaper than letting the model discover it by failing.
		tools: target.kind === "worker" ? (target.worker.session?.getActiveToolNames() ?? []) : null,
		// what the assistant has streamed so far, so switching back mid-turn is not a blank bubble
		live: target.kind === "host" ? b.hostLive : target.worker.live,
		usage: targetUsage(b, target),
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

/**
 * Which machine a page belongs to.
 *
 * Several windows are usually open at once - a server reached over ssh, a WSL distro, a Windows
 * box - and a bare hostname is the one label that does not tell them apart: WSL and Windows often
 * share (or mimic) one, and `ubuntu` is every second container. So the label names the *kind* of
 * machine first and falls back to the hostname when the kind needs no explaining.
 */
interface Machine {
	/** short, always the same for one environment: `WSL:Ubuntu`, `Windows`, `ssh:srv-01`, `srv-01` */
	label: string;
	host: string;
	user: string;
	platform: string;
	/** favicon colour: one hue per machine, so truncated tabs still differ at a glance */
	hue: number;
}

const MACHINE: Machine = (() => {
	const host = (() => {
		try {
			return hostname() || "unknown";
		} catch {
			return "unknown";
		}
	})();
	const user = (() => {
		try {
			return userInfo().username;
		} catch {
			return "";
		}
	})();
	const platform = process.platform;
	const wsl = (process.env.WSL_DISTRO_NAME ?? "").trim();
	let label = host;
	if (wsl) label = `WSL:${wsl.slice(0, 14)}`;
	else if (platform === "win32") label = "Windows";
	else if (platform === "darwin") label = "macOS";
	else if (process.env.SSH_CONNECTION) label = `ssh:${host}`;
	// FNV-1a over the identity: stable across restarts, different for Windows and WSL on one box
	let hash = 0x811c9dc5;
	for (const char of `${label}|${host}`) {
		hash ^= char.codePointAt(0) ?? 0;
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return { label, host, user, platform, hue: hash % 360 };
})();

/** The same "N" the CLI uses, tinted per machine; a data uri keeps the shell self-contained. */
const FAVICON = (() => {
	const svg =
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
		`<rect width="32" height="32" rx="9" fill="hsl(${MACHINE.hue},58%,46%)"/>` +
		`<path d="M10 23V9l12 14V9" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>` +
		`</svg>`;
	return `data:image/svg+xml,${encodeURIComponent(svg)}`;
})();

const escapeHtml = (text: string): string => text.replace(/[<&"]/g, (c) => (c === "<" ? "&lt;" : c === "&" ? "&amp;" : "&quot;"));

/**
 * `WSL:Ubuntu · nife-webui`: the machine first, because that is what collides between windows, then
 * the project, which is what separates two windows on the same machine.
 */
function pageTitle(machine: Machine, project: string): string {
	return [machine.label, project].filter(Boolean).join(" · ");
}

async function serveStatic(pathname: string, res: ServerResponse, title = pageTitle(MACHINE, "")): Promise<void> {
	const relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
	const file = resolve(DIST_DIR, relative);
	if (!file.startsWith(DIST_DIR + sep)) return send(res, 404, `not found: ${pathname}`);
	try {
		const body = await readFile(file);
		// only the shell carries a title: every tab used to be called "nife"
		if (relative === "index.html") {
			const html = body
				.toString("utf8")
				.replace(/<title>[^<]*<\/title>/, () => `<title>${escapeHtml(title)}</title><link rel="icon" href="${FAVICON}">`);
			return send(res, 200, html, "text/html; charset=utf-8");
		}
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
			const header = JSON.parse(first) as { type?: string; cwd?: unknown; webui?: { device?: unknown } };
			if (header.type !== "session") return null;
			const device = typeof header.webui?.device === "string" ? header.webui.device : undefined;
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
				...(device ? { device } : {}),
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
		if (targetWorkspace(b, viewedTarget(b)) === "work" && currentDir) add(currentDir);
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
	// Files a running runtime is writing to: temp cleanup must never pull one of those out from under it.
	const live = new Set<string>();
	const hostSession = b.ctx.sessionManager.getSessionFile();
	if (hostSession) live.add(resolve(hostSession));
	for (const worker of b.workers.values()) live.add(resolve(worker.path));
	const byPath = new Map<string, SessionRef>();
	let dropped = false;
	for (const ref of groups.flat()) {
		// A session whose project or file lives under a temp path is a throwaway run: forget the row
		// and delete the file, so neither this scan nor the next one has to look at it again. The
		// session this process is running is never deleted, even when it happens to live there.
		if (isTempPath(ref.cwd) || isTempPath(ref.path)) {
			if (!live.has(resolve(ref.path))) {
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

function projectGroups(
	b: Bridge,
	refs: SessionRef[],
	current: { cwd: string; device?: string } = { cwd: b.ctx.cwd },
): ProjectGroupInfo[] {
	const groups = new Map<string, ProjectGroupInfo>();
	for (const ref of refs) {
		if (!ref.hasMessage) continue;
		// group by the comparable path, but keep the spelling the session recorded: the page passes
		// that `cwd` back when it asks for one project's rows
		const key = ref.cwd ? projectKey(ref.device, ref.cwd) : "";
		let group = groups.get(key);
		if (!group) {
			// A device path groups as `router:/etc`: `basename` alone would list three projects called
			// `etc` for three devices, which is exactly the ambiguity this feature is about.
			group = {
				cwd: ref.cwd || "",
				device: ref.device,
				name: ref.device
					? `${ref.device}:${ref.cwd}`
					: ref.cwd
						? basename(ref.cwd) || ref.cwd
						: "Unknown project",
				count: 0,
				modified: ref.modified,
				current:
					Boolean(ref.cwd) && (ref.device ?? "") === (current.device ?? "") && samePath(ref.cwd, current.cwd),
			};
			groups.set(key, group);
		}
		group.count += 1;
		if (ref.modified.getTime() > group.modified.getTime()) group.modified = ref.modified;
	}
	const list = [...groups.values()];
	const index = list.findIndex((group) => group.current);
	if (index > 0) list.unshift(list.splice(index, 1)[0]);
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

async function projectSessionsForCwd(b: Bridge, workspace: Workspace, cwd: string, device?: string): Promise<SessionInfo[]> {
	const key = `${workspace}\n${projectKey(device, cwd)}`;
	const cached = b.projectSessionCache[key];
	if (cached && Date.now() - cached.at < SESSION_CACHE_MS) return cached.sessions;
	const refs = (await workspaceRefs(b, workspace)).filter(
		(ref) =>
			ref.hasMessage &&
			(ref.device ?? "") === (device ?? "") &&
			(cwd ? samePath(ref.cwd, cwd) : ref.cwd === ""),
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

/** The device list as the page sees it: what this extension saved, plus what was probed. */
function hostRows(
	b: Bridge,
): (HostEntry & { target: string; profile?: HostProfile; status?: { at: number; ms?: number; error?: string } })[] {
	return readHosts().map((entry) => ({
		...entry,
		target: sshTarget(entry),
		profile: b.remoteProfiles.get(entry.alias),
		status: b.remoteStatus.get(entry.alias),
	}));
}

/**
 * `cd <somewhere> && pwd` on the device. A quoted `~` would be a literal directory name, so the
 * home form is written as `$HOME` - still quoted, so a path with spaces stays one argument.
 */
const remoteCd = (asked: string): string => {
	if (asked === "~" || asked === "") return `cd "$HOME" && pwd`;
	if (asked.startsWith("~/")) return `cd "$HOME/${asked.slice(2)}" && pwd`;
	return `cd ${shellQuote(asked)} && pwd`;
};

/** Resolve a device directory (symlinks, `~`, `..`): a path that cannot be entered is an error. */
async function resolveRemoteDir(host: RemoteHost, asked: string): Promise<string> {
	const result = await host.run(remoteCd(asked), "/", 20);
	const path = result.text.trim().split("\n").pop()?.trim() ?? "";
	if (result.code !== 0 || !path) throw new Error(`不是文件夹：${asked}`);
	return path;
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
	const viewed = viewedTarget(b);
	const refs = await workspaceRefs(b, targetWorkspace(b, viewed));
	const groups = projectGroups(b, refs, { cwd: targetCwd(b, viewed), device: viewed.kind === "worker" ? viewed.worker.device : undefined });
	// Only projects with a saved conversation are listed. The current project is not injected as an
	// empty group: a New Work / New Chat still has no row, and deleting a workspace has to remove it
	// from the sidebar right away instead of leaving its name behind with "No sessions". The group
	// comes back with the first message, because that message is what puts a row in it.
	return {
		current: targetCwd(b, viewed),
		currentFile: targetManager(b, viewed).getSessionFile(),
		mode: targetWorkspace(b, viewed),
		groups: groups.map((group) => ({ ...group, key: projectKey(group.device, group.cwd) })),
	};
}

async function listSessions(b: Bridge, cwd: string, device?: string): Promise<unknown> {
	const viewed = viewedTarget(b);
	// Header-only sessions are the empty target of a workspace switch; they join Recents with their
	// first message, not before.
	const sessions = await projectSessionsForCwd(b, targetWorkspace(b, viewed), cwd, device);
	return {
		current: targetManager(b, viewed).getSessionFile(),
		cwd,
		sessions: sessions.map((session) => {
			const workerSid = b.workersByPath.get(pathKey(session.path));
			const worker = workerSid ? b.workers.get(workerSid) : undefined;
			const host = hostFile(b);
			const isHost = Boolean(host && samePath(host, session.path));
			return {
				path: session.path,
				id: session.id,
				name: session.name,
				cwd: session.cwd,
				modified: session.modified,
				messageCount: session.messageCount,
				// The sidebar shows a blue spinner while a turn runs and a green dot when it finished
				// in the background, so a reader in another conversation still sees what is happening.
				running: worker ? worker.running : isHost ? !b.ctx.isIdle() : false,
				done: worker ? worker.done : isHost ? b.hostDone === true : false,
				// Whitespace collapsed here, not in the page: a title is one line, whatever was pasted.
				firstMessage: session.firstMessage.replace(/\s+/g, " ").trim().slice(0, SESSION_TITLE_MAX),
			};
		}),
	};
}

/** The recorded prompt of a user message, for retrying it in a background runtime. */
function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as Record<string, unknown>[])
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => String(block.text))
		.join("\n");
}

function messageImages(content: unknown): ImageBlock[] {
	if (!Array.isArray(content)) return [];
	return (content as Record<string, unknown>[])
		.filter((block) => block?.type === "image" && typeof block.data === "string")
		.map((block) => ({ type: "image" as const, mimeType: String(block.mimeType ?? ""), data: String(block.data) }));
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

/** Same leaf move for a background runtime, which navigates its own session. */
async function navigateTarget(b: Bridge, target: Target, entryId: string): Promise<SwitchOutcome> {
	if (target.kind === "host") return await requestTree(b, entryId);
	const opened = await ensureWorkerSession(b, target.worker);
	if (!opened.ok) return { ok: false, message: opened.message };
	try {
		const result = await opened.session.navigateTree(entryId);
		return result.cancelled ? { ok: false, message: "navigation cancelled" } : { ok: true };
	} catch (error) {
		return { ok: false, message: error instanceof Error ? error.message : "navigation failed" };
	}
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

/** The session a request is about. Unknown sids are a stale tab, not the host session. */
function requestTarget(b: Bridge, sid: unknown): Target | null {
	return targetOf(b, sid) ?? null;
}

async function handle(b: Bridge, req: IncomingMessage, res: ServerResponse): Promise<void> {
	// `new URL("//x/y")` parses as a scheme-relative host, so the leading slash is collapsed first:
	// a doubled slash must stay a path, not become a hostname.
	const url = new URL((req.url ?? "/").replace(/^\/+/, "/"), `http://127.0.0.1:${b.port}`);
	const { path, mount } = routePath(req, url.pathname);
	// NIFE_WEBUI_DEBUG=1 shows what a tunnel actually forwarded, prefix included.
	if (DEBUG && (mount || req.url !== path)) console.error(`webui ${req.method} ${req.url} -> ${path}`);

	// Static assets carry no session data and are requested without the token.
	if (req.method === "GET" && !path.startsWith("/api/")) {
		// The title is painted before any script runs, so it names the session this process serves -
		// `viewSid` is global to the bridge and would hand another tab's project to this one. The page
		// corrects it as soon as the state arrives (a tab that re-attaches lives somewhere else).
		const project = b.ctx.cwd;
		return serveStatic(path, res, pageTitle(MACHINE, project ? basename(project) : ""));
	}

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
		const target = requestTarget(b, url.searchParams.get("sid"));
		if (!target) return send(res, 404, "unknown session");
		// the header refresh runs on every event and only reads counts: no reason to ship the page
		return send(res, 200, JSON.stringify(snapshot(b, target, url.searchParams.get("meta") === "1")), "application/json");
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
		const target = requestTarget(b, url.searchParams.get("sid"));
		if (!target) return send(res, 404, "unknown session");
		const messages = contextMessages(targetManager(b, target));
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
		const target = requestTarget(b, url.searchParams.get("sid"));
		if (!target) return send(res, 404, "unknown session");
		const messages = contextMessages(targetManager(b, target));
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
	if (req.method === "GET" && path === "/api/dirs" && url.searchParams.get("host")) {
		const alias = url.searchParams.get("host") ?? "";
		let host: RemoteHost;
		try {
			host = remoteConnection(b, alias);
		} catch (error) {
			return send(res, 404, error instanceof Error ? error.message : `unknown device: ${alias}`);
		}
		let target: string;
		try {
			target = await resolveRemoteDir(host, url.searchParams.get("path") ?? "~");
		} catch (error) {
			return send(res, 400, error instanceof Error ? error.message : `无法打开：${alias}`);
		}
		// Directories only, and no `find`: a busybox `find` without `-maxdepth` walks the whole tree.
		const listing = await host.run(
			`cd ${shellQuote(target)} && for entry in * .[!.]*; do [ -d "$entry" ] && printf '%s\\n' "$entry"; done`,
			"/",
			30,
		);
		const names = listing.text
			.split("\n")
			.map((name) => name.trim())
			.filter((name) => name.length > 0 && name !== "." && name !== "..")
			.slice(0, BROWSE_DIR_MAX);
		const dirs = names
			.map((name) => ({ name, path: target === "/" ? `/${name}` : `${target}/${name}` }))
			.sort((left, right) => left.name.localeCompare(right.name, "zh"));
		const parent = target === "/" ? null : target.replace(/\/+$/, "").replace(/\/[^/]+$/, "") || "/";
		const home = (
			await host.run(`printf %s "$HOME"`, "/", 10).catch(() => ({ text: "" }))
		).text.trim();
		return send(
			res,
			200,
			JSON.stringify({ host: alias, path: target, parent, home: home || "/", dirs }),
			"application/json",
		);
	}

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

	// The device list. Probing is a separate call: a page load must not wait for five dead hosts.
	if (req.method === "GET" && path === "/api/hosts") {
		return send(
			res,
			200,
			JSON.stringify({ hosts: hostRows(b), file: hostsFile() }),
			"application/json",
		);
	}

	if (req.method === "POST" && path === "/api/hosts/test") {
		const body = await readJson(req, 4 * 1024).catch(() => ({}) as Record<string, unknown>);
		const alias = typeof body.alias === "string" ? body.alias : "";
		let host: RemoteHost;
		try {
			host = remoteConnection(b, alias);
		} catch (error) {
			return send(res, 404, error instanceof Error ? error.message : `unknown device: ${alias}`);
		}
		try {
			const started = Date.now();
			const profile = await host.probe();
			b.remoteProfiles.set(host.alias, profile);
			b.remoteStatus.set(host.alias, { at: Date.now(), ms: Date.now() - started });
			return send(res, 200, JSON.stringify({ ok: true, profile, ms: Date.now() - started }), "application/json");
		} catch (error) {
			// a failed probe leaves the cached connection unusable: the next attempt must reconnect
			host.close();
			b.remotes.delete(host.alias);
			const reason = error instanceof Error ? error.message : "connection failed";
			b.remoteStatus.set(host.alias, { at: Date.now(), error: reason });
			b.remoteProfiles.delete(host.alias);
			return send(res, 200, JSON.stringify({ ok: false, error: reason }), "application/json");
		}
	}

	if (req.method === "POST" && (path === "/api/hosts/save" || path === "/api/hosts/remove")) {
		const body = await readJson(req, 8 * 1024).catch(() => ({}) as Record<string, unknown>);
		const alias = typeof body.alias === "string" ? body.alias.trim() : "";
		if (!VALID_ALIAS.test(alias)) return send(res, 400, "名称只能用字母、数字、点、下划线、减号（最长 32 位）");
		const previous = readHosts().find((entry) => entry.alias.toLowerCase() === alias.toLowerCase());
		if (path === "/api/hosts/save") {
			const host = typeof body.host === "string" ? body.host.trim() : "";
			if (!host) return send(res, 400, "缺少主机地址");
			const port = Number(body.port);
			const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
			upsertHost({
				alias,
				host,
				...(text(body.user) ? { user: text(body.user) } : {}),
				...(Number.isFinite(port) && port > 0 && port < 65536 ? { port } : {}),
				...(text(body.identity) ? { identity: text(body.identity) } : {}),
				...(text(body.proxyJump) ? { proxyJump: text(body.proxyJump) } : {}),
				...(text(body.label) ? { label: text(body.label) } : {}),
				...(Array.isArray(body.options)
					? { options: body.options.filter((option): option is string => typeof option === "string" && option.length > 0) }
					: previous?.options?.length
						? { options: previous.options }
						: {}),
			});
		} else {
			deleteHost(alias);
		}
		// Edited or removed settings must not be served by a connection opened with the old ones.
		const live = b.remotes.get(alias);
		if (live) {
			live.close();
			b.remotes.delete(alias);
		}
		b.remoteProfiles.delete(alias);
		return send(res, 200, JSON.stringify({ ok: true, hosts: hostRows(b) }), "application/json");
	}

	if (req.method === "GET" && path === "/api/groups") {
		return send(res, 200, JSON.stringify(await listGroups(b)), "application/json");
	}

	if (req.method === "GET" && path === "/api/sessions") {
		const cwd = url.searchParams.get("cwd");
		const device = url.searchParams.get("device") || undefined;
		return send(
			res,
			200,
			JSON.stringify(await listSessions(b, cwd ?? targetCwd(b, viewedTarget(b)), device)),
			"application/json",
		);
	}

	// Full-text search across this project's conversations. `SessionManager.list` already read every
	// file for the sidebar, so its allMessagesText filters the cheap way; only sessions that can hit
	// are opened again for snippets and entry ids.
	if (req.method === "GET" && path === "/api/search") {
		const raw = (url.searchParams.get("q") ?? "").trim();
		if (!raw) return send(res, 200, JSON.stringify({ results: [] }), "application/json");
		if (raw.length > SEARCH_QUERY_MAX) return send(res, 400, "query too long");
		const query = raw.toLowerCase();
		const refs = await workspaceRefs(b, targetWorkspace(b, viewedTarget(b)));
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
		const target = requestTarget(b, body.sid ?? url.searchParams.get("sid"));
		if (!target) return send(res, 404, "unknown session");
		// A background session runs its own loop: the page's queue is per session, so "busy" here only
		// concerns the conversation the reader is looking at.
		if (target.kind === "worker") {
			const outcome = await promptWorker(b, target.worker, text, images);
			return send(res, outcome.ok ? 200 : outcome.message === "busy" ? 409 : 409, outcome.ok ? "ok" : outcome.message);
		}
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
		const target = requestTarget(b, body.sid ?? url.searchParams.get("sid"));
		if (!target) return send(res, 404, "unknown session");
		if (target.kind === "worker") {
			const opened = await ensureWorkerSession(b, target.worker);
			if (!opened.ok) return send(res, 409, opened.message);
			try {
				await opened.session.compact(instructions || undefined);
			} catch (error) {
				return send(res, 409, error instanceof Error ? error.message : "compaction failed");
			}
			return send(res, 200, "ok");
		}
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
		const target = requestTarget(b, url.searchParams.get("sid"));
		if (!target) return send(res, 404, "unknown session");
		if (target.kind === "host") b.ctx.abort();
		else void target.worker.session?.abort();
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
		const target = requestTarget(b, body.sid ?? url.searchParams.get("sid"));
		if (!target) return send(res, 404, "unknown session");
		const model = b.ctx.modelRegistry.find(provider, id);
		if (!model) return send(res, 404, "unknown model");
		if (target.kind === "host") {
			const ok = await b.api.setModel(model as never);
			if (!ok) return send(res, 409, `no credentials for ${provider}/${id}`);
		} else {
			const opened = await ensureWorkerSession(b, target.worker);
			if (!opened.ok) return send(res, 409, opened.message);
			await opened.session.setModel(model as never);
		}
		broadcast(b, { type: "state_changed", sid: target.sid });
		return send(res, 200, "ok");
	}

	// The model manager's read: every catalog row, where it is stored, and the providers it can join.
	if (req.method === "GET" && path === "/api/models") {
		const target = requestTarget(b, url.searchParams.get("sid"));
		if (!target) return send(res, 404, "unknown session");
		return send(res, 200, JSON.stringify(await modelsPayload(b, target)), "application/json");
	}

	// Create: a models entry on an existing provider, or a whole new provider when the form says so.
	if (req.method === "POST" && path === "/api/models") {
		let body: Record<string, unknown>;
		try {
			body = await readJson(req);
		} catch {
			return send(res, 400, "bad JSON");
		}
		const providerId = readProviderId(body.provider);
		if (providerId.error) return send(res, 400, providerId.error);
		const modelId = readModelId(body.id);
		if (modelId.error) return send(res, 400, modelId.error);
		const { patch, error } = readModelPatch(body);
		if (error) return send(res, 400, error);
		const { root, content, error: loadError } = await readModelsJson();
		if (loadError) return send(res, 409, loadError);
		const fileRoot = root ?? { providers: {} };
		if (findModelEntry(fileRoot, providerId.id, modelId.id).kind === "models") {
			return send(res, 409, `models.json already has ${providerId.id}/${modelId.id}`);
		}
		const providers = (fileRoot.providers ??= {});
		let providerEntry = providers[providerId.id];
		const isNewProvider = !providerEntry || typeof providerEntry !== "object";
		if (isNewProvider) {
			// A provider nife does not know yet needs its endpoint, exactly like a hand-written entry.
			const parsedUrl = readBaseUrl(body.baseUrl);
			if (parsedUrl.error) return send(res, 400, parsedUrl.error);
			if (!parsedUrl.value) return send(res, 400, "base URL is required for a new provider");
			const parsedApi = readApi(body.api);
			if (parsedApi.error) return send(res, 400, parsedApi.error);
			if (!parsedApi.value) return send(res, 400, "api is required for a new provider");
			const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
			providerEntry = providers[providerId.id] = {
				name: providerId.id,
				baseUrl: parsedUrl.value,
				api: parsedApi.value,
			};
			if (apiKey) providerEntry.apiKey = apiKey;
		}
		if (!Array.isArray(providerEntry.models)) providerEntry.models = [];
		// a new provider already carries the endpoint, so its first model inherits instead of repeating it
		const entryPatch: ModelPatch =
			isNewProvider ? { ...patch, baseUrl: undefined, api: undefined } : patch;
		providerEntry.models.push(modelEntryFromForm(modelId.id, entryPatch));
		let failure: string | null;
		try {
			failure = await saveCatalog(b, fileRoot, content, providerId.id);
		} catch (saveError) {
			return send(res, 409, saveError instanceof Error ? saveError.message : String(saveError));
		}
		if (failure) return send(res, 409, failure);
		broadcast(b, { type: "state_changed", sid: requestTarget(b, url.searchParams.get("sid"))?.sid ?? "host" });
		return send(res, 200, JSON.stringify({ provider: providerId.id, id: modelId.id }), "application/json");
	}

	// Update: a models entry in place, a modelOverrides entry for anything else.
	if (req.method === "POST" && path === "/api/models/update") {
		let body: Record<string, unknown>;
		try {
			body = await readJson(req);
		} catch {
			return send(res, 400, "bad JSON");
		}
		const providerId = readProviderId(body.provider);
		if (providerId.error) return send(res, 400, providerId.error);
		const modelId = readModelId(body.id);
		if (modelId.error) return send(res, 400, modelId.error);
		const { patch, error } = readModelPatch(body);
		if (error) return send(res, 400, error);
		if (Object.keys(patch).length === 0) return send(res, 400, "nothing to save");
		const { root, content, error: loadError } = await readModelsJson();
		if (loadError) return send(res, 409, loadError);
		const fileRoot = root ?? { providers: {} };
		const stored = findModelEntry(fileRoot, providerId.id, modelId.id).kind;
		if (stored !== "models" && (patch.baseUrl !== undefined || patch.api !== undefined)) {
			return send(
				res,
				400,
				`${providerId.id}/${modelId.id} is not defined in models.json - it takes its endpoint from the provider, so change the provider endpoint instead`,
			);
		}
		applyModelPatch(fileRoot, providerId.id, modelId.id, patch);
		let failure: string | null;
		try {
			failure = await saveCatalog(b, fileRoot, content, providerId.id);
		} catch (saveError) {
			return send(res, 409, saveError instanceof Error ? saveError.message : String(saveError));
		}
		if (failure) return send(res, 409, failure);
		broadcast(b, { type: "state_changed", sid: requestTarget(b, url.searchParams.get("sid"))?.sid ?? "host" });
		return send(res, 200, "ok");
	}

	// The provider entry: name, baseUrl, api, key, auth header, oauth, headers and compat are shared by
	// every model of that provider, so they are edited here - a models entry can only add its own
	// baseUrl/api on top. Writes are validated by composing the file, so a change that would break the
	// provider (for example an empty entry) is rolled back with the compose error.
	if (req.method === "POST" && path === "/api/models/provider") {
		let body: Record<string, unknown>;
		try {
			body = await readJson(req);
		} catch {
			return send(res, 400, "bad JSON");
		}
		const providerId = readProviderId(body.provider);
		if (providerId.error) return send(res, 400, providerId.error);
		const { root, content, error: loadError } = await readModelsJson();
		if (loadError) return send(res, 409, loadError);
		const providerEntry = root?.providers?.[providerId.id];
		if (!root || !providerEntry || typeof providerEntry !== "object") {
			return send(
				res,
				400,
				`${providerId.id} is registered outside models.json, so its endpoint cannot be edited here`,
			);
		}
		let changed = false;
		if (body.name !== undefined) {
			if (typeof body.name !== "string") return send(res, 400, "name must be a string");
			const name = body.name.trim();
			if (name.length > 200) return send(res, 400, "name is too long (200 characters max)");
			if (name) providerEntry.name = name;
			else delete providerEntry.name;
			changed = true;
		}
		if (body.baseUrl !== undefined) {
			const baseUrl = readBaseUrl(body.baseUrl);
			if (baseUrl.error) return send(res, 400, baseUrl.error);
			if (baseUrl.value) {
				providerEntry.baseUrl = baseUrl.value;
			} else {
				delete providerEntry.baseUrl;
			}
			changed = true;
		}
		if (body.api !== undefined) {
			const api = readApi(body.api);
			if (api.error) return send(res, 400, api.error);
			if (api.value) {
				providerEntry.api = api.value;
			} else {
				delete providerEntry.api;
			}
			changed = true;
		}
		if (body.authHeader !== undefined) {
			if (typeof body.authHeader !== "boolean") return send(res, 400, "authHeader must be a boolean");
			if (body.authHeader) providerEntry.authHeader = true;
			else delete providerEntry.authHeader;
			changed = true;
		}
		if (body.oauth !== undefined) {
			const oauth = typeof body.oauth === "string" ? body.oauth.trim() : "";
			if (oauth && oauth !== "radius") return send(res, 400, 'oauth must be "radius" or empty');
			if (oauth) providerEntry.oauth = oauth;
			else delete providerEntry.oauth;
			changed = true;
		}
		if (body.headers !== undefined) {
			const headers = readObject(body.headers, "headers");
			if (headers.error) return send(res, 400, headers.error);
			for (const [key, value] of Object.entries(headers.value ?? {})) {
				if (typeof value !== "string") return send(res, 400, `header ${key} must be a string`);
			}
			if (headers.value) providerEntry.headers = headers.value;
			else delete providerEntry.headers;
			changed = true;
		}
		if (body.compat !== undefined) {
			const compat = readObject(body.compat, "compat");
			if (compat.error) return send(res, 400, compat.error);
			if (compat.value) providerEntry.compat = compat.value;
			else delete providerEntry.compat;
			changed = true;
		}
		if (body.clearApiKey === true) {
			delete providerEntry.apiKey;
			changed = true;
		}
		if (typeof body.apiKey === "string" && body.apiKey.trim()) {
			// the key is written verbatim, exactly like a hand-written models.json entry
			providerEntry.apiKey = body.apiKey.trim();
			changed = true;
		}
		if (!changed) return send(res, 400, "nothing to save");
		let failure: string | null;
		try {
			failure = await saveCatalog(b, root, content, providerId.id);
		} catch (saveError) {
			return send(res, 409, saveError instanceof Error ? saveError.message : String(saveError));
		}
		if (failure) return send(res, 409, failure);
		broadcast(b, { type: "state_changed", sid: requestTarget(b, url.searchParams.get("sid"))?.sid ?? "host" });
		return send(res, 200, "ok");
	}

	// Delete: the models entry and the override, then the scaffolding the removal leaves empty.
	if (req.method === "POST" && path === "/api/models/delete") {
		let body: Record<string, unknown>;
		try {
			body = await readJson(req);
		} catch {
			return send(res, 400, "bad JSON");
		}
		const providerId = readProviderId(body.provider);
		if (providerId.error) return send(res, 400, providerId.error);
		const modelId = readModelId(body.id);
		if (modelId.error) return send(res, 400, modelId.error);
		const { root, content, error: loadError } = await readModelsJson();
		if (loadError) return send(res, 409, loadError);
		if (!root || !removeModel(root, providerId.id, modelId.id)) {
			return send(res, 404, `nothing in models.json for ${providerId.id}/${modelId.id}`);
		}
		pruneProvider(root, providerId.id);
		let failure: string | null;
		try {
			failure = await saveCatalog(b, root, content, providerId.id);
		} catch (saveError) {
			return send(res, 409, saveError instanceof Error ? saveError.message : String(saveError));
		}
		if (failure) return send(res, 409, failure);
		broadcast(b, { type: "state_changed", sid: requestTarget(b, url.searchParams.get("sid"))?.sid ?? "host" });
		return send(res, 200, "ok");
	}

	if (req.method === "POST" && path === "/api/thinking") {
		const body = await readJson(req);
		const level = typeof body.level === "string" ? body.level : "";
		if (!ALL_LEVELS.includes(level)) return send(res, 400, "unknown level");
		const target = requestTarget(b, body.sid ?? url.searchParams.get("sid"));
		if (!target) return send(res, 404, "unknown session");
		if (target.kind === "host") {
			b.api.setThinkingLevel(level as never);
		} else {
			const opened = await ensureWorkerSession(b, target.worker);
			if (!opened.ok) return send(res, 409, opened.message);
			opened.session.setThinkingLevel(level as never);
		}
		broadcast(b, { type: "state_changed", sid: target.sid });
		return send(res, 200, "ok");
	}

	if (req.method === "POST" && path === "/api/mode") {
		const body = await readJson(req, 1024);
		if (body.mode !== "work" && body.mode !== "chat") return send(res, 400, "mode must be work or chat");
		// The workspace belongs to the conversation, not to the process: open the other workspace's
		// session for this project instead of switching the terminal's runtime.
		const viewed = viewedTarget(b);
		const cwd = targetCwd(b, viewed);
		const sessionPath = await workspaceSessionPath(b, body.mode, cwd);
		const outcome = attachSession(b, sessionPath);
		if (!outcome.ok) return send(res, 409, outcome.message);
		b.workspaceFiles[workspaceKey(body.mode, cwd)] = sessionPath;
		broadcast(b, { type: "session_switch", sid: outcome.sid });
		return send(res, 200, JSON.stringify({ mode: body.mode, sid: outcome.sid, path: sessionPath }), "application/json");
	}

	/**
	 * Open a conversation in the page. The terminal's own session is opened in place; every other one
	 * gets its own background runtime, so this never stops a turn and never moves the terminal.
	 */
	if (req.method === "POST" && (path === "/api/attach" || path === "/api/resume")) {
		let body: Record<string, unknown>;
		try {
			body = await readJson(req);
		} catch {
			body = {};
		}
		const sessionPath = typeof body.path === "string" ? body.path : "";
		if (!sessionPath) return send(res, 400, "missing path");
		const outcome = attachSession(b, sessionPath);
		if (!outcome.ok) return send(res, 409, outcome.message);
		const target = targetOf(b, outcome.sid);
		broadcast(b, { type: "session_switch", sid: outcome.sid });
		return send(
			res,
			200,
			JSON.stringify({ sid: outcome.sid, path: sessionPath, mode: target ? targetWorkspace(b, target) : "work" }),
			"application/json",
		);
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
		// A background runtime holds the file it writes to: stop it before the file goes away.
		for (const target of targets) {
			const sid = b.workersByPath.get(pathKey(target));
			const worker = sid ? b.workers.get(sid) : undefined;
			if (!worker) continue;
			if (worker.running) {
				try {
					await worker.session?.abort();
				} catch {
					// the delete below reports whatever is left
				}
			}
			disposeWorker(b, worker);
		}
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
			// A background runtime writes through its own manager; anything else is read from disk.
			const sid = b.workersByPath.get(pathKey(target));
			const worker = sid ? b.workers.get(sid) : undefined;
			if (worker) {
				worker.manager.appendSessionInfo(name);
				broadcastStatus(b, worker);
			} else {
				SessionManager.open(target).appendSessionInfo(name);
			}
		}
		invalidateSessions(b);
		broadcast(b, { type: "sessions_changed" });
		return send(res, 200, "ok");
	}

	if (req.method === "POST" && path === "/api/new") {
		const body = await readJson(req, 16 * 1024);
		const viewed = viewedTarget(b);
		const mode: Workspace = body.mode === "chat" ? "chat" : body.mode === "work" ? "work" : targetWorkspace(b, viewed);
		const device = typeof body.host === "string" ? body.host.trim() : "";
		let cwd: string;
		let remoteDevice: string | undefined;
		if (device && mode === "work") {
			// On a device: the directory is checked there, not here, and the recorded cwd is the URL
			// that keeps the session remote when it is opened again.
			let host: RemoteHost;
			try {
				host = remoteConnection(b, device);
			} catch (error) {
				return send(res, 404, error instanceof Error ? error.message : `unknown device: ${device}`);
			}
			const asked = typeof body.path === "string" && body.path.trim() ? body.path.trim() : "~";
			try {
				cwd = await resolveRemoteDir(host, asked);
				remoteDevice = device;
			} catch (error) {
				return send(res, 400, error instanceof Error ? error.message : `could not use ${asked}`);
			}
		} else {
			cwd = projectPath(b, typeof body.cwd === "string" ? body.cwd : "");
			try {
				await mkdir(cwd, { recursive: true });
				if (!(await stat(cwd)).isDirectory()) return send(res, 400, "working directory is not a directory");
			} catch (error) {
				return send(res, 400, `could not use ${cwd}: ${error instanceof Error ? error.message : "not a directory"}`);
			}
		}
		// A new conversation runs in the page as its own runtime: the terminal keeps whatever it has.
		const outcome = await createAttachedSession(b, mode, cwd, remoteDevice);
		if (!outcome.ok) return send(res, 409, outcome.message);
		return send(
			res,
			200,
			JSON.stringify({ path: outcome.path, cwd, mode, device: remoteDevice, sid: outcome.sid }),
			"application/json",
		);
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
		const target = requestTarget(b, body.sid ?? url.searchParams.get("sid"));
		if (!target) return send(res, 404, "unknown session");
		// Only a prompt the transcript shows can be rerun: the entry has to be a user message on the
		// current branch, which is exactly what the page offers the button for.
		const found = contextMessages(targetManager(b, target)).find((message) => message.entryId === entryId);
		if (!found) return send(res, 404, "unknown entry");
		if (found.role !== "user") return send(res, 400, "only a prompt can be rerun");
		const outcome = await navigateTarget(b, target, entryId);
		if (!outcome.ok) return send(res, 409, outcome.message ?? "navigation failed");
		// every open tab is now reading a different branch
		broadcast(b, { type: "session_tree", sid: target.sid });
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
		const request = requestTarget(b, body.sid ?? url.searchParams.get("sid"));
		if (!request) return send(res, 404, "unknown session");
		if (targetRunning(b, request)) return send(res, 409, "stop the current turn first");
		const found = contextMessages(targetManager(b, request)).find((message) => message.entryId === entryId);
		if (!found) return send(res, 404, "unknown entry");
		if (found.role !== "user") return send(res, 400, "only a prompt can be retried");
		const outcome = await navigateTarget(b, request, entryId);
		if (!outcome.ok) return send(res, 409, outcome.message ?? "navigation failed");
		if (request.kind === "worker") {
			const opened = await ensureWorkerSession(b, request.worker);
			if (!opened.ok) return send(res, 409, opened.message);
			const content = found.content;
			const text = typeof content === "string" ? content : messageText(content);
			const images = typeof content === "string" ? [] : messageImages(content);
			const sent = await promptWorker(b, request.worker, text, images);
			if (!sent.ok) return send(res, 409, sent.message);
			broadcast(b, { type: "session_tree", sid: request.sid });
			return send(res, 200, "ok");
		}
		// Broadcast only once the prompt is in the session: a page that reloads the truncated branch
		// must find it there, or a tab that already received the `message_end` would either lose the
		// row or show it twice depending on which response landed first.
		const parent = b.ctx.sessionManager.getLeafId();
		try {
			// the recorded content, not a rebuilt string: images ride along untouched
			b.api.sendUserMessage(found.content as string | (TextBlock | ImageBlock)[]);
			await waitForLeafChange(b, parent, 2_000);
		} catch (error) {
			return send(res, 409, error instanceof Error ? error.message : "send failed");
		}
		broadcast(b, { type: "session_tree", sid: request.sid });
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
		workers: new Map(),
		workersByPath: new Map(),
		viewSid: "host",
		hostLive: null,
		hostRunning: false,
		hostDone: false,
		modelRuntime: undefined,
		remotes: new Map(),
		remoteProfiles: new Map(),
		remoteStatus: new Map(),
		// `b` is only read when a request arrives, after the literal is assigned
		handle: (req, res) => handle(b, req, res),
	};

	const sweep = setInterval(() => sweepWorkers(b), 5 * 60 * 1000);
	sweep.unref?.();

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
		if (event.reason !== "quit") return;
		killServices();
		const b = store.__nifeWebui;
		if (b) for (const worker of [...b.workers.values()]) disposeWorker(b, worker);
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
		// The terminal just moved onto a file a background runtime already writes: one runtime per
		// session file, so the terminal wins and the worker goes away instead of appending twice.
		if (file) {
			const sid = b.workersByPath.get(pathKey(file));
			const worker = sid ? b.workers.get(sid) : undefined;
			if (worker) disposeWorker(b, worker);
		}
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
		b.workers ??= new Map();
		b.workersByPath ??= new Map();
		b.viewSid ??= "host";
		b.hostLive ??= null;
		b.hostRunning ??= false;
		b.hostDone ??= false;
		invalidateSessions(b);
		b.legacyWorkDir ??= legacyWorkDirOf(ctx.sessionManager.getSessionDir());
		if (b.publicUrls.size) scheduleTunnel(b, TUNNEL_HEARTBEAT_MS);
		const workspace = currentWorkspace(b);
		if (file) b.workspaceFiles[workspaceKey(workspace, ctx.cwd)] = file;
		// Chat workspace sessions never declare tools. Work sessions get nife's defaults from the
		// fresh runtime created by switchSession/newSession.
		if (workspace === "chat") b.api.setActiveTools([]);
		broadcast(b, { type: "session_start", reason: event.reason, sid: "host", path: file ?? undefined });
		broadcast(b, { type: "mode_changed", mode: workspace, sid: "host" });
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
		const b = store.__nifeWebui;
		if (b && event.message.role === "assistant") b.hostLive = { text: "", thinking: "" };
		forward({ type: "message_start", message: event.message });
	});
	api.on("message_update", (event) => {
		// Send only the delta: event.message is cumulative and would grow O(n^2) on the wire.
		const b = store.__nifeWebui;
		const delta = event.assistantMessageEvent;
		if (b?.hostLive) {
			if (delta.type === "text_delta") b.hostLive.text += delta.delta;
			else if (delta.type === "thinking_delta") b.hostLive.thinking += delta.delta;
			else if (delta.type === "error") b.hostLive.text += `\n${delta.error?.errorMessage ?? "request failed"}`;
		}
		forward({ type: "message_update", delta });
	});
	api.on("message_end", (event) => {
		const b = store.__nifeWebui;
		if (b) b.hostLive = null;
		if (!isHiddenMessage(event.message)) forward({ type: "message_end", message: event.message });
		if (b) announceMessageEntry(b, event.message);
	});
	api.on("agent_start", () => {
		const b = store.__nifeWebui;
		if (b) {
			b.hostRunning = true;
			b.hostDone = false;
			hostStatus(b);
		}
		forward({ type: "agent_start" });
	});
	api.on("agent_settled", (event) => {
		// `aborted` matters to the page: an interrupted turn is a deliberate stop, and the UI queue
		// must hold the next task instead of starting it.
		forward({ type: "agent_settled", aborted: Boolean(event?.aborted) });
		// Name the conversation once, after the first completed turn. It is a separate model call,
		// never part of the session transcript.
		const b = store.__nifeWebui;
		if (b) {
			b.hostRunning = false;
			b.hostLive = null;
			b.hostDone = b.viewSid !== "host";
			hostStatus(b);
			void autoTitle(b);
		}
	});
	api.on("turn_end", () => {
		// One step (assistant message + its tool results) is committed: the footer can move now.
		const b = store.__nifeWebui;
		if (b) broadcastStats(b, { kind: "host", sid: "host" });
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
