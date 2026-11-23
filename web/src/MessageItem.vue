<script setup>
import { computed, ref } from "vue";
import BlockItem from "./BlockItem.vue";
import FileIcon from "./FileIcon.vue";
import { splitAttachments } from "./files.js";
import { blocksOf, dataUrl, imagesOf, textOf } from "./message-utils.js";
import { failedTool, groupBlocks, stepLabel } from "./transcript.js";

const props = defineProps({
	item: { type: Object, required: true },
	// inside a collapsed process group the steps are already behind one click: no second wrapper
	flat: { type: Boolean, default: false },
	// this is the newest answer of the branch: it is the one "retry" regenerates
	retryable: { type: Boolean, default: false },
});

const emit = defineEmits(["edit", "retry"]);

// Only a committed prompt of the current branch can be edited: the session entry id is what moves
// the leaf back (see /api/tree), and a live turn has no entry yet.
const editable = computed(() => props.item.message?.role === "user" && Boolean(props.item.message?.entryId));

const copied = ref(false);
let copyTimer;

/** One icon, one clipboard write, a tick for a moment: used by the prompt and the answer rows. */
async function copyText(value) {
	if (!value) return;
	try {
		await navigator.clipboard.writeText(value);
		copied.value = true;
		clearTimeout(copyTimer);
		copyTimer = setTimeout(() => (copied.value = false), 1200);
	} catch {
		// clipboard blocked: leave the icon alone
	}
}

/** The answer as text: the actions copy the answer itself, never the reasoning or a tool's output. */
const answerText = computed(() => {
	if (props.item.kind !== "assistant" || props.flat) return "";
	return textOf(props.item.message.content).trim();
});

/**
 * The strip exists only when it has a button: a failed turn has nothing to copy, so it is worth a
 * row only when it is the newest answer and "retry" is therefore offered.
 */
const answerActions = computed(
	() => !props.flat && Boolean(answerText.value || (props.retryable && props.item.message?.errorMessage)),
);

// Dropped files travel as `[attached] <path>` lines; show chips instead of temp paths.
const userContent = computed(() => splitAttachments(textOf(props.item.message.content)));
const images = computed(() => imagesOf(props.item.message.content));
/** Thumbnails are cropped squares, so a click opens the picture whole. */
const viewer = ref(null);

// Thinking and tool calls collapse into one row per run, so a message reads as answer-first.
const segments = computed(() => {
	const blocks = blocksOf(props.item.message);
	if (!props.flat) return groupBlocks(blocks);
	return blocks.map((block) => ({ kind: "block", block }));
});

/** The collapsed row warns when a hidden step failed; the details stay closed otherwise. */
const segmentFailed = (segment) => failedTool(segment.blocks, props.item.results);

const compactCount = (value) => {
	const count = Number(value) || 0;
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
	return String(count);
};

const noticeLabel = (message) => {
	// the marker sits where the rewrite happened; the summary it carries is expandable below
	if (message.role === "compactionMarker") return `Context compacted · ${compactCount(message.tokensBefore)} tokens`;
	if (message.role === "compactionSummary") return "Context compacted";
	if (message.role === "branchSummary") return "Branch summary";
	// anything the transcript does not know how to render: name the role, so a stray row identifies
	// itself instead of showing up as a bare "Note"
	if (message.customType) return `Note (${message.customType})`;
	return message.role ? `Note (${message.role})` : "Note";
};

const noticeText = (message) => {
	if (message.summary) return message.summary;
	return textOf(message.content);
};
</script>

