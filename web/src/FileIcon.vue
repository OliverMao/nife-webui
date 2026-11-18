<script setup>
import { computed } from "vue";
import { FILE_ICONS, fileKind } from "./files.js";

const props = defineProps({
	name: { type: String, required: true },
});

const kind = computed(() => fileKind(props.name));
</script>

<template>
	<svg class="file-icon" :class="`file-${kind}`" viewBox="0 0 16 16" aria-hidden="true">
		<template v-for="(shape, i) in FILE_ICONS[kind]" :key="i">
			<circle v-if="shape.circle" :cx="shape.circle[0]" :cy="shape.circle[1]" :r="shape.circle[2]" />
			<path v-else :d="shape.d" />
		</template>
	</svg>
</template>
