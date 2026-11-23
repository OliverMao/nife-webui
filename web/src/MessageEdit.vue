<script setup>
import { computed, nextTick, onMounted, ref, watch } from "vue";
import FileIcon from "./FileIcon.vue";
import { uploadFile } from "./bridge.js";
import { formatBytes, splitAttachments } from "./files.js";
import { INLINE_MAX_CHARS, INLINE_TOTAL_CHARS, inlineTextOf } from "./inline.js";
import { previewImage } from "./images.js";
import { dataUrl, imagesOf, textOf } from "./message-utils.js";
import { IMAGE_MAX_COUNT, asImageFile, imageMimeType } from "./paste.js";

/**
 * The prompt, editable where it stands. DeepSeek's edit card: the bubble is replaced by this box -
 * attachments first, then the text, then Cancel / Send - and the composer is not involved at all.
 * Nothing is submitted until Send, which is when the branch moves (see /api/tree).
 */
const props = defineProps({
	item: { type: Object, required: true },
	// the branch is being moved: the card stays, its buttons do not
	busy: { type: Boolean, default: false },
	// what was typed so far, when this card had to be unmounted (the transcript only keeps a window
	// of rows mounted, so scrolling far enough away would otherwise lose the edit)
	draft: { type: Object, default: null },
	// Chat inlines text instead of handing the model a path it has no tool to read.
	chat: { type: Boolean, default: false },
});

// `notice` is the composer's toast: the card is too small for its own error line
const emit = defineEmits(["cancel", "submit", "draft", "notice"]);

// `[attached] <path>` lines are chips, not text: the same split the bubble and the composer use
const original = computed(() => splitAttachments(textOf(props.item.message.content)));
const initial = props.draft ?? {
	text: original.value.text,
	images: imagesOf(props.item.message.content),
	files: original.value.files,
};
const text = ref(initial.text);
const images = ref(
	initial.images.map((image, index) => ({ ...image, id: index, url: dataUrl(image) })),
);
const files = ref(initial.files.map((file, index) => ({ ...file, id: index })));
// dropped-but-not-yet-uploaded files and pasted images share one id space with the restored ones
let seq = 0;
const dragging = ref(false);

const box = ref(null);

function resize() {
	const node = box.value;
	if (!node) return;
	node.style.height = "auto";
	node.style.height = `${Math.min(node.scrollHeight, 220)}px`;
}

onMounted(() => {
	void nextTick(() => {
		const node = box.value;
		if (!node) return;
		node.focus();
		// editing usually continues where the prompt ended
		node.setSelectionRange(node.value.length, node.value.length);
		resize();
	});
});

const removeImage = (id) => (images.value = images.value.filter((image) => image.id !== id));
const removeFile = (id) => (files.value = files.value.filter((file) => file.id !== id));

/** Pasted or dropped pictures: previewed at once, resized behind it, exactly like the composer. */
async function addImages(incoming) {
	const room = IMAGE_MAX_COUNT - images.value.length;
	if (room <= 0) {
		emit("notice", `at most ${IMAGE_MAX_COUNT} images per message`);
		return;
	}
	if (incoming.length > room) emit("notice", `at most ${IMAGE_MAX_COUNT} images per message`);
	for (const file of incoming.slice(0, room)) {
		seq += 1;
		const id = `new-${seq}`;
		const preview = previewImage(file);
		images.value = [...images.value, { id, name: file.name, loading: true, url: preview.url }];
		const patch = (next) =>
			(images.value = images.value.map((image) => (image.id === id ? { ...image, ...next } : image)));
		try {
			patch({ ...(await preview.ready()), loading: false });
		} catch (error) {
			images.value = images.value.filter((image) => image.id !== id);
			emit("notice", error instanceof Error ? error.message : "could not read the pasted image");
		}
	}
}

const patchFile = (id, patch) =>
	(files.value = files.value.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)));

/** Dropped non-images: Work uploads a temp path, Chat reads the text here. */
async function addFiles(incoming) {
	for (const file of incoming) {
		seq += 1;
		const id = `new-${seq}`;
		const chip = { id, name: file.name || "file", size: file.size, progress: 0, path: "", reading: props.chat };
		files.value = [...files.value, chip];
		try {
			if (props.chat) {
				const text = await inlineTextOf(file);
				if (text.length > INLINE_MAX_CHARS) {
					throw new Error(`file is too long for Chat (limit ${Math.round(INLINE_MAX_CHARS / 1000)}k characters)`);
				}
				const used = files.value.reduce((total, entry) => total + (entry.text?.length ?? 0), 0);
				if (used + text.length > INLINE_TOTAL_CHARS) {
					throw new Error(`Chat can inline at most ${Math.round(INLINE_TOTAL_CHARS / 1000)}k characters per message`);
				}
				patchFile(id, { reading: false, progress: 1, text });
			} else {
				const uploaded = await uploadFile(file, (fraction) => patchFile(id, { progress: fraction }));
				patchFile(id, { progress: 1, path: uploaded.path, name: uploaded.name || chip.name });
			}
		} catch (error) {
			files.value = files.value.filter((entry) => entry.id !== id);
			emit("notice", error instanceof Error ? error.message : "upload failed");
		}
	}
}

/**
 * Clipboard files become attachments; copied text stays native, the textarea handles it. One pass,
 * because `getAsFile()` is not guaranteed to hand back the same object twice.
 */
/**
 * A clipboard item knows its type even when the File it hands over does not (a screenshot paste can
 * arrive with an empty `File.type` and no name, which used to look like a plain file - no preview,
 * no image block for the model). The File is re-typed before it reaches `prepareImage`.
 */
