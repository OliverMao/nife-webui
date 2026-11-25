/**
 * nife's own tools, with the device as their filesystem.
 *
 * The definitions are the built-in ones - same schemas, same prompt snippets, same rendering - and
 * only their `operations` are replaced. That is what makes a remote session behave like a local one
 * for the model: nothing in the prompt has to say "you are remote", and no skill has to learn a new
 * tool name.
 *
 * `grep` is the one exception. The built-in version spawns ripgrep on *this* machine whatever the
 * operations say, and a silent search of the wrong disk is worse than no tool at all - so it gets
 * an honest remote implementation here, running `rg` when the device has it and `grep -r` when it
 * does not. `find` needs nothing special: its built-in definition already delegates to `operations`.
 */

import { Type } from "typebox";
import {
	type BashOperations,
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type EditOperations,
	type FindOperations,
	type LsOperations,
	type ReadOperations,
	type ToolDefinition,
	type WriteOperations,
} from "nife-coding-agent";
import type { RemoteHost } from "./transport.ts";

/** POSIX single quotes: the remote side is a shell, so a path is data that has to be quoted. */
export const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/** The tools a device session is allowed to have. Everything else would run on this machine. */
export const remoteToolNames = ["read", "bash", "edit", "write", "ls", "grep", "find", "web_search"] as const;

const GREP_LIMIT = 100;
const GREP_MAX_LINES = 2000;

/** POSIX join: the device is always a POSIX box, whatever this machine runs. */
export function remoteResolve(path: string, cwd: string): string {
	const value = (path || "").trim();
	if (!value) return cwd || "/";
	if (value.startsWith("/")) return posixNormalize(value);
	return posixNormalize(`${cwd || "/"}/${value}`);
}

function posixNormalize(path: string): string {
	const parts: string[] = [];
	for (const part of path.split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") parts.pop();
		else parts.push(part);
	}
	return `/${parts.join("/")}`;
}

const grepSchema = Type.Object({
	pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
	path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
	glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
	literal: Type.Optional(
		Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" }),
	),
	context: Type.Optional(
		Type.Number({ description: "Number of lines to show before and after each match (default: 0)" }),
	),
	limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 100)" })),
});

/**
 * grep on the device. Output is shaped like the built-in one (`path:line: text`, `path-line- text`
 * for context), because that is what the model was told to expect; the search itself is `rg` when
 * it exists and `grep -r` when the device is a busybox box.
 */
function createGrepDefinition(host: RemoteHost, cwd: string, hasRipgrep: boolean): ToolDefinition {
	return {
		name: "grep",
		label: "grep",
		description:
			"Search file contents for a pattern. Returns matching lines with file paths and line numbers. Output is limited to 100 matches or 50KB.",
		promptSnippet: "Search file contents for patterns (on the device)",
		parameters: grepSchema as never,
		async execute(
			_callId: string,
			input: unknown,
			signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: { cwd?: string } | undefined,
		) {
			const args = input as {
				pattern: string;
				path?: string;
				glob?: string;
				ignoreCase?: boolean;
				literal?: boolean;
				context?: number;
				limit?: number;
			};
			const searchPath = remoteResolve(args.path ?? ".", ctx?.cwd || cwd);
			const limit = Math.max(1, args.limit ?? GREP_LIMIT);
			const context = args.context && args.context > 0 ? Math.round(args.context) : 0;
			// "no such file" has to be an error, and a pipeline would swallow the exit code: ask first
			if (!(await host.exists(searchPath))) throw new Error(`Path not found: ${searchPath}`);
			const words: string[] = hasRipgrep
				? ["rg", "--no-config", "--line-number", "--no-heading", "--color", "never", "--hidden"]
				: ["grep", "-rn"];
			if (args.ignoreCase) words.push("-i");
			if (args.literal) words.push("-F");
			if (context > 0) words.push("-C", String(context));
			if (args.glob) hasRipgrep ? words.push("--glob", shellQuote(args.glob)) : words.push(`--include=${shellQuote(args.glob)}`);
			// `--` before the pattern: a pattern starting with `-` is data, not an option
			const command = hasRipgrep
				? `${words.join(" ")} -- ${shellQuote(args.pattern)} ${shellQuote(searchPath)}`
				: `${words.join(" ")} -e ${shellQuote(args.pattern)} -- ${shellQuote(searchPath)}`;
			const result = await host.run(`${command} 2>&1 | head -n ${GREP_MAX_LINES}`, "/", 60);
			if (result.code !== 0 && result.code !== 1) {
				throw new Error(result.text.trim() || `grep exited with code ${result.code}`);
			}
			if (signal?.aborted) throw new Error("Operation aborted");
			const lines = result.text.split("\n").filter((line) => line.length > 0);
			const output: string[] = [];
			let matches = 0;
			for (const line of lines) {
				if (line === "--") continue;
				// `path:12: text` is a match, `path-12- text` a context line; anything else is noise
				const parsed = /^(.*?)([:-])(\d+)([:-]) ?(.*)$/.exec(line);
				if (!parsed) {
					output.push(line);
					continue;
				}
				const [, file, , number, separator, text] = parsed;
				const isMatch = separator === ":";
				if (isMatch) {
					matches += 1;
					if (matches > limit) break;
				}
				const relative = (file ?? "").startsWith(`${searchPath}/`)
					? (file ?? "").slice(searchPath.length + 1)
					: file;
				output.push(`${relative}${isMatch ? ":" : "-"}${number}${isMatch ? ": " : "- "}${text}`);
			}
			if (matches === 0) return { content: [{ type: "text", text: "No matches found" }] };
			if (matches > limit) output.push(`\n[${limit} results limit reached]`);
			return { content: [{ type: "text", text: output.join("\n") }] };
		},
	} as unknown as ToolDefinition;
}

