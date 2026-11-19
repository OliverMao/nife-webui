<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, triggerRef, watch } from "vue";
import EffortSlider from "./EffortSlider.vue";
import LiveMessage from "./LiveMessage.vue";
import MessageItem from "./MessageItem.vue";
import { prepareImage } from "./images.js";
import FileIcon from "./FileIcon.vue";
import { formatBytes } from "./files.js";
import { blocksOf } from "./message-utils.js";
import { IMAGE_MAX_COUNT, expandPastes, imageFiles, imageMimeType, imageProblem, pasteMarker, readClipboard } from "./paste.js";
import { metaOf, previewOf, promptTextOf, queueProblem } from "./queue.js";
import { groupItems, stepLabel } from "./transcript.js";

const token = new URLSearchParams(location.search).get("t") ?? "";
const api = (path) => `/api/${path}${path.includes("?") ? "&" : "?"}t=${encodeURIComponent(token)}`;

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
const narrow = ref(false);
const sessions = ref([]);
const currentFile = ref("");
// Session awaiting delete confirmation in the sidebar.
const pendingDelete = ref("");
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
			list.push({ kind: "assistant", message, results: own, index });
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
	return `${row.kind}:${typeof first?.index === "number" ? first.index : -1}`;
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
	const first = (session.firstMessage ?? "").trim().replace(/\s+/g, " ");
	return first.length > 60 ? `${first.slice(0, 60)}…` : first || session.id.slice(0, 8);
};

const title = computed(
	() => state.value.name || sessionTitle(sessions.value.find((s) => s.path === currentFile.value)) || "new session",
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

/** Wheel direction is checked too: a small nudge up must not be undone by the next chunk. */
function onTranscriptWheel(event) {
	markGesture();
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
	messages.value.push(message);
	triggerRef(messages);
}

function handle(payload) {
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
			// not be followed by the next queued task without the user asking for it.
			if (payload.aborted) queuePaused.value = true;
			clearQueuedErrors();
			refreshMeta();
			void drain();
			break;
		case "session_info_changed":
			state.value.name = payload.name;
			break;
		case "state_changed":
			loadState();
			break;
		case "subagents":
			subagents.value = payload.running ?? [];
			break;
		case "thinking_level_changed":
			state.value.thinkingLevel = payload.level;
			thinkingDraft.value = null;
			break;
		case "session_start":
		case "session_switch":
			// a queued task belongs to the conversation it was typed in
			if (queue.value.length > 0) {
				queuePaused.value = true;
				showNotice("queue paused after the session changed");
			}
			loadState();
			loadSessions();
			break;
		case "sessions_changed":
			loadSessions();
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
	const response = await fetch(api("state"));
	if (!response.ok) throw new Error(`state ${response.status}`);
	const loaded = await response.json();
	state.value = loaded;
	subagents.value = loaded.subagents ?? [];
	messages.value = loaded.messages ?? [];
	triggerRef(messages);
	loadedFrom.value = loaded.loadedFrom ?? 0;
	streaming.value = Boolean(loaded.streaming);
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
}

async function loadSessions() {
	const response = await fetch(api("sessions"));
	if (!response.ok) return;
	const data = await response.json();
	sessions.value = data.sessions ?? [];
	currentFile.value = data.current ?? "";
	pendingDelete.value = "";
}

/** Two-step delete: the row turns into a confirm pair, the file never leaves without a second click. */
async function deleteSession(session) {
	pendingDelete.value = "";
	const response = await fetch(api("delete"), {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ path: session.path }),
	});
	if (!response.ok) {
		showNotice((await response.text()).slice(0, 200) || "could not delete the session");
		return;
	}
	const method = (await response.text()).trim();
	sessions.value = sessions.value.filter((entry) => entry.path !== session.path);
	showNotice(method === "trash" ? "session moved to trash" : "session deleted");
}

async function postDetailed(path, body) {
	const response = await fetch(api(path), {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	return { ok: response.ok, message: response.ok ? "" : (await response.text()).slice(0, 200) };
}

async function post(path, body) {
	return (await postDetailed(path, body)).ok;
}

let pasteSeq = 0;
const pastes = new Map();

// Pasted images waiting to be sent: { id, name, mimeType, data, url }.
const attachments = ref([]);
// Dropped non-images waiting to be sent: { id, name, size, progress, path }. No path yet means the
// upload is still running, which is what the chip's progress bar shows.
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

async function send() {
	if (compacting.value) return;
	const value = expandPastes(text.value, pastes).trim();
	const images = attachments.value.map(({ name, mimeType, data }) => ({ name, mimeType, data }));
	const queuedFiles = files.value.map(({ name, path, size }) => ({ name, path, size }));
	if (files.value.some((file) => !file.path)) {
		showNotice("still uploading, try again in a moment");
		return;
	}
	if (!value && images.length === 0 && queuedFiles.length === 0) return;
	const problem = imageProblem(images);
	if (problem) {
		showNotice(problem);
		return;
	}
	queueSeq += 1;
	const item = { id: queueSeq, text: value, images, files: queuedFiles, error: "" };
	const blocked = queueProblem(queue.value, item);
	if (blocked) {
		showNotice(blocked);
		return;
	}
	clearComposer();
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
	const result = await dispatch(head);
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
		return { id: fileSeq, name: file.name, size: file.size, progress: 1, path: file.path };
	});
	nextTick(() => {
		inputEl.value?.focus();
		resize();
	});
}