function pictureOf(item, file) {
	const type = item.type || file.type;
	if (!type || type === file.type) return imageMimeType(file) ? file : null;
	const typed = new File([file], file.name || "image", { type });
	return imageMimeType(typed) ? typed : null;
}

function onPaste(event) {
	const pictures = [];
	const rest = [];
	for (const item of [...(event.clipboardData?.items ?? [])]) {
		if (item.kind !== "file") continue;
		const file = item.getAsFile();
		if (!file) continue;
		const picture = pictureOf(item, file);
		if (picture) pictures.push(picture);
		else rest.push(file);
	}
	if (pictures.length === 0 && rest.length === 0) return;
	event.preventDefault();
	if (pictures.length > 0) void addImages(pictures);
	if (rest.length > 0) void addFiles(rest);
}

function onDragOver(event) {
	if (!event.dataTransfer?.types.includes("Files")) return;
	event.preventDefault();
	event.stopPropagation();
	event.dataTransfer.dropEffect = "copy";
	dragging.value = true;
}

function onDragLeave(event) {
	if (event.relatedTarget) return;
	dragging.value = false;
}

function onDrop(event) {
	const dropped = [...(event.dataTransfer?.files ?? [])];
	dragging.value = false;
	if (dropped.length === 0) return;
	event.preventDefault();
	event.stopPropagation();
	void attachDropped(dropped);
}

/** Split a drop into pictures and files; a type the browser forgot is read from the header. */
async function attachDropped(dropped) {
	const pictures = [];
	const rest = [];
	for (const file of dropped) {
		const picture = await asImageFile(file);
		if (picture) pictures.push(picture);
		else rest.push(file);
	}
	if (pictures.length > 0) await addImages(pictures);
	if (rest.length > 0) await addFiles(rest);
}

const uploading = computed(() => files.value.some((file) => !file.path && typeof file.text !== "string"));
const preparing = computed(() => images.value.some((image) => image.loading));
const fileSize = (file) => {
	if (file.reading) return "Reading…";
	if (typeof file.text === "string") return formatBytes(file.size ?? file.text.length);
	if (!file.path) return file.progress > 0 ? `${Math.round(file.progress * 100)}%` : "Uploading…";
	return Number.isFinite(file.size) ? formatBytes(file.size) : "";
};

const empty = computed(
	() => !text.value.trim() && !images.value.some((image) => !image.loading) && files.value.length === 0,
);

/** The card's state as one sendable draft; promptTextOf() turns the files back into marker lines. */
const draftOf = () => ({
	text: text.value.trim(),
	images: images.value.filter((image) => !image.loading).map(({ mimeType, data }) => ({ mimeType, data })),
	// a file that is still uploading has no path and no text: it is not part of the draft
	files: files.value
		.filter((file) => file.path || typeof file.text === "string")
		.map(({ name, path, size, text }) => ({ name, path, size, text })),
});

// Hand every change back, so the draft survives being scrolled out of the rendered window.
watch([text, images, files], () => emit("draft", draftOf()));

function submit() {
	if (props.busy || empty.value) return;
	if (uploading.value) {
		emit("notice", "still uploading, try again in a moment");
		return;
	}
	if (preparing.value) {
		emit("notice", "still preparing the image, try again in a moment");
		return;
	}
	emit("submit", draftOf());
}

/** Enter sends, Shift+Enter is a newline - the composer's own rule. */
function onKeydown(event) {
	if (event.key !== "Enter" || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
	if (event.isComposing) return;
	event.preventDefault();
	submit();
}
</script>

<template>
	<div class="msg user">
		<div class="edit-card" :class="{ dragging }" @dragover="onDragOver" @dragleave="onDragLeave" @drop="onDrop">
			<!-- The composer's own attachment row, class for class: a prompt shows its pictures and files
			     exactly the way the input at the bottom does, thumbnails and remove badges included. -->
			<div v-if="images.length > 0 || files.length > 0" class="attachments">
				<figure v-for="image in images" :key="image.id" class="attachment" :class="{ loading: image.loading }">
					<img :src="image.url" alt="" :title="image.loading ? 'preparing…' : image.name || 'pasted image'" />
					<button type="button" class="attachment-remove" title="Remove image" @click="removeImage(image.id)">×</button>
				</figure>
				<div v-for="file in files" :key="file.id" class="file-chip" :title="file.path || file.name">
					<FileIcon :name="file.name" />
					<span class="file-meta">
						<span class="file-name ellipsis">{{ file.name }}</span>
						<span class="file-size">{{ fileSize(file) }}</span>
					</span>
					<button type="button" class="attachment-remove" title="Remove file" @click="removeFile(file.id)">×</button>
					<span
						v-if="!file.path && typeof file.text !== 'string'"
						class="file-progress"
						:style="{ width: `${Math.round(file.progress * 100)}%` }"
					></span>
				</div>
			</div>
			<textarea
				ref="box"
				v-model="text"
				rows="1"
				placeholder="Edit this prompt"
				:disabled="busy"
				@input="resize"
				@paste="onPaste"
				@keydown="onKeydown"
			></textarea>
			<div class="edit-foot">
				<button type="button" class="edit-cancel" :disabled="busy" @click="emit('cancel')">Cancel</button>
				<button
					type="button"
					class="edit-send"
					:disabled="busy || empty || uploading || preparing"
					:title="uploading ? 'Uploading…' : preparing ? 'Preparing the image…' : 'Send'"
					@click="submit"
				>
					{{ busy ? "Sending…" : uploading ? "Uploading…" : preparing ? "Preparing…" : "Send" }}
					<svg v-if="!busy" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 12V4M4 8l4-4 4 4" /></svg>
				</button>
			</div>
		</div>
	</div>
</template>