const IMAGE_TYPES: Array<{ mime: string; test: (head: Buffer) => boolean }> = [
	{ mime: "image/png", test: (head) => head.length > 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
	{ mime: "image/jpeg", test: (head) => head.length > 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff },
	{ mime: "image/gif", test: (head) => head.length > 6 && head.subarray(0, 3).toString("latin1") === "GIF" },
	{
		mime: "image/webp",
		test: (head) => head.length > 12 && head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP",
	},
];

/** Detect an image by its first bytes, the way the local tools do: there is no extension to trust. */
async function detectImageMimeType(host: RemoteHost, path: string): Promise<string | null> {
	let head: Buffer;
	try {
		head = await host.readWindow(path, 0, 16);
	} catch {
		return null;
	}
	return IMAGE_TYPES.find((entry) => entry.test(head))?.mime ?? null;
}

export function remoteToolDefinitions(host: RemoteHost, remoteCwd: string, tools: string[] = []): ToolDefinition[] {
	const hasRipgrep = tools.some((tool) => /(^|\/)rg$/.test(tool));
	const bash: BashOperations = {
		exec: (command, cwd, options) =>
			host.exec(command, cwd || remoteCwd, {
				onData: options.onData,
				timeout: options.timeout,
				signal: options.signal,
			}),
	};

	const read: ReadOperations = {
		readFile: (path) => host.readFile(path),
		// `access` promises exactly what the local one does: throw when the file cannot be read
		access: async (path) => {
			const { directory } = await host.stat(path);
			if (directory) throw new Error(`is a directory: ${path}`);
		},
		detectImageMimeType: (path) => detectImageMimeType(host, path),
	};

	const write: WriteOperations = {
		writeFile: (path, content) => host.writeFile(path, content),
		mkdir: async (dir) => {
			const { code, text } = await host.run(`mkdir -p ${shellQuote(dir)}`, "/", 30);
			if (code !== 0) throw new Error(text.trim() || `cannot create ${dir}`);
		},
	};

	const edit: EditOperations = {
		readFile: (path) => host.readFile(path),
		writeFile: (path, content) => host.writeFile(path, content),
		access: async (path) => {
			const { directory } = await host.stat(path);
			if (directory) throw new Error(`is a directory: ${path}`);
		},
	};

	const ls: LsOperations = {
		exists: (path) => host.exists(path),
		stat: async (path) => {
			const { directory } = await host.stat(path);
			return { isDirectory: () => directory };
		},
		readdir: (path) => host.list(path),
	};

	// `find` already delegates to `operations` when they exist, so a remote glob is enough for it
	const find: FindOperations = {
		exists: (path) => host.exists(path),
		glob: async (pattern, searchCwd, options) => {
			const limit = Math.max(1, options.limit);
			const command = hasRipgrep
				? `rg --files --hidden -g ${shellQuote(pattern)} ${shellQuote(searchCwd)} 2>/dev/null | head -n ${limit}`
				: // busybox find has no `**`: keep the last component, which is what a glob usually is
					`find ${shellQuote(searchCwd)} -type f -name ${shellQuote(pattern.split("/").pop() || pattern)} 2>/dev/null | head -n ${limit}`;
			const result = await host.run(command, "/", 60);
			return result.text
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.length > 0);
		},
	};

	return [
		createBashToolDefinition(remoteCwd, { operations: bash }) as ToolDefinition,
		createReadToolDefinition(remoteCwd, { operations: read }) as ToolDefinition,
		createWriteToolDefinition(remoteCwd, { operations: write }) as ToolDefinition,
		createEditToolDefinition(remoteCwd, { operations: edit }) as ToolDefinition,
		createLsToolDefinition(remoteCwd, { operations: ls }) as ToolDefinition,
		createFindToolDefinition(remoteCwd, { operations: find }) as ToolDefinition,
		createGrepDefinition(host, remoteCwd, hasRipgrep),
	];
}

/** What the model is told about the device, once per session, in the appended system prompt. */
export function remotePrompt(alias: string, path: string, profile?: { user: string; kernel: string; os: string; tools: string[]; root: boolean }): string {
	const lines = [`## Remote host: ${alias}`, ""];
	lines.push(
		`Every tool in this session executes on the ssh host \`${alias}\` through a single connection. The working directory is \`${path}\` on that machine, and paths in tool calls are remote paths. Nothing is read from or written to the machine running the browser.`,
	);
	if (profile) {
		const facts = [profile.os, profile.kernel].filter(Boolean).join(" · ");
		lines.push("");
		if (facts) lines.push(`- System: ${facts}`);
		lines.push(`- User: ${profile.user || "unknown"}${profile.root ? " (root)" : ""}`);
		if (profile.tools.length > 0) lines.push(`- Available commands: ${profile.tools.join(", ")}`);
		if (!profile.tools.includes("systemctl") && profile.tools.includes("uci")) {
			lines.push("- This looks like OpenWrt: services are managed with `uci` / `/etc/init.d/<name>`, not systemd.");
		}
		if (!profile.tools.includes("sudo") && !profile.root) {
			lines.push("- There is no `sudo` available here: commands run as your login user only.");
		}
	}
	lines.push(
		"",
		"Prefer commands that exist on this device (see the list above) over installing anything. A command that is interrupted keeps nothing: there is no terminal here to answer a prompt, so avoid anything interactive.",
	);
	return lines.join("\n");
}
