// A pasted or dropped image becomes an ImageContent block ({ mimeType, data }) for
// `sendUserMessage`. Anything over 2000px or 4.5MB of base64 is redrawn on a canvas first: that
// is the same cap nife applies to terminal clipboard images, and it keeps requests under the
// providers' 5MB per-image limit without pushing the work onto the agent. bmp is always redrawn
// to png, because nife attaches it but no provider accepts image/bmp.
import { IMAGE_MAX_BYTES, IMAGE_MAX_DIMENSION, imageMimeType } from "./paste.js";

const RESIZE_ATTEMPTS = 6;

/** data: URL -> base64 payload. */
function base64(dataUrl) {
	return dataUrl.slice(dataUrl.indexOf(",") + 1);
}

function readAsDataUrl(file) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result));
		reader.onerror = () => reject(new Error("could not read the pasted image"));
		reader.readAsDataURL(file);
	});
}

function draw(bitmap, scale, type, quality) {
	const canvas = document.createElement("canvas");
	canvas.width = Math.max(1, Math.round(bitmap.width * scale));
	canvas.height = Math.max(1, Math.round(bitmap.height * scale));
	const context = canvas.getContext("2d");
	if (!context) throw new Error("canvas is unavailable");
	context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
	return base64(canvas.toDataURL(type, quality));
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
		for (let attempt = 0; attempt < RESIZE_ATTEMPTS; attempt += 1) {
			const quality = type === "image/png" ? undefined : 0.85 - attempt * 0.1;
			const data = draw(bitmap, scale, type, quality);
			if (data.length <= IMAGE_MAX_BYTES) return { mimeType: type, data };
			scale *= 0.75;
		}
		throw new Error("could not shrink the image below 4.5MB");
	} finally {
		bitmap.close();
	}
}
