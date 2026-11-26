/**
 * The device list, and the ssh command line each device needs.
 *
 * This extension keeps its own list (`~/.nife/agent/webui-hosts.json`) and reads nothing else: a
 * conversation that runs on another machine is a first-class thing here, not a side effect of
 * whatever happens to be in `~/.ssh/config`. The list is edited in the page, so the file stays a
 * plain mirror of what the page shows.
 */

import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getAgentDir } from "nife-coding-agent";
import type { HostProfile } from "./transport.ts";

export interface HostEntry {
	/** the name the page uses, and the key of the host in a remote cwd (`ssh://router/etc`) */
	alias: string;
	host: string;
	user?: string;
	port?: number;
	identity?: string;
	proxyJump?: string;
	/**
	 * Optional password, for a device whose key is not installed yet. It is written in clear in this
	 * file (mode 0600) because there is no cross-platform keychain to put it in; a key is better and
	 * the form says so. Never sent to the page - only `hasPassword` travels.
	 */
	password?: string;
	/** extra `-o key=value` pairs, verbatim: whatever their setup needs */
	options?: string[];
}

export interface HostRow extends HostEntry {
	/** what ssh will actually connect to, for the tooltip */
	target: string;
	profile?: HostProfile;
	reachable?: boolean;
	error?: string;
}

interface HostFile {
	hosts?: HostEntry[];
}

export const hostsFile = (): string => join(getAgentDir(), "webui-hosts.json");

const expandHome = (path: string): string =>
	path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;

