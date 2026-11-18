// Large pastes are stored out of band and replaced with a marker, mirroring the TUI editor
// (`[paste #1 +48 lines]` / `[paste #1 1234 chars]`). Thresholds match the TUI too.
export const PASTE_MAX_LINES = 10;
export const PASTE_MAX_CHARS = 1000;

// Image paste limits. The send list is what providers accept and matches nife's clipboard path;
// the input list adds bmp, which nife attaches too but no provider takes as a media type, so the
// browser converts it to png. The byte cap is nife's own resize cap (4.5MB of base64, below the
// providers' 5MB per-image limit), so a dropped screenshot is shrunk to what the terminal would send.
export const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
export const IMAGE_INPUT_MIME_TYPES = [...IMAGE_MIME_TYPES, "image/bmp"];
export const IMAGE_MAX_BYTES = 4.5 * 1024 * 1024;
export const IMAGE_MAX_DIMENSION = 2000;
export const IMAGE_MAX_COUNT = 4;

const MARKER = /\[paste #(\d+)(?: \+\d+ lines| \d+ chars)?\]/g;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const MIME_ALIASES = { "image/x-bmp": "image/bmp", "image/x-ms-bmp": "image/bmp" };
const EXTENSION_MIME_TYPES = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	webp: "image/webp",
	gif: "image/gif",
	bmp: "image/bmp",
};

/** Normalize a clipboard payload and decide whether it should collapse into a marker. */
export function readClipboard(clip) {
	const text = clip.replace(/\r\n?/g, "\n").replace(/\t/g, "    ");
	const lines = text.split("\n").length;
	return { text, lines, large: lines > PASTE_MAX_LINES || text.length > PASTE_MAX_CHARS };
}

export function pasteMarker(id, clip) {
	const { text, lines } = readClipboard(clip);
	const marker =
		lines > PASTE_MAX_LINES ? `[paste #${id} +${lines} lines]` : `[paste #${id} ${text.length} chars]`;
	return { text, marker };
}

/** Replace markers with their stored payload; unknown or edited markers stay as typed. */
export function expandPastes(value, pastes) {
	return value.replace(MARKER, (marker, id) => pastes.get(Number(id)) ?? marker);
}

/** Clipboard items that carry an image file; text items and other files are left to the browser. */
export function imageFiles(items) {
	return items.filter((item) => item.kind === "file" && imageMimeType({ type: item.type, name: "" }) !== null);
}

/**
 * Image type a dropped or pasted file is handled as, or null when it is not an image. nife also
 * accepts a path to any file, but a browser drop never reveals that path, so non-images cannot be
 * attached from here.
 */
export function imageMimeType(file) {
	const reported = (file.type || "").toLowerCase();
	const mimeType = MIME_ALIASES[reported] ?? reported;
	if (IMAGE_INPUT_MIME_TYPES.includes(mimeType)) return mimeType;
	// Desktops often report no type at all; fall back to the extension.
	if (reported === "") {
		const extension = /\.([a-z0-9]+)$/i.exec(file.name || "")?.[1]?.toLowerCase() ?? "";
		return EXTENSION_MIME_TYPES[extension] ?? null;
	}
	return null;
}

/** Why these images cannot be sent, or null when they can. The bridge re-checks all of it. */
export function imageProblem(images) {
	if (images.length > IMAGE_MAX_COUNT) return `at most ${IMAGE_MAX_COUNT} images per message`;
	for (const image of images) {
		if (!IMAGE_MIME_TYPES.includes(image.mimeType)) return `unsupported image type ${image.mimeType || "(none)"}`;
		if (!BASE64.test(image.data)) return "malformed image data";
		if (image.data.length > IMAGE_MAX_BYTES) return "image is too large (limit 4.5MB)";
	}
	return null;
}
