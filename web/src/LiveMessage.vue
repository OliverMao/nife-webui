<script setup>
import { onBeforeUnmount, ref, watch } from "vue";
import { renderMarkdown } from "./markdown.js";

// Owns the streaming markdown so the transcript list is not re-rendered per token.
const props = defineProps({
	live: { type: Object, required: true },
});

const html = ref("");
const thinkEl = ref(null);
let lastRender = 0;
let timer = null;
let followFrame = 0;
let following = true;

/** Eased follow so the newest thinking line stays visible while it streams. */
function followTick() {
	followFrame = 0;
	const node = thinkEl.value;
	if (!node || !following) return;
	const target = node.scrollHeight - node.clientHeight;
	if (target <= 0) return;
	const delta = target - node.scrollTop;
	if (Math.abs(delta) < 1) {
		node.scrollTop = target;
		return;
	}
	node.scrollTop += delta * 0.3;
	followFrame = requestAnimationFrame(followTick);
}

function onThinkScroll() {
	const node = thinkEl.value;
	if (!node) return;
	// the user scrolled up: stop fighting them until they come back down
	following = node.scrollHeight - node.scrollTop - node.clientHeight < 32;
}

watch(
	() => props.live.thinking,
	() => {
		// collapsed by default: the body element only exists once the user opens the summary
		if (!thinkEl.value || followFrame) return;
		followFrame = requestAnimationFrame(followTick);
	},
	{ flush: "post" },
);

function render() {
	timer = null;
	lastRender = performance.now();
	html.value = renderMarkdown(props.live.text);
}

onBeforeUnmount(() => {
	if (timer) clearTimeout(timer);
	if (followFrame) cancelAnimationFrame(followFrame);
});

watch(
	() => props.live.text,
	() => {
		// markdown is O(length); cap it at ~8fps while tokens arrive
		const wait = 120 - (performance.now() - lastRender);
		if (wait <= 0) render();
		else if (!timer) timer = setTimeout(render, wait);
	},
);
</script>

<template>
	<div class="msg assistant live">
		<details v-if="live.thinking" class="thinking">
			<summary>
				<svg class="think-icon spinning" viewBox="0 0 16 16" aria-hidden="true">
					<path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4" />
				</svg>
				<span class="think-label">Thinking</span>
			</summary>
			<div ref="thinkEl" class="think-body streaming" @scroll.passive="onThinkScroll">{{ live.thinking }}</div>
		</details>
		<div v-if="html" class="md" v-html="html"></div>
		<div v-else class="text">{{ live.text }}</div>
	</div>
</template>
