<script setup>
import { computed } from "vue";
import BlockItem from "./BlockItem.vue";
import FileIcon from "./FileIcon.vue";
import { splitAttachments } from "./files.js";
import { blocksOf, dataUrl, imagesOf, textOf } from "./message-utils.js";
import { failedTool, groupBlocks, stepLabel } from "./transcript.js";

const props = defineProps({
	item: { type: Object, required: true },
	// inside a collapsed process group the steps are already behind one click: no second wrapper
	flat: { type: Boolean, default: false },
});

// Dropped files travel as `[attached] <path>` lines; show chips instead of temp paths.
const userContent = computed(() => splitAttachments(textOf(props.item.message.content)));

// Thinking and tool calls collapse into one row per run, so a message reads as answer-first.
const segments = computed(() => {
	const blocks = blocksOf(props.item.message);
	if (!props.flat) return groupBlocks(blocks);
	return blocks.map((block) => ({ kind: "block", block }));
});

/** The collapsed row warns when a hidden step failed; the details stay closed otherwise. */
const segmentFailed = (segment) => failedTool(segment.blocks, props.item.results);

const noticeLabel = (message) => {
	if (message.role === "compactionSummary") return "Context compacted";
	if (message.role === "branchSummary") return "Branch summary";
	return message.customType ? `Note (${message.customType})` : "Note";
};

const noticeText = (message) => {
	if (message.summary) return message.summary;
	return textOf(message.content);
};
</script>

<template>
	<div v-if="item.kind === 'user'" class="msg user">
		<div class="bubble">
			<div v-if="userContent.text" class="text">{{ userContent.text }}</div>
			<div v-if="userContent.files.length > 0" class="bubble-files">
				<span v-for="(file, i) in userContent.files" :key="i" class="bubble-file" :title="file.path">
					<FileIcon :name="file.name" />
					{{ file.name }}
				</span>
			</div>
			<img v-for="(image, i) in imagesOf(item.message.content)" :key="i" :src="dataUrl(image)" alt="" />
		</div>
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
