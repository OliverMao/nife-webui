// Large pastes are stored out of band and replaced with a marker, mirroring the TUI editor
// (`[paste #1 +48 lines]` / `[paste #1 1234 chars]`). Thresholds match the TUI too.
export const PASTE_MAX_LINES = 10;
export const PASTE_MAX_CHARS = 1000;

const MARKER = /\[paste #(\d+)(?: \+\d+ lines| \d+ chars)?\]/g;

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
