// nife's message model has no file block. Work files travel as one `[attached] <path>` line for
// the agent to read; Chat files travel as an `[attached-inline]` block because that workspace has no
// tool to read a path. Either way both the composer and the transcript render a file chip.

const ATTACHED_LINE = /^\[attached\] (.+)$/;
const INLINE_LINE = /^\[attached-inline\] (.+)$/;
const QUOTED = /^"(.*)"$/;

/**
 * One prompt line per dropped file. The stored path is generated and opaque, so the user's name
 * travels next to it: JSON keeps both unambiguous whatever the name contains, and it is still
 * readable for the agent, which only needs `path`.
 */
export function attachedLine(file) {
	return `[attached] ${JSON.stringify({ name: file.name || fileNameOf(file.path), path: file.path })}`;
}

/**
 * Chat has no tools, so text files are carried inside the prompt instead of as a path. The random
 * end token lets the transcript hide the block as a chip even when the file itself contains marker
 * text, and lets Edit put the file back without asking the server for it.
 */
export function inlineAttachedBlock(file) {
	const end = `NIFE_FILE_END_${Math.random().toString(36).slice(2, 10)}`;
	return `[attached-inline] ${JSON.stringify({ name: file.name, end })}\n${file.text}\n${end}`;
}

export function fileNameOf(path) {
	return path.split(/[\\/]/).pop() || path;
}

/** Category for the chip icon; unknown extensions fall back to a plain page. */
const EXTENSION_KINDS = {
	pdf: "pdf",
	png: "image",
	jpg: "image",
	jpeg: "image",
	gif: "image",
	webp: "image",
	bmp: "image",
	svg: "image",
	avif: "image",
	heic: "image",
	mp3: "audio",
	wav: "audio",
	flac: "audio",
	ogg: "audio",
	m4a: "audio",
	aac: "audio",
	mp4: "video",
	mov: "video",
	webm: "video",
	mkv: "video",
	avi: "video",
	zip: "archive",
	tar: "archive",
	gz: "archive",
	tgz: "archive",
	bz2: "archive",
	xz: "archive",
	zst: "archive",
	rar: "archive",
	"7z": "archive",
	txt: "text",
	log: "text",
	rst: "text",
	md: "text",
	markdown: "text",
	doc: "doc",
	docx: "doc",
	odt: "doc",
	rtf: "doc",
	csv: "sheet",
	tsv: "sheet",
	xls: "sheet",
	xlsx: "sheet",
	ods: "sheet",
	ppt: "slides",
	pptx: "slides",
	odp: "slides",
	key: "slides",
	json: "code",
	jsonc: "code",
	yml: "code",
	yaml: "code",
	toml: "code",
	ini: "code",
	xml: "code",
	js: "code",
	mjs: "code",
	cjs: "code",
	ts: "code",
	tsx: "code",
	jsx: "code",
	vue: "code",
	svelte: "code",
	py: "code",
	rb: "code",
	go: "code",
	rs: "code",
	java: "code",
	kt: "code",
	swift: "code",
	c: "code",
	h: "code",
	cpp: "code",
	hpp: "code",
	cs: "code",
	php: "code",
	sh: "code",
	bash: "code",
	zsh: "code",
	fish: "code",
	ps1: "code",
	lua: "code",
	sql: "code",
	html: "code",
	css: "code",
	scss: "code",
	less: "code",
	nix: "code",
};

export function fileKind(name) {
	const extension = /\.([a-z0-9]+)$/i.exec(name || "")?.[1]?.toLowerCase() ?? "";
	return EXTENSION_KINDS[extension] ?? "file";
}

// 16x16 stroked shapes, same weight as the rest of the UI icons.
const PAGE = [{ d: "M4 1.5h5l3 3v10H4z" }, { d: "M9 1.5v3h3" }];
const BARS = [{ d: "M6 7.5h4" }, { d: "M6 9.5h4" }, { d: "M6 11.5h2.5" }];