async function attachFiles(incoming) {
	for (const file of incoming) {
		if (attachments.value.length >= IMAGE_MAX_COUNT) {
			showNotice(`at most ${IMAGE_MAX_COUNT} images per message`);
			return;
		}
		try {
			const { mimeType, data } = await prepareImage(file);
			imageSeq += 1;
			attachments.value = [
				...attachments.value,
				{
					id: imageSeq,
					name: file.name || `pasted image ${imageSeq}`,
					mimeType,
					data,
					url: `data:${mimeType};base64,${data}`,
				},
			];
		} catch (error) {
			showNotice(error instanceof Error ? error.message : "could not read the pasted image");
		}
	}
}

function removeImage(id) {
	attachments.value = attachments.value.filter((image) => image.id !== id);
}

/** Bytes -> a file in nife's temp upload dir. XHR instead of fetch so the chip can show progress. */
function uploadFile(file, onProgress) {
	return new Promise((resolve, reject) => {
		const request = new XMLHttpRequest();
		request.open("POST", api("upload"));
		request.setRequestHeader("x-file-name", encodeURIComponent(file.name || "file"));
		request.upload.onprogress = (event) => {
			if (event.lengthComputable) onProgress(event.loaded / event.total);
		};
		request.onload = () => {
			if (request.status < 200 || request.status >= 300) {
				reject(new Error((request.responseText || `upload failed (${request.status})`).slice(0, 200)));
				return;
			}
			try {
				resolve(JSON.parse(request.responseText));
			} catch {
				reject(new Error("bad upload response"));
			}
		};
		request.onerror = () => reject(new Error("upload failed"));
		request.send(file);
	});
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
	const files = [...(event.dataTransfer?.files ?? [])];
	if (files.length === 0) return;
	event.preventDefault();
	dragging.value = false;
	const images = [];
	const others = [];
	for (const file of files) {
		if (imageMimeType(file)) images.push(file);
		else others.push(file);
	}
	if (images.length > 0) void attachFiles(images);
	if (others.length > 0) void uploadFiles(others);
}

function onDragOver(event) {
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
	if (narrow.value) {
		sidebarOpen.value = !sidebarOpen.value;
		return;
	}
	collapsed.value = !collapsed.value;
	localStorage.setItem("nife-webui.collapsed", collapsed.value ? "1" : "0");
}

function toggleMenu(name) {
	menu.value = menu.value === name ? null : name;
	modelQuery.value = "";
}

async function pickModel(model) {
	menu.value = null;
	if (await post("model", { provider: model.provider, id: model.id })) await loadState();
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
	sidebarOpen.value = false;
	const result = await postDetailed("resume", { path });
	if (!result.ok) {
		showNotice(result.message || "could not switch session");
		return;
	}
	await loadState();
	await loadSessions();
}

async function newSession() {
	sidebarOpen.value = false;
	const result = await postDetailed("new");
	if (!result.ok) {
		showNotice(result.message || "could not start a new session");
		return;
	}
	await loadState();
	await loadSessions();
}

