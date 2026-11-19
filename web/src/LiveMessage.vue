<script setup>
import { onBeforeUnmount, ref, watch } from "vue";
import LiveThinking from "./LiveThinking.vue";
import { renderMarkdown } from "./markdown.js";
import { stepLabel } from "./transcript.js";

// The turn that is still streaming. The reasoning goes inside the row that will commit as
// "Worked · N tools · M thoughts", and the answer stays outside it, so the live turn has the same
// shape as the committed one instead of leaving the thinking in a block of its own.
const props = defineProps({
	live: { type: Object, required: true },
	// the trailing "Worked" row is hosting the reasoning (see App.vue): only the answer is left here
	hosted: { type: Boolean, default: false },
});

const html = ref("");
// the row is this component's own element, so its expanded state lives here until the turn commits
const opened = ref(false);
let lastRender = 0;
let timer = null;

function render() {
	timer = null;
	lastRender = performance.now();
	html.value = renderMarkdown(props.live.text);
}

watch(
	() => props.live.text,
	() => {
		// markdown is O(length); cap it at ~8fps while tokens arrive
		const wait = 120 - (performance.now() - lastRender);
		if (wait <= 0) render();
		else if (!timer) timer = setTimeout(render, wait);
	},
);

function onToggle(event) {
	opened.value = event.target.open;
}

onBeforeUnmount(() => {
	if (timer) clearTimeout(timer);
});
</script>

<template>
	<div class="msg assistant live">
		<details v-if="!hosted && live.thinking" class="process working" @toggle="onToggle">
			<summary>
				<span class="chev"></span>
				<svg class="think-icon spinning" viewBox="0 0 16 16" aria-hidden="true">
					<path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4" />
				</svg>
				<span class="tool-verb">Working</span>
				<span class="tool-arg ellipsis">{{ stepLabel({ tools: 0, thoughts: 1 }) }}</span>
			</summary>
			<div class="process-body">
				<LiveThinking :live="live" :open="opened" />
			</div>
		</details>
		<div v-if="html" class="md" v-html="html"></div>
		<div v-else-if="live.text" class="text">{{ live.text }}</div>
	</div>
</template>
