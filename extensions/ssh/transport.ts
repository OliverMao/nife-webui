/**
 * One long-lived ssh connection per device, and the request/response protocol on top of it.
 *
 * A fresh `ssh host command` per tool call costs a handshake every time (200-600 ms on a WAN, and
 * Windows' OpenSSH cannot multiplex at all), so the connection is opened once and kept: the helper
 * script is evaluated from an argument - not from stdin - which leaves stdin free for the frames
 * that follow, so the same connection carries every command the session runs.
 *
 * Requests are serialized. Two conversations on one device therefore queue behind each other
 * instead of interleaving their output, which is the right trade for a shell: the alternative is a
 * protocol with per-request multiplexing and out-of-order output that no tool expects.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { HELPER_SCRIPT } from "./helper.ts";

/** A command to run remotely, streamed the way `BashOperations` expects. */
export interface RemoteExecOptions {
	onData?: (chunk: Buffer) => void;
	/** seconds, same unit the bash tool passes */
	timeout?: number;
	signal?: AbortSignal;
}

/** What a device is, as far as the agent needs to know to be useful on it. */
export interface HostProfile {
	user: string;
	kernel: string;
	os: string;
	/** the commands that exist: the difference between `systemctl`, `uci` and `apk` */
	tools: string[];
	root: boolean;
}

interface PendingJob {
	onFrame: (kind: string, payload: string) => void;
	fail: (error: Error) => void;
}

const decode = (payload: string): string => Buffer.from(payload, "base64").toString("utf8");
const encode = (text: string): string => Buffer.from(text, "utf8").toString("base64");

/**
 * A frame is split on spaces by the remote shell, so an empty field would silently shift every
 * field after it (`a  b` reads as two fields, not three). `-` stands in for empty.
 */
