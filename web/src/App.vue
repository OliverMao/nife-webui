<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, triggerRef, watch } from "vue";
import EffortSlider from "./EffortSlider.vue";
import LiveMessage from "./LiveMessage.vue";
import LiveThinking from "./LiveThinking.vue";
import MessageEdit from "./MessageEdit.vue";
import MessageItem from "./MessageItem.vue";
import { api, sessionFile, sessionSid, setSessionSid, uploadFile } from "./bridge.js";
import { previewImage } from "./images.js";
import FileIcon from "./FileIcon.vue";
import { formatBytes } from "./files.js";
import { INLINE_MAX_CHARS, INLINE_TOTAL_CHARS, inlineTextOf } from "./inline.js";
import { blocksOf } from "./message-utils.js";
import {
	IMAGE_MAX_COUNT,
	asImageFile,
	expandPastes,
	imageFiles,
	imageFromLink,
	imageLinkOf,
	imageProblem,
	pasteMarker,
	readClipboard,
} from "./paste.js";
import { metaOf, previewOf, promptTextOf, queueProblem } from "./queue.js";
import { groupItems, isProcessBlock, stepLabel } from "./transcript.js";


// Committed messages live in a shallowRef: objects are plain (not deep-proxied) and the list is
// only invalidated on message boundaries, never per streaming token.
const messages = shallowRef([]);
// Index of messages[0] in the session's full context: the page loads a tail slice, so this is the
// cursor for the previous one, and 0 means the whole history is loaded.
const loadedFrom = ref(0);
const live = ref(null); // { text, thinking } for the message currently streaming
const streaming = ref(false);
const online = ref(true);
const state = ref({ name: "", sessionId: "", cwd: "", model: null, thinkingLevel: "" });
const text = ref("");
const dialog = ref(null);
const dialogText = ref("");
const transcript = ref(null);
const transcriptBody = ref(null);
let resizeObserver;
const inputEl = ref(null);
const composerBox = ref(null);
const sidebarOpen = ref(false);
const collapsed = ref(localStorage.getItem("nife-webui.collapsed") === "1");
// Conversation mode: Work declares the coding tools; Chat declares none and uses nife's chat prompt.
const mode = ref("work");
const modeMenu = ref(false);
const isChat = computed(() => mode.value === "chat");
// Conversation search: a centred palette over the page, backed by the bridge's full-text scan.
const searchOpen = ref(false);
const searchQuery = ref("");
const searchInput = ref(null);
const searchResults = ref([]);
const searchBusy = ref(false);
const searchError = ref("");
let searchTimer = 0;
let searchAbort;
const narrow = ref(false);
// Sidebar metadata is lazy: groups arrive first, transcripts only when a project is expanded.
const groups = ref([]);
const sessionsByProject = ref({});
const sessions = computed(() => Object.values(sessionsByProject.value).flat());
const expandedProjects = ref([]);
const loadingProjects = ref([]);
const groupsMode = ref("");
const currentFile = ref("");
// The footer button publishes this page through nifetun and comes back with the public URL; from the
// public page the same button tears the tunnel down and reloads the local URL. The local origin is
// the only place a disconnect can be requested, because the request cannot survive the tunnel it kills.
const localHost = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(location.hostname);
const connecting = ref(false);
const tunnelMenu = ref(false);
const tunnelPending = computed(() => Boolean(state.value.tunnel?.pending) || connecting.value);
const pageTunnel = computed(() => Boolean(state.value.tunnel?.url));
const tunnelTitle = computed(() => {
	if (tunnelPending.value) return "nifetun: waiting for the approval mail";
	return pageTunnel.value ? "Tunnels (this page is public)" : "Tunnels";
});
/** What the "this page" row does, in one word. */
const pageAction = computed(() => {
	if (tunnelPending.value) return "waiting…";
	if (!pageTunnel.value) return "publish";
	return localHost ? "open" : "disconnect";
});

// The bridge builds the list (it owns the port numbers and drops its own port there), so the page
// only splits it: what the session serves, and what the reader typed in.
const portRows = computed(() => state.value.ports ?? []);
const serverRows = computed(() => portRows.value.filter((row) => row.kind === "server"));
const customRows = computed(() => portRows.value.filter((row) => row.kind === "custom"));
const serviceBusy = ref(0);
const knownServices = new Set();
/** The first load only fills the set: ports that were already there are not news. */
let servicesReady = false;

/** A new port is worth one line, not a dialog: the chip in the footer is the invitation. */
function noteServices(list) {
	const ports = (list ?? []).filter((service) => !knownServices.has(service.port));
	for (const service of ports) knownServices.add(service.port);
	if (!servicesReady) return;
	for (const service of ports) {
		const label = service.cmd ? `${service.cmd} on 127.0.0.1:${service.port}` : `127.0.0.1:${service.port}`;
		showNotice(`nife started ${label} — publish it from the sidebar`);
	}
}

/** Ask nifetun for one more port; the chip turns into a link to the public URL. */
async function publishService(service) {
	if (serviceBusy.value) return;
	serviceBusy.value = service.port;
	try {
		const response = await fetch(api("tunnel"), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ action: "up", port: service.port }),
		});
		if (!response.ok) {
			showNotice((await response.text()).slice(0, 200) || "could not publish");
			return;
		}
		const { tunnel, ports } = await response.json();
		state.value.tunnel = tunnel;
		state.value.ports = ports;
		const url = ports?.find((row) => row.port === service.port)?.url ?? "";
		if (url) showNotice(`127.0.0.1:${service.port} -> ${url}`);
		else if (tunnel?.pending) showNotice("waiting for the approval mail");
	} catch {
		showNotice("could not publish");
	} finally {
		serviceBusy.value = 0;
	}
}

// A port nobody detected: the agent may have started a server in a way the tree walk misses, or the
// port is not listening yet. Typing it in the menu is the same `up` call the rows make.
const manualValue = ref("");
const manualBusy = ref(false);

async function publishManual() {
	const text = manualValue.value.trim();
	if (!text || manualBusy.value) return;
	// `3000`, `127.0.0.1:3000` and `localhost:3000` all mean the same tunnel; anything else is refused
	const match = /^(?:(127\.0\.0\.1|localhost):)?(\d{1,5})$/.exec(text);
	const port = match ? Number(match[2]) : 0;
	if (!port || port > 65535) {
		showNotice("port or 127.0.0.1:port, e.g. 3000");
		return;
	}
	manualBusy.value = true;
	try {
		const response = await fetch(api("tunnel"), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ action: "up", port }),
		});
		if (!response.ok) {
			showNotice((await response.text()).slice(0, 200) || "could not publish");
			return;
		}
		const { tunnel, ports } = await response.json();
		state.value.tunnel = tunnel;
		state.value.ports = ports;
		manualValue.value = "";
		const url = ports?.find((row) => row.port === port)?.url ?? "";
		if (url) showNotice(`127.0.0.1:${port} -> ${url}`);
		else if (tunnel?.pending) showNotice("waiting for the approval mail");
	} catch {
		showNotice("could not publish");
	} finally {
		manualBusy.value = false;
	}
}

/** Unpublish one service: the tunnel is asked for this port only, so the page keeps its own. */
async function unpublishService(service) {
	if (serviceBusy.value) return;
	serviceBusy.value = service.port;
	try {
		const response = await fetch(api("tunnel"), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ action: "down", port: service.port }),
		});
		if (!response.ok) {
			showNotice((await response.text()).slice(0, 200) || "could not unpublish");
		} else {
			const payload = await response.json();
			state.value.tunnel = payload.tunnel;
			state.value.ports = payload.ports;
		}
	} catch {
		showNotice("could not unpublish");
	} finally {
		serviceBusy.value = 0;
	}
}

async function toggleTunnel() {
	const tunnel = state.value.tunnel;
	if (tunnel?.url) {
		if (localHost) {
			location.href = tunnel.url;
			return;
		}
		// Ask for the teardown from here (keepalive survives the navigation), then hop home: the
		// response cannot come back through the tunnel we are killing, and the local page repeats the
		// request with `tunnel=off` in case this one never made it out.
		tunnelMenu.value = false;
		void fetch(api("tunnel"), {
			method: "POST",
			keepalive: true,
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ action: "down" }),
		}).catch(() => {});
		location.href = `${tunnel.localUrl}&tunnel=off`;
		return;
	}
	if (tunnelPending.value) return;
	connecting.value = true;
	try {
		const response = await fetch(api("tunnel"), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ action: "up" }),
		});
		if (!response.ok) {
			showNotice((await response.text()).slice(0, 200) || "could not publish");
			connecting.value = false;
			return;
		}
		const { tunnel: next } = await response.json();
		if (next?.url) {
			location.href = next.url;
			return;
		}
		// no URL yet: the approval mail is out, and the state watch reloads once it is clicked
		showNotice("waiting for the approval mail");
	} catch {
		showNotice("could not publish");
		connecting.value = false;
	}
}

// Approved while the page was waiting: follow the URL as soon as the bridge reports it.
watch(
	() => state.value.tunnel?.url,
	(url) => {
		if (url && connecting.value) location.href = url;
	},
);

/** Back from the public page with "tunnel=off": tearing it down has to happen from here. */
async function finishTunnelDisconnect() {
	const params = new URLSearchParams(location.search);
	if (params.get("tunnel") !== "off") return;
	params.delete("tunnel");
	const query = params.toString();
	history.replaceState(null, "", `${location.pathname}${query ? `?${query}` : ""}`);
	await postDetailed("tunnel", { action: "down" });
	await loadState();
}
// Session row with its three-dot menu open: { session, top, left }.
const sessionMenu = ref(null);
// New session: the project choice lives in the composer instead of a modal, because it is part of
// the prompt the user is about to type. `freshSession` marks the empty session the page just made,
// so the chip disappears with the first message - nife fixes a session's cwd at that point.
const freshSession = ref(false);
const workspaceMenu = ref(false);
const newCwd = ref("");
const newBusy = ref(false);
const newError = ref("");
const newInput = ref(null);
// Directory browser in the picker: the folder on screen, its children, and the home shortcut.
const browseDir = ref("");
const browseParent = ref(null);
const browseHome = ref("");
const browseDirs = ref([]);
const browseBusy = ref(false);
const browseError = ref("");
const projectRoot = ref("");
const projectDirs = ref([]);
// Sessions waiting for delete confirmation in the centred modal.
const deleteQueue = ref([]);
// When the queue came from a project header, say so and leave the directory itself alone.
const deleteWorkspace = ref(null);
const deleting = ref(false);
// Inline rename: path of the row being edited, its draft, and the input to focus.
const renaming = ref("");
const renameText = ref("");
const renameEl = ref(null);
// Pinned sessions live in localStorage, shared by every project in the workspace.
const pinnedPaths = ref([]);
// Multi-select: rows become checkboxes and the sidebar footer turns into its action bar.
const selecting = ref(false);
const selectedPaths = ref([]);
// Manual context compaction in flight (the bridge also reports automatic ones).
const compacting = ref(false);
// UI task queue: sent one at a time, only after the previous turn settled. Paused on session
// switches and on Stop, because those are deliberate interruptions.
const queue = ref([]);
const queuePaused = ref(false);
let queueSeq = 0;
const draining = ref(false);
// Set between a successful POST and the agent_start/agent_settled that follows it, so a second
// send cannot slip out while the just-started turn is not visible as streaming yet.
let turnPending = false;
const menu = ref(null);
const modelQuery = ref("");
const thinkingDraft = ref(null);
// The model manager: the catalog as rows, with create/edit/delete backed by models.json.
const modelManager = ref(null); // { models, providers, path, writable, warning }
const modelManagerBusy = ref(false);
const modelManagerError = ref("");
const modelFilter = ref("");
const modelForm = ref(null); // create/edit view over one row
const modelFormError = ref("");
const modelDelete = ref(null); // row waiting for the inline delete confirmation
const subagents = ref([]);
const notice = ref("");
const noticeStyle = ref({});
// the bubble animation and the timer that unmounts it share one duration
const NOTICE_MS = 3000;
let noticeTimer;

/**
 * Bubble that surfaces from the middle of the composer box: measure the box so the rise starts
 * where the user is looking and ends above it, whatever the current composer height is.
 */
function showNotice(message) {
	notice.value = message;
	const rect = composerBox.value?.getBoundingClientRect();
	noticeStyle.value = rect
		? {
				// horizontally and vertically centred on the input box itself, not the viewport
				left: `${Math.round(rect.left + rect.width / 2)}px`,
				bottom: `${Math.round(window.innerHeight - (rect.top + rect.height / 2))}px`,
				"--rise": `-${Math.round(rect.height / 2 + 22)}px`,
			}
		: {};
	clearTimeout(noticeTimer);
	noticeTimer = setTimeout(() => (notice.value = ""), NOTICE_MS);
}


let source;
let frame = 0;
let pendingText = "";
let pendingThinking = "";

/** Pairs every tool call with its result once per message boundary, not per token. */
const items = computed(() => {
	const results = new Map();
	for (const message of messages.value) {
		if (message.role === "toolResult" && message.toolCallId) results.set(message.toolCallId, message);
	}
	const list = [];
	const used = new Set();
	for (let position = 0; position < messages.value.length; position += 1) {
		const message = messages.value[position];
		// absolute index in the session context: with paging, messages[0] is not message 0
		const index = loadedFrom.value + position;
		if (message.role === "toolResult") continue;
		if (message.role === "assistant") {
			const own = {};
			for (const block of blocksOf(message)) {
				if (block?.type === "toolCall" && results.has(block.id)) {
					own[block.id] = results.get(block.id);
					used.add(block.id);
				}
			}
			const blocks = blocksOf(message);
			const answer = blocks.some((block) => (block?.type === "text" && block.text?.trim()) || block?.type === "image");
			if (answer && blocks.some(isProcessBlock)) {
				// A message that reasons and then answers: the reasoning belongs to the run above it, so
				// the transcript reads "Worked · 2 tools · 2 thoughts" followed by the answer, instead
				// of leaving one more "Thought" outside the fold.
				list.push({
					kind: "assistant",
					part: "work",
					message: { ...message, content: blocks.filter(isProcessBlock) },
					results: own,
					index,
				});
				list.push({
					kind: "assistant",
					part: "answer",
					message: { ...message, content: blocks.filter((block) => !isProcessBlock(block)) },
					results: own,
					index,
				});
			} else {
				list.push({ kind: "assistant", message, results: own, index });
			}
		} else if (message.role === "user") {
			list.push({ kind: "user", message, results: {}, index });
		} else if (message.role === "bashExecution") {
			list.push({ kind: "bash", message, results: {}, index });
		} else {
			// custom / branchSummary / compactionSummary
			list.push({ kind: "notice", message, results: {}, index });
		}
	}
	for (let position = 0; position < messages.value.length; position += 1) {
		const message = messages.value[position];
		if (message.role === "toolResult" && !used.has(message.toolCallId)) {
			list.push({ kind: "result", message, results: {}, index: loadedFrom.value + position });
		}
	}
	return list;
});

// Thinking and tool calls between answers collapse into one row: the transcript shows the answers,
// and the how-it-got-there stays one click away.
const rows = computed(() => groupItems(items.value));

/**
 * The newest answer of the branch. Retry rewrites the conversation from there, so it is offered on
 * that row alone - an older answer is reached by editing its prompt (or `/tree`) instead.
 */
const lastAnswerIndex = computed(() => {
	let index = -1;
	for (const item of items.value) {
		if (item.kind !== "assistant") continue;
		const answered = item.message.errorMessage || blocksOf(item.message).some((block) => block?.type === "text" && block.text?.trim());
		if (answered) index = Math.max(index, item.index);
	}
	return index;
});

/**
 * Windowing. Mounting every message of a long session costs the browser its layout budget, and the
 * scroll then crawls. Only the tail is rendered: older rows leave the DOM while their exact height
 * moves into a spacer above, so nothing shifts visually. Scrolling up renders WIN_STEP more rows at
 * a time, and the rail on the right jumps task by task instead of dragging a scrollbar thumb.
 */
const WIN_MAX = 60;
const WIN_STEP = 24;
// nothing above the window has been measured yet, so the first open guesses. Every mounted page
// then feeds its measured height back in, so the spacer tracks the real rows instead of drifting
// tens of thousands of pixels away from them on a session full of tool output.
const WIN_ESTIMATE = 88;
const rowHeight = ref(WIN_ESTIMATE);
function learnRowHeight(measured, count) {
	if (!(measured > 0) || count <= 0) return;
	const sample = Math.min(600, Math.max(16, measured / count));
	rowHeight.value = rowHeight.value * 0.5 + sample * 0.5;
}
const runStart = ref(0);
// End of the window. Infinity means "down to the newest row", which is the normal tail view; jumping
// back into history makes it finite so the thousands of rows below the jump target stay unmounted.
const runEnd = ref(Number.POSITIVE_INFINITY);
const padPx = ref(0);
// message index at the top of the viewport, for the highlighted mark; message indices do not move
// when an older page is prepended, row indices do
const topMessage = ref(0);
// true while the view follows the newest message; declared here because the rail's active dot
// depends on it (at the bottom the newest task is the one being read)
const stick = ref(true);
const visibleRows = computed(() => rows.value.slice(runStart.value, runEnd.value));
// the spacer below a parked window: rows after runEnd are not rendered, only their estimated height
const tailPad = computed(() =>
	runEnd.value === Number.POSITIVE_INFINITY ? 0 : Math.max(0, rows.value.length - runEnd.value) * rowHeight.value,
);
// Every task in the session comes from the bridge, so the rail is complete even though only one
// page of messages is loaded: the rail is a map of the whole session, one dot per prompt.
const tasks = computed(() => state.value.tasks ?? []);
const railMarks = computed(() => tasks.value);
// The rail is a window, not the whole list: a long session has hundreds of prompts, and a column
// that tall is unusable. Dots scroll inside it and the arrow buttons page it.
const railList = ref(null);
const railOverflow = ref(false);

function updateRailOverflow() {
	const el = railList.value;
	railOverflow.value = !!el && el.scrollHeight > el.clientHeight + 2;
}

function scrollRail(direction) {
	const el = railList.value;
	if (!el) return;
	const page = Math.max(90, Math.round(el.clientHeight * 0.8));
	el.scrollBy({ top: direction * page, behavior: "smooth" });
}

/** Hover/focus preview for a rail dot: the first line of that prompt, next to the dot. */
const railTip = ref(null);

function showRailTip(event, task) {
	const rect = event.currentTarget.getBoundingClientRect();
	const top = Math.min(Math.max(rect.top + rect.height / 2, 56), window.innerHeight - 56);
	railTip.value = { text: task.label, top };
}

function hideRailTip() {
	railTip.value = null;
}

/** Keeps the dot of the task being read inside the rail window. */
function revealActiveTask() {
	const el = railList.value;
	if (!el) return;
	const dot = el.querySelector(".rail-dot.active");
	if (!(dot instanceof HTMLElement)) return;
	const view = el.getBoundingClientRect();
	const rect = dot.getBoundingClientRect();
	if (rect.top < view.top) el.scrollTop -= view.top - rect.top + 8;
	else if (rect.bottom > view.bottom) el.scrollTop += rect.bottom - view.bottom + 8;
}

const activeTaskIndex = computed(() => {
	const list = tasks.value;
	if (list.length === 0) return -1;
	// Following the tail means the newest message is on screen, not the one at the top of the window:
	// opening the page marks the last task, and scrolling up hands the mark back to the viewport.
	if (stick.value) return list[list.length - 1].index;
	let index = -1;
	for (const task of list) {
		if (task.index > topMessage.value) break;
		index = task.index;
	}
	return index;
});

watch(activeTaskIndex, () => nextTick(revealActiveTask));
// a session switch replaces the whole list: remeasure the window and bring the active dot into it
watch(railMarks, () =>
	nextTick(() => {
		updateRailOverflow();
		revealActiveTask();
	}),
);

// row index for the message a task starts at, so a rail click can land on the row
const rowByMessage = computed(() => {
	const map = new Map();
	rows.value.forEach((row, index) => {
		const first = row.kind === "process" ? row.steps[0] : row;
		if (typeof first?.index === "number") map.set(first.index, index);
	});
	return map;
});

/**
 * Stable identity for a row. `runStart + index` changes on every expansion, and a changed key makes
 * Vue tear the row down and rebuild it - the whole window would remount (and reload its images) on
 * each page of history, which is the flicker that looked like missing content.
 */
const rowKey = (row) => {
	const first = row.kind === "process" ? row.steps[0] : row;
	const index = typeof first?.index === "number" ? first.index : -1;
	// a message split into work + answer shares its index, so the part is part of the identity
	return `${row.kind}:${index}:${first?.part ?? ""}`;
};

/**
 * The live turn carries its own "Working" row (see LiveMessage), so a committed row only shows the
 * indicator in the gap between messages: a tool runs with no assistant message in flight, and the
 * next streaming row has not appeared yet.
 */
const workingRowKey = computed(() => {
	if (!streaming.value || live.value?.thinking || live.value?.text) return "";
	const last = visibleRows.value[visibleRows.value.length - 1];
	return last?.kind === "process" ? rowKey(last) : "";
});

