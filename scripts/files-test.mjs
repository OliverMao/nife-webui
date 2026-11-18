import assert from "node:assert/strict";
import { attachedLine, fileNameOf, fileKind, formatBytes, splitAttachments } from "../web/src/files.js";

// stored names are generated, so the marker carries the display name next to the path
assert.equal(
	attachedLine({ name: "报告 v1.pdf", path: "/tmp/nife-webui/1-abc/a1b2c3d4e5f60718.pdf" }),
	'[attached] {"name":"报告 v1.pdf","path":"/tmp/nife-webui/1-abc/a1b2c3d4e5f60718.pdf"}',
);
assert.equal(
	attachedLine({ path: "/tmp/x/no name.bin" }),
	'[attached] {"name":"no name.bin","path":"/tmp/x/no name.bin"}',
	"a nameless upload falls back to the stored file name",
);

// the marker lines are what the transcript turns back into file chips
const split = splitAttachments(
	'look at this\n\n[attached] {"name":"report.pdf","path":"/tmp/nife-webui/1-abc/a1.pdf"}\n[attached] {"name":"my file.pdf","path":"/tmp/x/b2.pdf"}',
);
assert.equal(split.text, "look at this");
assert.deepEqual(split.files, [
	{ name: "report.pdf", path: "/tmp/nife-webui/1-abc/a1.pdf" },
	{ name: "my file.pdf", path: "/tmp/x/b2.pdf" },
]);

// a name that is itself a path stays a label: only `path` is used
const weird = splitAttachments('[attached] {"name":"../../etc/passwd","path":"/tmp/x/a3.pdf"}');
assert.deepEqual(weird.files, [{ name: "../../etc/passwd", path: "/tmp/x/a3.pdf" }]);

// plain prompts, files-only prompts and older path-only lines all round-trip
assert.deepEqual(splitAttachments("just text"), { text: "just text", files: [] });
assert.deepEqual(splitAttachments('[attached] {"name":"only.pdf","path":"/tmp/only.pdf"}'), {
	text: "",
	files: [{ name: "only.pdf", path: "/tmp/only.pdf" }],
});
assert.deepEqual(splitAttachments('[attached] "/tmp/with space/old.pdf"'), {
	text: "",
	files: [{ name: "old.pdf", path: "/tmp/with space/old.pdf" }],
});

// lines that are not ours stay visible instead of turning into chips
assert.deepEqual(splitAttachments("[attached] hello"), { text: "[attached] hello", files: [] });
assert.deepEqual(splitAttachments("[attached] {not json"), { text: "[attached] {not json", files: [] });
assert.deepEqual(splitAttachments('[attached] {"name":"x.pdf"}'), { text: '[attached] {"name":"x.pdf"}', files: [] });

assert.equal(fileNameOf("C:\\Users\\li\\AppData\\Local\\Temp\\nife-webui\\1-abc\\报告 v1.pdf"), "报告 v1.pdf");
assert.equal(fileNameOf("plain.pdf"), "plain.pdf");

// chip icons are picked from the extension, case-insensitively
assert.equal(fileKind("报告 v1.pdf"), "pdf");
assert.equal(fileKind("README.md"), "text");
assert.equal(fileKind("app.tsx"), "code");
assert.equal(fileKind("data.CSV"), "sheet");
assert.equal(fileKind("song.mp3"), "audio");
assert.equal(fileKind("clip.webm"), "video");
assert.equal(fileKind("backup.tar.gz"), "archive");
assert.equal(fileKind("photo.JPEG"), "image");
assert.equal(fileKind("Makefile"), "file");
assert.equal(fileKind(""), "file");

assert.equal(formatBytes(0), "0 B");
assert.equal(formatBytes(999), "999 B");
assert.equal(formatBytes(1536), "1.5 KB");
assert.equal(formatBytes(25 * 1024 * 1024), "25 MB");

console.log("files ok");