const field = (text: string): string => (text === "" ? "-" : encode(text));

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export class RemoteHost {
	private child?: ChildProcessWithoutNullStreams;
	private opening?: Promise<void>;
	private buffer = "";
	private stderr = "";
	private pending = new Map<string, PendingJob>();
	private queue: Promise<unknown> = Promise.resolve();
	private counter = 0;
	private closed = false;
	private readonly script: string;

	constructor(
		readonly alias: string,
		readonly sshArgs: string[],
	) {
		// The helper reaches the device as an argument: `sh -s` would race the frames that follow it
		// on stdin, because a shell parses stdin in blocks and can swallow requests before the loop
		// that should read them exists.
		this.script = `sh -c 'eval "$(printf %s ${Buffer.from(HELPER_SCRIPT, "utf8").toString("base64")} | base64 -d)"'`;
	}

	/** Serialized: shell requests do not interleave, and neither do their answers. */
	private enqueue<T>(run: () => Promise<T>): Promise<T> {
		const next = this.queue.then(run, run);
		this.queue = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	private async ensure(): Promise<void> {
		if (this.closed) throw new Error(`ssh ${this.alias}: connection was closed`);
		if (this.child) return;
		this.opening ??= (async () => {
			const child = spawn("ssh", [...this.sshArgs, this.script], { stdio: ["pipe", "pipe", "pipe"] });
			// A dead ssh surfaces through `exit`; the stdin error that follows is noise.
			child.stdin.on("error", () => {});
			child.stdout.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => this.read(chunk));
			child.stderr.setEncoding("utf8");
			child.stderr.on("data", (chunk: string) => {
				this.stderr = (this.stderr + chunk).slice(-4000);
			});
			child.on("exit", (code, signal) => this.died(code, signal));
			this.child = child;
			this.stderr = "";
			this.buffer = "";
			// A round trip is the only proof that ssh authenticated and the helper is running: a wrong
			// key, a closed port or a login shell that refuses the command fails here, once, with the
			// ssh message, instead of somewhere inside a turn.
			await this.roundTrip(
				(id) => `PING ${id}`,
				60_000,
			);
		})().finally(() => {
			this.opening = undefined;
		});
		return this.opening;
	}

	private read(chunk: string): void {
		this.buffer += chunk;
		let index = this.buffer.indexOf("\n");
		while (index >= 0) {
			const line = this.buffer.slice(0, index);
			this.buffer = this.buffer.slice(index + 1);
			this.frame(line);
			index = this.buffer.indexOf("\n");
		}
		// A device that talks a lot without newlines (a progress bar) must not grow this forever.
		if (this.buffer.length > 4_000_000) this.buffer = "";
	}

	private frame(line: string): void {
		// `KIND id payload`, and anything else is banner text from the login shell: ignore it rather
		// than mistaking a MOTD for a response.
		const match = /^(OK|ERR|OUT|EXIT) (\S+) ?([\s\S]*)$/.exec(line);
		if (!match) return;
		const [, kind, id, payload] = match;
		const job = this.pending.get(id ?? "");
		if (!job) return;
		if (kind === "OUT" || kind === "EXIT") {
			job.onFrame(kind ?? "", payload ?? "");
			return;
		}
		this.pending.delete(id ?? "");
		job.onFrame(kind ?? "", payload ?? "");
	}

	private died(code: number | null, signal: NodeJS.Signals | null): void {
		this.child = undefined;
		this.buffer = "";
		const tail = this.stderr
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line && !/^Warning: Permanently added/.test(line))
			.slice(-3)
			.join(" ");
		const why = code ? `exit ${code}` : signal ? signal : "closed";
		const error = new Error(`ssh ${this.alias}: connection ${why}${tail ? ` - ${tail}` : ""}`);
		for (const [id, job] of this.pending) {
			this.pending.delete(id);
			job.fail(error);
		}
	}

	private write(line: string): void {
		const child = this.child;
		if (!child) throw new Error(`ssh ${this.alias}: not connected`);
		child.stdin.write(`${line}\n`);
	}

	private roundTrip(
		frame: (id: string) => string,
		budgetMs: number,
		onOut?: (payload: string) => void,
	): Promise<string> {
		const id = `${++this.counter}`;
		return new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`ssh ${this.alias}: no answer within ${Math.round(budgetMs / 1000)}s`));
			}, budgetMs);
			timer.unref?.();
			this.pending.set(id, {
				onFrame: (kind, payload) => {
					if (kind === "OUT") {
						onOut?.(payload);
						return;
					}
					clearTimeout(timer);
					if (kind === "ERR") reject(new Error(decode(payload)));
					else resolve(payload);
				},
				fail: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
			try {
				this.write(frame(id));
			} catch (error) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(error instanceof Error ? error : new Error(messageOf(error)));
			}
		});
	}

	/** A short request/response, serialized behind whatever else the device is doing. */
	private async callRaw(frame: (id: string) => string, budgetMs = 60_000): Promise<string> {
		return this.enqueue(async () => {
			await this.ensure();
			return this.roundTrip(frame, budgetMs);
		});
	}

	/** The same, for answers that are text: paths, listings, `d 4096`. */
	private call(frame: (id: string) => string, budgetMs = 60_000): Promise<string> {
		return this.callRaw(frame, budgetMs).then(decode);
	}

	exec(command: string, cwd: string, options: RemoteExecOptions = {}): Promise<{ exitCode: number | null }> {
		const seconds = options.timeout && options.timeout > 0 ? Math.round(options.timeout) : 0;
		// The command itself can run for as long as it likes: the timer only notices a dead channel,
		// and aborts where the signal asked for it. An aborted command keeps running on the device,
		// which is honest - there is nobody left to read its output.
		const budget = (seconds > 0 ? seconds * 1000 : 3_600_000) + 30_000;
		return this.enqueue(async () => {
			await this.ensure();
			return new Promise<{ exitCode: number | null }>((resolve, reject) => {
				const id = `${++this.counter}`;
				const timer = setTimeout(() => {
					this.pending.delete(id);
					reject(new Error(`ssh ${this.alias}: no answer within ${Math.round(budget / 1000)}s`));
				}, budget);
				timer.unref?.();
				const onAbort = () => {
					this.pending.delete(id);
					clearTimeout(timer);
					// The loop on the device is idle waiting for frames, so it can still act: the
					// command's process group is killed there, not just abandoned here.
					try {
						this.write(`KILL ${id}`);
					} catch {
						// the connection is already gone; nothing left to kill
					}
					reject(new Error("aborted"));
				};
				if (options.signal?.aborted) {
					clearTimeout(timer);
					reject(new Error("aborted"));
					return;
				}
				options.signal?.addEventListener("abort", onAbort, { once: true });
				this.pending.set(id, {
					onFrame: (kind, payload) => {
						if (kind === "OUT") {
							options.onData?.(Buffer.from(payload, "base64"));
							return;
						}
						clearTimeout(timer);
						options.signal?.removeEventListener("abort", onAbort);
						this.pending.delete(id);
						if (kind === "EXIT") {
							const code = Number(payload);
							resolve({ exitCode: Number.isFinite(code) ? code : null });
						} else {
							reject(new Error(decode(payload)));
						}
					},
					fail: (error) => {
						clearTimeout(timer);
						options.signal?.removeEventListener("abort", onAbort);
						reject(error);
					},
				});
				try {
					this.write(`EXEC ${id} ${field(cwd)} ${field(seconds > 0 ? String(seconds) : "")} ${encode(command)}`);
				} catch (error) {
					clearTimeout(timer);
					this.pending.delete(id);
					reject(error instanceof Error ? error : new Error(messageOf(error)));
				}
			});
		});
	}

	/** Collect a whole command's output, for the small requests that are not a tool call. */
	async run(command: string, cwd = "/", timeout?: number): Promise<{ code: number | null; text: string }> {
		const parts: Buffer[] = [];
		const { exitCode } = await this.exec(command, cwd, {
			timeout,
			onData: (chunk) => parts.push(chunk),
		});
		return { code: exitCode, text: Buffer.concat(parts).toString("utf8") };
	}

	/** Bytes, not text: a session that cannot read a binary file cannot copy one either. */
	readFile(path: string): Promise<Buffer> {
		return this.callRaw((id) => `READ ${id} ${field(path)} ${field("")} ${field("")}`, 120_000).then(
			(payload) => Buffer.from(payload, "base64"),
		);
	}

	/** One window of a file, for callers that would otherwise pull a gigabyte to show one hunk. */
	async readWindow(path: string, offset: number, count: number): Promise<Buffer> {
		const payload = await this.callRaw(
			(id) => `READ ${id} ${field(path)} ${field(String(offset))} ${field(String(count))}`,
			120_000,
		);
		return Buffer.from(payload, "base64");
	}

	async writeFile(path: string, content: string | Buffer, mode?: string): Promise<void> {
		const base64 = Buffer.from(content).toString("base64");
		await this.call((id) => `WRITE ${id} ${field(path)} ${field(mode ?? "")} ${base64 || "-"}`, 180_000);
	}

	async stat(path: string): Promise<{ directory: boolean; size: number }> {
		const text = await this.call((id) => `STAT ${id} ${field(path)}`);
		const [kind, size] = text.trim().split(" ");
		return { directory: kind === "d", size: Number(size) || 0 };
	}

	async exists(path: string): Promise<boolean> {
		try {
			await this.stat(path);
			return true;
		} catch {
			return false;
		}
	}

	async list(path: string): Promise<string[]> {
		const text = await this.call((id) => `LIST ${id} ${field(path)}`);
		return text.split("\n").filter((name) => name.length > 0);
	}

	/** Ask the device what it is, once per connection: init system, package manager, tooling. */
	async probe(): Promise<HostProfile> {
		const script = [
			`printf "user %s\\n" "$(id -un 2>/dev/null)"`,
			`printf "kernel %s\\n" "$(uname -srm 2>/dev/null)"`,
			`printf "os %s\\n" "$(sed -n 's/^PRETTY_NAME=//p' /etc/os-release 2>/dev/null | tr -d '"')"`,
			// POSIX `command -v` takes one name, and the point of this line is a device where half the
			// usual tools are missing: ask for each and keep the ones that answered.
			`printf "tools %s\\n" "$(for tool in sudo systemctl docker git node python3 busybox uci apk opkg apt-get dnf yum rg grep find sed awk; do command -v "$tool" 2>/dev/null; done | tr '\\n' ' ')"`,
			`printf "root %s\\n" "$(id -u 2>/dev/null)"`,
		].join("\n");
		const { text } = await this.run(script, "/", 20);
		const value = (key: string): string =>
			new RegExp(`^${key} (.*)$`, "m").exec(text)?.[1]?.trim() ?? "";
		return {
			user: value("user"),
			kernel: value("kernel"),
			os: value("os"),
			tools: value("tools").split(/\s+/).filter(Boolean),
			root: value("root") === "0",
		};
	}

	close(): void {
		this.closed = true;
		const child = this.child;
		this.child = undefined;
		if (!child) return;
		try {
			child.stdin.write("BYE\n");
			child.stdin.end();
		} catch {
			// already gone
		}
		// A device that never answers must not keep the process alive at exit.
		const kill = setTimeout(() => child.kill(), 1500);
		kill.unref?.();
	}
}