/**
 * Where the streaming reasoning goes. When the transcript already ends in a collapsed run, that row
 * hosts it: the reasoning grows inside the row it will commit into, instead of stacking a second
 * "Working" row under it and merging the two on commit. A parked window keeps its own rows, so the
 * live body is only ever injected at the tail.
 */
const liveRowKey = computed(() => {
	if (!streaming.value || !live.value?.thinking || runEnd.value !== Number.POSITIVE_INFINITY) return "";
	const last = visibleRows.value[visibleRows.value.length - 1];
	return last?.kind === "process" ? rowKey(last) : "";
});
const liveHosted = computed(() => liveRowKey.value !== "");
// reading live.text in the template would re-render the whole row list on every token, so the
// condition that only needs "has the answer started" is a computed that turns into a boolean
const liveHasText = computed(() => Boolean(live.value?.text));

/**
 * A turn is in flight and nothing has arrived yet - the prompt is uploaded, the agent is starting,
 * or the model is prefilling/padding before its first token. That gap can be seconds long and used
 * to look like the page had ignored the send: show the same "Working" line the run will occupy, so
 * it turns into the real row instead of appearing from nowhere.
 */
const waitingForModel = computed(() => {
	if (!streaming.value && !turnPending) return false;
	// anything the run itself is already showing takes over: the answer, its reasoning, or a
	// trailing run whose label is already "Working"
	if (liveHasText.value || Boolean(live.value?.thinking)) return false;
	if (workingRowKey.value || liveRowKey.value) return false;
	return true;
});

// Which committed rows the reader has open. Bound back onto <details> so a row that the live turn
// was expanded into can be handed over still open: a body that collapses in the same frame the
// message lands makes the page jump by its whole height.
const openRows = ref(new Set());
function setRowOpen(key, open) {
	const next = new Set(openRows.value);
	if (open) next.add(key);
	else next.delete(key);
	openRows.value = next;
}

/*
 * The reasoning inside a collapsed row is not in the first page (a session full of tool output would
 * ship megabytes of text nobody has asked to see). Opening the row fetches just those messages and
 * merges them back in place: the row keeps its key, its open state and its place in the scroll.
 */
const stepsLoaded = reactive(new Set());
const stepsLoading = reactive(new Set());
const stepsFailed = reactive(new Set());

/** Has this row's payload been stripped? A committed row from the live stream already has it all. */
const rowTrimmed = (row) =>
	row.kind === "process" &&
	row.steps.some(
		(step) => step.message?.trimmed || Object.values(step.results ?? {}).some((result) => result?.trimmed),
	);

async function ensureSteps(row) {
	const key = rowKey(row);
	if (!rowTrimmed(row) || stepsLoaded.has(key) || stepsLoading.has(key)) return;
	stepsLoading.add(key);
	stepsFailed.delete(key);
	const first = row.steps[0]?.index ?? 0;
	const last = row.steps[row.steps.length - 1]?.index ?? first;
	try {
		const response = await fetch(api(`steps?from=${first}&to=${last}`));
		if (!response.ok) throw new Error(`steps ${response.status}`);
		mergeSteps(await response.json());
		stepsLoaded.add(key);
	} catch {
		stepsFailed.add(key);
	} finally {
		stepsLoading.delete(key);
	}
}

/** Replace the trimmed messages with the real ones, by absolute index. */
function mergeSteps(page) {
	const byIndex = new Map((page.messages ?? []).map((message, offset) => [page.from + offset, message]));
	let changed = false;
	for (let position = 0; position < messages.value.length; position += 1) {
		const full = byIndex.get(loadedFrom.value + position);
		if (!full) continue;
		messages.value[position] = full;
		changed = true;
	}
	if (changed) triggerRef(messages);
}

function onRowToggle(row, event) {
	const open = Boolean(event.target?.open);
	setRowOpen(rowKey(row), open);
	if (open) void ensureSteps(row);
}

/** `toggle` is not delivered everywhere (headless browsers skip it), so opening is read here too. */
function onRowClick(row, event) {
	if (!event.target?.closest?.("summary")) return;
	// currentTarget is gone by the time the tick runs; the element itself is not
	const details = event.currentTarget;
	nextTick(() => {
		if (!details?.open) return;
		setRowOpen(rowKey(row), true);
		void ensureSteps(row);
	});
}

/** Carry the live row's expanded state over to the committed row it just became. */
function claimLiveRow() {
	if (!transcriptBody.value?.querySelector(".msg.live .process[open]")) return;
	const target = rows.value.filter((row) => row.kind === "process").at(-1);
	if (!target) return;
	const next = new Set(openRows.value);
	next.add(rowKey(target));
	openRows.value = next;
}

/** True while a row is the one producing output: the row hosting the live turn, or the last run. */
const rowWorking = (row) => {
	const key = rowKey(row);
	return key === workingRowKey.value || key === liveRowKey.value;
};

const messageOfRow = (index) => {
	const row = rows.value[index];
	const first = row?.kind === "process" ? row.steps[0] : row;
	return typeof first?.index === "number" ? first.index : -1;
};

const rowOf = (index) => transcriptBody.value?.querySelector(`[data-row="${index}"]`) ?? null;
const topOf = (el) => el.getBoundingClientRect().top;

/** The row the reader is looking at: the first one whose bottom is below the viewport top. */
function firstVisible() {
	const el = transcript.value;
	if (!el) return null;
	const limit = topOf(el);
	for (const node of transcriptBody.value?.querySelectorAll("[data-row]") ?? []) {
		const rect = node.getBoundingClientRect();
		if (rect.bottom > limit + 1) {
			const index = Number(node.dataset.row);
			return { index, message: messageOfRow(index), top: rect.top };
		}
	}
	return null;
}

/** Opens the window on the tail of a freshly loaded session. */
function openWindow() {
	const count = rows.value.length;
	runStart.value = Math.max(0, count - WIN_MAX);
	runEnd.value = Number.POSITIVE_INFINITY;
	padPx.value = runStart.value * rowHeight.value;
	topMessage.value = messageOfRow(runStart.value);
}

/**
 * Settled rows leave the DOM and their height moves into the spacer above. Only rows that are
 * already out of sight go: the spacer keeps everything below them exactly where it was, so this is
 * invisible whether the reader sits at the bottom or somewhere in the middle of the history.
 */
function trimWindow() {
	const limit = firstVisible()?.index ?? runStart.value;
	const excess = Math.min(rows.value.length - runStart.value - WIN_MAX, limit - runStart.value);
	if (excess <= 0) return;
	const anchor = rowOf(runStart.value);
	const dropped = rowOf(runStart.value + excess);
	// measured before the update, so the spacer takes exactly the height that leaves the flow
	if (!anchor || !dropped) return;
	const measured = topOf(dropped) - topOf(anchor);
	if (measured > 0) learnRowHeight(measured, excess);
	padPx.value += measured;
	runStart.value += excess;
}

// A long turn keeps appending while the reader is somewhere in the history: follow() is parked in
// that case, so the window would grow back to the whole session without this.
watch(
	() => rows.value.length,
	() => {
		if (!stick.value) trimWindow();
	},
);

let loadingOlder = false;
const hasOlder = computed(() => loadedFrom.value > 0);

/**
 * Pulls the previous page of messages. Every row index has to shift by the number of rows that
 * arrived, and the spacer takes their estimated height: the page lands above the window, so what is
 * on screen does not move.
 */
async function loadOlder() {
	if (loadingOlder || loadedFrom.value === 0) return 0;
	loadingOlder = true;
	try {
		const response = await fetch(api(`messages?before=${loadedFrom.value}`));
		if (!response.ok) return 0;
		const page = await response.json();
		const older = page.messages ?? [];
		const before = rows.value.length;
		messages.value = [...older, ...messages.value];
		loadedFrom.value = page.from ?? 0;
		const added = rows.value.length - before;
		if (added === 0) return 0;
		const grow = added * rowHeight.value;
		runStart.value += added;
		if (runEnd.value !== Number.POSITIVE_INFINITY) runEnd.value += added;
		padPx.value += grow;
		await nextTick();
		// the page lands above the window as a spacer, so the scroll offset has to grow by the same
		// amount: otherwise the rows on screen are pushed down by the new spacer and the reader sees
		// the empty part of it
		const el = transcript.value;
		if (el) {
			writeScrollTop(el, el.scrollTop + grow);
			lastScrollTop = el.scrollTop;
		}
		return added;
	} finally {
		loadingOlder = false;
	}
}

let expanding = false;
const PAD_MARGIN = 600;

/**
 * True while the spacer above the window is in view, or close enough to it that one more scroll
 * would expose it. The lower bound matters as much as the upper one: once the spacer is far above
 * the viewport the reader is inside the rendered rows, and expanding there would mount the whole
 * history on every scroll event.
 */
function padVisible() {
	const el = transcript.value;
	if (!el || runStart.value === 0) return false;
	// how much spacer still sits below the top of the viewport: 0 = the window starts right there
	const behind = padPx.value - el.scrollTop;
	return behind > -PAD_MARGIN && behind < el.clientHeight + PAD_MARGIN;
}

/** True while the unrendered rows below a parked window reach into the viewport. */
function tailPadVisible() {
	const el = transcript.value;
	const body = transcriptBody.value;
	if (!el || !body || runEnd.value === Number.POSITIVE_INFINITY) return false;
	const bottom = body.getBoundingClientRect().bottom - el.getBoundingClientRect().top + el.scrollTop;
	return bottom - (el.scrollTop + el.clientHeight) < PAD_MARGIN;
}

/**
 * Nothing is above the window any more, so the spacer has to go: the estimate it accumulated while
 * rows were unrendered would otherwise show as a gap above the first row. The scroll offset gives
 * the same height back, so the reader keeps looking at the same row.
 */
function settlePad() {
	const el = transcript.value;
	if (runStart.value !== 0 || padPx.value <= 0) return;
	const leftover = padPx.value;
	padPx.value = 0;
	if (el) {
		writeScrollTop(el, Math.max(0, el.scrollTop - leftover));
		lastScrollTop = el.scrollTop;
	}
}

/**
 * Reveals older rows on scroll-up and keeps the row under the cursor exactly where it was.
 *
 * The spacer is an estimate, so it can be taller than the rows it stands for and a reader who
 * scrolls fast can reach it before a single scroll event mounts rows: that is the gap that looked
 * empty. Each pass mounts a page and gives its measured height back to the spacer, and the loop
 * repeats while the spacer is still in view, so the viewport never sits on top of it.
 */
async function expandWindow() {
	if (expanding) return;
	// the window is sitting on the oldest loaded row: the history above it has to arrive first
	if (runStart.value === 0) {
		settlePad();
		if (!hasOlder.value) return;
		if ((await loadOlder()) === 0) return;
	}
	expanding = true;
	try {
		const el = transcript.value;
		if (el) {
			// A drag can drop the reader in the middle of the spacer, so the page that has to be
			// mounted is sized from the gap, not from a fixed step: one pass then covers the screen.
			for (let pass = 0; pass < 3; pass += 1) {
				const behind = padPx.value - el.scrollTop;
				if (behind < -PAD_MARGIN) break;
				const need = behind > 0 ? Math.ceil(behind / rowHeight.value) + WIN_STEP : WIN_STEP;
				const step = Math.min(need, WIN_MAX * 3);
				const anchor = firstVisible();
				const before = runStart.value;
				runStart.value = Math.max(0, before - step);
				const mounted = before - runStart.value;
				if (mounted === 0) break;
				await nextTick();
				const after = anchor && rowOf(anchor.index);
				if (!after || !anchor) break;
				// the rows that entered the window now hold real height: the spacer gives it back,
				// which returns the anchor row to its old position without touching scrollTop
				const delta = topOf(after) - anchor.top;
				learnRowHeight(delta, mounted);
				const taken = Math.min(padPx.value, delta);
				padPx.value -= taken;
				const deficit = delta - taken;
				if (deficit > 0) {
					// the rows were taller than the spacer standing in for them: scroll down by the
					// rest instead of clamping the spacer to 0, which would delete the space above
					// the window and make the browser clamp the scroll position to the new bottom
					writeScrollTop(el, el.scrollTop + deficit);
					lastScrollTop = el.scrollTop;
				}
			}
		}
		settlePad();
	} finally {
		expanding = false;
	}
}

let extending = false;
/** Scrolling down inside a parked window renders the next page of rows below, until the tail is real. */
async function extendWindow() {
	if (extending || runEnd.value === Number.POSITIVE_INFINITY) return;
	extending = true;
	try {
		for (let pass = 0; pass < 4; pass += 1) {
			const end = Math.min(rows.value.length, runEnd.value + WIN_STEP);
			if (end <= runEnd.value) break;
			// nothing above runEnd moves: the tail spacer just gives up the rows that become real
			runEnd.value = end >= rows.value.length ? Number.POSITIVE_INFINITY : end;
			await nextTick();
			trimWindow();
			if (!tailPadVisible()) break;
		}
	} finally {
		extending = false;
	}
}

/**
 * Rail click. The task may sit in a page that is not loaded yet, so pull pages until it is; then
 * park the window around its row, so a jump into ancient history does not mount every row below it,
 * and align it with the viewport top.
 */
async function jumpToTask(task) {
	let row = rowByMessage.value.get(task.index);
	if (row === undefined) {
		// the rail knows every prompt, the transcript only knows the loaded ones
		for (let guard = 0; loadedFrom.value > task.index && guard < 40; guard += 1) {
			if ((await loadOlder()) === 0) break;
		}
		row = rowByMessage.value.get(task.index);
	}
	if (row !== undefined) await jumpToRow(row);
}

async function jumpToRow(target) {
	const el = transcript.value;
	if (!el) return;
	const windowEnd = Math.min(runEnd.value, rows.value.length);
	if (target < runStart.value || target >= windowEnd - 2) {
		runStart.value = Math.max(0, target - 4);
		const end = Math.min(rows.value.length, target + WIN_STEP + 8);
		runEnd.value = end >= rows.value.length ? Number.POSITIVE_INFINITY : end;
		padPx.value = runStart.value * rowHeight.value;
		await nextTick();
	}
	const node = rowOf(target);
	if (!node) return;
	writeScrollTop(el, el.scrollTop + (topOf(node) - topOf(el)));
	lastScrollTop = el.scrollTop;
	topMessage.value = messageOfRow(target);
	stick.value = nearBottom();
}

const modelLabel = computed(() => (state.value.model ? (state.value.model.name ?? state.value.model.id) : "model"));

// The bridge can only switch the *bypass* list, not the proxy address: nife builds its HTTP agent
// once at startup. So the row says what it actually does - direct vs through the proxy.
const proxy = computed(
	() => state.value.proxy ?? { configured: false, bypassed: false, http: null, https: null, bypass: "" },
);