function readFileJson(path: string): HostFile {
	try {
		if (!existsSync(path)) return {};
		const parsed = JSON.parse(readFileSync(path, "utf8")) as HostFile;
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

/** Saved devices, in the order they were added. */
export function readHosts(): HostEntry[] {
	const file = readFileJson(hostsFile());
	const list = Array.isArray(file.hosts) ? file.hosts : [];
	return list
		.filter((entry): entry is HostEntry => Boolean(entry) && typeof entry.alias === "string" && entry.alias.length > 0)
		// normalized through the same shape that is written: a key this version does not know (an old
		// `label`, a typo) must not reach the page and must not survive the next save
		.map((entry) => plainHost({ ...entry, alias: entry.alias.trim() }));
}

export function writeHosts(hosts: HostEntry[]): void {
	const path = hostsFile();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify({ hosts: hosts.map(plainHost) }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	// the file may already exist with wider permissions: `mode` only applies when it is created
	try {
		chmodSync(path, 0o600);
	} catch {
		// a filesystem without modes (FAT, some network shares) is allowed to say no
	}
}

const plainHost = (entry: HostEntry): HostEntry => ({
	alias: entry.alias,
	host: entry.host,
	...(entry.password ? { password: entry.password } : {}),
	...(entry.user ? { user: entry.user } : {}),
	...(entry.port ? { port: entry.port } : {}),
	...(entry.identity ? { identity: entry.identity } : {}),
	...(entry.proxyJump ? { proxyJump: entry.proxyJump } : {}),
	...(entry.options?.length ? { options: entry.options } : {}),
});

export const findHost = (alias: string): HostEntry | undefined =>
	readHosts().find((entry) => entry.alias.toLowerCase() === alias.toLowerCase());

/** Add or replace one device, keeping the list order: editing does not reshuffle the page. */
export function upsertHost(entry: HostEntry): HostEntry[] {
	const list = readHosts();
	const at = list.findIndex((known) => known.alias.toLowerCase() === entry.alias.toLowerCase());
	if (at >= 0) list[at] = entry;
	else list.push(entry);
	writeHosts(list);
	return list;
}

export function deleteHost(alias: string): HostEntry[] {
	const list = readHosts().filter((entry) => entry.alias.toLowerCase() !== alias.toLowerCase());
	writeHosts(list);
	return list;
}

/** The alias is a name in a URL-ish label (`router:/etc`), so it stays in that alphabet. */
export const VALID_ALIAS = /^[A-Za-z0-9._-]{1,32}$/;

/** How ssh addresses this device. There is no config alias to rely on: the entry is the config. */
export const sshTarget = (entry: HostEntry): string =>
	entry.user ? `${entry.user}@${entry.host}` : entry.host;

/**
 * The known-hosts file this extension keeps for itself.
 *
 * A device the user just added has a key nobody has seen yet, and `BatchMode=yes` means ssh cannot
 * ask. `accept-new` records it here - not in `~/.ssh/known_hosts`, which belongs to the user's own
 * ssh - and a key that later changes is still refused instead of silently trusted.
 */
export const knownHostsFile = (): string => join(getAgentDir(), "ssh_known_hosts");

/** Quote an `-o` value that would otherwise be split by ssh's own config parser. */
const quoteOption = (value: string): string => (/\s/.test(value) ? `"${value}"` : value);

/**
 * A password file that outlived its process is a secret on disk. Anything older than an hour is
 * from a run that crashed rather than one that finished (cleanup removes its own directory), so it
 * is deleted the next time a password is used. Best effort: a busy tmpdir is not an error.
 */
function sweepAskpass(): void {
	try {
		const base = tmpdir();
		for (const name of readdirSync(base)) {
			if (!name.startsWith("nife-askpass-")) continue;
			const path = join(base, name);
			try {
				if (Date.now() - statSync(path).mtimeMs > 3_600_000) rmSync(path, { recursive: true, force: true });
			} catch {
				// vanished between listing and stat
			}
		}
	} catch {
		// no tmpdir to sweep
	}
}

/**
 * A password ssh can read without a terminal.
 *
 * `ssh` never takes a password on stdin; it asks a program named by `SSH_ASKPASS` (with
 * `SSH_ASKPASS_REQUIRE=force`, which is what makes it work when there *is* a terminal). The
 * password goes in its own 0600 file next to the script, and both live in a temporary directory
 * that is removed when the connection closes.
 */
export interface Askpass {
	env: Record<string, string>;
	cleanup: () => void;
}

export function writeAskpass(password: string): Askpass {
	sweepAskpass();
	const dir = mkdtempSync(join(tmpdir(), "nife-askpass-"));
	const secret = join(dir, "password");
	writeFileSync(secret, `${password}\n`, { encoding: "utf8", mode: 0o600 });
	const windows = process.platform === "win32";
	const script = join(dir, windows ? "askpass.cmd" : "askpass.sh");
	writeFileSync(script, windows ? '@echo off\r\ntype "%~dp0password"\r\n' : '#!/bin/sh\nexec cat "$(dirname "$0")/password"\n', {
		encoding: "utf8",
		mode: 0o700,
	});
	return {
		// DISPLAY is a formality some builds still check before they run askpass at all
		env: { SSH_ASKPASS: script, SSH_ASKPASS_REQUIRE: "force", DISPLAY: process.env.DISPLAY ?? ":0" },
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

/** The argv ssh needs, without the remote command that `RemoteHost` appends. */
export function sshArgs(entry: HostEntry): string[] {
	const password = Boolean(entry.password);
	const args = [
		"-T",
		// BatchMode disables password auth entirely, so it only applies to key-only devices
		...(password ? ["-o", "NumberOfPasswordPrompts=1", "-o", "PreferredAuthentications=publickey,password,keyboard-interactive"] : ["-o", "BatchMode=yes"]),
		"-o",
		"StrictHostKeyChecking=accept-new",
		"-o",
		// an `-o key=value` string is tokenized by ssh itself, so a Windows profile path with a space
		// in it has to be quoted here
		`UserKnownHostsFile=${quoteOption(knownHostsFile())}`,
		"-o",
		"ConnectTimeout=10",
		"-o",
		"ServerAliveInterval=15",
		"-o",
		"ServerAliveCountMax=3",
		"-o",
		"LogLevel=ERROR",
	];
	if (entry.port) args.push("-p", String(entry.port));
	if (entry.identity) args.push("-i", expandHome(entry.identity), "-o", "IdentitiesOnly=yes");
	if (entry.proxyJump) args.push("-J", entry.proxyJump);
	for (const option of entry.options ?? []) args.push("-o", option);
	args.push(sshTarget(entry));
	return args;
}

/** `router:/etc` — compact enough for a chip, complete enough to know where it is. */
export const remoteLabel = (device: string, path: string): string => `${device}:${path}`;
