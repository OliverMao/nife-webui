<script setup>
import { blocksOf, dataUrl, imagesOf, mdOf, textOf, toolArg, toolLabel } from "./message-utils.js";

defineProps({
	item: { type: Object, required: true },
});

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
			<div class="text">{{ textOf(item.message.content) }}</div>
			<img v-for="(image, i) in imagesOf(item.message.content)" :key="i" :src="dataUrl(image)" alt="" />
		</div>
	</div>

	<div v-else-if="item.kind === 'assistant'" class="msg assistant">
		<template v-for="(block, i) in blocksOf(item.message)" :key="i">
			<div v-if="block.type === 'text'" class="md" v-html="mdOf(block)"></div>
			<details v-else-if="block.type === 'thinking'" class="thinking">
				<summary>
					<svg class="think-icon" viewBox="0 0 16 16" aria-hidden="true">
						<path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4" />
					</svg>
					<span class="think-label">Thought</span>
					<span class="think-preview ellipsis">{{ block.thinking.replace(/\s+/g, " ").slice(0, 80) }}</span>
				</summary>
				<div class="think-body">{{ block.thinking }}</div>
			</details>
			<details
				v-else-if="block.type === 'toolCall'"
				class="tool"
				:class="{ failed: item.results[block.id]?.isError }"
			>
				<summary>
					<span class="chev"></span>
					<span class="tool-verb">{{ toolLabel(block) }}</span>
					<span class="tool-arg ellipsis">{{ toolArg(block) }}</span>
					<span v-if="!item.results[block.id]" class="tool-state running">running</span>
				</summary>
				<div class="tool-body">
					<pre class="code">{{ JSON.stringify(block.arguments ?? {}, null, 2) }}</pre>
					<template v-if="item.results[block.id]">
						<div class="text">{{ textOf(item.results[block.id].content) }}</div>
					</template>
				</div>
			</details>
			<img v-else-if="block.type === 'image'" :src="dataUrl(block)" alt="" />
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
