// Minimal, safe markdown for chat output. Escapes first, then applies a fixed set of
// inline/block transforms, so raw HTML in model output never reaches the DOM.
// Deliberately no dependency except KaTeX: math is a syntax no hand-written renderer gets right,
// and nested lists and reference links are still out of scope.

import katex from "katex";

const PLACEHOLDER = "\u0000";

/**
 * LaTeX, in whichever spelling the model was trained on. `$…$` and `\(…\)` are inline; `$$…$$` and
 * `\[…\]` are display math and get their own block. The dollar form only fires when it looks like a
 * formula - no space just inside the delimiters, no digit right after the closing one - so a sentence
 * such as "$5 for the small one and $12 for the large" stays a sentence. Finding those runs is the
 * callers' job (see `inline` and the display loop); this is only tex in, html out.
 */

/**
 * Rendered formulas, keyed by their source. A streaming answer re-renders its whole markdown on every
 * token, so the same formula is parsed dozens of times a second; rendering is pure, so it is kept. The
 * ceiling matters: a long answer keeps arriving with formulas nobody will draw again.
 */
const mathCache = new Map();
const MATH_CACHE_MAX = 512;

function mathHtml(tex, display) {
	const body = String(tex).trim();
	if (!body) return "";
	const key = `${display ? "d" : "i"}:${body}`;
	const cached = mathCache.get(key);
	if (cached !== undefined) return cached;
	let html;
	try {
		html = katex.renderToString(body, {
			displayMode: display,
			// Model output is not a LaTeX document: an unknown macro or a stray character must show as
			// red text in place, not blank the message or throw during a stream of updates.
			throwOnError: false,
			strict: false,
			trust: false,
		});
	} catch {
		html = `<code>${escapeHtml(body)}</code>`;
	}
	if (mathCache.size >= MATH_CACHE_MAX) mathCache.clear();
	mathCache.set(key, html);
	return html;
}

/** Display math as its own block, with the tex kept as a title so it can still be copied out. */
function mathBlock(tex) {
	return `<div class="math-block" title="${escapeHtml(String(tex).trim())}">${mathHtml(tex, true)}</div>`;
}

export function escapeHtml(text) {
	return String(text)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function emphasis(text) {
	const strongs = [];
	let out = text.replace(/\*\*(.+?)\*\*/g, (_, inner) => {
		strongs.push(inner);
		return `\u0001${strongs.length - 1}\u0001`;
	});
	out = out.replace(/(^|[\s(（])\*([^*\s][^*]*?)\*/g, "$1<em>$2</em>");
	out = out.replace(/~~([^~]+)~~/g, "<del>$1</del>");
	return out.replace(/\u0001(\d+)\u0001/g, (_, index) => `<strong>${emphasis(strongs[Number(index)])}</strong>`);
}

function inline(text) {
	const stash = [];
	const keep = (html) => {
		stash.push(html);
		return `${PLACEHOLDER}${stash.length - 1}${PLACEHOLDER}`;
	};

	let work = String(text);
	// images, inline code and <autolinks> are stashed before escaping so their markup survives
	work = work.replace(/`([^`\n]+)`/g, (_, code) => keep(`<code>${escapeHtml(code)}</code>`));
	work = work.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, url) =>
		keep(/^https?:\/\//i.test(url) ? `<img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}" loading="lazy" />` : escapeHtml(alt)),
	);
	work = work.replace(/<(https?:\/\/[^\s>]+)>/g, (_, url) =>
		keep(`<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer noopener">${escapeHtml(url)}</a>`),
	);
	// Math is stashed with the code: rendering it here means the tex never meets the emphasis pass,
	// and a formula may contain characters that pass would otherwise eat (`*`, `_`, `~~`).
	work = work.replace(/\$\$([^$\n]+?)\$\$/g, (_, tex) => keep(mathBlock(tex)));
	work = work.replace(/\\\[([\s\S]+?)\\\]/g, (_, tex) => keep(mathBlock(tex)));
	work = work.replace(/\\\(([\s\S]+?)\\\)/g, (_, tex) => keep(mathHtml(tex, false)));
	work = work.replace(/(?<![\\$])\$(?![\s$])([^$\n]+?)(?<![\s\\])\$(?![\d$])/g, (_, tex) => keep(mathHtml(tex, false)));

	let out = emphasis(escapeHtml(work));
	out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, url) => {
		if (!/^https?:\/\//i.test(url)) return `${label} (${url})`;
		return `<a href="${url}" target="_blank" rel="noreferrer noopener">${label}</a>`;
	});

	return out.replace(new RegExp(`${PLACEHOLDER}(\\d+)${PLACEHOLDER}`, "g"), (_, index) => stash[Number(index)]);
}

