/**
 * The shell half of a remote session.
 *
 * A device that cannot run nife still has to answer "read this file", "write that file", "run this
 * command", and it has to do so without installing anything. So the helper is a POSIX script that
 * is evaluated from an argument (`ssh host sh -c 'eval "$(...)"'`) and lives only in that process:
 * nothing is written to the device, nothing has to be cleaned up afterwards, and busybox is enough
 * to run it. It is passed as an argument rather than on stdin because stdin has to stay free for
 * the frames that follow - a shell parses stdin in blocks and would swallow requests before the
 * loop that reads them exists.
 *
 * The frame loop never blocks, not even while a command runs: `EXEC` starts the command as its own
 * session (when `setsid` exists) and streams its output, so the loop is still there to read a
 * `KILL` for it. That is what makes the stop button stop something on the device rather than only
 * in the browser.
 *
 * The first line a device sends is not always our frame, though: a login banner or an MOTD also
 * arrives on stdout. Frames are therefore shaped (`KIND id payload`) and the reader ignores
 * everything else.
 *
 *   request                                answer
 *   EXEC  <id> <cwd> <timeout> <cmd>       OUT <id> <b64 chunk> … then EXIT <id> <code>
 *   KILL  <id>                             OK <id> killed
 *   READ  <id> <path> <offset> <count>     OK <id> <b64>
 *   WRITE <id> <path> <mode> <b64 data>    OK <id> <b64 path>
 *   STAT  <id> <path>                      OK <id> <b64 "d|f <size>">
 *   LIST  <id> <path>                      OK <id> <b64 newline separated names>
 *   PING  <id>                             OK <id> ok
 *   BYE                                    (kill what is running, exit)
 *
 * Everything that can contain a space, a newline or a byte that is not text is base64, so a frame
 * never needs quoting on either side - which is what keeps Windows' `ssh.exe` and a busybox `sh`
 * from disagreeing about escapes. An empty field is `-`, because the shell splits a frame on
 * spaces and `a  b` has one field where two were meant.
 *
 * Control lines go to file descriptor 3 (a copy of stdout taken before any command runs) so a
 * command's output, piped into the OUT emitter, can never be mistaken for a frame.
 *
 * Written without `${...}` where avoidable: this is a TypeScript template literal, and a shell
 * script full of `${var}` would have to escape every one of them.
 */
