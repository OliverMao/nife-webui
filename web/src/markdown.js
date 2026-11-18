// Minimal, safe markdown for chat output. Escapes first, then applies a fixed set of
// inline/block transforms, so raw HTML in model output never reaches the DOM.
// Deliberately no dependency: nested lists and reference links are out of scope.

const PLACEHOLDER = "\u0000";

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
