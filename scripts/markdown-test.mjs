import assert from "node:assert/strict";
import { renderMarkdown } from "../web/src/markdown.js";

// raw HTML from the model must never become markup
assert.equal(
	renderMarkdown('<img src=x onerror="alert(1)">'),
	"<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</p>",
);

// javascript: links stay text
assert.equal(renderMarkdown("[click](javascript:alert(1))"), "<p>click (javascript:alert(1))</p>");
assert.equal(
	renderMarkdown("[docs](https://example.com/a)"),
	'<p><a href="https://example.com/a" target="_blank" rel="noreferrer noopener">docs</a></p>',
);

// code fences are escaped and get a copy button
const fenced = renderMarkdown("```ts\nconst a = 1 < 2 && 3 > 2;\n```");
assert.match(fenced, /class="code-lang">ts</);
assert.match(fenced, /const a = 1 &lt; 2 &amp;&amp; 3 &gt; 2;/);
assert.match(fenced, /data-copy/);

// inline code is not touched by emphasis rules
assert.equal(renderMarkdown("`a*b*c` and *real*"), "<p><code>a*b*c</code> and <em>real</em></p>");

// blocks
assert.equal(renderMarkdown("## Title"), "<h3>Title</h3>");
assert.equal(renderMarkdown("- one\n- two"), "<ul><li>one</li><li>two</li></ul>");
assert.equal(renderMarkdown("1. one\n2. two"), "<ol><li>one</li><li>two</li></ol>");
assert.equal(renderMarkdown("> quoted"), "<blockquote>quoted</blockquote>");
assert.equal(renderMarkdown("a\n\nb"), "<p>a</p><p>b</p>");
assert.equal(renderMarkdown("**bold** and ~~gone~~"), "<p><strong>bold</strong> and <del>gone</del></p>");

// tables
const table = renderMarkdown("| a | b |\n|:--|--:|\n| 1 | 2 |");
assert.match(table, /<table>/);
assert.match(table, /<th style="text-align:left">a<\/th>/);
assert.match(table, /<th style="text-align:right">b<\/th>/);
assert.match(table, /<td style="text-align:left">1<\/td>/);

// no outer pipes
assert.match(renderMarkdown("a | b\n--- | ---\n1 | 2"), /<td>1<\/td>/);

// escaped pipe stays inside one cell
assert.match(renderMarkdown("| a |\n| --- |\n| x \\| y |"), /<td>x \| y<\/td>/);

// inline markup inside cells
assert.match(renderMarkdown("| h |\n| - |\n| **bold** |"), /<td><strong>bold<\/strong><\/td>/);

// a pipe without a delimiter row is not a table
assert.equal(renderMarkdown("a | b"), "<p>a | b</p>");

// images, tasks, nesting, autolinks, nested emphasis
assert.match(renderMarkdown("![alt](https://x.dev/a.png)"), /<img src="https:\/\/x.dev\/a.png" alt="alt"/);
assert.match(renderMarkdown("- [x] done"), /class="task-box done"/);
assert.match(renderMarkdown("- [ ] todo"), /<span class="task-box"><\/span>todo/);
assert.match(renderMarkdown("- a\n  - b"), /<ul><li>a<\/li><ul class="depth-2"><li>b<\/li><\/ul><\/ul>/);
assert.match(renderMarkdown("~~~js\nx\n~~~"), /class="code-lang">js</);
assert.match(renderMarkdown("<https://x.dev>"), /<a href="https:\/\/x.dev"/);
assert.equal(renderMarkdown("**a *b* c**"), "<p><strong>a <em>b</em> c</strong></p>");

// empty input
assert.equal(renderMarkdown(""), "");

console.log("markdown ok");
