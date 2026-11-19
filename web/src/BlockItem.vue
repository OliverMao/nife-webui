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
	<!-- One click opens the row; the reasoning must not need a second one, so it is plain text here. -->
	<div v-else-if="block.type === 'thinking'" class="think-body">{{ block.thinking }}</div>
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