/** undici keeps http and https apart, so show both; the scheme is the label, the host is the value. */
const proxyLine = computed(() => {
	const { http, https } = proxy.value;
	const host = (url) => url.replace(/^https?:\/\//i, "");
	if (!http && !https) return "no proxy in this session";
	if (http && http === https) return `http + https ${host(http)}`;
	return [http ? `http ${host(http)}` : "http direct", https ? `https ${host(https)}` : "https direct"].join(" · ");
});

const filteredModels = computed(() => {
	const query = modelQuery.value.trim().toLowerCase();
	const models = state.value.models ?? [];
	if (!query) return models;
	return models.filter(
		(model) =>
			model.id.toLowerCase().includes(query) ||
			(model.name ?? "").toLowerCase().includes(query) ||
			model.provider.toLowerCase().includes(query),
	);
});

const isCurrentModel = (model) =>
	state.value.model?.provider === model.provider && state.value.model?.id === model.id;

const sessionTitle = (session) => {
	if (!session) return "";
	const name = (session.name ?? "").trim();
	if (name) return name;
	const first = (session.firstMessage ?? "").trim().replace(/\s+/g, " ");
	return first.length > 60 ? `${first.slice(0, 60)}…` : first || session.id.slice(0, 8);
};

const title = computed(
	() =>
		state.value.name ||
		sessionTitle(sessions.value.find((s) => s.path === currentFile.value)) ||
		(isChat.value ? "Nife Chat" : "Nife Work"),
);

const LABEL_BLUE = [77, 147, 248];
const LABEL_VIOLET = [139, 92, 246];

const thinkingLevels = computed(() => state.value.thinkingLevels ?? []);
const thinkingIndex = computed(() => Math.max(thinkingLevels.value.indexOf(state.value.thinkingLevel), 0));
const thinkingValue = computed(() => thinkingDraft.value ?? thinkingIndex.value);
const thinkingIsOff = computed(
	() => String(thinkingLevels.value[thinkingValue.value] ?? "").trim().toLowerCase() === "off",
);
const thinkingTone = computed(() => {
	if (thinkingIsOff.value || thinkingLevels.value.length < 2) return "";
	const t = Math.max(0, (thinkingValue.value / (thinkingLevels.value.length - 1) - 1 / 3) / (1 - 1 / 3));
	const [r, g, b] = LABEL_BLUE.map((from, i) => Math.round(from + (LABEL_VIOLET[i] - from) * t));
	return `rgb(${r}, ${g}, ${b})`;
});

const compact = (value) => {
	const n = Number(value) || 0;
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${Math.round(n / 1000)}k`;
	return String(n);
};

const money = (value) => {
	const cost = Number(value) || 0;
	if (cost === 0) return "";
	return cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`;
};

const contextPercent = computed(() => {
	const usage = state.value.usage;
	return usage?.percent != null ? Math.min(100, Math.max(0, usage.percent)) : null;
});



// The composer ring. While compaction runs it creeps toward full with a glow (the real number is
// meaningless mid-summarization), then drops back to the measured percentage when it finishes, and
// the CSS transition animates that decrease.
const sweepPercent = ref(0);
let sweepFrame = 0;

/** Repeating fill while compaction runs: rise -> full -> start over. The bridge decides the end. */
const SWEEP_PERIOD = 2800;
const SWEEP_RISE = 0.82; // rest of the cycle holds at 100%

function startSweep() {
	const base = contextPercent.value ?? 0;
	cancelAnimationFrame(sweepFrame);
	const startedAt = performance.now();
	const step = (now) => {
		if (!compacting.value) {
			sweepFrame = 0;
			return;
		}
		const elapsed = now - startedAt;
		const cycle = Math.floor(elapsed / SWEEP_PERIOD);
		const phase = (elapsed % SWEEP_PERIOD) / SWEEP_PERIOD;
		// first cycle grows from the measured usage, later ones from empty
		const floor = cycle === 0 ? base : 0;
		const t = Math.min(phase / SWEEP_RISE, 1);
		sweepPercent.value = floor + (100 - floor) * (1 - (1 - t) ** 3);
		sweepFrame = requestAnimationFrame(step);
	};
	sweepFrame = requestAnimationFrame(step);
}

watch(compacting, (running) => {
	if (running) {
		startSweep();
		return;
	}
	cancelAnimationFrame(sweepFrame);
	sweepFrame = 0;
});

const progressPercent = computed(() => (compacting.value ? sweepPercent.value : (contextPercent.value ?? 0)));

const usageLine = computed(() => {
	const stats = state.value.stats;
	const usage = state.value.usage;
	const parts = [];
	if (stats) parts.push(`${stats.messages} msgs`, `${stats.toolCalls} tools`);
	if (usage?.contextWindow) {
		parts.push(
			usage.percent != null
				? `context ${compact(usage.tokens)} / ${compact(usage.contextWindow)} (${Math.round(usage.percent)}%)`
				: `context — / ${compact(usage.contextWindow)}`,
		);
	}
	if (stats) {
		parts.push(`in ${compact(stats.input)} out ${compact(stats.output)}`);
		if (stats.cacheRead) parts.push(`cache ${compact(stats.cacheRead)}`);
		const cost = money(stats.cost);
		if (cost) parts.push(cost);
	}
	return parts.join(" · ");
});

const when = (value) => {
	const date = new Date(value);
	const minutes = Math.round((Date.now() - date.getTime()) / 60000);
	if (!Number.isFinite(minutes)) return "";
	if (minutes < 1) return "now";
	if (minutes < 60) return `${minutes}m`;
	if (minutes < 1440) return `${Math.round(minutes / 60)}h`;
	return date.toLocaleDateString();
};

/**
 * Sticky follow. Scrolling up always wins over an incoming message, and it only comes back once the
 * user is within FOLLOW_SLACK of the bottom again. The ref also drives the "Latest" button.
 *
 * The subtlety: the transcript moves the viewport up all by itself. A collapsing thinking block, a
 * tool row folding back, or the live message being replaced by its final version makes the content
 * above shrink, and the browser then clamps scrollTop down. Treating every downward scrollTop move
 * as "the user scrolled up" switched following off for good - that was the "auto-scroll sometimes
 * stops working" bug. So a scroll only counts as user intent when a gesture happened recently;
 * a clamp (no gesture, and it lands exactly on the new bottom) keeps following.
 */
const FOLLOW_SLACK = 64;
// a scroll event this close to the last real gesture is attributed to the user
const GESTURE_MS = 400;
let lastScrollTop = 0;
let lastGestureAt = 0;
// Our own scrollTop writes (anchoring a page, aligning a jump) fire scroll events too. Without this
// they look like the reader scrolling, and a "scroll up" attributed to the browser can call follow()
// and yank the view back to the bottom.
let selfScrollAt = 0;
function writeScrollTop(el, value) {
	selfScrollAt = performance.now();
	el.scrollTop = value;
}
// dragging the scrollbar produces scroll events with no wheel/touch, so the press itself counts
let pointerHeld = false;

function nearBottom() {
	const el = transcript.value;
	if (!el) return true;
	return el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK;
}

function atBottom() {
	const el = transcript.value;
	if (!el) return true;
	return el.scrollHeight - el.scrollTop - el.clientHeight <= 1;
}

function markGesture() {
	lastGestureAt = performance.now();
}

function onTranscriptScroll() {
	const el = transcript.value;
	if (!el) return;
	if (performance.now() - selfScrollAt < 120) {
		// a scroll we caused: the position is already where the windowing wanted it
		lastScrollTop = el.scrollTop;
		return;
	}
	const first = firstVisible();
	topMessage.value = first?.message ?? messageOfRow(runStart.value);
	// measured against the rendered window, not the scroll container: the spacers themselves are
	// tens of thousands of pixels tall, so an absolute threshold would leave the reader inside one
	if (padVisible()) void expandWindow();
	// runStart 0 means the window sits on the oldest loaded row: there is no spacer to watch, so the
	// scroll position itself is the signal that the history above has to arrive
	else if (hasOlder.value && runStart.value === 0 && el.scrollTop < 400) void expandWindow();
	else if (tailPadVisible()) void extendWindow();
	const movedUp = el.scrollTop < lastScrollTop - 2;
	lastScrollTop = el.scrollTop;
	if (!movedUp) {
		stick.value = nearBottom();
		return;
	}
	const fromUser = pointerHeld || performance.now() - lastGestureAt < GESTURE_MS;
	if (!fromUser) {
		// the browser clamped us (content shrank) or an image finished loading above: keep following
		if (stick.value) follow();
		return;
	}
	stick.value = false;
}

/**
 * The wheel belongs to whatever is under the pointer. Inner areas have no scrollbar (see the
 * `.transcript *` rule in style.css), so this decides the level: an output or an open run's body
 * takes the wheel while it can still move, and the transcript gets it at the ends and everywhere
 * else. Returns that element, or null when the transcript is next.
 */
function wheelTarget(event) {
	if (!event.deltaY) return null;
	const start = event.target instanceof Element ? event.target : null;
	for (let node = start; node && node !== transcript.value; node = node.parentElement) {
		const overflow = getComputedStyle(node).overflowY;
		if (overflow !== "auto" && overflow !== "scroll") continue;
		const canMove =
			event.deltaY < 0 ? node.scrollTop > 0 : node.scrollTop + node.clientHeight < node.scrollHeight - 1;
		if (canMove) return node;
	}
	return null;
}

/** Wheel direction is checked too: a small nudge up must not be undone by the next chunk. */
function onTranscriptWheel(event) {
	// a real gesture either way: the transcript may take over as soon as the area under the pointer
	// has nowhere left to scroll, and that hand-over must count as the reader's own scroll
	markGesture();
	// an inner area consumed it: the transcript did not move, so following must not detach
	if (wheelTarget(event)) return;
	if (event.deltaY < 0) stick.value = false;
}

/** iOS can defer scroll events during momentum, so a touch away from the bottom detaches at once. */
function onTranscriptTouch() {
	markGesture();
	if (!nearBottom()) stick.value = false;
}

function onTranscriptPointerDown() {
	pointerHeld = true;
	markGesture();
}

function onPointerRelease() {
	pointerHeld = false;
}

const SCROLL_KEYS = new Set(["PageUp", "PageDown", "ArrowUp", "ArrowDown", "Home", "End", " "]);

/**
 * Scroll to the newest message while sticking; a user who scrolled up keeps their position.
 * Batched into one rAF: a send can change the textarea height and add a queue row in the same
 * frame, and scrolling per change is what made the transcript jump.
 */
let followFrame = 0;
let followTries = 0;
function follow() {
	if (followFrame) return;
	followFrame = requestAnimationFrame(() => {
		followFrame = 0;
		const el = transcript.value;
		if (!el || !stick.value) return;
		trimWindow();
		writeScrollTop(el, el.scrollHeight);
		// content can grow between reading scrollHeight and writing scrollTop (a markdown delta, an
		// image decoding); one more frame settles it instead of leaving the view a line short
		if (atBottom() || ++followTries > 2) followTries = 0;
		else follow();
	});
}

/** Local actions (own prompt, session load, the Latest button) win over a scrolled-up view. */
function scrollToBottom() {
	// the window may be parked in the middle of the history; reopen it on the tail before following
	if (runEnd.value !== Number.POSITIVE_INFINITY || rows.value.length - runStart.value > WIN_MAX * 2) openWindow();
	stick.value = true;
	follow();
}

/** Enter sends; Shift+Enter breaks the line. Composition must finish first (IME picks with Enter). */
function onComposerKeydown(event) {
	if (event.key !== "Enter" || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
	if (event.isComposing) return;
	event.preventDefault();
	send();
}

/** Compact the session context; the bridge resolves with the outcome of the compaction model call. */
async function compactContext() {
	if (compacting.value) return;
	// the ring is the progress indicator from here on, so the menu has no job left
	menu.value = null;
	compacting.value = true;
	const result = await postDetailed("compact", {});
	if (!result.ok) {
		compacting.value = false;
		// Every failure is reported: the ring drops back within a frame when nothing changed, so a
		// silent "Already compacted" would look like a dead button.
		showNotice((result.message || "compaction failed").replace(/^error:\s*/i, ""));
		return;
	}
	// no toast on success: the transcript already gains its "Context compacted" row
	await loadState();
	compacting.value = false;
	queuePaused.value = false;
	void drain();
}

/** Coalesces streaming deltas into one DOM update per animation frame. */
function scheduleFlush() {
	if (frame) return;
	frame = requestAnimationFrame(() => {
		frame = 0;
		if (!live.value) {
			pendingText = "";
			pendingThinking = "";
			return;
		}
		if (pendingText) {
			live.value.text += pendingText;
			pendingText = "";
		}
		if (pendingThinking) {
			live.value.thinking += pendingThinking;
			pendingThinking = "";
		}
	});
}

function applyDelta(delta) {
	if (delta.type === "text_delta") pendingText += delta.delta;
	else if (delta.type === "thinking_delta") pendingThinking += delta.delta;
	else if (delta.type === "error") pendingText += `\n${delta.error?.errorMessage ?? "request failed"}`;
	else return;
	scheduleFlush();
}

function push(message) {
	// a prompt can arrive before the bridge knows which entry it was written to (see entry_id)
	const stamped =
		message?.role === "user" && !message.entryId && orphanEntryIds.length > 0
			? { ...message, entryId: orphanEntryIds.shift() }
			: message;
	messages.value.push(stamped);
	triggerRef(messages);
}

/**
 * Which session entry a prompt landed in, announced by the bridge right after nife persists it. The
 * two can arrive in either order (the message, then its id; the id, then the message), so whichever
 * is late fills the gap: the id is stamped on the newest prompt that still has none.
 */
const orphanEntryIds = [];

function stampEntryId(entryId) {
	if (typeof entryId !== "string" || !entryId) return;
	for (let index = messages.value.length - 1; index >= 0; index -= 1) {
		const message = messages.value[index];
		if (message.role !== "user" || message.entryId) continue;
		messages.value = messages.value.map((entry, position) =>
			position === index ? { ...entry, entryId } : entry,
		);
		return;
	}
	orphanEntryIds.push(entryId);
}

/** Sidebar rows of every project that is loaded, so a status event can patch them in place. */
function patchSessionRow(path, patch) {
	if (!path) return;
	const found = sessions.value.find((session) => session.path === path);
	if (found) Object.assign(found, patch);
	for (const rows of Object.values(sessionsByProject.value)) {
		for (const session of rows) if (session.path === path) Object.assign(session, patch);
	}
}

/** A background turn finished while the reader was elsewhere: dot on the row, toast on the page. */
function sessionFinished(payload) {
	const known = sessions.value.find((session) => session.path === payload.path);
	const label = known ? sessionTitle(known) : payload.name || projectName(payload.cwd) || "会话";
	showNotice(`「${label}」已完成`);
	// the row's time and title changed with the turn; the list is cheap enough to re-read
	void loadGroups({ refresh: true });
}

/** Events from another conversation still update its row, but never this transcript. */
function fromOtherSession(payload) {
	if (!payload.sid || payload.sid === sessionSid()) return false;
	// A confirmation raised by a background run still needs an answer, whoever it belongs to.
	if (payload.type === "dialog") return false;
	if (payload.type === "session_status") {
		patchSessionRow(payload.path, { running: Boolean(payload.running), done: Boolean(payload.done) });
		if (!payload.running && payload.done) sessionFinished(payload);
		return true;
	}
	if (payload.type === "sessions_changed" || payload.type === "notice") {
		if (payload.type === "notice" && payload.text) showNotice(payload.text);
		if (payload.type === "sessions_changed") void loadGroups({ refresh: true });
		return true;
	}
	return true;
}

function handle(payload) {
	if (fromOtherSession(payload)) return;
	switch (payload.type) {
		case "message_start":
			if (payload.message?.role === "assistant") {
				live.value = { text: "", thinking: "" };
				pendingText = "";
				pendingThinking = "";
				follow();
			}
			break;
		case "message_update":
			applyDelta(payload.delta);
			break;
		case "message_end":
			live.value = null;
			pendingText = "";
			pendingThinking = "";
			push(payload.message);
			// the turn just became a committed row: keep it open for the reader who expanded it live
			if (payload.message?.role === "assistant" && blocksOf(payload.message).some(isProcessBlock)) claimLiveRow();
			// A user message is your own action - typed here, sent from the terminal, or drained from
			// the queue - so it brings the view down even if you were reading further up. Assistant
			// messages only follow while the view is already at the bottom.
			if (payload.message?.role === "user") scrollToBottom();
			else follow();
			break;
		case "agent_start":
			streaming.value = true;
			break;
		case "agent_settled":
			streaming.value = false;
			turnPending = false;
			// an aborted turn may end without message_end; drop an empty placeholder
			if (live.value && !live.value.text && !live.value.thinking) live.value = null;
			// The bridge reports every abort, including Escape in the terminal: a stopped turn must
			// not be followed by the next queued task without the user asking for it. An empty queue
			// has nothing to hold, so it stays unpaused and the strip stays away.
			queuePaused.value = payload.aborted && queue.value.length > 0;
			clearQueuedErrors();
			refreshMeta();
			void drain();
			break;
		case "session_status":
			// the viewed conversation: the local flags already track it, but the row must too
			patchSessionRow(payload.path, { running: Boolean(payload.running), done: Boolean(payload.done) });
			break;
		case "session_info_changed":
			state.value.name = payload.name;
			break;
		case "state_changed":
			loadState();
			break;
		case "mode_changed": {
			const next = payload.mode === "chat" ? "chat" : "work";
			if (next !== mode.value && (attachments.value.length > 0 || files.value.length > 0)) {
				attachments.value = [];
				files.value = [];
				showNotice("attachments cleared after switching workspace");
			}
			mode.value = next;
			modeMenu.value = false;
			break;
		}
		case "stats":
			// pushed after every committed step, so a long tool loop keeps the footer honest
			state.value.stats = payload.stats;
			state.value.usage = payload.usage ?? null;
			break;
		case "subagents":
			subagents.value = payload.running ?? [];
			break;
		case "tunnel":
			state.value.tunnel = payload.tunnel;
			if (payload.ports) state.value.ports = payload.ports;
			break;
		case "services":
			state.value.services = payload.services;
			if (payload.ports) state.value.ports = payload.ports;
			noteServices(payload.services);
			break;
		case "thinking_level_changed":
			state.value.thinkingLevel = payload.level;
			thinkingDraft.value = null;
			break;
		case "session_start":
		case "session_switch":
			workspaceMenu.value = false;
			// a queued task belongs to the conversation it was typed in
			if (queue.value.length > 0) {
				queuePaused.value = true;
				showNotice("queue paused after the session changed");
			}
			// the prompt being edited belongs to the session that just went away
			cancelEdit();
			// the manager's highlight belongs to the session that just went away
			closeModelManager();
			loadState();
			loadGroups({ reveal: true });
			break;
		case "sessions_changed":
			loadGroups({ refresh: true });
			break;
		case "entry_id":
			stampEntryId(payload.entryId);
			break;
		case "session_tree":
			// the leaf moved. The tab that moved it reloads on its own, in order with the prompt it is
			// about to post; the others have to catch up here.
			if (!movingBranch.value) loadState().catch(() => {});
			break;
		case "compaction_start":
			compacting.value = true;
			break;
		case "compaction_end":
			if (!payload.ok) {
				compacting.value = false;
				break;
			}
			// Compacting is an explicit "keep going": continue the queue without waiting for a Resume
			// click. Refresh before releasing the sweep so the ring animates straight to the new
			// percentage instead of dropping to the stale one first.
			queuePaused.value = false;
			loadState()
				.catch(() => {})
				.finally(() => {
					compacting.value = false;
					void drain();
				});
			break;
		case "dialog":
			dialog.value = payload;
			dialogText.value = payload.prefill ?? "";
			break;
		default:
			break;
	}
}

function connect() {
	source = new EventSource(api("events"));
	source.onopen = () => {
		online.value = true;
	};
	source.onerror = () => {
		online.value = false;
	};
	source.onmessage = (event) => handle(JSON.parse(event.data));
}

async function loadState() {
	let response = await fetch(api("state"));
	if (response.status === 404) {
		// The background runtime behind this sid was evicted, the file was deleted, or the bridge
		// restarted. Try the same conversation again; with no file left, fall back to the terminal's.
		const path = state.value.sessionFile || sessionFile();
		setSessionSid("host");
		if (path) {
			const reattach = await postDetailed("attach", { path });
			if (reattach.ok) setSessionSid(reattach.data?.sid, path);
		}
		response = await fetch(api("state"));
	}
	if (!response.ok) throw new Error(`state ${response.status}`);
	const loaded = await response.json();
	// The tab remembers where it was: a reload keeps the conversation, and the sid survives only
	// while this nife process does (a stale one falls back to the re-attach above).
	setSessionSid(loaded.sid, loaded.sessionFile);
	state.value = loaded;
	mode.value = loaded.mode === "chat" ? "chat" : "work";
	subagents.value = loaded.subagents ?? [];
	// rows are keyed by message index, so an open row means nothing after a session switch; the same
	// goes for "this row already has its steps", which is keyed the same way
	openRows.value = new Set();
	stepsLoaded.clear();
	stepsLoading.clear();
	stepsFailed.clear();
	messages.value = loaded.messages ?? [];
	triggerRef(messages);
	// the snapshot carries every id itself: ids announced for messages that are no longer here are stale
	orphanEntryIds.length = 0;
	loadedFrom.value = loaded.loadedFrom ?? 0;
	streaming.value = Boolean(loaded.streaming);
	// A turn that is still running when the reader comes back: show what it has streamed so far.
	live.value = loaded.live ? { text: loaded.live.text ?? "", thinking: loaded.live.thinking ?? "" } : null;
	pendingText = "";
	pendingThinking = "";
	if (loaded.sessionFile) currentFile.value = loaded.sessionFile;
	turnPending = false;
	openWindow();
	scrollToBottom();
}

/** Refreshes header fields only; reloading messages would fight the user's scroll. */
async function refreshMeta() {
	// meta=1 skips the transcript page: this runs on every event and only reads header fields
	const response = await fetch(api("state?meta=1"));
	if (!response.ok) return;
	const loaded = await response.json();
	state.value = { ...state.value, ...loaded, messages: state.value.messages };
	mode.value = loaded.mode === "chat" ? "chat" : "work";
}

/** The last path segment, for compact project labels next to rows from other projects. */
function projectName(path) {
	return String(path || "").split(/[\\/]/).filter(Boolean).pop() || path || "";
}

/** Only rows from another project need the extra label; the current one is already in the footer. */
const projectTag = (session) => {
	const cwd = session?.cwd || "";
	return cwd && cwd !== state.value.cwd ? projectName(cwd) : "";
};

/** Everything the new-session picker can suggest: default root, its children, this project, history. */
const projectOptions = computed(() => {
	const seen = new Set();
	const list = [];
	const add = (path, name, kind) => {
		const clean = String(path || "").trim();
		if (!clean || seen.has(clean)) return;
		seen.add(clean);
		list.push({ path: clean, name: name || projectName(clean), kind });
	};
	add(projectRoot.value, "project", "default");
	for (const entry of projectDirs.value) add(entry.path, entry.name, entry.kind);
	add(state.value.cwd, projectName(state.value.cwd), "current");
	for (const session of sessions.value) add(session.cwd, projectName(session.cwd), "recent");
	return list;
});

const filteredProjects = computed(() => {
	const query = newCwd.value.trim().toLowerCase();
	if (!query) return projectOptions.value;
	// A complete choice still shows every alternative; only a partial path narrows the list.
	if (projectOptions.value.some((entry) => entry.path.toLowerCase() === query)) return projectOptions.value;
	return projectOptions.value.filter(
		(entry) => entry.path.toLowerCase().includes(query) || entry.name.toLowerCase().includes(query),
	);
});

/** Breadcrumb segments, so the browser can walk back up without typing a path. */
function pathCrumbs(path) {
	const value = String(path || "");
	const sep = value.includes("\\") && !value.includes("/") ? "\\" : "/";
	const parts = value.split(/[\\/]/).filter(Boolean);
	const crumbs = [];
	let acc = value.startsWith(sep) ? sep : "";
	if (acc) crumbs.push({ name: sep, path: sep });
	for (const part of parts) {
		if (!acc) acc = /^[A-Za-z]:$/.test(part) ? part + sep : part;
		else acc = acc.endsWith(sep) ? acc + part : acc + sep + part;
		crumbs.push({ name: part, path: acc });
	}
	return crumbs;
}

const browseCrumbs = computed(() => pathCrumbs(browseDir.value));

/** Shortcuts for people who do not know any paths: home, the default root, this project. */
const quickSpots = computed(() => {
	const seen = new Set();
	const list = [];
	const add = (name, path) => {
		const clean = String(path || "").trim();
		if (!clean || seen.has(clean)) return;
		seen.add(clean);
		list.push({ name, path: clean });
	};
	add("主目录", browseHome.value);
	add("默认项目目录", projectRoot.value);
	add("当前项目", state.value.cwd);
	return list;
});

/** One level of subdirectories; the empty path means home, the same rule the server applies. */
async function loadBrowse(path) {
	browseBusy.value = true;
	browseError.value = "";
	try {
		const response = await fetch(api(`dirs?path=${encodeURIComponent(path ?? "")}`));
		if (!response.ok) {
			browseError.value = (await response.text()).slice(0, 200) || "无法打开这个文件夹";
			return;
		}
		const data = await response.json();
		browseDir.value = data.path ?? "";
		browseParent.value = data.parent ?? null;
		browseHome.value = data.home || browseHome.value;
		browseDirs.value = Array.isArray(data.dirs) ? data.dirs : [];
	} catch {
		browseError.value = "无法打开这个文件夹";
	} finally {
		browseBusy.value = false;
	}
}

function enterDir(path) {
	if (!path) return;
	void loadBrowse(path);
}

/**
 * Typing a known project's name should open that project, not create a folder called like it: an
 * exact path wins, then an exact name from the filtered list. Anything else is a path to create.
 */
const typedPick = computed(() => {
	const query = newCwd.value.trim().replace(/[\\/]+$/, "");
	if (!query) return null;
	const lower = query.toLowerCase();
	const byPath = projectOptions.value.find(
		(entry) => entry.path.replace(/[\\/]+$/, "").toLowerCase() === lower,
	);
	if (byPath) return byPath;
	return filteredProjects.value.find((entry) => entry.name.toLowerCase() === lower) ?? null;
});

/** The directory the footer button and Enter would start the conversation in. */
const targetPath = computed(() => {
	const query = newCwd.value.trim();
	if (!query) return browseDir.value || "";
	return typedPick.value?.path ?? query;
});

/** A typed path that is not already one of the suggestions still deserves its own row. */
const newPathRow = computed(() => Boolean(newCwd.value.trim()) && !typedPick.value);

/** Same rule as the bridge (a tmp/temp segment): say it here before the session cannot be kept. */
const targetIsTemp = computed(() =>
	targetPath.value
		.split(/[\\/]+/)
		.some((segment) => segment.toLowerCase() === "tmp" || segment.toLowerCase() === "temp"),
);

async function loadProjects() {
	try {
		const response = await fetch(api("projects"));
		if (!response.ok) return;
		const data = await response.json();
		projectRoot.value = data.default || "";
		projectDirs.value = Array.isArray(data.projects) ? data.projects : [];
	} catch {
		// the text field still accepts a path when discovery fails
	}
}

const pendingGroups = new Map();
let groupGeneration = 0;

const groupLoaded = (key) => Object.prototype.hasOwnProperty.call(sessionsByProject.value, key);
const groupCollapsed = (key) => !expandedProjects.value.includes(key);

function expandProject(key) {
	if (!expandedProjects.value.includes(key)) expandedProjects.value = [...expandedProjects.value, key];
}

async function ensureGroup(key, force = false) {
	if (!force && groupLoaded(key)) return;
	const pending = pendingGroups.get(key);
	if (pending) return pending;
	const generation = groupGeneration;
	if (!loadingProjects.value.includes(key)) loadingProjects.value = [...loadingProjects.value, key];
	const job = (async () => {
		try {
			const response = await fetch(api(`sessions?cwd=${encodeURIComponent(key)}`));
			if (!response.ok) return;
			const data = await response.json();
			if (generation !== groupGeneration) return;
			sessionsByProject.value = { ...sessionsByProject.value, [key]: data.sessions ?? [] };
			if (data.current) currentFile.value = data.current;
		} catch {
			// the group stays folded-empty; opening it again retries
		} finally {
			if (generation === groupGeneration) {
				loadingProjects.value = loadingProjects.value.filter((entry) => entry !== key);
				pendingGroups.delete(key);
			}
		}
	})();
	pendingGroups.set(key, job);
	return job;
}

async function toggleProjectGroup(group) {
	const key = group.cwd || "";
	if (expandedProjects.value.includes(key)) {
		expandedProjects.value = expandedProjects.value.filter((entry) => entry !== key);
		return;
	}
	expandProject(key);
	await ensureGroup(key);
}

/** Reveal a group and load it, used by session switches, search jumps and new sessions. */
async function revealProject(cwd) {
	const key = cwd || "";
	expandProject(key);
	await ensureGroup(key);
}

async function loadGroups(options = {}) {
	const { refresh = false, reveal = false } = options;
	const response = await fetch(api("groups"));
	if (!response.ok) return;
	const data = await response.json();
	const next = Array.isArray(data.groups) ? data.groups : [];
	groups.value = next;
	if (data.currentFile) currentFile.value = data.currentFile;
	if (groupsMode.value !== (data.mode || "work")) {
		groupsMode.value = data.mode || "work";
		groupGeneration += 1;
		pendingGroups.clear();
		expandedProjects.value = [];
		sessionsByProject.value = {};
		loadingProjects.value = [];
	}
	const keys = new Set(next.map((group) => group.cwd || ""));
	const kept = {};
	for (const [key, rows] of Object.entries(sessionsByProject.value)) {
		if (keys.has(key)) kept[key] = rows;
	}
	sessionsByProject.value = kept;
	expandedProjects.value = expandedProjects.value.filter((key) => keys.has(key));
	if (expandedProjects.value.length === 0) {
		// Expand the current project when it has rows. An empty New Work, or a workspace whose
		// conversations were just deleted, has no group at all: opening another project then would
		// read as if the current one had moved there.
		const active = next.find((group) => group.current)?.cwd;
		if (active !== undefined) expandProject(active);
	}
	if (reveal) {
		const active = next.find((group) => group.current)?.cwd;
		if (active !== undefined) {
			expandProject(active);
			await ensureGroup(active, true);
		}
	}
	if (refresh) {
		const loaded = Object.keys(sessionsByProject.value);
		await Promise.all(loaded.map((key) => ensureGroup(key, true)));
	} else if (expandedProjects.value.length > 0) {
		const first = expandedProjects.value[0];
		if (keys.has(first)) await ensureGroup(first);
	}
}

/** One section per project; rows arrive from ensureGroup when the section is opened. */
const sessionGroups = computed(() => {
	const pinned = new Set(pinnedPaths.value);
	return groups.value.map((group) => {
		const key = group.cwd || "";
		const loaded = groupLoaded(key);
		const raw = sessionsByProject.value[key] ?? [];
		const first = [];
		const rest = [];
		for (const session of raw) (pinned.has(session.path) ? first : rest).push(session);
		return {
			...group,
			key,
			loaded,
			loading: loadingProjects.value.includes(key),
			count: loaded ? raw.length : group.count,
			sessions: [...first, ...rest],
		};
	});
});

const orderedSessions = computed(() => sessionGroups.value.flatMap((group) => group.sessions));

const selectedSessions = computed(() =>
	orderedSessions.value.filter((session) => selectedPaths.value.includes(session.path)),
);
const selectedCount = computed(() => selectedPaths.value.length);
const allSelectedPinned = computed(
	() => selectedSessions.value.length > 0 && selectedSessions.value.every((session) => isPinned(session.path)),
);

const pinKey = () => `nife-webui.pinned:workspace:${mode.value}`;

function loadPinned() {
	try {
		const key = pinKey();
		// Pins belong to the workspace now, not to one project. Carry the old per-directory list over
		// once, then keep every project's pins together.
		const oldKey = `nife-webui.pinned:${state.value.cwd || ""}:${mode.value}`;
		const olderKey = `nife-webui.pinned:${state.value.cwd || ""}`;
		const raw = localStorage.getItem(key) ?? localStorage.getItem(oldKey) ?? (mode.value === "work" ? localStorage.getItem(olderKey) : null);
		const parsed = JSON.parse(raw ?? "[]");
		pinnedPaths.value = Array.isArray(parsed) ? parsed.filter((path) => typeof path === "string") : [];
		if (raw !== null && localStorage.getItem(key) === null) savePinned();
	} catch {
		pinnedPaths.value = [];
	}
}

function savePinned() {
	try {
		localStorage.setItem(pinKey(), JSON.stringify(pinnedPaths.value));
	} catch {
		// storage can be disabled; pinning simply does not survive a reload then
	}
}

watch([() => state.value.cwd, mode], loadPinned, { immediate: true });

// A session stops being "new" the moment it has a message or a turn: the project is settled then.
watch([() => messages.value.length, streaming], ([count, busy]) => {
	if (count > 0 || busy) freshSession.value = false;
});

const isPinned = (path) => pinnedPaths.value.includes(path);

function setPinned(list, pinned) {
	const next = new Set(pinnedPaths.value);
	for (const session of list) {
		if (pinned) next.add(session.path);
		else next.delete(session.path);
	}
	pinnedPaths.value = [...next];
	savePinned();
}

/** Place the row menu next to its button, right-aligned enough to stay on screen. */
function toggleSessionMenu(event, session) {
	if (sessionMenu.value?.session.path === session.path) {
		sessionMenu.value = null;
		return;
	}
	const rect = event.currentTarget.getBoundingClientRect();
	const width = 160;
	sessionMenu.value = {
		session,
		top: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 150)),
		left: Math.max(8, Math.min(rect.left - 4, window.innerWidth - width - 8)),
	};
}