async function answer(value) {
	const request = dialog.value;
	dialog.value = null;
	await post("dialog", value === undefined ? { id: request.id } : { id: request.id, value });
}

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
		if (narrow.value) sidebarOpen.value = false;
		// Answer, don't just hide: an unanswered dialog would block the agent on both sides.
		if (dialog.value) answer(undefined);
	});
	await loadState();
	await loadSessions();
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
	<div class="app" :class="{ collapsed }">
		<nav class="sidebar" :class="{ open: sidebarOpen }">
			<div class="sidebar-head">
				<span class="brand">nife</span>
				<div class="head-actions">
					<button type="button" class="iconbtn" title="Reload sessions" @click="loadSessions">
						<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.6-3.7M13 2v3h-3" /></svg>
					</button>
					<button type="button" class="iconbtn" title="New session" @click="newSession">
						<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg>
					</button>
				</div>
			</div>

			<button type="button" class="new-chat" @click="newSession">
				<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg>
				New chat
			</button>

			<div class="section-label">Recents</div>
			<div class="session-list">
				<p v-if="sessions.length === 0" class="muted pad">No sessions in this directory.</p>
				<div
					v-for="session in sessions"
					:key="session.path"
					:class="['session', session.path === currentFile ? 'current' : '']"
				>
					<button type="button" class="session-main" @click="switchTo(session.path)">
						<span class="session-name">{{ sessionTitle(session) }}</span>
						<span class="session-when">{{ when(session.modified) }}</span>
					</button>
					<template v-if="pendingDelete === session.path">
						<button type="button" class="session-confirm" @click="deleteSession(session)">Delete</button>
						<button type="button" class="session-cancel" @click="pendingDelete = ''">Cancel</button>
					</template>
					<button
						v-else
						type="button"
						class="session-delete"
						:disabled="session.path === currentFile"
						:title="session.path === currentFile ? 'Cannot delete the session you are in' : 'Delete session'"
						@click.stop="pendingDelete = session.path"
					>
						<svg viewBox="0 0 16 16" aria-hidden="true">
							<path d="M3 4.5h10M6.5 4.5V2.5h3v2M4.8 4.5l.6 9h5.2l.6-9" />
						</svg>
					</button>
				</div>
			</div>

			<div class="sidebar-foot">
				<span class="muted ellipsis">{{ state.cwd }}</span>
			</div>
		</nav>

		<!-- Narrow screens: the sidebar is an overlay, so tapping anywhere else closes it. -->
		<div v-if="narrow && sidebarOpen" class="sidebar-backdrop" @click="sidebarOpen = false"></div>

		<section class="main">
			<header class="topbar">
				<button type="button" class="iconbtn panel-toggle" @click.stop="toggleSidebar">
					<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 3.5h12M2 8h12M2 12.5h8" /></svg>
				</button>
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
						<h1>What should we build?</h1>
						<p class="muted">
							This page drives the session running in your terminal. Anything you send here shows up in the CLI too.
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
							:class="{ failed: row.counts.failed }"
							:data-row="runStart + index"
						>
							<summary>
								<span class="chev"></span>
								<span class="tool-verb">Worked</span>
								<span class="tool-arg ellipsis">{{ stepLabel(row.counts) }}</span>
							</summary>
							<div class="process-body">
								<MessageItem v-for="(step, i) in row.steps" :key="i" :item="step" flat />
							</div>
						</details>
						<MessageItem v-else :item="row" :data-row="runStart + index" />
					</template>

					<LiveMessage v-if="live" :live="live" />

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
				<div v-if="queue.length > 0 || queuePaused" class="queue" :class="{ paused: queuePaused }">
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
					<div v-if="attachments.length > 0 || files.length > 0" class="attachments">
						<figure v-for="image in attachments" :key="image.id" class="attachment">
							<img :src="image.url" :alt="image.name" :title="image.name" />
							<button type="button" class="attachment-remove" title="Remove image" @click="removeImage(image.id)">
								×
							</button>
						</figure>
						<div v-for="file in files" :key="file.id" class="file-chip" :title="file.path || file.name">
							<FileIcon :name="file.name" />
							<span class="file-meta">
								<span class="file-name ellipsis">{{ file.name }}</span>
								<span class="file-size">
									{{ file.path ? formatBytes(file.size) : `${Math.round(file.progress * 100)}%` }}
								</span>
							</span>
							<button type="button" class="attachment-remove" title="Remove file" @click="removeFile(file.id)">
								×
							</button>
							<span v-if="!file.path" class="file-progress" :style="{ width: `${Math.round(file.progress * 100)}%` }"></span>
						</div>
					</div>
					<textarea
						ref="inputEl"
						v-model="text"
						rows="1"
						placeholder="Describe a task, or ask a question"
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
								</div>
							</div>

							<p v-if="usageLine" class="composer-stats">
								<span class="ellipsis">{{ usageLine }}</span>
							</p>
						</div>

						<button
							type="button"
							class="send"
							:disabled="compacting"
							:class="{ stop: streaming, ready: (text.trim().length > 0 || attachments.length > 0 || files.length > 0) && !streaming && !compacting }"
							:title="streaming ? 'Stop' : 'Send'"
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
					<!-- compaction owns the session: dim the box and say why it does not take input -->
					<div v-if="compacting" class="composer-mask">
						<span class="composer-mask-spinner"></span>
						<span>Compacting context…</span>
					</div>
				</div>
			</form>
		</section>

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
	</div>
</template>