const DELIMITER_ROW = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** Split a table row on unescaped pipes, dropping the optional leading/trailing ones. */
function splitRow(line) {
	let row = line.trim();
	if (row.startsWith("|")) row = row.slice(1);
	if (row.endsWith("|")) row = row.slice(0, -1);
	return row.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

function alignOf(cell) {
	const left = cell.startsWith(":");
	const right = cell.endsWith(":");
	if (left && right) return "center";
	if (right) return "right";
	if (left) return "left";
	return "";
}

function table(header, delimiters, rows) {
	const align = delimiters.map(alignOf);
	const cell = (tag, text, index) => {
		const style = align[index] ? ` style="text-align:${align[index]}"` : "";
		return `<${tag}${style}>${inline(text)}</${tag}>`;
	};
	const head = header.map((text, i) => cell("th", text, i)).join("");
	const body = rows
		.map((row) => `<tr>${header.map((_, i) => cell("td", row[i] ?? "", i)).join("")}</tr>`)
		.join("");
	return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function codeBlock(language, code) {
	const label = language ? `<span class="code-lang">${escapeHtml(language)}</span>` : "<span></span>";
	return `<div class="code-block">${label}<button type="button" class="code-copy" data-copy>Copy</button><pre><code>${escapeHtml(
		code,
	)}</code></pre></div>`;
}

export function renderMarkdown(source) {
	const lines = String(source ?? "")
		.replace(/\r\n/g, "\n")
		.split("\n");
	const html = [];
	const listStack = [];
	let paragraph = [];

	const flushParagraph = () => {
		if (paragraph.length === 0) return;
		html.push(`<p>${inline(paragraph.join(" "))}</p>`);
		paragraph = [];
	};
	const closeLists = (depth = 0) => {
		while (listStack.length > depth) html.push(`</${listStack.pop()}>`);
	};
	const flushList = () => closeLists(0);
	/** Keeps exactly `depth` open lists, the deepest one being `tag`. */
	const syncList = (depth, tag) => {
		flushParagraph();
		closeLists(depth);
		if (listStack[depth - 1] === tag) return;
		if (listStack.length === depth) html.push(`</${listStack.pop()}>`);
		listStack.push(tag);
		const cls = depth > 1 ? ` class="depth-${depth}"` : "";
		html.push(`<${tag}${cls}>`);
	};
	const listDepthOf = (indent) => (indent === 0 ? 1 : Math.min(1 + Math.ceil(indent / 4), 3));
	const listItem = (text) => {
		const task = text.match(/^\[([ xX])\]\s+(.*)$/);
		if (!task) return `<li>${inline(text)}</li>`;
		const done = task[1].toLowerCase() === "x";
		return `<li class="task"><span class="task-box${done ? " done" : ""}"></span>${inline(task[2])}</li>`;
	};

	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i];
		const fence = line.match(/^\s*(?:```|~~~)(\S*)\s*$/);
		if (fence) {
			flushParagraph();
			flushList();
			const body = [];
			i += 1;
			while (i < lines.length && !/^\s*(?:```|~~~)\s*$/.test(lines[i])) {
				body.push(lines[i]);
				i += 1;
			}
			html.push(codeBlock(fence[1], body.join("\n")));
			continue;
		}

		if (/^\s*$/.test(line)) {
			flushParagraph();
			continue;
		}

		// table: a row of cells followed by a delimiter row
		if (line.includes("|") && i + 1 < lines.length && DELIMITER_ROW.test(lines[i + 1])) {
			const delimiters = splitRow(lines[i + 1]);
			if (delimiters.length > 0) {
				flushParagraph();
				flushList();
				const header = splitRow(line);
				const rows = [];
				i += 2;
				while (i < lines.length && lines[i].includes("|") && !/^\s*$/.test(lines[i])) {
					rows.push(splitRow(lines[i]));
					i += 1;
				}
				i -= 1; // the for loop advances again
				html.push(table(header, delimiters, rows));
				continue;
			}
		}

		// A display formula on its own lines: `$$` … `$$` or `\[` … `\]`, one line or several. Text
		// after the closing delimiter is left to the normal path, so a stray `$$` cannot swallow a
		// whole message.
		const open = line.match(/^\s*(\$\$|\\\[)\s*(.*)$/);
		if (open) {
			const closer = open[1] === "$$" ? "$$" : "\\]";
			let collected = "";
			let closed = false;
			let cursor = i;
			let tail = open[2];
			while (true) {
				const at = tail.indexOf(closer);
				if (at >= 0) {
					collected += `${collected ? "\n" : ""}${tail.slice(0, at)}`;
					closed = true;
					break;
				}
				collected += `${collected ? "\n" : ""}${tail}`;
				cursor += 1;
				if (cursor >= lines.length) break;
				tail = lines[cursor];
			}
			if (closed) {
				flushParagraph();
				flushList();
				i = cursor;
				html.push(mathBlock(collected));
				continue;
			}
		}

		const heading = line.match(/^(#{1,6})\s+(.*)$/);
		if (heading) {
			flushParagraph();
			flushList();
			const level = Math.min(heading[1].length + 1, 6);
			html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
			continue;
		}

		if (/^\s*([-*_])\s*\1\s*\1[\s-*_]*$/.test(line)) {
			flushParagraph();
			flushList();
			html.push("<hr />");
			continue;
		}

		const quote = line.match(/^>\s?(.*)$/);
		if (quote) {
			flushParagraph();
			flushList();
			const body = [quote[1]];
			while (i + 1 < lines.length && /^>\s?/.test(lines[i + 1])) {
				i += 1;
				body.push(lines[i].replace(/^>\s?/, ""));
			}
			html.push(`<blockquote>${inline(body.join(" "))}</blockquote>`);
			continue;
		}

		const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
		if (bullet) {
			syncList(listDepthOf(bullet[1].replace(/\t/g, "  ").length), "ul");
			html.push(listItem(bullet[2]));
			continue;
		}

		const ordered = line.match(/^(\s*)\d+[.)]\s+(.*)$/);
		if (ordered) {
			syncList(listDepthOf(ordered[1].replace(/\t/g, "  ").length), "ol");
			html.push(listItem(ordered[2]));
			continue;
		}

		flushList();
		paragraph.push(line.trim());
	}

	flushParagraph();
	flushList();
	return html.join("");
}