function togglePin(session) {
	sessionMenu.value = null;
	const next = !isPinned(session.path);
	setPinned([session], next);
	showNotice(next ? "session pinned" : "session unpinned");
}

function pinSelected() {
	const targets = selectedSessions.value;
	if (!targets.length) return;
	const next = !allSelectedPinned.value;
	setPinned(targets, next);
	showNotice(next ? `${targets.length} sessions pinned` : `${targets.length} sessions unpinned`);
	exitSelect();
}

function enterSelect(session) {
	sessionMenu.value = null;
	tunnelMenu.value = false;
	closeSearch();
	selecting.value = true;
	if (session && !selectedPaths.value.includes(session.path)) {
		selectedPaths.value = [...selectedPaths.value, session.path];
	}
}

function toggleSelected(session) {
	selectedPaths.value = selectedPaths.value.includes(session.path)
		? selectedPaths.value.filter((path) => path !== session.path)
		: [...selectedPaths.value, session.path];
}

function exitSelect() {
	selecting.value = false;
	selectedPaths.value = [];
}

/** Rename in place, like the sidebar editor: Enter commits, Escape or a click elsewhere abandons. */
async function startRename(session) {
	sessionMenu.value = null;
	renaming.value = session.path;
	renameText.value = sessionTitle(session);
	await nextTick();
	const input = Array.isArray(renameEl.value) ? renameEl.value[0] : renameEl.value;
	input?.focus();
	input?.select();
}

function cancelRename() {
	renaming.value = "";
	renameText.value = "";
}

async function commitRename(session) {
	if (renaming.value !== session.path) return;
	const name = renameText.value.trim();
	const current = (session.name ?? "").trim();
	renaming.value = "";
	if (name === current) return;
	const result = await postDetailed("rename", { path: session.path, name });
	if (!result.ok) {
		showNotice(result.message || "could not rename the session");
		return;
	}
	await loadGroups({ refresh: true });
	if (session.path === currentFile.value) await refreshMeta();
}

/** The menu only asks; the modal is where the file actually goes. */
function askDeleteSession(session) {
	sessionMenu.value = null;
	deleteWorkspace.value = null;
	deleteQueue.value = [session];
}

function askDeleteSelected() {
	if (!selectedSessions.value.length) return;
	deleteWorkspace.value = null;
	deleteQueue.value = [...selectedSessions.value];
}

/** A project header deletes its conversations; the project directory and its files stay. */
async function askDeleteProject(group) {
	if (selecting.value) return;
	if (!group.loaded) await ensureGroup(group.key);
	const sessions = sessionsByProject.value[group.key] ?? [];
	if (!sessions.length) {
		showNotice("No sessions to delete");
		return;
	}
	sessionMenu.value = null;
	deleteWorkspace.value = { name: group.name, cwd: group.cwd };
	deleteQueue.value = [...sessions];
}

function cancelDelete() {
	if (deleting.value) return;
	deleteQueue.value = [];
	deleteWorkspace.value = null;
}

/**
 * Delete one session or a selection. The bridge moves the runtime to a fresh session first when the
 * active one is included, so the page just reloads and lands on that workspace's New Work / New Chat screen.
 */
async function confirmDeleteSessions() {
	const targets = deleteQueue.value;
	if (!targets.length || deleting.value) return;
	const workspace = deleteWorkspace.value;
	const wasCurrent = targets.some((session) => session.path === currentFile.value);
	deleting.value = true;
	try {
		const response = await fetch(api("delete"), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ paths: targets.map((session) => session.path) }),
		});
		if (!response.ok) {
			showNotice((await response.text()).slice(0, 200) || "could not delete the session");
			return;
		}
		const payload = await response.json().catch(() => ({}));
		const methods = Array.isArray(payload.methods) ? payload.methods : [];
		const gone = new Set(targets.map((session) => session.path));
		const kept = {};
		for (const [key, rows] of Object.entries(sessionsByProject.value)) {
			kept[key] = rows.filter((entry) => !gone.has(entry.path));
		}
		sessionsByProject.value = kept;
		selectedPaths.value = selectedPaths.value.filter((path) => !gone.has(path));
		pinnedPaths.value = pinnedPaths.value.filter((path) => !gone.has(path));
		savePinned();
		if (wasCurrent) {
			// The conversation that was open is gone: start a fresh one in the same project, the way the
			// bridge used to move the runtime to an empty session.
			const removed = targets.find((session) => session.path === currentFile.value);
			const cwd = removed?.cwd || state.value.cwd;
			setSessionSid("host");
			carryQueue(null);
			queue.value = [];
			const opened = await postDetailed("new", { cwd, mode: mode.value });
			if (opened.ok) {
				setSessionSid(opened.data?.sid, opened.data?.path);
				freshSession.value = true;
			}
			await loadState();
		}
		await loadGroups({ refresh: true });
		exitSelect();
		if (workspace && localStorage.getItem("nife-webui.new-cwd") === workspace.cwd) {
			localStorage.removeItem("nife-webui.new-cwd");
		}
		showNotice(
			workspace
				? `${workspace.name}: ${targets.length} sessions deleted`
				: targets.length > 1
					? `${targets.length} sessions deleted`
					: methods[0] === "trash"
						? "session moved to trash"
						: "session deleted",
		);
	} catch {
		showNotice("could not delete the session");
	} finally {
		deleting.value = false;
		deleteQueue.value = [];
		deleteWorkspace.value = null;
	}
}

