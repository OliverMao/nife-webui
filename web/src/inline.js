// Chat workspace attachment extraction. There are no tools in this workspace, so text files and
// selectable PDF text are carried inside the prompt instead of being handed over as a path.
import { pdfText } from "./pdf.js";

export const INLINE_MAX_BYTES = 2 * 1024 * 1024;
export const INLINE_MAX_CHARS = 150_000;
export const INLINE_TOTAL_CHARS = 300_000;
const PDF_MAX_BYTES = 25 * 1024 * 1024;

const isPdf = (file) =>
	file.type === "application/pdf" || /\.pdf$/i.test(file.name || "");

function decodeText(bytes) {
	if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
	if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
	return new TextDecoder("utf-8").decode(bytes);
}

export async function inlineTextOf(file) {
	if (isPdf(file)) {
		if (file.size > PDF_MAX_BYTES) throw new Error("PDF is too large for Chat (limit 25MB)");
		let text;
		try {
			text = await pdfText(file);
		} catch {
			throw new Error("could not read this PDF — open it in Nife Work");
		}
		if (!text.trim()) throw new Error("this PDF has no selectable text — open it in Nife Work");
		return text;
	}
	if (file.size > INLINE_MAX_BYTES) throw new Error("file is too large for Chat (limit 2MB) — open it in Nife Work");
	const text = decodeText(new Uint8Array(await file.arrayBuffer()));
	if (text.includes("\u0000")) throw new Error("this looks like a binary file — open it in Nife Work");
	const broken = (text.match(/\uFFFD/g) ?? []).length;
	if (broken > Math.max(4, text.length * 0.01)) {
		throw new Error("this looks like a binary file — open it in Nife Work");
	}
	if (!text.trim()) throw new Error("this file has no readable text");
	return text;
}