<template>
	<div v-if="item.kind === 'user'" class="msg user">
		<!-- Attachments read as attachments: a row of thumbnails above the text, not pictures inside
		     the sentence. The pill is skipped when there is no text, so an image-only message is
		     nothing but its thumbnails. -->
		<div v-if="images.length > 0" class="bubble-images">
			<button
				v-for="(image, i) in images"
				:key="i"
				type="button"
				class="bubble-image"
				:aria-label="`Show image ${i + 1}`"
				@click="viewer = image"
			>
				<img :src="dataUrl(image)" alt="" />
			</button>
		</div>
		<div v-if="userContent.text || userContent.files.length > 0" class="bubble">
			<div v-if="userContent.text" class="text">{{ userContent.text }}</div>
			<div v-if="userContent.files.length > 0" class="bubble-files">
				<span v-for="(file, i) in userContent.files" :key="i" class="bubble-file" :title="file.path">
					<FileIcon :name="file.name" />
					{{ file.name }}
				</span>
			</div>
		</div>
		<!-- Under the pill, in the row's own bottom margin, exactly like the DeepSeek row: nothing is
		     reserved while the pointer is elsewhere, and no text label is needed for two icons. -->
		<div v-if="editable" class="msg-actions">
			<button
				v-if="userContent.text"
				type="button"
				class="msg-action"
				:title="copied ? 'Copied' : 'Copy this prompt'"
				:aria-label="copied ? 'Copied' : 'Copy this prompt'"
				@click="copyText(userContent.text)"
			>
				<svg v-if="copied" viewBox="0 0 16 16" aria-hidden="true">
					<path d="M3.5 8.5l3 3 6-6.5" />
				</svg>
				<svg v-else viewBox="0 0 16 16" aria-hidden="true">
					<rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
					<path d="M10.5 3.5a1 1 0 0 0-1-1H3.5a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1" />
				</svg>
			</button>
			<button
				type="button"
				class="msg-action"
				title="Edit this prompt and run it again from here"
				aria-label="Edit this prompt"
				@click="emit('edit', item)"
			>
				<svg viewBox="0 0 16 16" aria-hidden="true">
					<path d="M10.4 2.9l2.7 2.7-6.9 6.9-3.4.7.7-3.4z" />
				</svg>
			</button>
		</div>
		<Teleport to="body">
			<div v-if="viewer" class="image-viewer" @click="viewer = null">
				<img :src="dataUrl(viewer)" alt="" />
			</div>
		</Teleport>
	</div>

	<div v-else-if="item.kind === 'assistant'" class="msg assistant">
		<template v-for="(segment, i) in segments" :key="i">
			<details v-if="segment.kind === 'process'" class="process" :class="{ failed: segmentFailed(segment) }">
				<summary>
					<span class="chev"></span>
					<span class="tool-verb">Worked</span>
					<span class="tool-arg ellipsis">{{ stepLabel(segment.counts) }}</span>
				</summary>
				<div class="process-body">
					<BlockItem v-for="(block, j) in segment.blocks" :key="j" :block="block" :results="item.results" />
				</div>
			</details>
			<BlockItem v-else :block="segment.block" :results="item.results" />
		</template>
		<div v-if="item.message.errorMessage" class="text error">{{ item.message.errorMessage }}</div>
		<!-- Under the answer, right where it ends (the DeepSeek row): copy the text, or regenerate
		     this turn. Retry only on the newest answer, since it rewrites the branch from there. -->
		<div v-if="answerActions" class="msg-actions">
			<button
				v-if="answerText"
				type="button"
				class="msg-action"
				:title="copied ? 'Copied' : 'Copy the answer'"
				:aria-label="copied ? 'Copied' : 'Copy the answer'"
				@click="copyText(answerText)"
			>
				<svg v-if="copied" viewBox="0 0 16 16" aria-hidden="true">
					<path d="M3.5 8.5l3 3 6-6.5" />
				</svg>
				<svg v-else viewBox="0 0 16 16" aria-hidden="true">
					<rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
					<path d="M10.5 3.5a1 1 0 0 0-1-1H3.5a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1" />
				</svg>
			</button>
			<button
				v-if="retryable"
				type="button"
				class="msg-action"
				title="Retry this answer"
				aria-label="Retry this answer"
				@click="emit('retry', item)"
			>
				<svg viewBox="0 0 16 16" aria-hidden="true">
					<path d="M13 8a5 5 0 1 1-1.6-3.7" />
					<path d="M13.2 2.3v3.2h-3.2" />
				</svg>
			</button>
		</div>
	</div>

	<div v-else-if="item.kind === 'bash'" class="msg other">
		<details class="tool" :class="{ failed: item.message.exitCode }">
			<summary>
				<span class="chev"></span>
				<span class="tool-verb">Ran</span>
				<span class="tool-arg ellipsis">{{ item.message.command }}</span>
				<span v-if="item.message.exitCode" class="tool-state">{{ item.message.exitCode }}</span>
			</summary>
			<div class="tool-body">
				<div class="text">{{ item.message.output }}</div>
			</div>
		</details>
	</div>

	<div v-else-if="item.kind === 'result'" class="msg other">
		<details class="tool" :class="{ failed: item.message.isError }">
			<summary>
				<span class="chev"></span>
				<span class="tool-verb">{{ item.message.toolName }}</span>
			</summary>
			<div class="tool-body">
				<div class="text">{{ textOf(item.message.content) }}</div>
			</div>
		</details>
	</div>

	<div v-else class="msg notice">
		<details class="notice">
			<summary>
				<span class="chev"></span>
				<span class="tool-verb">{{ noticeLabel(item.message) }}</span>
			</summary>
			<div class="think-body">{{ noticeText(item.message) }}</div>
		</details>
	</div>
</template>
