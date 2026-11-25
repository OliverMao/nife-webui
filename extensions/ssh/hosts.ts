/**
 * The device list, and the ssh command line each device needs.
 *
 * This extension keeps its own list (`~/.nife/agent/webui-hosts.json`) and reads nothing else: a
 * conversation that runs on another machine is a first-class thing here, not a side effect of
 * whatever happens to be in `~/.ssh/config`. The list is edited in the page, so the file stays a
 * plain mirror of what the page shows.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
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
	label?: string;
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
		.map((entry) => ({ ...entry, alias: entry.alias.trim() }));
}

export function writeHosts(hosts: HostEntry[]): void {
	const path = hostsFile();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify({ hosts: hosts.map(plainHost) }, null, 2)}\n`, "utf8");
}

const plainHost = (entry: HostEntry): HostEntry => ({
	alias: entry.alias,
	host: entry.host,
	...(entry.user ? { user: entry.user } : {}),
	...(entry.port ? { port: entry.port } : {}),
	...(entry.identity ? { identity: entry.identity } : {}),
	...(entry.proxyJump ? { proxyJump: entry.proxyJump } : {}),
	...(entry.label ? { label: entry.label } : {}),
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

/** The argv ssh needs, without the remote command that `RemoteHost` appends. */
export function sshArgs(entry: HostEntry): string[] {
	const args = [
		"-T",
		"-o",
		"BatchMode=yes",
		"-o",
		"StrictHostKeyChecking=accept-new",
		"-o",
		`UserKnownHostsFile=${knownHostsFile()}`,
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
