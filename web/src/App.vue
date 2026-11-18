<script setup>
import { computed, nextTick, onMounted, ref, shallowRef, triggerRef } from "vue";
import EffortSlider from "./EffortSlider.vue";
import LiveMessage from "./LiveMessage.vue";
import MessageItem from "./MessageItem.vue";
import { blocksOf } from "./message-utils.js";
import { expandPastes, pasteMarker, readClipboard } from "./paste.js";

const token = new URLSearchParams(location.search).get("t") ?? "";
const api = (path) => `/api/${path}?t=${encodeURIComponent(token)}`;

// Committed messages live in a shallowRef: objects are plain (not deep-proxied) and the list is
// only invalidated on message boundaries, never per streaming token.
const messages = shallowRef([]);
const live = ref(null); // { text, thinking } for the message currently streaming
const streaming = ref(false);
const online = ref(true);
const state = ref({ name: "", sessionId: "", cwd: "", model: null, thinkingLevel: "" });
const text = ref("");
const dialog = ref(null);
const dialogText = ref("");
const transcript = ref(null);
const inputEl = ref(null);
const sidebarOpen = ref(false);
const collapsed = ref(localStorage.getItem("nife-webui.collapsed") === "1");
const narrow = ref(false);
const sessions = ref([]);
const currentFile = ref("");
const menu = ref(null);
const modelQuery = ref("");
const thinkingDraft = ref(null);
const subagents = ref([]);

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
	for (const message of messages.value) {
		if (message.role === "toolResult") continue;
		if (message.role === "assistant") {
			const own = {};
			for (const block of blocksOf(message)) {
				if (block?.type === "toolCall" && results.has(block.id)) {
					own[block.id] = results.get(block.id);
					used.add(block.id);
				}
			}
			list.push({ kind: "assistant", message, results: own });
		} else if (message.role === "user") {
			list.push({ kind: "user", message, results: {} });
		} else if (message.role === "bashExecution") {
			list.push({ kind: "bash", message, results: {} });
		} else {
			// custom / branchSummary / compactionSummary
			list.push({ kind: "notice", message, results: {} });
		}
	}
	for (const message of messages.value) {
		if (message.role === "toolResult" && !used.has(message.toolCallId)) {
			list.push({ kind: "result", message, results: {} });
		}
	}
	return list;
});

const modelLabel = computed(() => (state.value.model ? (state.value.model.name ?? state.value.model.id) : "model"));

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

/** Puts the first line of a new reply in view and leaves the viewport alone afterwards. */
function pinMessageStart() {
	nextTick(() => {
		const container = transcript.value;
		const node = container?.querySelector(".msg.live");
		if (!container || !node) return;
		const containerBox = container.getBoundingClientRect();
		const nodeBox = node.getBoundingClientRect();
		const target = nodeBox.top - containerBox.top + container.scrollTop - containerBox.height * 0.22;
		// only scroll forward: never yank the view away from what the user is reading
		if (target > container.scrollTop) container.scrollTop = target;
	});
}

/** Only used for local actions (own prompt, session load); streaming never moves the view. */
function scrollToBottom() {
	nextTick(() => {
		if (transcript.value) transcript.value.scrollTop = transcript.value.scrollHeight;
	});
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
				pinMessageStart();
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
			break;
		case "agent_start":
			streaming.value = true;
			break;
		case "agent_settled":
			streaming.value = false;
			// an aborted turn may end without message_end; drop an empty placeholder
			if (live.value && !live.value.text && !live.value.thinking) live.value = null;
			refreshMeta();
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
			loadState();
			loadSessions();
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
	streaming.value = Boolean(loaded.streaming);
	scrollToBottom();
}

/** Refreshes header fields only; reloading messages would fight the user's scroll. */
async function refreshMeta() {
	const response = await fetch(api("state"));
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
}

async function post(path, body) {
	const response = await fetch(api(path), {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	return response.ok;
}

let pasteSeq = 0;
const pastes = new Map();

async function send() {
	const raw = text.value;
	const value = expandPastes(raw, pastes).trim();
	if (!value) return;
	text.value = "";
	resize();
	scrollToBottom();
	inputEl.value?.focus();
	if (!(await post("prompt", { text: value }))) {
		text.value = raw;
		resize();
		return;
	}
	pastes.clear();
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
	const clip = event.clipboardData?.getData("text/plain");
	if (!clip || !readClipboard(clip).large) return;
	event.preventDefault();
	pasteSeq += 1;
	const { text: body, marker } = pasteMarker(pasteSeq, clip);
	pastes.set(pasteSeq, body);
	insertAtCursor(marker);
}

async function abort() {
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

async function switchTo(path) {
	sidebarOpen.value = false;
	if (await post("resume", { path })) {
		await loadState();
		await loadSessions();
	}
}

async function newSession() {
	sidebarOpen.value = false;
	if (await post("new")) {
		await loadState();
		await loadSessions();
	}
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
	});
	window.addEventListener("click", () => {
		menu.value = null;
	});
	window.addEventListener("keydown", (event) => {
		if (event.key !== "Escape") return;
		menu.value = null;
		// Answer, don't just hide: an unanswered dialog would block the agent on both sides.
		if (dialog.value) answer(undefined);
	});
	await loadState();
	await loadSessions();
	connect();
	inputEl.value?.focus();
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
				<button
					v-for="session in sessions"
					:key="session.path"
					type="button"
					:class="['session', session.path === currentFile ? 'current' : '']"
					@click="switchTo(session.path)"
				>
					<svg class="session-icon" viewBox="0 0 16 16" aria-hidden="true">
						<path d="M4 2h8v12l-4-3-4 3z" />
					</svg>
					<span class="session-name">{{ sessionTitle(session) }}</span>
					<span class="session-when">{{ when(session.modified) }}</span>
				</button>
			</div>

			<div class="sidebar-foot">
				<span class="muted ellipsis">{{ state.cwd }}</span>
			</div>
		</nav>

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

			<main ref="transcript" class="transcript" @click="onTranscriptClick">
				<div v-if="messages.length === 0 && !live" class="empty">
					<h1>What should we build?</h1>
					<p class="muted">
						This page drives the session running in your terminal. Anything you send here shows up in the CLI too.
					</p>
				</div>

				<MessageItem v-for="(item, index) in items" :key="index" :item="item" />

				<LiveMessage v-if="live" :live="live" />
			</main>

			<form class="composer" @submit.prevent="send">
				<div class="composer-box">
					<svg class="box-progress" aria-hidden="true" :title="contextPercent !== null ? `context ${Math.round(contextPercent)}%` : undefined">
						<rect class="progress-track" x="0" y="0" width="100%" height="100%" rx="19" pathLength="100" />
						<rect
							class="progress-value"
							x="0"
							y="0"
							width="100%"
							height="100%"
							rx="19"
							pathLength="100"
							:stroke-dasharray="`${contextPercent ?? 0} 100`"
						/>
					</svg>
					<textarea
						ref="inputEl"
						v-model="text"
						rows="1"
						placeholder="Describe a task, or ask a question"
						@input="resize"
						@paste="onPaste"
						@keydown.enter.exact.prevent="send"
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
								</div>
							</div>

							<p v-if="usageLine" class="composer-stats">
								<span class="ellipsis">{{ usageLine }}</span>
							</p>
						</div>

						<button
							type="button"
							class="send"
							:class="{ stop: streaming, ready: text.trim().length > 0 && !streaming }"
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
