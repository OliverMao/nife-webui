// A pasted or dropped image becomes an ImageContent block ({ mimeType, data }) for
// `sendUserMessage`. Anything over 2000px or 4.5MB of base64 is redrawn on a canvas first: that
// is the same cap nife applies to terminal clipboard images, and it keeps requests under the
// providers' 5MB per-image limit without pushing the work onto the agent. bmp is always redrawn
// to png, because nife attaches it but no provider accepts image/bmp.
import { IMAGE_MAX_BYTES, IMAGE_MAX_DIMENSION, imageMimeType } from "./paste.js";

const RESIZE_ATTEMPTS = 4;

/** data: URL -> base64 payload. */
function base64(dataUrl) {
	return dataUrl.slice(dataUrl.indexOf(",") + 1);
}

function readAsDataUrl(blob) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result));
		reader.onerror = () => reject(new Error("could not read the pasted image"));
		reader.readAsDataURL(blob);
	});
}

/**
 * Encoding goes through `toBlob`, not `toDataURL`: a 2000px PNG takes hundreds of milliseconds and
 * toDataURL does that on the main thread, freezing the spinner that is supposed to say work is
 * happening. The blob is then read as base64 asynchronously.
 */
function encode(canvas, type, quality) {
	return new Promise((resolve, reject) => {
		canvas.toBlob(
			(blob) => {
				if (!blob) {
					reject(new Error("canvas is unavailable"));
					return;
				}
				readAsDataUrl(blob).then(resolve, reject);
			},
			type,
			quality,
		);
	});
}

async function draw(bitmap, scale, type, quality) {
	const canvas = document.createElement("canvas");
	canvas.width = Math.max(1, Math.round(bitmap.width * scale));
	canvas.height = Math.max(1, Math.round(bitmap.height * scale));
	const context = canvas.getContext("2d");
	if (!context) throw new Error("canvas is unavailable");
	context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
	return base64(await encode(canvas, type, quality));
}

export async function prepareImage(file) {
	const mimeType = imageMimeType(file);
	if (!mimeType) throw new Error(`${file.type || file.name || "that file"} is not a supported image`);

	// Animated GIFs cannot be scaled without losing the animation, so only their size is checked.
	if (mimeType === "image/gif") {
		const data = base64(await readAsDataUrl(file));
		if (data.length > IMAGE_MAX_BYTES) throw new Error("GIF is too large (limit 4.5MB)");
		return { mimeType, data };
	}

	const bitmap = await createImageBitmap(file);
	try {
		const fits =
			mimeType !== "image/bmp" &&
			bitmap.width <= IMAGE_MAX_DIMENSION &&
			bitmap.height <= IMAGE_MAX_DIMENSION &&
			(file.size * 4) / 3 <= IMAGE_MAX_BYTES;
		if (fits) return { mimeType, data: base64(await readAsDataUrl(file)) };

		// PNG stays lossless (screenshots, UI mockups) and bmp needs a provider media type; photos
		// and oversized webp go to JPEG.
		const type = mimeType === "image/png" || mimeType === "image/bmp" ? "image/png" : "image/jpeg";
		let scale = Math.min(1, IMAGE_MAX_DIMENSION / bitmap.width, IMAGE_MAX_DIMENSION / bitmap.height);
		let quality = type === "image/png" ? undefined : 0.85;
		for (let attempt = 0; attempt < RESIZE_ATTEMPTS; attempt += 1) {
			const data = await draw(bitmap, scale, type, quality);
			if (data.length <= IMAGE_MAX_BYTES) return { mimeType: type, data };
			// Ask the overshoot how much smaller the picture has to be instead of creeping down 25% a
			// time: a full-resolution photo dragged from disk used to be encoded up to six times, and a
			// PNG encode of a 2000px screenshot is the expensive step here. Area scales with the square
			// of the edge, so the new edge is `1/sqrt(over)`; the extra 5% covers the slack.
			const over = data.length / IMAGE_MAX_BYTES;
			scale = Math.max(0.2, scale * Math.min(0.9, Math.sqrt(1 / over) * 0.95));
			if (type !== "image/png") quality = Math.max(0.6, quality - 0.05);
		}
		throw new Error("could not shrink the image below 4.5MB");
	} finally {
		bitmap.close();
	}
}

/**
 * A preview that exists before the work does. A dropped photo can take seconds to decode and
 * re-encode on the main thread, and until this existed the attachment appeared only afterwards:
 * nothing on screen, no way to tell the drop had landed. The blob URL is instant and costs no
 * decode; `ready()` resolves with the resized payload (and the data URL to keep showing) once
 * `prepareImage` is done, so the caller can swap the placeholder in place.
 */
// `?debug=1` on the page: how long each attachment took to decode and re-encode. The interesting
// number when a drop "hangs" is whether that time is spent here or before the drop is delivered.
const DEBUG = new URLSearchParams(location.search).has("debug");

export function previewImage(file) {
	const url = URL.createObjectURL(file);
	return {
		url,
		async ready() {
			const started = performance.now();
			try {
				const { mimeType, data } = await prepareImage(file);
				return { mimeType, data, url: `data:${mimeType};base64,${data}` };
			} finally {
				if (DEBUG) {
					const ms = Math.round(performance.now() - started);
					console.log(`[webui] ${file.name || "image"} ${file.size}B prepared in ${ms}ms`);
				}
				// the picture is on screen again (or the chip is gone): the blob is no longer needed
				URL.revokeObjectURL(url);
			}
		},
	};
}
