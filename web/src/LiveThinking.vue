<script setup>
import { onBeforeUnmount, ref, watch } from "vue";

// The reasoning streaming into the trailing "Working" row. It owns the text so the transcript list
// is not re-rendered per token, and it eases to the newest line while the reader stays at the bottom.
const props = defineProps({
	live: { type: Object, required: true },
	// the surrounding row is open; opening mid-stream should land on the newest line, not the oldest
	open: { type: Boolean, default: false },
});

const el = ref(null);
let frame = 0;
let following = true;

function tick() {
	frame = 0;
	const node = el.value;
	if (!node || !following) return;
	const target = node.scrollHeight - node.clientHeight;
	if (target <= 0) return;
	const delta = target - node.scrollTop;
	if (Math.abs(delta) < 1) {
		node.scrollTop = target;
		return;
	}
	node.scrollTop += delta * 0.3;
	frame = requestAnimationFrame(tick);
}

function onScroll() {
	const node = el.value;
	if (!node) return;
	// the reader scrolled up: stop fighting them until they come back down
	following = node.scrollHeight - node.scrollTop - node.clientHeight < 32;
}

watch(
	() => props.live.thinking,
	() => {
		// collapsed by default: the body has no layout until the row is open
		if (!el.value || frame) return;
		frame = requestAnimationFrame(tick);
	},
	{ flush: "post" },
);

watch(
	() => props.open,
	(open) => {
		if (!open || !el.value) return;
		following = true;
		el.value.scrollTop = el.value.scrollHeight;
	},
	{ flush: "post" },
);

onBeforeUnmount(() => {
	if (frame) cancelAnimationFrame(frame);
});
</script>

<template>
	<div ref="el" class="think-body streaming" @scroll.passive="onScroll">{{ live.thinking }}</div>
</template>