async function postDetailed(path, body) {
	const response = await fetch(api(path), {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await response.text();
	if (!response.ok) return { ok: false, message: text.slice(0, 200), data: null };
	let data = null;
	try {
		data = JSON.parse(text);
	} catch {
		// some endpoints answer with a plain "ok"
	}
	return { ok: true, message: "", data };
}

async function post(path, body) {
	return (await postDetailed(path, body)).ok;
}

/**
 * Queued sends belong to one conversation: park the current list when the view moves, so a task
 * typed for A is not delivered into B after a switch.
 */
const queues = new Map();
function carryQueue(nextPath) {
	const from = currentFile.value;
	if (from === nextPath) return;
	if (from) queues.set(from, queue.value.slice());
	queue.value = nextPath ? [...(queues.get(nextPath) ?? [])] : [];
	queuePaused.value = false;
}

/** Open a conversation in the page, then read its state. Switching never stops a running turn. */
async function attachSession(path) {
	carryQueue(path);
	const result = await postDetailed("attach", { path });
	if (!result.ok) {
		showNotice(result.message || "could not open the session");
		return false;
	}
	setSessionSid(result.data?.sid, path);
	if (selecting.value) exitSelect();
	sidebarOpen.value = false;
	sessionMenu.value = null;
	workspaceMenu.value = false;
	freshSession.value = false;
	await loadState();
	await loadGroups({ reveal: true });
	return true;
}

let pasteSeq = 0;
const pastes = new Map();

// Pasted images waiting to be sent: { id, name, mimeType, data, url }.
const attachments = ref([]);
// Dropped files waiting to be sent: Work has { path, progress }, Chat has { text, reading }.
// A Work file with no path yet is still uploading; a Chat chip reading is still extracting text.
const files = ref([]);
const dragging = ref(false);
let imageSeq = 0;
let fileSeq = 0;

function clearComposer() {
	text.value = "";
	attachments.value = [];
	files.value = [];
	pastes.clear();
	// resize() reads the textarea's scrollHeight, so it has to run after Vue wrote the empty value;
	// measuring in this tick kept the old multi-line height and made the composer shrink later.
	nextTick(resize);
	scrollToBottom();
	inputEl.value?.focus();
}

/** POSTs one item; resolves with the bridge's answer and marks the turn as in flight on success. */
async function dispatch(item) {
	draining.value = true;
	const result = await postDetailed("prompt", { text: promptTextOf(item), images: item.images });
	draining.value = false;
	if (result.ok) turnPending = true;
	return result;
}

/**
 * One retry tick for a bridge that answered "busy": the settle event is the real trigger, this only
 * covers the case where that event was missed (reconnect) and the strip would otherwise sit still.
 */
let drainTimer = 0;
function scheduleDrain() {
	if (drainTimer) return;
	drainTimer = window.setTimeout(() => {
		drainTimer = 0;
		void drain();
	}, 800);
}

/** Attachments still being prepared (image resize) or uploaded: nothing can be sent yet. */
const preparing = computed(
	() =>
		attachments.value.some((image) => image.loading) ||
		files.value.some((file) => !file.path && typeof file.text !== "string"),
);

/** The composer as one queue item, or null when it is not sendable yet (the notice says why). */
function composedItem() {
	const value = expandPastes(text.value, pastes).trim();
	const images = attachments.value.map(({ name, mimeType, data }) => ({ name, mimeType, data }));
	const queuedFiles = files.value.map(({ name, path, size, text }) => ({ name, path, size, text }));
	if (files.value.some((file) => !file.path && typeof file.text !== "string")) {
		showNotice("still uploading, try again in a moment");
		return null;
	}
	if (!value && images.length === 0 && queuedFiles.length === 0) return null;
	const problem = imageProblem(images);
	if (problem) {
		showNotice(problem);
		return null;
	}
	queueSeq += 1;
	return { id: queueSeq, text: value, images, files: queuedFiles, error: "" };
}

async function send() {
	if (compacting.value || movingBranch.value) return;
	// The inline editor owns the send while it is open: its own button (or Cancel) settles it.
	if (editing.value) {
		showNotice("send or cancel the prompt you are editing first");
		return;
	}
	if (preparing.value) {
		showNotice("still preparing the attachments, try again in a moment");
		return;
	}
	// The one slash command the page can honour itself: nife's /chat toggles chat mode.
	if (text.value.trim() === "/chat") {
		if (attachments.value.length > 0 || files.value.length > 0) {
			showNotice("send /chat on its own");
			return;
		}
		clearComposer();
		await pickMode(isChat.value ? "work" : "chat");
		return;
	}
	const item = composedItem();
	if (!item) return;
	const blocked = queueProblem(queue.value, item);
	if (blocked) {
		showNotice(blocked);
		return;
	}
	// The directory choice ends with the first prompt: from here on the session owns its project.
	freshSession.value = false;
	clearComposer();
	await deliver(item);
}

/** Send one composed item now, or park it in the queue when the session is not ready for it. */
async function deliver(item) {
	// Paused means "do not continue the queued tasks", not "swallow what I type next": an explicit
	// send while the session is idle starts now and resumes the queue, so the parked items follow
	// this turn instead of waiting for a Resume click.
	if (queuePaused.value && !streaming.value && !compacting.value) {
		const result = await dispatch(item);
		if (result.ok) {
			queuePaused.value = false;
			return;
		}
		// "busy" means the session is mid-turn after all: park it again, resumed, and let the settle
		// drain it - it is not an error the user has to retry
		if (result.message === "busy") {
			queuePaused.value = false;
			queue.value = [item, ...queue.value];
			scheduleDrain();
			return;
		}
		const message = result.message || "could not send";
		queue.value = [{ ...item, error: message }, ...queue.value];
		showNotice(message);
		return;
	}
	queue.value = [...queue.value, item];
	void drain();
}

/** Sends the head of the queue when the session is idle; called from settle/compaction events. */
async function drain() {
	if (draining.value || queuePaused.value || streaming.value || compacting.value) return;
	if (turnPending) {
		// The bridge is authoritative here: if the turn already ended and its settle event was
		// missed (reconnect, reload), ask instead of keeping the queue wedged.
		const response = await fetch(api("state"));
		if (!response.ok) return;
		const loaded = await response.json();
		if (loaded.streaming) return;
		turnPending = false;
	}
	const head = queue.value[0];
	if (!head) return;
	const sid = sessionSid();
	const path = currentFile.value;
	const result = await dispatch(head);
	if (sessionSid() !== sid) {
		// The reader switched conversations while this send was in flight. It was accepted by the old
		// session or refused by it, but it never belongs in the new session's queue: park the failure
		// with the conversation it was typed for and leave the view alone.
		if (!result.ok && path) {
			const parked = queues.get(path) ?? [];
			queues.set(path, [{ ...head, error: result.message === "busy" ? "" : result.message || "could not send" }, ...parked]);
		}
		return;
	}
	if (!result.ok) {
		// a busy bridge is transient: the item stays at the head with no error and the next settle
		// sends it (this is the only case where the page and nife briefly disagree about being idle)
		if (result.message === "busy") {
			scheduleDrain();
			return;
		}
		// keep it at the head so nothing is lost, and stop: retrying every turn would spam the notice
		const message = result.message || "could not send";
		queue.value = queue.value.map((item, index) => (index === 0 ? { ...item, error: message } : item));
		showNotice(message);
		return;
	}
	queue.value = queue.value.slice(1);
}

/** A busy/aborted bridge is a temporary condition: clear stale failures so Retry stays reachable. */
function clearQueuedErrors() {
	if (!queue.value.some((item) => item.error)) return;
	queue.value = queue.value.map((item) => (item.error ? { ...item, error: "" } : item));
}

function resumeQueue() {
	queuePaused.value = false;
	if (queue.value[0]?.error) {
		queue.value = queue.value.map((item, index) => (index === 0 ? { ...item, error: "" } : item));
	}
	void drain();
}

function removeQueued(index) {
	queue.value = queue.value.filter((_, position) => position !== index);
	// an empty queue has nothing to hold, so do not leave the next task paused
	if (queue.value.length === 0) queuePaused.value = false;
}

function clearQueue() {
	queue.value = [];
	queuePaused.value = false;
}

/** Pull a queued item back into the composer (it leaves the queue). */
function editQueued(index) {
	const item = queue.value[index];
	if (!item) return;
	removeQueued(index);
	text.value = item.text;
	attachments.value = item.images.map((image, position) => {
		imageSeq += 1;
		return {
			id: imageSeq,
			name: image.name || `image ${position + 1}`,
			mimeType: image.mimeType,
			data: image.data,
			url: `data:${image.mimeType};base64,${image.data}`,
		};
	});
	files.value = item.files.map((file) => {
		fileSeq += 1;
		return { id: fileSeq, name: file.name, size: file.size, progress: 1, path: file.path, text: file.text };
	});
	nextTick(() => {
		inputEl.value?.focus();
		resize();
	});
}

/**
 * Editing an earlier prompt where it stands. The bubble itself turns into an editor (MessageEdit):
 * nothing is copied into the composer, nothing is destroyed, and the branch only moves when the
 * edited prompt is sent - cancelling just puts the bubble back.
 */
const editing = ref(null); // { entryId, busy }
// A send that has to move the branch first: the post follows, and a second click must not race it.
const movingBranch = ref(false);

function openEdit(item) {
	const message = item.message;
	if (!message?.entryId) return;
	if (streaming.value || compacting.value || draining.value || movingBranch.value) {
		showNotice("stop the current turn first");
		return;
	}
	menu.value = null;
	// one editor at a time: reopening elsewhere drops the previous one, which was never submitted
	editing.value = { entryId: message.entryId, busy: false, draft: null };
}

/** The card's state, kept here so scrolling it out of the rendered window does not undo the edit. */
function keepDraft(draft) {
	if (editing.value) editing.value.draft = draft;
}

function cancelEdit() {
	editing.value = null;
}

/** The nearest prompt before an answer, which is the turn "retry" regenerates. */
function promptBefore(index) {
	for (let position = messages.value.length - 1; position >= 0; position -= 1) {
		if (loadedFrom.value + position >= index) continue;
		const message = messages.value[position];
		if (message.role === "user") return message;
	}
	return null;
}

/**
 * Retry an answer: move the branch back to the prompt that produced it and send that prompt again,
 * unchanged. One prompt, a fresh answer, exactly the branch `/tree` would give.
 */
async function retryAnswer(item) {
	if (streaming.value || compacting.value || movingBranch.value) {
		showNotice("stop the current turn first");
		return;
	}
	const prompt = promptBefore(item.index);
	if (!prompt?.entryId) {
		showNotice("could not find the prompt behind this answer");
		return;
	}
	movingBranch.value = true;
	try {
		const result = await postDetailed("retry", { entryId: prompt.entryId });
		if (!result.ok) {
			showNotice(result.message || "could not retry this answer");
			return;
		}
		// the branch was truncated under our feet: reload before the new turn streams in
		await loadState();
		// loadState clears it, but this turn is ours: keep the "Working" placeholder until it settles
		turnPending = true;
	} finally {
		movingBranch.value = false;
	}
}

/** The prompt as one queue item, from what the inline editor still holds. */
function editedItem(draft) {
	queueSeq += 1;
	return { id: queueSeq, text: draft.text, images: draft.images, files: draft.files, error: "" };
}

/**
 * Send the edited prompt: move the branch back to its prompt first (that is what /tree does), then
 * deliver it like any other message, so it becomes a new branch of the same session file.
 */
async function submitEdit(draft) {
	const target = editing.value;
	if (!target || target.busy || movingBranch.value) return;
	const item = editedItem(draft);
	const blocked = queueProblem(queue.value, item);
	if (blocked) {
		showNotice(blocked);
		return;
	}
	target.busy = true;
	movingBranch.value = true;
	try {
		const moved = await postDetailed("tree", { entryId: target.entryId });
		if (!moved.ok) {
			showNotice(moved.message || "could not move back to that prompt");
			return;
		}
		editing.value = null;
		// Reload the truncated branch before the prompt is posted: the message that follows must be the
		// only thing appended after it, and the branch the queue lands on has to be the new one.
		await loadState();
		await deliver(item);
	} finally {
		movingBranch.value = false;
		target.busy = false;
	}
}


async function attachFiles(incoming) {
	for (const file of incoming) {
		if (attachments.value.length >= IMAGE_MAX_COUNT) {
			showNotice(`at most ${IMAGE_MAX_COUNT} images per message`);
			return;
		}
		imageSeq += 1;
		const id = imageSeq;
		// The chip and its picture appear before the resize starts; `loading` is what the spinner and
		// the send guard read until the resized data replaces the blob URL.
		const preview = previewImage(file);
		attachments.value = [
			...attachments.value,
			{ id, name: file.name || `pasted image ${id}`, loading: true, url: preview.url },
		];
		const patch = (next) => {
			attachments.value = attachments.value.map((image) => (image.id === id ? { ...image, ...next } : image));
		};
		try {
			patch({ ...(await preview.ready()), loading: false });
		} catch (error) {
			attachments.value = attachments.value.filter((image) => image.id !== id);
			showNotice(error instanceof Error ? error.message : "could not read the pasted image");
		}
	}
}

function removeImage(id) {
	attachments.value = attachments.value.filter((image) => image.id !== id);
}

/** Chat has no tools: read the file here and carry its text in the prompt instead of a path. */
async function inlineFiles(dropped) {
	for (const file of dropped) {
		fileSeq += 1;
		const chip = {
			id: fileSeq,
			name: file.name || `file ${fileSeq}`,
			size: file.size,
			progress: 0,
			path: "",
			reading: true,
		};
		files.value = [...files.value, chip];
		const update = (patch) => {
			files.value = files.value.map((entry) => (entry.id === chip.id ? { ...entry, ...patch } : entry));
		};
		try {
			const text = await inlineTextOf(file);
			if (text.length > INLINE_MAX_CHARS) {
				throw new Error(`file is too long for Chat (limit ${Math.round(INLINE_MAX_CHARS / 1000)}k characters)`);
			}
			const used = files.value.reduce((total, entry) => total + (entry.text?.length ?? 0), 0);
			if (used + text.length > INLINE_TOTAL_CHARS) {
				throw new Error(`Chat can inline at most ${Math.round(INLINE_TOTAL_CHARS / 1000)}k characters per message`);
			}
			update({ reading: false, progress: 1, text });
		} catch (error) {
			files.value = files.value.filter((entry) => entry.id !== chip.id);
			showNotice(error instanceof Error ? error.message : "could not read the file");
		}
	}
}

async function uploadFiles(dropped) {
	for (const file of dropped) {
		fileSeq += 1;
		const chip = { id: fileSeq, name: file.name || `file ${fileSeq}`, size: file.size, progress: 0, path: "" };
		files.value = [...files.value, chip];
		const update = (patch) => {
			files.value = files.value.map((entry) => (entry.id === chip.id ? { ...entry, ...patch } : entry));
		};
		try {
			const uploaded = await uploadFile(file, (fraction) => update({ progress: fraction }));
			// The server keeps its own generated file name and returns the display name separately.
			update({ progress: 1, path: uploaded.path, name: uploaded.name || chip.name });
		} catch (error) {
			files.value = files.value.filter((entry) => entry.id !== chip.id);
			showNotice(error instanceof Error ? error.message : "upload failed");
		}
	}
}

function removeFile(id) {
	files.value = files.value.filter((entry) => entry.id !== id);
}

/** Files dropped anywhere in the page: images attach inline, everything else becomes a path. */
function onDrop(event) {
	if (compacting.value) {
		// the textarea is disabled mid-compaction; dropping would desync the queue
		event.preventDefault();
		dragging.value = false;
		return;
	}
	if (editing.value) {
		// the prompt being edited has its own drop target; the composer is not the one on screen
		dragging.value = false;
		return;
	}
	const files = [...(event.dataTransfer?.files ?? [])];
	const types = [...(event.dataTransfer?.types ?? [])];
	if (files.length === 0) {
		// A drag that started in another page or app can carry a link and no bytes. Left alone the
		// browser would navigate to it, which looks like the page hanging on a drop that "worked".
		if (types.includes("Files") || (!types.includes("text/plain") && types.some((type) => type.startsWith("text/")))) {
			event.preventDefault();
			dragging.value = false;
			void attachLink(event.dataTransfer);
		}
		return;
	}
	event.preventDefault();
	dragging.value = false;
	void attachDropped(files);
}

/**
 * A drop with no bytes: our own pictures travel as `data:`/`blob:` links, so reusing one is a plain
 * fetch and goes through the normal attachment path. A link from somewhere else cannot be read by
 * the page (CORS), so it says so instead of silently doing nothing.
 */
async function attachLink(transfer) {
	const link = transfer?.getData("text/uri-list") || transfer?.getData("text/plain") || "";
	const own = imageLinkOf(link);
	const file = own ? await imageFromLink(own) : null;
	if (file) {
		await attachFiles([file]);
		return;
	}
	showNotice("that drag carried a link, not a file — paste the image instead");
}

/** Split a drop into pictures and files; a type the browser forgot is read from the header. */
async function attachDropped(dropped) {
	const images = [];
	const others = [];
	for (const file of dropped) {
		const picture = await asImageFile(file);
		if (picture) images.push(picture);
		else others.push(file);
	}
	if (images.length > 0) await attachFiles(images);
	if (others.length > 0) {
		// No tools in chat: text files are inlined, Work keeps the temp-path flow.
		if (isChat.value) await inlineFiles(others);
		else await uploadFiles(others);
	}
}

function onDragOver(event) {
	if (editing.value) return; // the inline editor highlights itself
	if (!event.dataTransfer?.types.includes("Files")) return;
	event.preventDefault();
	event.dataTransfer.dropEffect = "copy";
	dragging.value = true;
}

function onDragLeave(event) {
	// Ignore the move between child elements; only clear when the pointer leaves the window.
	if (event.relatedTarget) return;
	dragging.value = false;
}

function insertAtCursor(snippet) {
	const node = inputEl.value;
	const start = node?.selectionStart ?? text.value.length;
	const end = node?.selectionEnd ?? start;
	text.value = text.value.slice(0, start) + snippet + text.value.slice(end);
	nextTick(() => {
		if (node) {
			const caret = start + snippet.length;
			node.setSelectionRange(caret, caret);
			node.focus();
		}
		resize();
	});
}

function onPaste(event) {
	if (compacting.value) return;
	const files = imageFiles([...(event.clipboardData?.items ?? [])])
		.map((item) => item.getAsFile())
		.filter(Boolean);
	if (files.length > 0) {
		// Stop the browser from inserting the image's file name or alt text as well.
		event.preventDefault();
		void attachFiles(files);
		return;
	}
	const clip = event.clipboardData?.getData("text/plain");
	if (!clip || !readClipboard(clip).large) return;
	event.preventDefault();
	pasteSeq += 1;
	const { text: body, marker } = pasteMarker(pasteSeq, clip);
	pastes.set(pasteSeq, body);
	insertAtCursor(marker);
}

async function abort() {
	// Pause before the request: abort() settles the turn almost immediately, and agent_settled would
	// drain the queue before we ever saw the response. Always pause, so a message typed right after
	// Stop waits instead of starting a new turn the moment the abort lands. No toast: the queue
	// strip already shows the paused state.
	queuePaused.value = true;
	await post("abort");
}

function toggleSidebar() {
	modeMenu.value = false;
	if (narrow.value) {
		sidebarOpen.value = !sidebarOpen.value;
		return;
	}
	collapsed.value = !collapsed.value;
	localStorage.setItem("nife-webui.collapsed", collapsed.value ? "1" : "0");
	if (collapsed.value) {
		closeSearch();
		exitSelect();
	}
}

/** Search is an overlay: it works from the expanded header and the compact pill alike. */
async function openSearch() {
	modeMenu.value = false;
	if (selecting.value) exitSelect();
	searchOpen.value = true;
	searchQuery.value = "";
	searchResults.value = [];
	searchError.value = "";
	await nextTick();
	searchInput.value?.focus();
}

function closeSearch() {
	// Keep the query and results while the fade-out runs; the next open resets them.
	searchOpen.value = false;
	searchBusy.value = false;
	clearTimeout(searchTimer);
	searchAbort?.abort();
	searchAbort = undefined;
}

function toggleSearch() {
	if (searchOpen.value) closeSearch();
	else void openSearch();
}

/** Wait out the keystroke, then ask the bridge; stale responses are aborted, not rendered. */
function scheduleSearch() {
	clearTimeout(searchTimer);
	searchAbort?.abort();
	searchAbort = undefined;
	searchError.value = "";
	const query = searchQuery.value.trim();
	if (!query) {
		searchResults.value = [];
		searchBusy.value = false;
		return;
	}
	searchBusy.value = true;
	searchTimer = setTimeout(() => void runSearch(query), 180);
}

watch(searchQuery, scheduleSearch);

async function runSearch(query) {
	const controller = new AbortController();
	searchAbort = controller;
	try {
		const response = await fetch(api(`search?q=${encodeURIComponent(query)}`), { signal: controller.signal });
		if (!response.ok) throw new Error((await response.text()).slice(0, 200) || `search ${response.status}`);
		const payload = await response.json();
		if (searchQuery.value.trim() !== query) return;
		searchResults.value = payload.results ?? [];
	} catch (error) {
		if (error?.name === "AbortError") return;
		searchError.value = error instanceof Error ? error.message : "search failed";
	} finally {
		if (searchAbort === controller) {
			searchBusy.value = false;
			searchAbort = undefined;
		}
	}
}

/** Split a snippet into plain/highlighted runs without v-html. */
function highlightParts(text) {
	const query = searchQuery.value.trim();
	if (!query) return [{ text, hit: false }];
	const parts = [];
	const lower = text.toLowerCase();
	const needle = query.toLowerCase();
	let from = 0;
	for (;;) {
		const at = lower.indexOf(needle, from);
		if (at < 0) break;
		if (at > from) parts.push({ text: text.slice(from, at), hit: false });
		parts.push({ text: text.slice(at, at + needle.length), hit: true });
		from = at + needle.length;
	}
	if (from < text.length) parts.push({ text: text.slice(from), hit: false });
	return parts;
}

/** Open the session behind a hit and park the transcript on the matching message. */
async function openSearchResult(group, match) {
	const entryId = match?.entryId ?? group.matches?.[0]?.entryId ?? "";
	const path = group.path;
	closeSearch();
	if (group.cwd) await revealProject(group.cwd);
	if (path !== currentFile.value) {
		if (!(await attachSession(path))) return;
	}
	if (entryId) await revealEntry(entryId);
}

async function revealEntry(entryId) {
	const find = () => messages.value.findIndex((message) => message.entryId === entryId);
	let index = find();
	for (let guard = 0; index < 0 && loadedFrom.value > 0 && guard < 40; guard += 1) {
		if ((await loadOlder()) === 0) break;
		index = find();
	}
	if (index < 0) return;
	const row = rowByMessage.value.get(loadedFrom.value + index);
	if (row !== undefined) await jumpToRow(row);
}

function openFirstSearchResult() {
	const group = searchResults.value[0];
	if (group) void openSearchResult(group, group.matches?.[0]);
}

function toggleMenu(name) {
	menu.value = menu.value === name ? null : name;
	modelQuery.value = "";
}

/** Switch between the coding agent and a plain conversation, then re-read the bridge's truth. */
async function pickMode(next) {
	modeMenu.value = false;
	if (next === mode.value) return;
	const result = await postDetailed("mode", { mode: next });
	if (!result.ok) {
		showNotice(result.message || "could not switch mode");
		return;
	}
	if (selecting.value) exitSelect();
	sidebarOpen.value = false;
	freshSession.value = false;
	workspaceMenu.value = false;
	carryQueue(null);
	queue.value = [];
	if (result.data?.sid) setSessionSid(result.data.sid);
	await loadState();
	loadPinned();
	await loadGroups({ reveal: true });
}

async function pickModel(model) {
	menu.value = null;
	if (await post("model", { provider: model.provider, id: model.id })) await loadState();
}

/**
 * The model manager. Rows are the composed catalog (not only the credentialed models), so a row
 * with no key yet stays visible and can be finished or removed. Create/edit/delete write
 * models.json - the shared catalog - and the state reload shows the result in the chip and the
 * menu as well.
 */
const modelRows = computed(() => {
	const query = modelFilter.value.trim().toLowerCase();
	const rows = modelManager.value?.models ?? [];
	if (!query) return rows;
	return rows.filter(
		(row) =>
			row.id.toLowerCase().includes(query) ||
			String(row.name ?? "").toLowerCase().includes(query) ||
			row.provider.toLowerCase().includes(query),
	);
});

/** A new row on a provider nife does not have yet must carry its endpoint. */
const modelFormNeedsEndpoint = computed(() => {
	const form = modelForm.value;
	if (!form || form.mode !== "create") return false;
	return !(modelManager.value?.providers ?? []).some((provider) => provider.id === form.provider && provider.defined);
});

/** Base URL and API can be typed whenever the row lands in a models entry - a new provider's own
 *  entry, or an existing provider. modelOverrides has no endpoint field, so it is shown read-only. */
const modelFormEndpoint = computed(() => {
	const form = modelForm.value;
	if (!form) return false;
	if (form.mode === "create") return form.endpoint !== false;
	return Boolean(form.canEditEndpoint);
});

/** Providers whose entry lives in models.json - those are the endpoints this page can rewrite. */
const modelProviders = computed(() => modelManager.value?.providers ?? []);

async function openModelManager() {
	menu.value = null;
	modelManagerError.value = "";
	modelFilter.value = "";
	const response = await fetch(api("models"));
	if (!response.ok) {
		showNotice((await response.text()).slice(0, 200) || "could not load models");
		return;
	}
	try {
		modelManager.value = await response.json();
	} catch {
		showNotice("bad models response");
	}
}

async function loadModelManager() {
	const response = await fetch(api("models"));
	if (!response.ok) {
		modelManagerError.value = (await response.text()).slice(0, 200) || "could not reload models";
		return;
	}
	try {
		modelManager.value = await response.json();
	} catch {
		modelManagerError.value = "bad models response";
	}
}

function closeModelManager() {
	if (modelManagerBusy.value) return;
	modelManager.value = null;
	modelForm.value = null;
	modelDelete.value = null;
	modelFilter.value = "";
	modelManagerError.value = "";
	modelFormError.value = "";
}

function startCreateModel() {
	const providers = modelManager.value?.providers ?? [];
	modelDelete.value = null;
	modelFormError.value = "";
	modelForm.value = {
		mode: "create",
		provider: (providers.find((provider) => provider.defined) ?? providers[0])?.id ?? "",
		id: "",
		name: "",
		reasoning: false,
		input: ["text"],
		contextWindow: 128000,
		maxTokens: 16384,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		baseUrl: "",
		api: "openai-completions",
		apiKey: "",
		endpointSource: "inherited",
		inheritedEndpoint: "",
	};
}

function startEditModel(row) {
	modelDelete.value = null;
	modelFormError.value = "";
	modelForm.value = {
		mode: "edit",
		provider: row.provider,
		id: row.id,
		name: row.name ?? row.id,
		reasoning: Boolean(row.reasoning),
		input: [...(row.input ?? ["text"])],
		contextWindow: row.contextWindow,
		maxTokens: row.maxTokens,
		cost: { ...row.cost },
		baseUrl: row.baseUrl ?? "",
		api: row.api ?? "",
		canEditEndpoint: row.source === "models",
		endpointSource: row.endpointSource ?? "inherited",
		inheritedEndpoint: row.endpoint ?? "",
	};
}

/** The provider endpoint form: shared by every model of that provider, so it is edited once. */
function startEditProvider(provider) {
	const row =
		typeof provider === "string"
			? (modelProviders.value.find((entry) => entry.id === provider) ?? {
					id: provider,
					defined: true,
					baseUrl: "",
					api: null,
					hasKey: false,
				})
			: provider;
	modelDelete.value = null;
	modelFormError.value = "";
	modelForm.value = {
		mode: "provider",
		provider: row.id,
		baseUrl: row.baseUrl ?? "",
		api: row.api ?? "",
		apiKey: "",
		hasKey: Boolean(row.hasKey),
		clearKey: false,
	};
}

function cancelModelForm() {
	if (modelManagerBusy.value) return;
	modelForm.value = null;
	modelFormError.value = "";
}

async function saveModelForm() {
	const form = modelForm.value;
	if (!form || modelManagerBusy.value) return;
	modelManagerBusy.value = true;
	modelFormError.value = "";
	const endpoint = modelFormEndpoint.value ? { baseUrl: form.baseUrl, api: form.api } : {};
	const fields = {
		name: form.name,
		reasoning: form.reasoning,
		input: form.input,
		contextWindow: form.contextWindow,
		maxTokens: form.maxTokens,
		cost: form.cost,
		...endpoint,
	};
	const result =
		form.mode === "provider"
			? await postDetailed("models/provider", {
					provider: form.provider,
					baseUrl: form.baseUrl,
					api: form.api,
					...(form.apiKey.trim() ? { apiKey: form.apiKey } : {}),
					...(form.clearKey ? { clearApiKey: true } : {}),
				})
			: form.mode === "create"
				? await postDetailed("models", {
						provider: form.provider,
						id: form.id,
						...fields,
						...(modelFormNeedsEndpoint.value ? { apiKey: form.apiKey } : {}),
					})
				: await postDetailed("models/update", { provider: form.provider, id: form.id, ...fields });
	modelManagerBusy.value = false;
	if (!result.ok) {
		modelFormError.value = result.message || "could not save the model";
		return;
	}
	modelForm.value = null;
	await loadModelManager();
	await loadState();
	showNotice(form.mode === "provider" ? "Endpoint saved" : form.mode === "create" ? "Model added" : "Model saved");
}

function askDeleteModel(row) {
	modelForm.value = null;
	modelManagerError.value = "";
	modelDelete.value = { provider: row.provider, id: row.id, name: row.name ?? row.id };
}

async function confirmDeleteModel() {
	const row = modelDelete.value;
	if (!row || modelManagerBusy.value) return;
	modelManagerBusy.value = true;
	const result = await postDetailed("models/delete", { provider: row.provider, id: row.id });
	modelManagerBusy.value = false;
	modelDelete.value = null;
	if (!result.ok) {
		modelManagerError.value = result.message || "could not delete the model";
		return;
	}
	await loadModelManager();
	await loadState();
	showNotice("Model deleted");
}

async function onThinkingChange(index) {
	const level = thinkingLevels.value[index];
	if (!level) return;
	if (level === state.value.thinkingLevel) {
		thinkingDraft.value = null;
		return;
	}
	thinkingDraft.value = index;
	if (await post("thinking", { level })) await loadState();
	if (thinkingDraft.value === index) thinkingDraft.value = null;
}

/** Turn the proxy off for this session (NO_PROXY=*) or back on, then re-read the truth from nife. */
async function toggleProxy() {
	const bypass = !proxy.value.bypassed;
	const result = await postDetailed("proxy", { bypass });
	if (!result.ok) {
		showNotice(result.message || "proxy switch failed");
		return;
	}
	await loadState();
	showNotice(bypass ? "proxy off · connecting directly" : "proxy on");
}

async function switchTo(path) {
	await attachSession(path);
}

/**
 * New Work / New Chat: start the empty session right away in the last project used, then let the
 * composer's directory chip move it elsewhere until the first prompt arrives.
 */
async function newSession() {
	sidebarOpen.value = false;
	sessionMenu.value = null;
	closeSearch();
	exitSelect();
	workspaceMenu.value = false;
	newError.value = "";
	await loadProjects();
	const cwd = localStorage.getItem("nife-webui.new-cwd") || projectRoot.value || "~/.nife/project";
	await startNewSession(cwd);
}

/**
 * Create and switch to an empty session in `cwd`. From the picker a failure stays inline (the menu
 * is still open); from the sidebar there is no picker to write into, so it becomes a notice.
 */
async function startNewSession(path, { inline = false } = {}) {
	if (newBusy.value) return;
	const cwd = String(path || "").trim();
	if (!cwd) {
		if (inline) newError.value = "Enter a working directory";
		return;
	}
	newBusy.value = true;
	newError.value = "";
	carryQueue(null);
	const result = await postDetailed("new", { cwd, mode: mode.value });
	newBusy.value = false;
	if (!result.ok) {
		const message = result.message || "could not start a new session";
		if (inline) {
			newError.value = message;
		} else {
			showNotice(message);
		}
		return;
	}
	setSessionSid(result.data?.sid);
	queue.value = [];
	const resolved = typeof result.data?.cwd === "string" ? result.data.cwd : cwd;
	localStorage.setItem("nife-webui.new-cwd", resolved);
	newCwd.value = resolved;
	freshSession.value = true;
	workspaceMenu.value = false;
	await loadState();
	await loadGroups({ reveal: true });
	inputEl.value?.focus();
}

/** Open the project picker above the composer, starting at the directory this session runs in. */
function toggleWorkspacePicker() {
	workspaceMenu.value = !workspaceMenu.value;
	if (!workspaceMenu.value) return;
	newError.value = "";
	newCwd.value = "";
	// the recents list grows while the session runs, so re-read it instead of trusting the first load
	void loadProjects();
	void loadBrowse(state.value.cwd || browseHome.value || "~");
	nextTick(() => {
		newInput.value?.focus();
		newInput.value?.select();
	});
}

/** Closing with the keyboard has to hand the caret back to the prompt, not to the page. */
function closeWorkspacePicker() {
	if (!workspaceMenu.value) return;
	workspaceMenu.value = false;
	inputEl.value?.focus();
}

/** Picking the directory the session already runs in is a no-op, not another empty session. */
async function pickWorkspace(path) {
	const cwd = String(path || "").trim();
	if (!cwd) return;
	if (cwd === state.value.cwd) {
		closeWorkspacePicker();
		return;
	}
	await startNewSession(cwd, { inline: true });
}

async function answer(value) {
	const request = dialog.value;
	dialog.value = null;
	await post("dialog", value === undefined ? { id: request.id } : { id: request.id, value });
}

/**
 * Size chip: an upload shows its progress - or just "Uploading…" when the browser reports no total,
 * which is what made a slow drop look stuck at 0% - a sent file its bytes, a restored one neither.
 */
const fileSize = (file) => {
	if (file.reading) return "Reading…";
	if (typeof file.text === "string") return formatBytes(file.size ?? file.text.length);
	if (!file.path) return file.progress > 0 ? `${Math.round(file.progress * 100)}%` : "Uploading…";
	return Number.isFinite(file.size) ? formatBytes(file.size) : "attached";
};

function resize() {
	const node = inputEl.value;
	if (!node) return;
	node.style.height = "auto";
	node.style.height = `${Math.min(node.scrollHeight, 220)}px`;
}

/** Delegated: markdown code blocks carry their own copy button. */
async function onTranscriptClick(event) {
	const button = event.target?.closest?.(".code-copy");
	if (!button) return;
	const code = button.parentElement?.querySelector("code");
	if (!code) return;
	try {
		await navigator.clipboard.writeText(code.textContent ?? "");
		button.textContent = "Copied";
		setTimeout(() => {
			button.textContent = "Copy";
		}, 1200);
	} catch {
		// clipboard blocked; leave the label alone
	}
}

onMounted(async () => {
	const query = window.matchMedia("(max-width: 820px)");
	narrow.value = query.matches;
	query.addEventListener("change", (event) => {
		narrow.value = event.matches;
		// leaving the overlay layout must not leave a hidden "open" sidebar behind
		if (!event.matches) sidebarOpen.value = false;
	});
	window.addEventListener("click", () => {
		menu.value = null;
		tunnelMenu.value = false;
		sessionMenu.value = null;
		modeMenu.value = false;
		workspaceMenu.value = false;
	});
	window.addEventListener("dragover", onDragOver);
	window.addEventListener("dragleave", onDragLeave);
	window.addEventListener("drop", onDrop);
	window.addEventListener("pointerup", onPointerRelease);
	window.addEventListener("pointercancel", onPointerRelease);
	// the rail window depends on layout, so it can only be measured once the app is on screen
	await nextTick();
	updateRailOverflow();
	revealActiveTask();
	window.addEventListener("resize", () => {
		hideRailTip();
		updateRailOverflow();
	});
	window.addEventListener("keydown", (event) => {
		// keyboard scrolling is a gesture too, otherwise PageUp/ArrowUp would be read as a clamp
		if (SCROLL_KEYS.has(event.key)) markGesture();
		if (event.key !== "Escape") return;
		menu.value = null;
		tunnelMenu.value = false;
		sessionMenu.value = null;
		if (modeMenu.value) {
			modeMenu.value = false;
			return;
		}
		if (workspaceMenu.value) {
			closeWorkspacePicker();
			return;
		}
		if (deleteQueue.value.length) {
			cancelDelete();
			return;
		}
		if (renaming.value) {
			cancelRename();
			return;
		}
		if (selecting.value) {
			exitSelect();
			return;
		}
		if (searchOpen.value) {
			closeSearch();
			return;
		}
		if (modelForm.value) {
			cancelModelForm();
			return;
		}
		if (modelManager.value) {
			closeModelManager();
			return;
		}
		cancelEdit();
		if (narrow.value) sidebarOpen.value = false;
		// Answer, don't just hide: an unanswered dialog would block the agent on both sides.
		if (dialog.value) answer(undefined);
	});
	await loadState();
	// the first scan lands after the first state request, so give it a moment before ports count as
	// "new" - otherwise opening the page would announce the servers that were already there
	noteServices(state.value.services);
	setTimeout(() => {
		servicesReady = true;
	}, 3000);
	await finishTunnelDisconnect();
	await loadGroups({ reveal: true });
	connect();
	inputEl.value?.focus();
	// Streaming markdown, collapsing tool rows, loading images and a growing textarea all change the
	// transcript height after a scroll; watch the boxes instead of scrolling per token.
	resizeObserver = new ResizeObserver(() => follow());
	if (transcript.value) resizeObserver.observe(transcript.value);
	if (transcriptBody.value) resizeObserver.observe(transcriptBody.value);
});

onBeforeUnmount(() => {
	cancelAnimationFrame(sweepFrame);
	if (drainTimer) clearTimeout(drainTimer);
	resizeObserver?.disconnect();
	window.removeEventListener("dragover", onDragOver);
	window.removeEventListener("dragleave", onDragLeave);
	window.removeEventListener("drop", onDrop);
	window.removeEventListener("pointerup", onPointerRelease);
	window.removeEventListener("pointercancel", onPointerRelease);
});
</script>

<template>
	<div class="app" :class="{ collapsed, chat: isChat }">
		<nav class="sidebar" :class="{ open: sidebarOpen }">
			<div v-if="selecting" class="sidebar-head select-head">
				<span class="select-title">已选择 {{ selectedCount }} 个对话</span>
				<button type="button" class="iconbtn" title="退出多选" @click="exitSelect">
					<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
				</button>
			</div>
			<div v-else class="sidebar-head">
				<div class="brand-group">
					<span class="brand">Nife</span>
					<button
						type="button"
						class="mode-trigger"
						:class="{ open: modeMenu }"
						:aria-expanded="modeMenu"
						aria-haspopup="menu"
						:aria-label="`Switch workspace, current Nife ${isChat ? 'Chat' : 'Work'}`"
						@click.stop="modeMenu = !modeMenu"
					>
						<span>{{ isChat ? "Chat" : "Work" }}</span>
						<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 6.5L8 10l3.5-3.5" /></svg>
					</button>
					<Transition name="mode-pop">
						<div v-if="modeMenu" class="mode-menu" role="menu" @click.stop>
							<button
								type="button"
								class="mode-option"
								:class="{ active: !isChat }"
								role="menuitemradio"
								:aria-checked="!isChat"
								@click="pickMode('work')"
							>
								<span class="mode-copy">
									<strong>Nife Work</strong>
									<small>构建、调试与发布</small>
								</span>
								<svg v-if="!isChat" class="mode-check" viewBox="0 0 16 16" aria-hidden="true">
									<path d="M3.5 8.5l3 3 6-7" />
								</svg>
							</button>
							<button
								type="button"
								class="mode-option"
								:class="{ active: isChat }"
								role="menuitemradio"
								:aria-checked="isChat"
								@click="pickMode('chat')"
							>
								<span class="mode-copy">
									<strong>Nife Chat</strong>
									<small>专注思考与交流</small>
								</span>
								<svg v-if="isChat" class="mode-check" viewBox="0 0 16 16" aria-hidden="true">
									<path d="M3.5 8.5l3 3 6-7" />
								</svg>
							</button>
						</div>
					</Transition>
				</div>
				<div class="head-actions">
					<button
						type="button"
						class="iconbtn"
						:class="{ active: searchOpen }"
						:title="searchOpen ? 'Close search' : 'Search conversations'"
						@click.stop="toggleSearch"
					>
						<svg viewBox="0 0 16 16" aria-hidden="true">
							<circle cx="7" cy="7" r="4.2" />
							<path d="M10.2 10.2L14 14" />
						</svg>
					</button>
					<button type="button" class="iconbtn" title="Collapse sidebar" @click.stop="toggleSidebar">
						<svg viewBox="0 0 16 16" aria-hidden="true">
							<rect x="2.5" y="3" width="11" height="10" rx="2" />
							<path d="M6.5 3.5v9" />
						</svg>
					</button>
				</div>
			</div>

			<button v-if="!selecting" type="button" class="new-chat" @click="newSession">
				<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg>
				{{ isChat ? "New Chat" : "New Work" }}
			</button>

			<div v-if="!selecting" class="section-label">{{ isChat ? "Chats" : "Recents" }}</div>
			<div class="session-list" :class="{ picking: selecting }">
				<p v-if="groups.length === 0" class="muted pad">{{ isChat ? "No chats yet." : "No sessions yet." }}</p>
				<div v-for="group in sessionGroups" :key="group.key" class="session-group">
					<div
						class="session-group-head"
						:class="{ current: group.current, disabled: selecting }"
						:title="group.cwd || 'Unknown project'"
					>
						<button
							type="button"
							class="session-group-toggle"
							:aria-expanded="!groupCollapsed(group.key)"
							@click="toggleProjectGroup(group)"
						>
							<svg class="session-group-chevron" :class="{ collapsed: groupCollapsed(group.key) }" viewBox="0 0 16 16" aria-hidden="true">
								<path d="M4.5 6.5L8 10l3.5-3.5" />
							</svg>
							<span v-if="group.current" class="session-group-current" title="Current project"></span>
							<span class="session-group-name">{{ group.name }}</span>
							<span class="session-group-count">{{ group.count }}</span>
						</button>
						<button
							v-if="!selecting"
							type="button"
							class="session-group-delete"
							title="删除工作区会话"
							aria-label="删除工作区会话"
							@click.stop="askDeleteProject(group)"
						>
							<svg viewBox="0 0 16 16" aria-hidden="true">
								<path d="M3 4.5h10M6.5 4.5V2.5h3v2M4.8 4.5l.6 9h5.2l.6-9" />
							</svg>
						</button>
					</div>
					<div class="session-group-body" :class="{ collapsed: groupCollapsed(group.key) }">
						<div class="session-group-inner">
							<p v-if="group.loading && !group.loaded" class="session-group-hint">Loading…</p>
							<p v-else-if="group.loaded && group.sessions.length === 0" class="session-group-hint">No sessions</p>
				<div
					v-for="session in group.sessions"
					:key="session.path"
					:class="[
						'session',
						session.path === currentFile ? 'current' : '',
						selectedPaths.includes(session.path) ? 'selected' : '',
					]"
				>
					<button v-if="selecting" type="button" class="session-pick" @click="toggleSelected(session)">
						<span class="pick-box" :class="{ checked: selectedPaths.includes(session.path) }">
							<svg v-if="selectedPaths.includes(session.path)" viewBox="0 0 16 16" aria-hidden="true">
								<path d="M3.5 8.5l3 3 6-7" />
							</svg>
						</span>
						<span class="session-copy">
							<span class="session-name">{{ sessionTitle(session) }}</span>
						</span>
					</button>
					<input
						v-else-if="renaming === session.path"
						ref="renameEl"
						v-model="renameText"
						class="session-rename"
						aria-label="Session name"
						@click.stop
						@keydown.enter.prevent="commitRename(session)"
						@keydown.esc.prevent="cancelRename"
						@blur="commitRename(session)"
					/>
					<template v-else>
						<button type="button" class="session-main" @click="switchTo(session.path)">
							<span class="session-copy">
								<span class="session-name">{{ sessionTitle(session) }}</span>
							</span>
							<span
							v-if="session.running"
							class="session-state running"
							title="正在后台运行"
							aria-label="running"
						></span>
						<span
							v-else-if="session.done"
							class="session-state done"
							title="已完成，点开查看"
							aria-label="finished"
						></span>
						<span v-if="isPinned(session.path)" class="session-pin" title="Pinned">
								<svg viewBox="0 0 16 16" aria-hidden="true">
									<path d="M9.6 2.4l4 4-1.7.5-2.3 2.3.5 2.2-1 1L4.4 7.7l1-1 2.2.5L9.9 4.9z" />
									<path d="M6.3 9.7L3 13" />
								</svg>
							</span>
							<span class="session-when">{{ when(session.modified) }}</span>
						</button>
						<button
							type="button"
							class="session-more"
							:class="{ open: sessionMenu?.session.path === session.path }"
							title="Session actions"
							aria-label="Session actions"
							@click.stop="toggleSessionMenu($event, session)"
						>
							<svg viewBox="0 0 16 16" aria-hidden="true">
								<circle cx="3.5" cy="8" r="1.2" />
								<circle cx="8" cy="8" r="1.2" />
								<circle cx="12.5" cy="8" r="1.2" />
							</svg>
						</button>
					</template>
				</div>
						</div>
					</div>
				</div>
			</div>

			<div v-if="selecting" class="select-bar">
				<button type="button" class="select-action" :disabled="!selectedCount" @click="pinSelected">
					<svg viewBox="0 0 16 16" aria-hidden="true">
						<path d="M9.6 2.4l4 4-1.7.5-2.3 2.3.5 2.2-1 1L4.4 7.7l1-1 2.2.5L9.9 4.9z" />
						<path d="M6.3 9.7L3 13" />
					</svg>
					<span>{{ allSelectedPinned ? "取消置顶" : "置顶" }}</span>
				</button>
				<span class="select-sep"></span>
				<button type="button" class="select-action danger" :disabled="!selectedCount" @click="askDeleteSelected">
					<svg viewBox="0 0 16 16" aria-hidden="true">
						<path d="M3 4.5h10M6.5 4.5V2.5h3v2M4.8 4.5l.6 9h5.2l.6-9" />
					</svg>
					<span>删除</span>
				</button>
			</div>

			<div v-else class="sidebar-foot">
				<span class="muted ellipsis foot-path">{{ state.cwd }}</span>
				<!-- No nifetun extension, no tunnel control: the bridge reports whether it is usable -->
				<button
					v-if="state.tunnelAvailable"
					type="button"
					class="tunnel-chip"
					:class="{ pending: tunnelPending, open: pageTunnel }"
					:title="tunnelTitle"
					@click.stop="tunnelMenu = !tunnelMenu"
				>
					<span v-if="tunnelPending" class="tunnel-wait"></span>
					<svg v-else-if="pageTunnel && !localHost" viewBox="0 0 16 16" aria-hidden="true">
						<path d="M4 4l8 8M12 4l-8 8" />
					</svg>
					<svg v-else viewBox="0 0 16 16" aria-hidden="true">
						<path d="M6.5 9.5a2.5 2.5 0 0 0 3.6 0l2-2a2.5 2.5 0 0 0-3.5-3.5l-1 1M9.5 6.5a2.5 2.5 0 0 0-3.6 0l-2 2a2.5 2.5 0 0 0 3.5 3.5l1-1" />
					</svg>
					tunnel
				</button>

				<!-- The tunnel menu, the same shape as the model selector: this page first, then the ports
				     the session serves, then a slot for a port nobody detected. The page's own port is
				     never listed: it is what this menu belongs to. -->
				<div v-if="tunnelMenu && state.tunnelAvailable" class="menu tunnel-menu" @click.stop>
					<button type="button" class="menu-item tunnel-page" :disabled="tunnelPending" @click="toggleTunnel">
						<svg viewBox="0 0 16 16" aria-hidden="true">
							<path d="M6.5 9.5a2.5 2.5 0 0 0 3.6 0l2-2a2.5 2.5 0 0 0-3.5-3.5l-1 1M9.5 6.5a2.5 2.5 0 0 0-3.6 0l-2 2a2.5 2.5 0 0 0 3.5 3.5l1-1" />
						</svg>
						<span class="ellipsis">Nife Web</span>
						<span class="tunnel-action" :class="{ waiting: tunnelPending }">{{ pageAction }}</span>
					</button>

					<div class="menu-label">Server</div>
					<div class="menu-list">
						<div v-for="row in serverRows" :key="`server-${row.port}`" class="menu-item tunnel-row">
							<span class="ellipsis" :title="row.cmd ? `${row.cmd} on 127.0.0.1:${row.port}` : `127.0.0.1:${row.port}`">
								<span class="muted">{{ row.port }}</span>
								<template v-if="row.cmd"> · {{ row.cmd }}</template>
							</span>
							<template v-if="row.url">
								<a class="tunnel-row-open" :href="row.url" target="_blank" rel="noreferrer">open</a>
								<button
									type="button"
									class="tunnel-row-x"
									:title="`Stop publishing ${row.port}`"
									@click="unpublishService(row)"
								>
									×
								</button>
							</template>
							<button
								v-else
								type="button"
								class="tunnel-row-plus"
								:disabled="Boolean(serviceBusy)"
								:title="`Publish ${row.port} through nifetun`"
								@click="publishService(row)"
							>
								<span v-if="serviceBusy === row.port" class="tunnel-wait"></span>
								<template v-else>+</template>
							</button>
						</div>
						<p v-if="!serverRows.length" class="muted pad">Nothing listening</p>
					</div>

					<div class="menu-footer">
						<div class="menu-label">Custom Port</div>
						<div v-for="row in customRows" :key="`custom-${row.port}`" class="menu-item tunnel-row">
							<span class="ellipsis muted">{{ row.port }}</span>
							<a class="tunnel-row-open" :href="row.url" target="_blank" rel="noreferrer">open</a>
							<button type="button" class="tunnel-row-x" :title="`Stop publishing ${row.port}`" @click="unpublishService(row)">
								×
							</button>
						</div>
						<input
							v-model="manualValue"
							class="menu-search tunnel-add"
							inputmode="numeric"
							placeholder="port"
							aria-label="Port to publish"
							:disabled="manualBusy"
							@keydown.enter.prevent="publishManual"
							@keydown.esc.prevent="tunnelMenu = false"
						/>
					</div>
				</div>
			</div>
		</nav>

		<!-- Session actions: fixed, so the list's scroll box cannot clip the menu. -->
		<Teleport to="body">
			<div
				v-if="sessionMenu"
				class="session-menu"
				:style="{ top: `${sessionMenu.top}px`, left: `${sessionMenu.left}px` }"
				@click.stop
			>
				<button type="button" class="session-menu-item" @click="startRename(sessionMenu.session)">
					<svg viewBox="0 0 16 16" aria-hidden="true">
						<path d="M3 13l.6-3L11 2.6a1.5 1.5 0 0 1 2.1 0l.3.3a1.5 1.5 0 0 1 0 2.1L6 12.4 3 13zM9.8 4.2l2 2" />
					</svg>
					<span>重命名</span>
				</button>
				<button type="button" class="session-menu-item" @click="togglePin(sessionMenu.session)">
					<svg viewBox="0 0 16 16" aria-hidden="true">
						<path d="M9.6 2.4l4 4-1.7.5-2.3 2.3.5 2.2-1 1L4.4 7.7l1-1 2.2.5L9.9 4.9z" />
						<path d="M6.3 9.7L3 13" />
					</svg>
					<span>{{ isPinned(sessionMenu.session.path) ? "取消置顶" : "置顶" }}</span>
				</button>
				<button type="button" class="session-menu-item" @click="enterSelect(sessionMenu.session)">
					<svg viewBox="0 0 16 16" aria-hidden="true">
						<path d="M6 4h7M6 8h7M6 12h7" />
						<rect x="2.5" y="3" width="2" height="2" rx="0.6" />
						<rect x="2.5" y="7" width="2" height="2" rx="0.6" />
						<rect x="2.5" y="11" width="2" height="2" rx="0.6" />
					</svg>
					<span>多选</span>
				</button>
				<div class="session-menu-sep"></div>
				<button type="button" class="session-menu-item danger" @click="askDeleteSession(sessionMenu.session)">
					<svg viewBox="0 0 16 16" aria-hidden="true">
						<path d="M3 4.5h10M6.5 4.5V2.5h3v2M4.8 4.5l.6 9h5.2l.6-9" />
					</svg>
					<span>删除</span>
				</button>
			</div>
		</Teleport>

		<!-- Full-text search: centred palette, animated in and out. -->
		<Teleport to="body">
			<Transition name="search-pop">
				<div v-if="searchOpen" class="search-modal" @click.self="closeSearch">
					<div class="search-panel" role="dialog" aria-modal="true" aria-label="搜索当前工作区的所有项目">
						<div class="search-input-row">
							<svg viewBox="0 0 16 16" aria-hidden="true">
								<circle cx="7" cy="7" r="4.2" />
								<path d="M10.2 10.2L14 14" />
							</svg>
							<input
								ref="searchInput"
								v-model="searchQuery"
								type="text"
								placeholder="搜索当前工作区的所有项目"
								aria-label="搜索当前工作区的所有项目"
								@keydown.esc.prevent.stop="closeSearch"
								@keydown.enter.prevent="openFirstSearchResult"
							/>
							<button type="button" class="search-close" title="Close search" @click="closeSearch">
								<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
							</button>
						</div>

						<div class="search-body">
							<p v-if="!searchQuery.trim()" class="search-hint">搜索当前工作区所有项目的标题和消息内容</p>
							<p v-else-if="searchBusy && searchResults.length === 0" class="search-hint">正在搜索…</p>
							<p v-else-if="searchError" class="search-hint error">{{ searchError }}</p>
							<p v-else-if="searchResults.length === 0" class="search-hint">没有找到匹配的内容</p>
							<template v-else>
								<div v-for="group in searchResults" :key="group.path" class="search-group">
									<button type="button" class="search-session" @click="openSearchResult(group, group.matches[0])">
										<span class="search-session-title">{{ sessionTitle(group) }}</span>
										<span v-if="projectTag(group)" class="search-session-project" :title="group.cwd">{{ projectTag(group) }}</span>
										<span class="search-session-date">{{ when(group.modified) }}</span>
									</button>
									<button
										v-for="match in group.matches"
										:key="`${group.path}:${match.entryId}`"
										type="button"
										class="search-match"
										@click="openSearchResult(group, match)"
									>
										<span
											v-for="(part, index) in highlightParts(match.text)"
											:key="index"
											:class="{ hit: part.hit }"
										>{{ part.text }}</span>
									</button>
								</div>
							</template>
						</div>
					</div>
				</div>
			</Transition>
		</Teleport>

		<!-- Narrow screens: the sidebar is an overlay, so tapping anywhere else closes it. -->
		<div v-if="narrow && sidebarOpen" class="sidebar-backdrop" @click="sidebarOpen = false"></div>

		<section class="main">
			<header class="topbar">
				<div v-if="narrow || collapsed" class="top-actions-pill">
					<button type="button" class="iconbtn" title="Open sidebar" @click.stop="toggleSidebar">
						<svg viewBox="0 0 16 16" aria-hidden="true">
							<rect x="2.5" y="3" width="11" height="10" rx="2" />
							<path d="M6.5 3.5v9" />
						</svg>
					</button>
					<button type="button" class="iconbtn" title="Search conversations" @click.stop="openSearch">
						<svg viewBox="0 0 16 16" aria-hidden="true">
							<circle cx="7" cy="7" r="4.2" />
							<path d="M10.2 10.2L14 14" />
						</svg>
					</button>
					<button type="button" class="iconbtn" :title="isChat ? 'New Chat' : 'New Work'" @click.stop="newSession">
						<svg viewBox="0 0 16 16" aria-hidden="true">
							<path d="M13.2 7.8a5.2 5.2 0 0 1-7.6 4.5L3 13l.7-2.6A5.2 5.2 0 1 1 13.2 7.8z" />
							<path d="M8 5.8v4M6 7.8h4" />
						</svg>
					</button>
				</div>
				<div class="titles">
					<strong class="ellipsis">{{ title }}</strong>
				</div>
				<div class="topbar-right">
					<span v-for="child in subagents" :key="child.id" class="agent-chip" title="Subagent running">
						<span class="agent-dot"></span>
						{{ child.agent || "agent" }}<template v-if="child.count > 1"> ×{{ child.count }}</template>
					</span>
					<span class="dot" :class="{ busy: streaming, offline: !online }"></span>
				</div>
			</header>

			<main
				ref="transcript"
				class="transcript"
				@scroll.passive="onTranscriptScroll"
				@wheel.passive="onTranscriptWheel"
				@touchstart.passive="onTranscriptTouch"
				@pointerdown.passive="onTranscriptPointerDown"
				@click="onTranscriptClick"
			>
				<div ref="transcriptBody" class="transcript-body">
					<div v-if="messages.length === 0 && !live" class="empty">
						<h1>{{ isChat ? "What's on your mind?" : "What should we build?" }}</h1>
						<p class="muted">
							{{
								isChat
									? "A quieter space for questions, ideas, and thinking out loud."
									: "This page drives the session running in your terminal. Anything you send here shows up in the CLI too."
							}}
						</p>
					</div>

					<div
						v-if="padPx > 0 || runStart > 0"
						class="window-pad"
						:style="{ height: `${padPx}px` }"
						aria-hidden="true"
					></div>

					<template v-for="(row, index) in visibleRows" :key="rowKey(row)">
						<details
							v-if="row.kind === 'process'"
							class="process"
							:class="{ failed: row.counts.failed, working: rowWorking(row) }"
							:open="openRows.has(rowKey(row))"
							:data-row="runStart + index"
							@toggle="onRowToggle(row, $event)"
							@click="onRowClick(row, $event)"
						>
							<summary>
								<span class="chev"></span>
								<svg
									v-if="rowWorking(row)"
									class="think-icon spinning"
									viewBox="0 0 16 16"
									aria-hidden="true"
								>
									<path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4" />
								</svg>
								<span class="tool-verb">{{ rowWorking(row) ? "Working" : "Worked" }}</span>
								<span class="tool-arg ellipsis">{{
									rowKey(row) === liveRowKey
										? stepLabel({ tools: row.counts.tools, thoughts: row.counts.thoughts + 1 })
										: stepLabel(row.counts)
								}}</span>
							</summary>
							<div class="process-body">
								<!-- The row opened before its content arrived: say so instead of showing the
								     empty markers the first page carried and letting it look broken. -->
								<div v-if="stepsLoading.has(rowKey(row))" class="steps-loading">
									<svg class="think-icon spinning" viewBox="0 0 16 16" aria-hidden="true">
										<path
											d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4"
										/>
									</svg>
									<span>loading {{ row.counts.tools + row.counts.thoughts }} steps…</span>
								</div>
								<button
									v-else-if="stepsFailed.has(rowKey(row))"
									type="button"
									class="steps-loading failed"
									@click="ensureSteps(row)"
								>
									could not load the steps · retry
								</button>
								<template v-else>
									<MessageItem v-for="(step, i) in row.steps" :key="i" :item="step" flat />
									<LiveThinking
										v-if="rowKey(row) === liveRowKey"
										:live="live"
										:open="openRows.has(rowKey(row))"
									/>
								</template>
							</div>
						</details>
						<MessageEdit
							v-else-if="editing && editing.entryId === row.message?.entryId"
							:item="row"
							:data-row="runStart + index"
							:busy="editing.busy"
							:draft="editing.draft"
							:chat="isChat"
							@cancel="cancelEdit"
							@submit="submitEdit"
							@draft="keepDraft"
							@notice="showNotice"
						/>
						<MessageItem
							v-else
							:item="row"
							:data-row="runStart + index"
							:retryable="row.index === lastAnswerIndex"
							@edit="openEdit"
							@retry="retryAnswer"
						/>
					</template>

					<!-- Only when there is something to draw: an empty live block still carries its margins,
					     and mounting it for the tick before the first delta arrives made the page blink. -->
					<LiveMessage
						v-if="live && (liveHasText || (!liveHosted && live.thinking))"
						:live="live"
						:hosted="liveHosted"
					/>

					<!-- The send landed but the run has nothing to show yet: hold the "Working" line for it. -->
					<div v-if="waitingForModel" class="msg waiting" aria-live="polite">
						<!-- the width of the real row's chevron: the line must not jump when it replaces this -->
						<span class="waiting-spacer" aria-hidden="true"></span>
						<svg class="think-icon spinning" viewBox="0 0 16 16" aria-hidden="true">
							<path
								d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4"
							/>
						</svg>
						<span class="tool-verb">Working</span>
					</div>

					<div v-if="tailPad > 0" class="window-pad" :style="{ height: `${tailPad}px` }" aria-hidden="true"></div>
				</div>

				<nav v-if="tasks.length > 1" class="rail" aria-label="Tasks">
					<button
						v-if="railOverflow"
						type="button"
						class="rail-nav"
						title="Earlier tasks"
						@click="scrollRail(-1)"
					>
						<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 10l4-4 4 4" /></svg>
					</button>
					<div
						ref="railList"
						class="rail-list"
						tabindex="0"
						aria-label="Task list, scrollable"
						@scroll.passive="hideRailTip"
						@keydown.esc="railList?.blur()"
					>
						<button
							v-for="task in railMarks"
							:key="task.index"
							type="button"
							class="rail-dot"
							:class="{ active: task.index === activeTaskIndex }"
							:aria-label="task.label"
							@mouseenter="showRailTip($event, task)"
							@mouseleave="hideRailTip"
							@focus="showRailTip($event, task)"
							@blur="hideRailTip"
							@click="jumpToTask(task)"
						></button>
					</div>
					<button
						v-if="railOverflow"
						type="button"
						class="rail-nav"
						title="Later tasks"
						@click="scrollRail(1)"
					>
						<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" /></svg>
					</button>
				</nav>
				<div v-if="railTip" class="rail-tip" :style="{ top: `${railTip.top}px` }">{{ railTip.text }}</div>
				<button
					v-if="!stick"
					type="button"
					class="jump-latest"
					title="Scroll to the newest message"
					@click="scrollToBottom"
				>
					<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M4 8.5l4 4 4-4" /></svg>
					Latest
				</button>
			</main>

			<form class="composer" @submit.prevent="send">
				<p v-if="notice" class="composer-notice" :style="noticeStyle">{{ notice }}</p>

				<!-- queue strip: narrower than the composer box and flush against its top edge -->
				<!-- no items, no strip: a paused empty queue would be a popup with nothing in it -->
				<div v-if="queue.length > 0" class="queue" :class="{ paused: queuePaused }">
					<div class="queue-head">
						<span class="queue-title">
							{{ queuePaused ? "Paused" : "Queue" }} · {{ queue.length }}
						</span>
						<button
							v-if="queuePaused || queue[0]?.error"
							type="button"
							class="queue-action resume"
							@click="resumeQueue"
						>
							{{ queuePaused ? "Resume" : "Retry" }}
						</button>
						<button type="button" class="queue-action" @click="clearQueue">Clear</button>
					</div>
					<div v-if="queue.length > 0" class="queue-list">
						<div v-for="(item, index) in queue" :key="item.id" class="queue-item">
							<span class="queue-index">{{ index + 1 }}</span>
							<button
								type="button"
								class="queue-text ellipsis"
								:title="`Edit: ${previewOf(item.text) || metaOf(item) || 'queued item'}`"
								@click="editQueued(index)"
							>
								{{ previewOf(item.text) || metaOf(item) || "empty" }}
							</button>
							<span v-if="item.error" class="queue-error" :title="item.error">failed</span>
							<span v-else-if="draining && index === 0 && !queuePaused" class="queue-state">sending…</span>
							<span v-else-if="metaOf(item)" class="queue-meta">{{ metaOf(item) }}</span>
							<button
								type="button"
								class="queue-remove"
								title="Remove from queue"
								@click="removeQueued(index)"
							>
								×
							</button>
						</div>
					</div>
				</div>
				<div ref="composerBox" class="composer-box" :class="{ dragging }">
					<svg
						class="box-progress"
						:class="{ compacting }"
						aria-hidden="true"
						:title="compacting ? 'compacting context' : contextPercent !== null ? `context ${Math.round(contextPercent)}%` : undefined"
					>
						<rect class="progress-track" x="0" y="0" width="100%" height="100%" rx="19" pathLength="100" />
						<rect
							class="progress-value"
							x="0"
							y="0"
							width="100%"
							height="100%"
							rx="19"
							pathLength="100"
							:stroke-dasharray="`${progressPercent} 100`"
						/>
					</svg>
					<!-- New session: where it runs is part of the prompt, not a separate dialog. The chip is
					     only there while the session is empty; the first message settles the directory. -->
					<div v-if="freshSession" class="workspace-row">
						<button
							type="button"
							class="workspace-chip"
							:class="{ open: workspaceMenu }"
							:aria-expanded="workspaceMenu"
							aria-haspopup="dialog"
							:disabled="newBusy"
							title="选择这个对话所在的项目目录"
							@click.stop="toggleWorkspacePicker"
						>
							<svg viewBox="0 0 16 16" aria-hidden="true">
								<path d="M2.2 4.9a1.5 1.5 0 0 1 1.5-1.5h2.2l1.3 1.6h4.9a1.5 1.5 0 0 1 1.5 1.5v4.6a1.5 1.5 0 0 1-1.5 1.5H3.7a1.5 1.5 0 0 1-1.5-1.5z" />
							</svg>
							<span class="workspace-chip-name">{{ projectName(state.cwd) }}</span>
							<span class="workspace-chip-path ellipsis">{{ state.cwd }}</span>
							<svg class="workspace-chip-caret" viewBox="0 0 16 16" aria-hidden="true">
								<path d="M4.5 6.5L8 10l3.5-3.5" />
							</svg>
						</button>

						<div v-if="workspaceMenu" class="menu workspace-menu" role="dialog" aria-label="选择项目目录" @click.stop>
							<label class="workspace-search">
								<svg viewBox="0 0 16 16" aria-hidden="true">
									<circle cx="7" cy="7" r="4.2" />
									<path d="M10.2 10.2L14 14" />
								</svg>
								<input
									ref="newInput"
									v-model="newCwd"
									type="text"
									autocomplete="off"
									spellcheck="false"
									placeholder="搜索项目，或直接输入路径"
									@keydown.enter.prevent="pickWorkspace(targetPath)"
									@keydown.esc.prevent.stop="closeWorkspacePicker()"
								/>
								<button
									v-if="newCwd"
									type="button"
									class="workspace-clear"
									title="清除"
									aria-label="清除"
									@click="newCwd = ''"
								>
									×
								</button>
							</label>

							<!-- typing: known projects, then the typed path as its own "create here" row -->
							<template v-if="newCwd.trim()">
								<div v-if="filteredProjects.length" class="workspace-list">
									<button
										v-for="entry in filteredProjects"
										:key="entry.path"
										type="button"
										class="workspace-option"
										:class="{ selected: entry.path === state.cwd }"
										:disabled="newBusy"
										@click="pickWorkspace(entry.path)"
									>
										<svg viewBox="0 0 16 16" aria-hidden="true">
											<path d="M2.2 4.9a1.5 1.5 0 0 1 1.5-1.5h2.2l1.3 1.6h4.9a1.5 1.5 0 0 1 1.5 1.5v4.6a1.5 1.5 0 0 1-1.5 1.5H3.7a1.5 1.5 0 0 1-1.5-1.5z" />
										</svg>
										<span class="workspace-option-copy">
											<span class="workspace-option-name ellipsis">{{ entry.name }}</span>
											<span class="workspace-option-path ellipsis">{{ entry.path }}</span>
										</span>
										<span v-if="entry.path === state.cwd" class="workspace-option-kind">当前</span>
										<span v-else class="workspace-option-kind">
											{{ entry.kind === "default" ? "默认" : entry.kind === "recent" ? "最近" : "项目" }}
										</span>
									</button>
								</div>
								<button
									v-if="newPathRow"
									type="button"
									class="workspace-option create"
									:disabled="newBusy"
									@click="pickWorkspace(newCwd)"
								>
									<svg viewBox="0 0 16 16" aria-hidden="true">
										<path d="M8 3.5v9M3.5 8h9" />
									</svg>
									<span class="workspace-option-copy">
										<span class="workspace-option-name">在此新建对话</span>
										<span class="workspace-option-path ellipsis">{{ newCwd.trim() }}</span>
									</span>
								</button>
							</template>

							<!-- empty input: browse the filesystem, no path knowledge needed -->
							<template v-else>
								<div class="workspace-quick">
									<p class="workspace-label">常用位置</p>
									<button
										v-for="spot in quickSpots"
										:key="spot.path"
										type="button"
										class="workspace-spot"
										:class="{ selected: spot.path === browseDir }"
										title="打开这个文件夹"
										@click="enterDir(spot.path)"
									>
										<svg v-if="spot.name === '主目录'" viewBox="0 0 16 16" aria-hidden="true">
											<path d="M3 7.4L8 3l5 4.4V13H3z" />
											<path d="M6.4 13V9.5h3.2V13" />
										</svg>
										<svg v-else viewBox="0 0 16 16" aria-hidden="true">
											<path d="M2.2 4.9a1.5 1.5 0 0 1 1.5-1.5h2.2l1.3 1.6h4.9a1.5 1.5 0 0 1 1.5 1.5v4.6a1.5 1.5 0 0 1-1.5 1.5H3.7a1.5 1.5 0 0 1-1.5-1.5z" />
										</svg>
										<span class="workspace-spot-name">{{ spot.name }}</span>
										<span class="workspace-spot-path ellipsis">{{ spot.path }}</span>
									</button>
								</div>

								<div class="workspace-browse">
									<div class="workspace-crumbs">
										<button
											type="button"
											class="workspace-up"
											:disabled="!browseParent"
											title="上一级"
											aria-label="上一级"
											@click="enterDir(browseParent)"
										>
											<svg viewBox="0 0 16 16" aria-hidden="true">
												<path d="M8 12.5v-9M4.5 8L8 4.5 11.5 8" />
											</svg>
										</button>
										<div class="workspace-crumb-row">
											<template v-for="(crumb, index) in browseCrumbs" :key="crumb.path">
												<span v-if="index" class="workspace-crumb-sep" aria-hidden="true">›</span>
												<button
													type="button"
													class="workspace-crumb"
													:title="crumb.path"
													@click="enterDir(crumb.path)"
												>
													{{ crumb.name }}
												</button>
											</template>
										</div>
									</div>

									<div class="workspace-list">
										<p v-if="browseBusy" class="workspace-hint-row">读取文件夹…</p>
										<p v-else-if="browseError" class="workspace-error">{{ browseError }}</p>
										<div v-else-if="!browseDirs.length" class="workspace-blank">
											<span>这个文件夹里没有子文件夹</span>
											<span class="workspace-blank-hint">可以点上方的「主目录」，或直接输入路径</span>
										</div>
										<button
											v-for="dir in browseDirs"
											:key="dir.path"
											type="button"
											class="workspace-option folder"
											@click="enterDir(dir.path)"
										>
											<svg viewBox="0 0 16 16" aria-hidden="true">
												<path d="M2.2 4.9a1.5 1.5 0 0 1 1.5-1.5h2.2l1.3 1.6h4.9a1.5 1.5 0 0 1 1.5 1.5v4.6a1.5 1.5 0 0 1-1.5 1.5H3.7a1.5 1.5 0 0 1-1.5-1.5z" />
											</svg>
											<span class="workspace-option-name ellipsis">{{ dir.name }}</span>
											<svg class="workspace-option-chev" viewBox="0 0 16 16" aria-hidden="true">
												<path d="M6.5 4.5L10 8l-3.5 3.5" />
											</svg>
										</button>
									</div>
								</div>
							</template>

							<p v-if="newError" class="workspace-error">{{ newError }}</p>

							<div class="workspace-foot">
								<span class="workspace-target ellipsis" :title="targetPath">{{ targetPath }}</span>
								<span v-if="targetIsTemp" class="workspace-temp" title="临时目录里的会话不会被保留">临时</span>
								<button type="button" class="workspace-cancel" @click="closeWorkspacePicker()">取消</button>
								<button
									type="button"
									class="workspace-go"
									:disabled="newBusy || !targetPath || targetPath === state.cwd"
									@click="pickWorkspace(targetPath)"
								>
									{{ targetPath && targetPath === state.cwd ? "已是当前目录" : "在此新建对话" }}
								</button>
							</div>
						</div>
					</div>
					<div v-if="attachments.length > 0 || files.length > 0" class="attachments">
						<figure v-for="image in attachments" :key="image.id" class="attachment" :class="{ loading: image.loading }">
							<img :src="image.url" :alt="image.name" :title="image.loading ? 'preparing…' : image.name" />
							<button type="button" class="attachment-remove" title="Remove image" @click="removeImage(image.id)">
								×
							</button>
						</figure>
						<div v-for="file in files" :key="file.id" class="file-chip" :title="file.path || file.name">
							<FileIcon :name="file.name" />
							<span class="file-meta">
								<span class="file-name ellipsis">{{ file.name }}</span>
								<span class="file-size">{{ fileSize(file) }}</span>
							</span>
							<button type="button" class="attachment-remove" title="Remove file" @click="removeFile(file.id)">
								×
							</button>
							<span
							v-if="!file.path && typeof file.text !== 'string'"
							class="file-progress"
							:style="{ width: `${Math.round(file.progress * 100)}%` }"
						></span>
						</div>
					</div>
					<textarea
						ref="inputEl"
						v-model="text"
						rows="1"
						:placeholder="isChat ? 'Message Nife Chat' : 'Describe a task, or ask a question'"
						:disabled="compacting"
						@input="resize"
						@paste="onPaste"
						@keydown="onComposerKeydown"
					></textarea>
					<div class="composer-foot">
						<div class="foot-left">
							<div class="menu-wrap">
								<button type="button" class="chip" @click.stop="toggleMenu('model')">
									<span class="ellipsis">{{ modelLabel }}</span>
									<span
										v-if="thinkingLevels.length > 1"
										class="chip-effort"
										:style="thinkingTone ? { color: thinkingTone } : undefined"
									>
										{{ thinkingLevels[thinkingValue] }}
									</span>
									<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" /></svg>
								</button>

								<div v-if="menu === 'model'" class="menu model-menu" @click.stop>
									<input
										v-if="(state.models ?? []).length > 12"
										v-model="modelQuery"
										class="menu-search"
										placeholder="Filter models"
									/>
									<div class="menu-list">
										<button
											v-for="model in filteredModels"
											:key="`${model.provider}/${model.id}`"
											type="button"
											:class="['menu-item', isCurrentModel(model) && 'active']"
											@click="pickModel(model)"
										>
											<span class="ellipsis">{{ model.name || model.id }}</span>
											<span class="menu-hint">{{ model.provider }}</span>
										</button>
										<p v-if="filteredModels.length === 0" class="muted pad">No models</p>
									</div>
									<div v-if="thinkingLevels.length > 1" class="menu-footer">
										<EffortSlider :levels="thinkingLevels" :index="thinkingValue" @change="onThinkingChange" />
									</div>
									<!-- context tools keep their own section: they are actions, not reasoning settings -->
									<div class="menu-footer">
										<div class="menu-label">Tools</div>
										<button
											type="button"
											class="menu-action"
											:disabled="compacting || streaming"
											:title="streaming ? 'Stop the current turn first' : 'Summarize the context so the conversation can continue'"
											@click.stop="compactContext"
										>
											<svg viewBox="0 0 16 16" aria-hidden="true">
												<path d="M3.5 8h9" />
												<path d="M5.2 3.9L8 6.4l2.8-2.5" />
												<path d="M5.2 12.1L8 9.6l2.8 2.5" />
											</svg>
											<span class="ellipsis">{{ compacting ? "Compacting…" : "Compact context" }}</span>
											<span v-if="contextPercent !== null" class="menu-hint">{{ Math.round(contextPercent) }}%</span>
										</button>
									</div>
									<!-- network: the one proxy decision a running session can make (see webui.ts) -->
									<div class="menu-footer">
										<div class="menu-label">Network</div>
										<button
											type="button"
											class="menu-action"
											:disabled="!proxy.configured"
											:title="
												proxy.configured
													? proxy.bypassed
														? 'Requests go straight to the provider, ignoring both proxies this session started with'
														: 'Requests go through the http and https proxies below; the bypass list has no per-scheme switch'
													: 'nife was started without HTTP_PROXY/HTTPS_PROXY, so this session has nothing to switch'
											"
											@click.stop="toggleProxy"
										>
											<svg viewBox="0 0 16 16" aria-hidden="true">
												<circle cx="8" cy="8" r="5.2" />
												<path d="M2.8 8h10.4" />
												<path d="M8 2.8c1.5 1.6 2.3 3.3 2.3 5.2S9.5 11.6 8 13.2C6.5 11.6 5.7 9.9 5.7 8S6.5 4.4 8 2.8" />
											</svg>
											<span class="ellipsis">Proxy</span>
											<span
												class="switch"
												:class="{ on: proxy.configured && !proxy.bypassed, unavailable: !proxy.configured }"
												aria-hidden="true"
											></span>
										</button>
										<p class="proxy-time">{{ proxyLine }}</p>
									</div>
									<!-- manual control over the catalog entry, not over the turn -->
									<div class="menu-footer">
										<div class="menu-label">Model</div>
										<button
											type="button"
											class="menu-action"
											:title="'Add, edit or delete models in models.json'"
											@click.stop="openModelManager"
										>
											<svg viewBox="0 0 16 16" aria-hidden="true">
												<path d="M11.2 2.3l2.5 2.5-8 8-3.4.9.9-3.4 8-8z" />
												<path d="M9.6 4l2.4 2.4" />
											</svg>
											<span class="ellipsis">Manage models</span>
										</button>
									</div>
								</div>
							</div>

							<p v-if="usageLine" class="composer-stats">
								<span class="ellipsis">{{ usageLine }}</span>
							</p>
						</div>

						<div class="foot-right">
							<button
								type="button"
								class="send"
								:disabled="compacting || ((Boolean(editing) || preparing) && !streaming)"
								:class="{ stop: streaming, ready: !editing && (text.trim().length > 0 || attachments.length > 0 || files.length > 0) && !streaming && !compacting }"
								:title="
									editing
										? 'Finish the prompt you are editing first'
										: preparing
											? 'Preparing the attachments…'
											: streaming
												? 'Stop'
												: 'Send'
								"
								@click="streaming ? abort() : send()"
							>
								<svg v-if="streaming" viewBox="0 0 16 16" aria-hidden="true">
									<rect x="4" y="4" width="8" height="8" rx="1.5" />
								</svg>
								<svg v-else viewBox="0 0 16 16" aria-hidden="true">
									<path d="M8 12V4M4 8l4-4 4 4" />
								</svg>
							</button>
						</div>
					</div>
					<!-- compaction owns the session: dim the box and say why it does not take input -->
					<div v-if="compacting" class="composer-mask">
						<span class="composer-mask-spinner"></span>
						<span>Compacting context…</span>
					</div>
				</div>
			</form>
		</section>

		<div v-if="deleteQueue.length" class="modal" @click.self="cancelDelete">
			<div class="modal-card delete-card" role="alertdialog" aria-modal="true">
				<h2 v-if="deleteWorkspace">删除工作区“{{ deleteWorkspace.name }}”？</h2>
				<h2 v-else-if="deleteQueue.length === 1">删除后，该对话将不可恢复</h2>
				<h2 v-else>删除后，这 {{ deleteQueue.length }} 个对话将不可恢复</h2>
				<p v-if="deleteWorkspace">将永久删除其中的 {{ deleteQueue.length }} 个对话；项目目录和文件不会被删除。</p>
				<p v-else-if="deleteQueue.length === 1">该对话的聊天记录将被永久删除。</p>
				<p v-else>这些对话的聊天记录将被永久删除。</p>
				<div class="modal-actions">
					<button type="button" class="ghost" :disabled="deleting" @click="cancelDelete">取消</button>
					<button type="button" class="danger" :disabled="deleting" @click="confirmDeleteSessions">
						{{ deleting ? "删除中…" : deleteWorkspace ? "删除工作区" : deleteQueue.length === 1 ? "删除该对话" : "删除这些对话" }}
					</button>
				</div>
			</div>
		</div>

		<div v-if="dialog" class="modal">
			<div class="modal-card">
				<h2>{{ dialog.title }}</h2>
				<p v-if="dialog.message">{{ dialog.message }}</p>
				<div v-if="dialog.kind === 'input' || dialog.kind === 'editor'">
					<textarea v-if="dialog.kind === 'editor'" v-model="dialogText" rows="8" :placeholder="dialog.placeholder"></textarea>
					<input v-else v-model="dialogText" type="text" :placeholder="dialog.placeholder" />
				</div>
				<div class="modal-actions">
					<template v-if="dialog.kind === 'confirm'">
						<button type="button" class="ghost" @click="answer(false)">No</button>
						<button type="button" class="primary" @click="answer(true)">Yes</button>
					</template>
					<template v-else-if="dialog.kind === 'select'">
						<button v-for="option in dialog.options" :key="option" type="button" class="ghost" @click="answer(option)">
							{{ option }}
						</button>
						<button type="button" class="ghost" @click="answer(undefined)">Cancel</button>
					</template>
					<template v-else>
						<button type="button" class="ghost" @click="answer(undefined)">Cancel</button>
						<button type="button" class="primary" @click="answer(dialogText)">OK</button>
					</template>
				</div>
			</div>
		</div>

	<!-- The model manager: rows are the catalog; create, edit and delete write models.json. -->
	<div v-if="modelManager" class="modal" @click.self="closeModelManager">
		<div class="modal-card model-manager-card" role="dialog" aria-modal="true" aria-labelledby="model-manager-title">
			<div class="model-manager-head">
				<h2 id="model-manager-title">Models</h2>
				<button v-if="!modelForm" type="button" class="model-manager-add" :disabled="modelManagerBusy" @click="startCreateModel">
					<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" /></svg>
					<span>Add model</span>
				</button>
			</div>
			<p class="model-manager-path">{{ modelManager.path }}</p>

			<!-- provider endpoint: one baseUrl/api/key for every model of that provider -->
			<template v-if="modelForm && modelForm.mode === 'provider'">
				<div class="model-form">
					<div class="model-edit-grid">
						<p class="model-edit-identity">{{ modelForm.provider }} · provider endpoint</p>
						<label class="model-edit-field model-edit-span">
							<span>Base URL <span class="muted">used by every model without its own</span></span>
							<input v-model.trim="modelForm.baseUrl" type="text" spellcheck="false" placeholder="https://host/v1" />
						</label>
						<label class="model-edit-field">
							<span>API</span>
							<select v-model="modelForm.api">
								<option value="">inherit</option>
								<option value="openai-completions">openai-completions</option>
								<option value="openai-responses">openai-responses</option>
								<option value="anthropic-messages">anthropic-messages</option>
								<option value="google-generative-ai">google-generative-ai</option>
							</select>
						</label>
						<label class="model-edit-field model-edit-span">
							<span>API key <span class="muted">optional — literal, $ENV_VAR or !command</span></span>
							<input
								v-model="modelForm.apiKey"
								type="password"
								autocomplete="off"
								spellcheck="false"
								:placeholder="modelForm.hasKey ? 'keep the stored key' : 'sk-…'"
							/>
						</label>
						<label v-if="modelForm.hasKey" class="model-edit-check model-edit-span">
							<input type="checkbox" v-model="modelForm.clearKey" />
							<span>Remove the stored key</span>
						</label>
					</div>
				</div>
				<p v-if="modelFormError" class="model-edit-error" role="alert">{{ modelFormError }}</p>
				<div class="modal-actions">
					<button type="button" class="ghost" :disabled="modelManagerBusy" @click="cancelModelForm">Cancel</button>
					<button type="button" class="primary" :disabled="modelManagerBusy || !modelManager.writable" @click="saveModelForm">
						{{ modelManagerBusy ? "Saving…" : "Save endpoint" }}
					</button>
				</div>
			</template>

			<!-- create/edit: one row's fields, and the endpoint when the row can carry one -->
			<template v-else-if="modelForm">
				<div class="model-form">
				<div class="model-edit-grid">
					<template v-if="modelForm.mode === 'create'">
						<label class="model-edit-field">
							<span>Provider</span>
							<input v-model.trim="modelForm.provider" type="text" list="model-provider-ids" spellcheck="false" placeholder="provider id" />
							<datalist id="model-provider-ids">
								<option v-for="provider in modelManager.providers" :key="provider.id" :value="provider.id" />
							</datalist>
						</label>
						<label class="model-edit-field">
							<span>Model id</span>
							<input v-model.trim="modelForm.id" type="text" maxlength="200" spellcheck="false" placeholder="id sent to the API" />
						</label>
					</template>
					<template v-else>
						<p class="model-edit-identity">{{ modelForm.provider }} · {{ modelForm.id }}</p>
					</template>
					<label class="model-edit-field model-edit-span">
						<span>Name</span>
						<input v-model="modelForm.name" type="text" maxlength="200" spellcheck="false" :placeholder="modelForm.id || 'display name'" />
					</label>
					<div class="model-edit-row">
						<label class="model-edit-check">
							<input type="checkbox" v-model="modelForm.reasoning" />
							<span>Reasoning</span>
						</label>
						<div class="model-edit-inputs">
							<span class="muted model-edit-label">Input</span>
							<label class="model-edit-check" title="Text input is required">
								<input type="checkbox" :value="'text'" v-model="modelForm.input" disabled />
								<span>text</span>
							</label>
							<label class="model-edit-check">
								<input type="checkbox" :value="'image'" v-model="modelForm.input" />
								<span>image</span>
							</label>
						</div>
					</div>
					<label class="model-edit-field">
						<span>Context window</span>
						<input v-model.number="modelForm.contextWindow" type="number" min="1" step="1" />
					</label>
					<label class="model-edit-field">
						<span>Max output tokens</span>
						<input v-model.number="modelForm.maxTokens" type="number" min="1" step="1" />
					</label>
					<template v-if="modelFormEndpoint">
						<label class="model-edit-field model-edit-span">
							<span>
								Base URL
								<span class="muted">· empty inherits the provider</span>
							</span>
							<input
								v-model.trim="modelForm.baseUrl"
								type="text"
								spellcheck="false"
								:placeholder="modelForm.inheritedEndpoint || 'https://host/v1'"
							/>
						</label>
						<label class="model-edit-field">
							<span>API</span>
							<select v-model="modelForm.api">
								<option value="">inherit</option>
								<option value="openai-completions">openai-completions</option>
								<option value="openai-responses">openai-responses</option>
								<option value="anthropic-messages">anthropic-messages</option>
								<option value="google-generative-ai">google-generative-ai</option>
							</select>
						</label>
					</template>
					<p v-else-if="modelForm.mode === 'edit'" class="muted model-edit-note model-edit-span">
						Its endpoint comes from provider
						<button type="button" class="linkbtn" @click="startEditProvider(modelForm.provider)">
							{{ modelForm.provider }}
						</button>
						— edit the provider endpoint instead.
					</p>
					<div class="model-edit-cost">
						<p class="muted model-edit-label">Cost per 1M tokens</p>
						<div class="model-edit-cost-grid">
							<label class="model-edit-field"><span>Input</span><input v-model.number="modelForm.cost.input" type="number" min="0" step="any" /></label>
							<label class="model-edit-field"><span>Output</span><input v-model.number="modelForm.cost.output" type="number" min="0" step="any" /></label>
							<label class="model-edit-field"><span>Cache read</span><input v-model.number="modelForm.cost.cacheRead" type="number" min="0" step="any" /></label>
							<label class="model-edit-field"><span>Cache write</span><input v-model.number="modelForm.cost.cacheWrite" type="number" min="0" step="any" /></label>
						</div>
					</div>
					<label v-if="modelFormNeedsEndpoint" class="model-edit-field model-edit-span">
						<span>API key <span class="muted">optional — literal, $ENV_VAR or !command</span></span>
						<input v-model="modelForm.apiKey" type="text" spellcheck="false" placeholder="sk-…" />
					</label>
				</div>
				</div>
				<p v-if="modelFormError" class="model-edit-error" role="alert">{{ modelFormError }}</p>
				<div class="modal-actions">
					<button type="button" class="ghost" :disabled="modelManagerBusy" @click="cancelModelForm">Cancel</button>
					<button type="button" class="primary" :disabled="modelManagerBusy || !modelManager.writable" @click="saveModelForm">
						{{ modelManagerBusy ? "Saving…" : modelForm.mode === "create" ? "Add model" : "Save" }}
					</button>
				</div>
			</template>

			<!-- the rows: this is the manager -->
			<template v-else>
				<input
					v-if="modelManager.models.length > 8"
					v-model="modelFilter"
					class="menu-search model-manager-filter"
					placeholder="Filter models"
				/>
				<p v-if="modelManagerError" class="model-edit-error" role="alert">{{ modelManagerError }}</p>
				<p v-else-if="modelManager.warning" class="model-edit-error" role="alert">{{ modelManager.warning }}</p>
				<div class="model-rows">
					<div
						v-for="row in modelRows"
						:key="`${row.provider}/${row.id}`"
						class="model-row"
						:class="{ current: row.current, confirming: modelDelete && modelDelete.provider === row.provider && modelDelete.id === row.id }"
					>
						<template v-if="modelDelete && modelDelete.provider === row.provider && modelDelete.id === row.id">
							<span class="model-row-name ellipsis">Delete “{{ modelDelete.name }}”?</span>
							<span class="model-row-actions">
								<button type="button" class="ghost" :disabled="modelManagerBusy" @click="modelDelete = null">Cancel</button>
								<button type="button" class="danger" :disabled="modelManagerBusy" @click="confirmDeleteModel">
									{{ modelManagerBusy ? "Deleting…" : "Delete" }}
								</button>
							</span>
						</template>
						<template v-else>
							<button type="button" class="model-row-main" @click="startEditModel(row)">
								<span class="model-row-name ellipsis">{{ row.name || row.id }}</span>
								<span class="model-row-meta">{{ row.provider }}</span>
								<span class="model-row-meta model-row-limits">{{ compact(row.contextWindow) }} ctx · {{ compact(row.maxTokens) }} out</span>
								<span v-if="row.source === 'overrides'" class="model-row-tag" title="Stored as a modelOverrides entry">override</span>
								<span v-if="!row.available" class="model-row-tag muted-tag" title="No credentials for this provider yet">no key</span>
								<span v-if="row.current" class="model-row-tag current-tag">current</span>
							</button>
							<span class="model-row-actions">
								<button type="button" class="iconbtn" title="Edit this model" @click="startEditModel(row)">
									<svg viewBox="0 0 16 16" aria-hidden="true">
										<path d="M11.2 2.3l2.5 2.5-8 8-3.4.9.9-3.4 8-8z" />
										<path d="M9.6 4l2.4 2.4" />
									</svg>
								</button>
								<button
									type="button"
									class="iconbtn"
									:disabled="row.source === 'none'"
									:title="row.source === 'none' ? 'Nothing in models.json to delete' : 'Delete this model'"
									@click="askDeleteModel(row)"
								>
									<svg viewBox="0 0 16 16" aria-hidden="true">
										<path d="M3.5 4.5h9M6.5 4.5V3h3v1.5M5 4.5l.5 8h5l.5-8" />
									</svg>
								</button>
							</span>
						</template>
					</div>
					<p v-if="modelRows.length === 0" class="muted pad">No models</p>
				</div>
				<div class="model-endpoints">
					<p class="muted model-edit-label">Provider endpoints</p>
					<div v-for="provider in modelProviders" :key="provider.id" class="model-endpoint">
						<span class="model-endpoint-id ellipsis">{{ provider.id }}</span>
						<span class="model-endpoint-url ellipsis" :class="{ muted: !provider.baseUrl }">
							{{ provider.baseUrl || (provider.defined ? "inherit" : "registered outside models.json") }}
						</span>
						<span v-if="provider.hasKey" class="model-row-tag" title="an apiKey is stored for this provider">key</span>
						<button
							v-if="provider.defined"
							type="button"
							class="iconbtn"
							title="Edit this provider endpoint"
							@click="startEditProvider(provider)"
						>
							<svg viewBox="0 0 16 16" aria-hidden="true">
								<path d="M11.2 2.3l2.5 2.5-8 8-3.4.9.9-3.4 8-8z" />
								<path d="M9.6 4l2.4 2.4" />
							</svg>
						</button>
					</div>
					<p v-if="modelProviders.length === 0" class="muted pad">No providers defined here</p>
				</div>
				<div class="modal-actions">
					<button type="button" class="ghost" :disabled="modelManagerBusy" @click="closeModelManager">Close</button>
				</div>
			</template>
		</div>
	</div>
	</div>
</template>