export const HELPER_SCRIPT = `# nife remote helper - streamed, never installed
set -u
exec 3>&1
tmpdir=\${TMPDIR:-/tmp}

enc() { base64 | tr -d '\\n'; }
b64() { printf %s "$1" | enc; }
dec() { [ "$1" = "-" ] && return 0; printf %s "$1" | base64 -d 2>/dev/null; }
say() { printf '%s\\n' "$*" >&3; }
have() { command -v "$1" >/dev/null 2>&1; }
unmask() { [ "$1" = "-" ] && printf '' || printf %s "$1"; }

# One chunk of a command's output per call; returns 1 when there is nothing left to send. Chunks are
# small enough that a single write stays under PIPE_BUF: two processes share fd 3, and a long frame
# could otherwise interleave with another one.
pump() {
	id=$1 file=$2
	pos=$(cat "$file.pos" 2>/dev/null)
	case $pos in ''|*[!0-9]*) pos=0 ;; esac
	sent=$(cat "$file.sent" 2>/dev/null)
	case $sent in ''|*[!0-9]*) sent=0 ;; esac
	size=$(wc -c < "$file" 2>/dev/null | tr -d ' ')
	case $size in ''|*[!0-9]*) size=0 ;; esac
	[ "$size" -le "$pos" ] && return 1
	if [ "$sent" -ge 1000000 ]; then
		# a megabyte is more than any tool will show: stop sending, keep draining
		printf '%s' "$size" > "$file.pos"
		return 1
	fi
	end=$((pos + 2000))
	[ "$end" -gt "$size" ] && end=$size
	data=$(tail -c "+$((pos + 1))" "$file" 2>/dev/null | head -c "$((end - pos))" | enc)
	printf '%s' "$end" > "$file.pos"
	printf '%s' "$((sent + end - pos))" > "$file.sent"
	[ -n "$data" ] && say "OUT $id $data"
	return 0
}

# Runs in the background (see the frame loop), so the loop keeps reading while this waits.
run_exec() {
	id=$1 cwd=$2 limit=$3 cmd=$4
	cwd=$(dec "$cwd"); limit=$(dec "$limit"); cmd=$(dec "$cmd")
	case $limit in ''|*[!0-9]*) limit= ;; esac
	if [ ! -d "$cwd" ]; then
		say "ERR $id $(b64 "not a directory: $cwd")"
		return
	fi
	base="$tmpdir/.nife-run-$$-$id"
	out="$base.out"; codefile="$base.code"; pidf="$base.pid"
	rm -f "$out" "$out.pos" "$out.sent" "$codefile" "$pidf"
	# cwd and the command go in as positional parameters, so there is no second round of quoting to
	# get wrong; the runner announces its own pid, because a forking setsid makes $! useless.
	runner='printf "%s" "$$" > "$4"; cd "$1" || exit 127; if [ -n "$3" ] && command -v timeout >/dev/null 2>&1; then timeout "$3" sh -c "$2"; else sh -c "$2"; fi; echo $? > "$5"'
	if have setsid; then
		setsid sh -c "$runner" nife "$cwd" "$cmd" "$limit" "$pidf" "$codefile" > "$out" 2>&1 &
	else
		sh -c "$runner" nife "$cwd" "$cmd" "$limit" "$pidf" "$codefile" > "$out" 2>&1 &
	fi
	tries=0
	while [ ! -s "$pidf" ] && [ "$tries" -lt 100 ]; do
		sleep 0.1 2>/dev/null || sleep 1
		tries=$((tries + 1))
	done
	pid=$(cat "$pidf" 2>/dev/null)
	while [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; do
		while pump "$id" "$out"; do :; done
		sleep 0.2 2>/dev/null || sleep 1
	done
	while pump "$id" "$out"; do :; done
	code=$(cat "$codefile" 2>/dev/null)
	rm -f "$out" "$out.pos" "$out.sent" "$codefile" "$pidf"
	say "EXIT $id \${code:-1}"
}

# setsid gave the command its own process group, so the whole tree goes down with one signal. If it
# could not (no setsid on the device), killing the group would take this helper with it - kill the
# process itself instead.
run_kill() {
	id=$1
	pidf="$tmpdir/.nife-run-$$-$id.pid"
	tries=0
	while [ ! -s "$pidf" ] && [ "$tries" -lt 40 ]; do
		sleep 0.05 2>/dev/null || sleep 1
		tries=$((tries + 1))
	done
	pid=$(cat "$pidf" 2>/dev/null)
	case $pid in ''|*[!0-9]*) return 0 ;; esac
	pgid=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')
	own=$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')
	if [ -n "$pgid" ] && [ "$pgid" != "$own" ]; then
		kill -TERM "-$pgid" 2>/dev/null
	else
		pgid=
		kill -TERM "$pid" 2>/dev/null
	fi
	sleep 0.3 2>/dev/null || sleep 1
	if [ -n "$pgid" ]; then
		kill -KILL "-$pgid" 2>/dev/null
	else
		kill -KILL "$pid" 2>/dev/null
	fi
	say "OK $id killed"
}

run_read() {
	id=$1 path=$2 off=$3 count=$4
	path=$(dec "$path"); off=$(dec "$off"); count=$(dec "$count")
	if [ -d "$path" ]; then say "ERR $id $(b64 "is a directory: $path")"; return; fi
	if [ ! -f "$path" ]; then say "ERR $id $(b64 "no such file: $path")"; return; fi
	case $off in ''|*[!0-9]*) off=0 ;; esac
	case $count in ''|*[!0-9]*) count=0 ;; esac
	if [ "$count" -gt 0 ]; then
		data=$(tail -c "+$((off + 1))" "$path" 2>/dev/null | head -c "$count" | enc)
	else
		data=$(head -c 4000000 "$path" 2>/dev/null | enc)
	fi
	[ -n "$data" ] || data=-
	say "OK $id $data"
}

run_write() {
	id=$1 path=$2 mode=$3 data=$4
	path=$(dec "$path"); mode=$(dec "$mode"); data=$(unmask "$data")
	dir=$(dirname "$path")
	if [ ! -d "$dir" ]; then
		mkdir -p "$dir" 2>/dev/null || { say "ERR $id $(b64 "cannot create $dir")"; return; }
	fi
	stage="$tmpdir/.nife-write-$$-$id"
	if printf %s "$data" | base64 -d > "$stage" 2>/dev/null; then
		case $mode in ''|*[!0-7]*) ;; *) chmod "$mode" "$stage" 2>/dev/null ;; esac
		if mv -f "$stage" "$path" 2>/dev/null; then
			say "OK $id $(b64 "$path")"
		else
			rm -f "$stage"; say "ERR $id $(b64 "cannot write $path")"
		fi
	else
		rm -f "$stage"; say "ERR $id $(b64 "bad payload for $path")"
	fi
}

run_stat() {
	id=$1 path=$2
	path=$(dec "$path")
	if [ ! -e "$path" ]; then say "ERR $id $(b64 "no such file: $path")"; return; fi
	if [ -d "$path" ]; then kind=d; else kind=f; fi
	size=$(wc -c < "$path" 2>/dev/null | tr -d ' ')
	say "OK $id $(b64 "$kind \${size:-0}")"
}

run_list() {
	id=$1 path=$2
	path=$(dec "$path")
	if [ ! -d "$path" ]; then say "ERR $id $(b64 "not a directory: $path")"; return; fi
	say "OK $id $(LC_ALL=C ls -a1 "$path" 2>/dev/null | sed -e '/^\\.$/d' -e '/^\\.\\.$/d' | enc)"
}

while IFS= read -r frame; do
	set -f
	set -- $frame
	set +f
	kind=\${1:-}
	id=\${2:-}
	case $kind in
		EXEC) run_exec "$id" "\${3:-}" "\${4:-}" "\${5:-}" & ;;
		KILL) run_kill "$id" & ;;
		READ) run_read "$id" "\${3:-}" "\${4:-}" "\${5:-}" ;;
		WRITE) run_write "$id" "\${3:-}" "\${4:-}" "\${5:-}" ;;
		STAT) run_stat "$id" "\${3:-}" ;;
		LIST) run_list "$id" "\${3:-}" ;;
		PING) say "OK $id ok" ;;
		BYE)
			for pidf in "$tmpdir"/.nife-run-$$-*.pid; do
				[ -f "$pidf" ] || continue
				pid=$(cat "$pidf" 2>/dev/null)
				case $pid in ''|*[!0-9]*) ;; *) kill -KILL "$pid" 2>/dev/null ;; esac
				rm -f "$pidf"
			done
			exit 0
			;;
		'') ;;
		*) say "ERR \${id:-0} $(b64 "unknown frame: $kind")" ;;
	esac
done
exit 0
`;