export const FILE_ICONS = {
	file: PAGE,
	text: [{ d: "M3.5 1.5h9v13h-9z" }, ...BARS],
	doc: [...PAGE, { d: "M6 8h4" }, { d: "M6 10h4" }, { d: "M6 12h2.5" }],
	pdf: [...PAGE, { d: "M6 6.5h4" }, { d: "M6 9h4" }, { d: "M6 11.5h4" }],
	sheet: [{ d: "M2.5 3.5h11v9h-11z" }, { d: "M2.5 6.5h11" }, { d: "M6 3.5v9" }, { d: "M9.5 3.5v9" }],
	slides: [{ d: "M2.5 3h11v7.5h-11z" }, { d: "M8 10.5v2" }, { d: "M5.5 13.8h5" }],
	archive: [{ d: "M3 2.5h10v2.5H3z" }, { d: "M4.2 5v9h7.6V5" }, { d: "M8 7v1" }, { d: "M8 9.5v1" }, { d: "M8 12v1" }],
	code: [{ d: "M5.8 5.5L3.2 8l2.6 2.5" }, { d: "M10.2 5.5L12.8 8l-2.6 2.5" }],
	audio: [{ circle: [4.9, 11.2, 1.4] }, { circle: [10.4, 9.7, 1.4] }, { d: "M6.3 11.2V5l5.5-1.5v6.2" }],
	video: [{ d: "M2.5 4.5h7v7h-7z" }, { d: "M9.5 7l3.7-2v6l-3.7-2" }],
	image: [{ d: "M2.5 3.5h11v9h-11z" }, { circle: [5.8, 6.4, 1] }, { d: "M3 11.6l3.1-3.1 2.6 2.6" }],
};

/** Split prompt text into what the user typed and the files the bridge appended. */
export function splitAttachments(text) {
	const files = [];
	const kept = [];
	const lines = text.split("\n");
	for (let index = 0; index < lines.length; index += 1) {
		const inline = INLINE_LINE.exec(lines[index].trim());
		if (inline) {
			const parsed = parseInlineAttachment(inline[1]);
			if (parsed) {
				let end = index + 1;
				while (end < lines.length && lines[end] !== parsed.end) end += 1;
				if (end < lines.length) {
					const body = lines.slice(index + 1, end).join("\n");
					files.push({ name: parsed.name, text: body, size: body.length, inline: true });
					index = end;
					continue;
				}
				// A truncated marker is ordinary text, not a reason to eat the rest of the prompt.
				kept.push(...lines.slice(index));
				break;
			}
		}
		const match = ATTACHED_LINE.exec(lines[index].trim());
		if (!match) {
			kept.push(lines[index]);
			continue;
		}
		const file = parseAttachment(match[1]);
		if (file) files.push(file);
		else kept.push(lines[index]);
	}
	return { text: kept.join("\n").trim(), files };
}

function parseInlineAttachment(payload) {
	try {
		const parsed = JSON.parse(payload);
		if (typeof parsed?.name === "string" && parsed.name && typeof parsed.end === "string" && parsed.end) {
			return { name: parsed.name, end: parsed.end };
		}
	} catch {
		// fall through to text
	}
	return null;
}

function parseAttachment(payload) {
	const raw = payload.trim();
	if (raw.startsWith("{")) {
		try {
			const parsed = JSON.parse(raw);
			if (typeof parsed?.path === "string" && parsed.path) {
				const name = typeof parsed.name === "string" && parsed.name ? parsed.name : fileNameOf(parsed.path);
				return { name, path: parsed.path };
			}
		} catch {
			return null;
		}
		return null;
	}
	// Sessions recorded before names were carried along stored just the path.
	const path = raw.replace(QUOTED, "$1");
	return /[\\/]/.test(path) ? { name: fileNameOf(path), path } : null;
}

export function formatBytes(bytes) {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
	const units = ["B", "KB", "MB", "GB"];
	const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
	const value = bytes / 1024 ** index;
	return `${value >= 10 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}
