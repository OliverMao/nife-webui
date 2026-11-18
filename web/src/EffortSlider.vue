<script setup>
import { computed, ref } from "vue";

// Visuals follow dsh-codex-effort-slider: blue -> violet -> deep violet fill, white knob,
// energy layer + stardust only above the first third, ticks per level.
const KNOB = 12; // px radius
const BLUE = [77, 147, 248];
const VIOLET = [147, 51, 234];
const DEEP = [76, 29, 149];
const TEXT_VIOLET = [139, 92, 246];
const ENERGY_START = 1 / 3;
const ENERGY_END = 2 / 3;
const STAR_COUNT = 22;
const GOLDEN = 0.6180339887498949;

const props = defineProps({
	levels: { type: Array, required: true },
	index: { type: Number, required: true },
});
const emit = defineEmits(["change"]);

const track = ref(null);
const dragging = ref(false);
// continuous pointer position while dragging; null when the knob sits on a level
const dragPct = ref(null);

const count = computed(() => props.levels.length);
const pct = computed(() => {
	if (count.value <= 0) return 0;
	// a single level means "max", not "off"
	if (count.value === 1) return 1;
	return Math.max(0, Math.min(count.value - 1, props.index)) / (count.value - 1);
});

const shownPct = computed(() => dragPct.value ?? pct.value);

const clamp01 = (value) => (value > 0 ? (value > 1 ? 1 : value) : 0);
const mix = (from, to, t) => {
	const k = clamp01(t);
	return [0, 1, 2].map((i) => Math.round(from[i] + (to[i] - from[i]) * k));
};
const rgb = (color) => `rgb(${color[0]},${color[1]},${color[2]})`;

const energy = computed(() => clamp01((shownPct.value - ENERGY_START) / (1 - ENERGY_START)));

const fillTip = computed(() => {
	const t = shownPct.value;
	if (t <= ENERGY_START) return BLUE;
	if (t <= ENERGY_END) return mix(BLUE, VIOLET, (t - ENERGY_START) / (ENERGY_END - ENERGY_START));
	return mix(VIOLET, DEEP, (t - ENERGY_END) / (1 - ENERGY_END));
});
const fillBackground = computed(() => `linear-gradient(90deg, ${rgb(BLUE)}, ${rgb(fillTip.value)})`);

const levelName = computed(() => String(props.levels[props.index] ?? ""));
const isOff = computed(() => ["off", "none", "关闭", "无"].includes(levelName.value.replace(/\s+/g, "").toLowerCase()));
const valueColor = computed(() => (isOff.value ? "" : rgb(mix(BLUE, TEXT_VIOLET, energy.value))));

const knobPos = computed(() => `calc(${KNOB}px + ${shownPct.value} * (100% - ${KNOB * 2}px))`);
const tickPos = (index) =>
	`calc(${KNOB}px + ${count.value <= 1 ? 1 : index / (count.value - 1)} * (100% - ${KNOB * 2}px))`;

const hash = (index, salt) => ((Math.abs(Math.sin((index + 1) * salt) * 43758.5453) % 1) + 1) % 1;
const stars = Array.from({ length: STAR_COUNT }, (_, i) => {
	const phase = ((i + 1) * GOLDEN) % 1;
	const spread = 1 - 0.08 + 2 * 0.08 * hash(i, 29);
	return {
		top: `${8 + hash(i, 71) * 84}%`,
		brightness: Math.round((0.5 + 0.5 * hash(i, 61)) * 100) / 100,
		duration: `${(1.5 * spread).toFixed(2)}s`,
		delay: `${(-phase * 1.5).toFixed(2)}s`,
	};
});
const visibleStars = computed(() => stars.slice(0, Math.round(energy.value * STAR_COUNT)));

const pctFromEvent = (event) => {
	const node = track.value;
	if (!node) return 0;
	const rect = node.getBoundingClientRect();
	return clamp01((event.clientX - rect.left - KNOB) / Math.max(rect.width - KNOB * 2, 1));
};

/** Nearest level: the knob tracks the pointer linearly and only the level snaps. */
function nearest(pointer) {
	const total = count.value;
	if (total <= 1) return 0;
	return Math.max(0, Math.min(total - 1, Math.round(clamp01(pointer) * (total - 1))));
}

function commit(next) {
	if (next !== props.index) emit("change", next);
}

function onPointerDown(event) {
	if (count.value <= 1) return;
	dragging.value = true;
	track.value?.setPointerCapture?.(event.pointerId);
	track.value?.focus?.();
	dragPct.value = pctFromEvent(event);
	commit(nearest(dragPct.value));
}

function onPointerMove(event) {
	if (!dragging.value) return;
	dragPct.value = pctFromEvent(event);
	commit(nearest(dragPct.value));
}

function onPointerUp(event) {
	dragging.value = false;
	// dropping dragPct lets the knob animate onto the level it snapped to
	dragPct.value = null;
	try {
		track.value?.releasePointerCapture?.(event.pointerId);
	} catch {
		// pointer already released
	}
}

function onKeydown(event) {
	if (count.value <= 1) return;
	const last = count.value - 1;
	const keys = {
		ArrowRight: () => Math.min(last, props.index + 1),
		ArrowUp: () => Math.min(last, props.index + 1),
		ArrowLeft: () => Math.max(0, props.index - 1),
		ArrowDown: () => Math.max(0, props.index - 1),
		Home: () => 0,
		End: () => last,
	};
	const next = keys[event.key];
	if (!next) return;
	event.preventDefault();
	commit(next());
}
</script>

<template>
	<div class="effort">
		<div class="effort-head">
			<span class="effort-label">Reasoning</span>
			<span class="effort-value" :style="valueColor ? { color: valueColor } : undefined">{{ levelName }}</span>
		</div>
		<div
			ref="track"
			class="effort-track"
			:class="{ dragging }"
			:style="energy > 0 ? { boxShadow: `0 0 ${Math.round(energy * 16)}px rgba(168, 85, 247, 0.5)` } : undefined"
			role="slider"
			tabindex="0"
			aria-label="Reasoning effort"
			:aria-valuemin="0"
			:aria-valuemax="count - 1"
			:aria-valuenow="index"
			:aria-valuetext="levelName"
			@pointerdown="onPointerDown"
			@pointermove="onPointerMove"
			@pointerup="onPointerUp"
			@pointercancel="onPointerUp"
			@keydown="onKeydown"
		>
			<div class="effort-fill" :style="{ width: knobPos, background: fillBackground }"></div>
			<div class="effort-energy" :style="{ width: knobPos, opacity: energy }">
				<div class="effort-sweep"></div>
				<span
					v-for="(star, i) in visibleStars"
					:key="i"
					class="effort-star"
					:style="{ top: star.top, '--b': star.brightness, animationDuration: star.duration, animationDelay: star.delay }"
				></span>
			</div>
			<span
				v-for="(level, i) in levels"
				:key="level"
				class="effort-tick"
				:class="{ on: i <= index }"
				:style="{ left: tickPos(i) }"
			></span>
			<span class="effort-knob" :style="{ left: knobPos }"></span>
		</div>
	</div>
</template>
