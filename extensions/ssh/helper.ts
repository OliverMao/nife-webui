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
 * The first line a device sends is not always our frame, though: a login banner or an MOTD also
 * arrives on stdout. Frames are therefore shaped (`KIND id payload`) and the reader ignores
 * everything else.
 *
 *   request                                answer
 *   EXEC  <id> <cwd> <timeout> <cmd>       OUT <id> <b64 chunk> … then EXIT <id> <code>
 *   READ  <id> <path> <offset> <count>     OK <id> <b64>
 *   WRITE <id> <path> <mode> <b64 data>    OK <id> <b64 path>
 *   STAT  <id> <path>                      OK <id> <b64 "d|f <size>">
 *   LIST  <id> <path>                      OK <id> <b64 newline separated names>
 *   PING  <id>                             OK <id> ok
 *   BYE                                    (exit)
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

stream() {
	id=$1
	buf= total=0
	while IFS= read -r line || [ -n "$line" ]; do
		# Batch whole lines into one frame: a fork per line turned 20000 lines into 35 seconds.
		if [ "$total" -lt 1000000 ]; then
			buf="$buf$line
"
			if [ \${#buf} -ge 8192 ]; then
				say "OUT $id $(printf %s "$buf" | enc)"
				total=$((total + \${#buf}))
				buf=
			fi
		fi
		line=
	done
	if [ -n "$buf" ]; then say "OUT $id $(printf %s "$buf" | enc)"; fi
}

run_exec() {
	id=$1 cwd=$2 limit=$3 cmd=$4
	cwd=$(dec "$cwd"); limit=$(dec "$limit"); cmd=$(dec "$cmd")
	case $limit in ''|*[!0-9]*) limit= ;; esac
	if [ ! -d "$cwd" ]; then
		say "ERR $id $(b64 "not a directory: $cwd")"
		return
	fi
	stage="$tmpdir/.nife-code-$$"
	(
		cd "$cwd" || exit 127
		if [ -n "$limit" ] && have timeout; then
			timeout "$limit" sh -c "$cmd" </dev/null
		else
			sh -c "$cmd" </dev/null
		fi
		printf '%s' "$?" > "$stage"
	) 2>&1 | stream "$id"
	code=$(cat "$stage" 2>/dev/null); rm -f "$stage"
	say "EXIT $id \${code:-1}"
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
	stage="$tmpdir/.nife-write-$$"
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
		EXEC) run_exec "$id" "\${3:-}" "\${4:-}" "\${5:-}" ;;
		READ) run_read "$id" "\${3:-}" "\${4:-}" "\${5:-}" ;;
		WRITE) run_write "$id" "\${3:-}" "\${4:-}" "\${5:-}" ;;
		STAT) run_stat "$id" "\${3:-}" ;;
		LIST) run_list "$id" "\${3:-}" ;;
		PING) say "OK $id ok" ;;
		BYE) exit 0 ;;
		'') ;;
		*) say "ERR \${id:-0} $(b64 "unknown frame: $kind")" ;;
	esac
done
exit 0
`;
