<script setup>
import { dataUrl, mdOf, textOf, toolArg, toolLabel } from "./message-utils.js";

// One content block of an assistant message. Split out so a run of thinking/tool blocks can be
// collapsed as a group without duplicating the markup.
defineProps({
	block: { type: Object, required: true },
	results: { type: Object, required: true },
});
</script>

<template>
	<div v-if="block.type === 'text'" class="md" v-html="mdOf(block)"></div>
	<img v-else-if="block.type === 'image'" :src="dataUrl(block)" alt="" />
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
	<details v-else-if="block.type === 'toolCall'" class="tool" :class="{ failed: results[block.id]?.isError }">
		<summary>
			<span class="chev"></span>
			<span class="tool-verb">{{ toolLabel(block) }}</span>
			<span class="tool-arg ellipsis">{{ toolArg(block) }}</span>
			<span v-if="!results[block.id]" class="tool-state running">running</span>
		</summary>
		<div class="tool-body">
			<pre class="code">{{ JSON.stringify(block.arguments ?? {}, null, 2) }}</pre>
			<div v-if="results[block.id]" class="text">{{ textOf(results[block.id].content) }}</div>
		</div>
	</details>
</template>
