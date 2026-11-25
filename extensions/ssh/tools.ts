/**
 * nife's own tools, with the device as their filesystem.
 *
 * The definitions are the built-in ones - same schemas, same prompt snippets, same rendering - and
 * only their `operations` are replaced. That is what makes a remote session behave like a local one
 * for the model: nothing in the prompt has to say "you are remote", and no skill has to learn a new
 * tool name.
 *
 * `find` and `grep` are deliberately absent: the built-in ones run `rg`/`fd` locally, and a silent
 * search of this machine's disk is worse than no tool at all. The model uses `bash` there, which is
 * honest about where the command ran.
 */

import {
	type BashOperations,
	createBashToolDefinition,
	createEditToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type EditOperations,
	type LsOperations,
	type ReadOperations,
	type ToolDefinition,
	type WriteOperations,
} from "nife-coding-agent";
import type { RemoteHost } from "./transport.ts";

/** POSIX single quotes: the remote side is a shell, so a path is data that has to be quoted. */
export const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/** The tools a device session is allowed to have. Everything else would run on this machine. */
export const remoteToolNames = ["read", "bash", "edit", "write", "ls", "web_search"] as const;

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

export function remoteToolDefinitions(host: RemoteHost, remoteCwd: string): ToolDefinition[] {
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

	return [
		createBashToolDefinition(remoteCwd, { operations: bash }) as ToolDefinition,
		createReadToolDefinition(remoteCwd, { operations: read }) as ToolDefinition,
		createWriteToolDefinition(remoteCwd, { operations: write }) as ToolDefinition,
		createEditToolDefinition(remoteCwd, { operations: edit }) as ToolDefinition,
		createLsToolDefinition(remoteCwd, { operations: ls }) as ToolDefinition,
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
		"`grep` and `find` tools are not available in this session - run `grep -rn` / `find` through `bash` instead, on the device. Prefer commands that exist on this device (see the list above) over installing anything.",
	);
	return lines.join("\n");
}
