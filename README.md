# nife-webui

Attaches a browser UI to a **running** nife CLI session. The terminal's conversation is the same
one the page shows — same messages, same streaming tokens, same approval dialogs — and every other
conversation the page opens runs as its own background session inside the same process, so moving
between them never stops a turn. Session files are read for the sidebar, search and the transcripts
the page is not attached to; a live conversation is fed by events, not by tailing its file.

## Build (maintainer only)

Users never build anything: `web/dist` is committed and shipped, so `nife install` + `/webui` is
all it takes. The Vue app has to be rebuilt only when you change something under `web/src`.

```bash
npm install
npm run build      # web/dist; also runs automatically on `npm pack` / publish via prepack
```

Dev server against a live bridge (HMR, proxies `/api`):

```bash
WEBUI_TARGET=http://127.0.0.1:PORT npm run dev
# open http://127.0.0.1:5173/?t=TOKEN  (PORT/TOKEN come from /webui)
```

## Layout

```
extensions/webui.ts   server: HTTP + SSE, ctx.ui interception, event forwarding
web/src/App.vue       transcript, composer, dialog modal
web/src/MessageItem.vue  one transcript row; BlockItem.vue one content block
web/src/MessageEdit.vue  a prompt's bubble, replaced by its inline editor
web/src/LiveMessage.vue  the streaming turn: `Working` row (LiveThinking.vue) + answer
web/src/transcript.js  collapses thinking/tool runs into one row
web/src/images.js     pasted image -> canvas resize -> base64 ImageContent
web/src/paste.js      text-paste markers + image mime/size rules
web/src/files.js      dropped-file marker lines, names, sizes, type icons
web/src/inline.js     Chat attachments: text/PDF extraction, size caps
web/src/pdf.js        lazy pdf.js text extraction for Chat
web/src/FileIcon.vue  one stroked 16px glyph per file category
web/src/style.css     all styling
web/dist/             built output, served by the extension
```

## Install

```bash
nife install https://github.com/OliverMao/nife-webui   # persistent, writes ~/.nife/agent/settings.json
nife install https://github.com/OliverMao/nife-webui@v0.0.1  # pinned to a tag; update by pinning a newer tag
nife update --extensions                                # unpinned installs track main
nife install -l https://github.com/OliverMao/nife-webui # project-local, writes .nife/settings.json
nife -e https://github.com/OliverMao/nife-webui         # this run only, nothing persisted
nife install /absolute/path/to/nife-webui              # local checkout
```

Then just run `nife`. The extension starts the bridge on launch and opens the printed URL in your
default browser, so the web UI is there without typing anything. nife clones the repo and runs
`npm install --omit=dev --legacy-peer-deps`, so the only thing it resolves is the manifest: there
are no runtime dependencies, and `web/dist` ships prebuilt. Nothing is compiled on install.

The extension is plain `node:http` + SSE; the UI is prebuilt into `web/dist`.

## Use

In the CLI session:

```
/webui                 -> webui: http://127.0.0.1:51234/?t=...
/webui off                stop the bridge and free the port
/webui auto on|off        autostart + auto-open on the next launch (default on)
/webui auto               print the current setting
```

Several windows are usually open at once, so the tab is named after what makes it different:
`<machine> · <project>`. The machine half is `WSL:<distro>` inside WSL, `Windows`, `macOS`,
`ssh:<host>` for a process reached over ssh, and the hostname otherwise - the kind first, because a
WSL distro and the Windows host of the same laptop often share one hostname. Each machine also gets
its own favicon colour (a hash of that label), so truncated tabs still differ at a glance, and the
project half follows the conversation the tab is switched to.

On launch the bridge starts by itself and the URL is opened once per process; the tab survives
`/reload`, `/new`, `/resume` and `/fork`, since the bridge keeps its port, token and session
binding. Autostart is skipped for headless runs (`nife --print`, subagents) and can be turned off
three ways: `/webui auto off` (persisted in `~/.nife/agent/webui.json`, honors
`NIFE_CODING_AGENT_DIR`), `NIFE_WEBUI=0` for a single launch, or `/webui off` for the current one.

Each running CLI process gets its own port and its own token, so several sessions can be open in
several tabs at once.

## Devices over ssh

A conversation can run on another machine without installing anything on it. The device only needs
`sh` and `base64` (busybox is enough: routers, NAS boxes, embedded Linux); nife stays on this
machine, and so do the transcripts.

`+ New Work` asks where it runs first: the picker opens with two tabs, `本机` and `SSH 设备`. The
second one lists the devices, has `添加 SSH 设备` / edit, and after a device is picked the same
folder browser walks *its* filesystem - `in this directory` then starts a conversation whose tools
run there.

- **Nothing is written to the device.** A POSIX helper is passed as an argument to
  `ssh host sh -c 'eval "$(...)"'`, so it lives only in that process's memory, and the frames that
  follow travel on the same stdin. No node, no download, no cleanup, no root.
- **One connection per device.** A fresh ssh per tool call costs a handshake every time, and
  Windows' OpenSSH cannot multiplex; here the connection stays open and requests are serialized on
  it. Requests are `EXEC` / `READ` / `WRITE` / `STAT` / `LIST` with base64 payloads, so a path with
  spaces or a file with a NUL never has to survive shell quoting.
- **The tools are nife's tools.** `bash`, `read`, `write`, `edit`, `ls` and `find` are the built-in
  definitions with their operations pointed at the device, so the model sees the same schemas and
  the same prompt snippets. `grep` is rewritten rather than reused - the built-in one spawns
  ripgrep on *this* machine whatever the operations say - and it runs `rg` when the device has it,
  `grep -r` when it does not, keeping the built-in output shapes (`path:line: text`, `path-line-
  text` for context lines).
- **The stop button stops something.** `EXEC` runs the command in its own session on the device and
  streams its output, so the frame loop is still listening: aborting a turn sends `KILL`, which
  takes the process group down. Without that the model loop would stop while the device kept
  building.
- **The model is told what it is on.** The first connection probes the device (`uname`, os-release,
  `systemctl`/`uci`/`apk`/`sudo`, user, root) and appends that to the system prompt, so a router is
  not treated like a Debian box.

In the sidebar a device is one group, not one group per directory: `router` with every conversation
that ran on it, each row tagged with the directory it ran in (`work`, `etc`, `root`). Three rows per
router would turn Recents into a filesystem listing. Devices and local projects share one list,
sorted by recency - a device just carries the terminal glyph (and its rows the directory tag).

Pinned conversations are not folded into their groups: they sit in a `置顶` block at the top that
never collapses, so "the four I use" are always one click away. Every row there carries the project
(or the device directory) it belongs to, because no group header says it any more. A conversation is listed once - the
group it came from shows it only after it is unpinned, and a group that held nothing but pins
disappears instead of lingering as "0 / No sessions".

A device conversation records the device in its session header (`webui.device`) and keeps the real
remote path as its `cwd`, so the tab reads `ssh:router · etc`, and
re-opening the conversation after a reload still runs on the device. That cwd is a path *on the
device*: the "temporary session" cleanup (a cwd or file under `tmp`/`temp` is thrown away) only ever
looks at this machine, never at a device path.

The connection has a life of its own. It opens on the first tool call (or a `测试连接`), is shared by
every conversation on that device, and is closed the moment the last of them is closed; one that no
conversation is attached to any more is swept after 10 minutes. Nothing stays connected just because
it was used once.

The device list is this extension's own: `~/.nife/agent/webui-hosts.json`, edited in the page and
read from nowhere else - a conversation on another machine is a first-class thing here, not a side
effect of whatever happens to be in `~/.ssh/config`:

```json
{ "hosts": [{ "alias": "router", "host": "192.168.1.1", "user": "root", "port": 22,
              "identity": "~/.ssh/id_ed25519", "proxyJump": "bastion" }] }
```

`添加 SSH 设备` / edit in the picker's SSH tab writes it: name, host, user, port, key, password,
jump host, with `测试连接` running a probe and reporting the OS, the user and how many usual
commands exist. The name *is* the identity - it is what the sidebar groups by and what `ssh:<name>`
means in the tab title and the session header. The row keeps the result (`已连接 · 482ms`, or `连接失败` with the reason in the
tooltip).

Authentication is a key when there is one and a password when there is not. Keys need nothing:
`BatchMode=yes` is set so a missing key fails fast instead of waiting on a prompt nobody can answer.
A password has to reach `ssh` without a terminal, so the form's password field is turned into an
`SSH_ASKPASS` script plus a `0600` file in a private temp directory for the life of the connection
(removed on close, and anything left behind by a crash is swept an hour later), with
`NumberOfPasswordPrompts=1` so a wrong password fails once instead of looping.

That password is stored **in clear** in `webui-hosts.json`, which is written `0600` - there is no
keychain that works the same on Windows, WSL and a server, and pretending otherwise would only
sound safer. A key is the better answer, and the form says so; `清除密码` removes a stored one
without touching the rest of the entry.

Host keys are remembered in `~/.nife/agent/ssh_known_hosts` with `accept-new`, so a device works the
first time it is added while a key that later changes is still refused; the user's own
`~/.ssh/known_hosts` is never touched.

### On Windows

The bridge runs on Windows too, and the device side is unchanged - it is still just `sh` over ssh.
What differs is everything around the local `ssh.exe`:

- The client is `%SystemRoot%\System32\OpenSSH\ssh.exe`, which is not always on `PATH`; it is looked
  up there before falling back to `ssh`, and `NIFE_SSH_PATH` overrides both.
- The helper travels as one argv element (`sh -c '<script>'`) with no double quotes in it, because
  Windows hands that element through libuv's quoting on the way to `ssh.exe`.
- Remote paths stay POSIX. Node on Windows resolves `/etc/nginx` to `C:\etc\nginx` before a tool
  sees it, so every path is normalized back (`C:\etc\nginx` -> `/etc/nginx`) before it is sent.
- `UserKnownHostsFile` is quoted when the profile path contains a space.

Passwords work here too, which is worth stating because the mechanism looks like it should not:
`ssh` asks for a password through the program named by `SSH_ASKPASS`, and Windows' `ssh.exe` starts
that with its own `posix_spawnp` - which does run a `.cmd`. Tested against Windows OpenSSH 9.5p1
with `SSH_ASKPASS_REQUIRE=force`, a `.cmd` under a path containing spaces, and the password in a
separate `0600` file (the shape this extension writes). No askpass `.exe` is needed, and the
official Win32-OpenSSH release does not ship one either.

## Public URL (nifetun)

With the [nifetun](https://github.com/OliverMao/nife-tunnel) extension installed (`/tunnel` in the
session, `tunnel_up` in the tool list), the `tunnel` pill in the sidebar footer - right after the
working directory - opens a menu in the same style as the model selector:

```
⛓ Nife Web                        publish     <- the page itself; no port is ever named
SERVER
  4599 · node                  open    ×       <- what the session is serving right now
  5173 · node                           +
CUSTOM PORT
  4711                         open    ×
  [ port ]                                    <- type a port nobody detected
```

- `Nife Web` publishes this page (`POST /api/tunnel` `{"action":"up"}`), turns the pill into a
  spinner while it waits, and reloads at `https://<domain>/t/<id>/?t=<token>` once the URL is there.
  While the approval mail is out the spinner stays and the page follows the URL by itself; the verb
  reads `publish`, `open`, `disconnect` or `waiting…` so the row never needs a second control.
- viewed publicly, `disconnect` asks for the teardown **from here** (`keepalive`, so the request
  survives the navigation) and then goes back to the local URL with `&tunnel=off`, where the local
  page repeats the request in case the first one never made it out of the tunnel it was killing.
- `Server` is the detection described below; `Custom Port` keeps the ports the reader typed in, and
  the page's own port is in neither list. Publishing one of them never disturbs the page: nifetun
  appends the port to the running client's config file (hot reload on the same connections) instead
  of restarting it, which would drop the page's tunnel - and every other tunnel - for a moment.
- the pill itself carries the state: link icon and green when this page is public, amber pulse while
  the approval is pending, `×` once the page is being viewed through the tunnel.
- quitting nife takes the servers it started with it (`session_shutdown` with reason `quit`, plus a
  synchronous `process.on("exit")`: the descendants of the CLI get `SIGTERM`, deepest first). A
  reload or a session switch keeps them, because the process and its tunnels are still there. The
  tree walk lives here because detection does; nifetun handles the tunnels themselves.
- nothing is published at startup any more: the bridge never opens a public URL on its own.

The terminal still narrates it: `webui: publishing 127.0.0.1:<port> through nifetun…` when the page
asks, then either `webui public: <url>` or `webui: waiting for tunnel approval` (nifetun answers as
soon as its client reports the pending enrollment, not after its 15s URL wait).

**Other services.** Ports that the session itself started - anything listening under this CLI's
process tree, e.g. a dev server the agent ran with `bash` - show up as dashed `+:3000` chips in the
same footer. Clicking one publishes **that port only** (`{"action":"up","port":3000}`), so the page
and its token stay local; the chip turns into a link to the public URL, with a `×` on hover to stop
publishing it. The terminal says `webui public: 127.0.0.1:3000 -> https://…` for each one, and a new
port is announced once (`nife started node on 127.0.0.1:3000 — publish it from the sidebar`).
Detection is restricted to descendants of the CLI process, on every platform: `/proc` (socket inodes
plus `/proc/<pid>/fd`) on Linux, `lsof` + `ps` on macOS, `netstat -ano` + `Get-CimInstance
Win32_Process` on Windows. Only loopback or any-address listeners count, because that is what
`127.0.0.1:<port>` can reach. The scan runs in the background and is cached for 3s - the Windows pair
of commands takes about a second, so `/api/state` serves the last list and a changed list is pushed
as `{type:"services"}`; it is refreshed right after a tool finishes (a server needs a moment to bind,
so 700ms later) and the page ignores ports that were already there for the first 3s.
- The page works under a path prefix: requests are built from `location.pathname`, not the origin,
  so `/api/state`, `/api/events` (SSE) and uploads all go through `/t/<id>/`. `web/dist` uses
  relative asset URLs (`base: "./"`), so nothing depends on the edge rewriting `index.html`.
- The bridge also strips `/t/<id>` itself, from `X-Forwarded-Prefix` when the edge sends it and from
  the path when it does not: an edge built before that header existed (or with `strip_prefix` off)
  forwards `/t/<id>/api/...` untouched, and a doubled prefix still lands on the right route. A 404
  from the bridge names the path it could not route (`not found: /t/<id>/...`), which is how that
  case is told apart from the edge's own "no such tunnel" page.
- `Origin` on POSTs is accepted when it matches the request's own `Host`, which is how the public
  URL gets through while another site still cannot drive the session.
- The tunnel client is a separate process owned by `/tunnel`, and it can die on its own. The bridge
  keeps a 20s heartbeat: a client that vanished is reported (`webui: tunnel dropped, republishing…`),
  the dead link is dropped from the page, and `up` is asked again - up to five times, and the chip
  disappears once nifetun stops answering. Without that, a dead client left every request (page and
  API alike) on the edge's 404 while the bridge kept serving fine on 127.0.0.1.
- `down` removes only this port from the tunnel: another port served by the same client keeps its
  tunnel (the client is restarted with what is left), so disconnecting the page never kills someone
  else's tunnel. `/webui off` still leaves the tunnel alone (`/tunnel down` stops it), and the client
  process outlives nife anyway.
- No nifetun, no public URL: everything else is unchanged and the bridge stays on `127.0.0.1`.

From the browser:

- `Nife Work` and `Nife Chat` are separate workspaces with separate session histories. New
  sessions live in a global web-ui store (`~/.nife/webui/work` and `~/.nife/webui/chat`), not in
  the directory nife was started from; each header records the project `cwd`, and opening it makes
  nife rebuild the runtime (and its tools) for that directory. Every nife project directory and
  every old `webui-chat/` directory is discovered, but only session headers are read during
  discovery; transcript bodies wait until the project is expanded. Sessions that belong to a temp
  location are throwaway sandbox runs: any path segment named `tmp` or `temp` (case-insensitive),
  `os.tmpdir()`, `TMPDIR`/`TEMP`/`TMP`, `%LOCALAPPDATA%\Temp` and `%SystemRoot%\Temp` on Windows,
  `/tmp` and `/var/tmp` on Unix - for the project `cwd` or for the session file itself. They never
  show up as projects, and discovery deletes the file instead of remembering it (the session this
  process is running is the one exception - hidden from the lists, never deleted from under itself)
- `New Work` / `New Chat` starts the empty session immediately in the last directory used and puts
  the project chip in the composer, because the directory is part of the prompt. Clicking it opens
  a picker that works without knowing any paths: the folders of the current project with a
  breadcrumb (and an up button) to walk anywhere, plus shortcuts for the home directory,
  `~/.nife/project` and the current project. Typing filters known projects and history and also
  accepts any path (`~` expanded); a name that matches a known project opens it, anything else
  becomes a new directory on the server. The picker is backed by `GET /api/dirs`, which lists one
  level of subdirectories without leaving the server. Picking another directory moves the
  still-empty session there, the last choice is remembered in `localStorage`, and once the first
  message is sent the chip disappears: nife fixes a session's `cwd` at that point
- left sidebar lists sessions for the current workspace across **all projects**, click to switch.
  Rows are grouped under foldable project headers; the active/most recent project is expanded and
  marked with a dot, other groups follow by latest activity and are collapsed. The first group's
  rows load immediately; expanding any other group fetches just that project's sessions, so a large
  old session tree does not delay the first paint.
- **background sessions**: opening a conversation attaches it, it does not replace the terminal's
  runtime. The terminal's own session runs in place; every other conversation the page opens gets
  its own in-process `AgentSession` (`POST /api/attach`), so switching the page away from a running
  turn keeps it running instead of answering `stop the current turn first`. Two different limits:
  at most 12 session files are open at once (a parsed transcript, cheap) and at most 5 of them hold
  a *runtime* (a whole agent with tools, a model and an event stream). Reading a conversation needs
  only the parse, so opening one - clicking a row, switching Work/Chat - never waits for a
  background turn to finish; when all five runtimes are busy the transcript still opens in full,
  the composer says so and refuses the send until one ends. A runtime is recycled automatically:
  the oldest idle one first, never the one on screen, and the session file stays open so the next
  prompt rebuilds it. A run that
  started there keeps going while the page reads something else, and every per-session endpoint
  takes a `sid` so a turn is never confused with the conversation next to it. Rows show a blue
  spinner while a turn runs and a green dot when it finished unattended, with a toast naming the
  conversation; opening the row clears the dot. The row state comes from the event stream: a list
  response that was computed before the last status event is not allowed to overwrite it (a turn
  that ended while the request was in flight kept its spinner until a page refresh), a pinned row is
  patched in its own copy of the list, and a reconnected stream re-reads the list instead of waiting
  for a refresh. A running conversation can still be aborted, or
  deleted (which stops it first). Idle runtimes are rebuilt from the session file on the next visit,
  and the page remembers which conversation it was on across reloads A trash button on each
  project header deletes that workspace's conversations after one confirmation; the project
  directory and its files are left untouched, and the header disappears with its last conversation
  instead of lingering as an empty group. A project only appears once it has a saved conversation:
  an empty New Work / New Chat is not a row, so there is no group to leave behind either. The
  footer always shows the active project. Search scans every conversation in the current workspace,
  again across projects, and its results carry a project label
- the mode selector switches workspace but keeps the current project directory: it opens that
  project's last session in the target workspace, or an empty New Work / New Chat for it. Each
  workspace has its own Recents, pins and search; the page queue belongs to the conversation, so it
  is parked (not delivered into the other session) when the view moves. The terminal is never moved
  by the page: it keeps whatever session it had
- Chat workspace sessions always declare no tools and use nife's chat system prompt. The workspace
  is derived from the session file location, so `/new`, `/resume` and `/fork` stay inside it.
  Dropped images attach as image content for vision models; text, code, CSV, Markdown, JSON and
  selectable PDF text are read in the browser and carried inside the prompt, so Chat needs no tool
  to read them. Binary/Office files still need Work. The terminal's own `/resume` selector keeps
  nife's project-local behavior; the page is the cross-project switcher
- hovering a session reveals a `⋯` menu with `重命名`, `置顶`, `多选` and `删除`. Rename edits the
  row in place (Enter commits, Escape cancels) and prefers the stored `session_info` name over the
  first prompt. Pinned rows sort above the rest **within their project group** and keep a pin mark;
  the pin list is stored in `localStorage` per workspace (not per project), because it is a browser
  preference, not session content
- after a new conversation's first turn settles, the bridge asks the current model for a short
  title (a separate request, never part of the transcript) and writes the same `session_info` entry
  a manual rename writes. The sidebar updates through `sessions_changed`. A manual name always
  wins; if the title request fails, the first-prompt fallback stays in place
- the sidebar header keeps the existing `Nife` wordmark, with the mode selector right beside it and
  the search/panel buttons on the right. Search opens an animated centred palette and scans the
  user/assistant text of every conversation in this workspace and all its projects: results group
  matching snippets under their session title and highlight the query. Clicking a snippet switches
  to that session (and its project) and
  jumps to the matching message. Escape or the X closes the palette; the compact pill opens the
  same one
- entering `多选` from a row's `⋯` menu turns rows into circular
  checkboxes, the header counts the selection, and the footer offers `置顶` plus `删除`. Bulk pin
  toggles all checked rows; bulk delete asks once in the same centred modal. The active session can
  be deleted too: the bridge first switches to a fresh session in the same project, so the page
  lands on that workspace's New Work / New Chat screen. Deletion uses the `trash` CLI when it is
  installed and falls back to `unlink`, mirroring
  the TUI selector, and every open tab refreshes via the `sessions_changed` event
- sending while a turn is running **queues** the task instead of interrupting it: a strip 20px
  narrower than the composer sits flush on its top edge, listing FIFO items with a text preview, a
  `2 images · 1 file` counter, click-to-edit back into the composer and `×` to drop. Limits are 20
  items / 40MB of queued images. Exactly one item is sent per finished turn (driven by
  `agent_settled`, plus `compaction_end` because compaction is not an agent turn), and the queue
  pauses - with a `Resume` button - on `/new`, `/resume`, and on any aborted turn: the bridge
  forwards `aborted` from `agent_settled`, so Escape in the terminal pauses the page's queue too,
  and Stop sets the flag before it even asks the bridge, closing the race where the settle event
  would drain the queue first. Pausing stops the *automatic* continuation only: sending while the
  session is idle and the queue is paused runs that message immediately and resumes the queue, so
  the parked items follow that turn. `Resume` continues without a new message, `Clear` drops them; failures stay at the head with a
  `Retry` action instead of silently disappearing
- `+` starts a fresh session (`/new`). A new conversation gets its file only when the first prompt is
  persisted; the bridge watches for that file and broadcasts `sessions_changed`, so the row appears
  in Recents immediately instead of after a manual refresh
- hovering a user prompt reveals two icons in the row's own bottom margin - copy, and edit (the
  DeepSeek row). Edit happens **in place**: the bubble is replaced by an editor card at the same
  spot (`web/src/MessageEdit.vue`) holding its attachments, its text and its own `Cancel` / `Send`,
  so the composer is never touched and nothing is destroyed. The card takes images and files the
  same way the composer does, and shows them with the composer's own `.attachments` row: 56px
  thumbnails with the corner remove badge, `file-chip`s with name and size, a progress bar while an
  upload runs. Paste goes through `prepareImage` (a clipboard item's type is trusted, and a File that
  arrives with an empty type is re-typed before it - a screenshot otherwise looked like a plain
  file, with no preview and no image block for the model), drop uploads non-images in Work and
  inlines them in Chat, and `Send` waits while a file is still being read or uploaded. `Cancel` (or
  Escape) puts the bubble
  back. `Send` first posts the prompt's session entry id to `POST /api/tree` - which runs
  `ctx.navigateTree` for that prompt, no branch summary, exactly like `/tree` - reloads the
  truncated branch, and only then posts the edited prompt, so it lands on the branch it edits and
  becomes a new branch of the same session file. The TUI editor is filled with the same prompt, so
  both screens agree. The composer refuses to send while a prompt is being edited (`send or cancel
  the prompt you are editing first`), and a prompt in a session that is still running is refused
  with `stop the current turn first`. Under the hood the transcript rows carry `entryId`/`parentId`,
  and - because nife persists a prompt *after* emitting `message_end` - the bridge announces the id
  in a follow-up `entry_id` event that the page stamps on the prompt it just received; without that,
  the newest prompt only became editable after a reload. Only a user message on the current branch
  can be edited.
- every answer carries two icons in its own bottom margin, right where the text ends (the DeepSeek
  row): **copy** takes the answer's text alone - never the reasoning, the tool output or the
  Markdown source of a code block - and **retry** regenerates that turn. Retry is offered only on
  the newest answer, because it rewrites the conversation from there: `POST /api/retry` moves the
  leaf to the parent of the prompt behind that answer (`ctx.navigateTree`, as `/tree` does) and
  sends that prompt again exactly as it was recorded - same text, same images, same `[attached]`
  markers - so the branch keeps one prompt and gets a fresh answer instead of a duplicate turn. A
  failed turn has nothing to copy but is exactly what retry is for, so it keeps the strip whenever
  it is the newest answer. The composer refuses to send while a turn streams or an upload runs, and
  retry does the same (`stop the current turn first`)
- the answer text is the only thing shown outside a collapsed run: thinking and tool calls always
  sit inside a closed `Worked · 3 tools · 1 thought` row, whether they arrived as separate
  process-only messages (`isProcessItem` in `web/src/transcript.js`) or as adjacent blocks inside a
  message that also carries text. A single step folds the same way (`Worked · 1 thought`), so the
  transcript reads as answers only, with the working out one click away. The turn that is still
  streaming reuses that row: the trailing run turns `Working` and the incoming reasoning grows at the
  end of its body (`web/src/LiveMessage.vue`, `web/src/LiveThinking.vue`), with the answer below the
  fold, so committing the turn only swaps the live body for its block and does not move the page.
  Inside the row, tool steps stay flat one-liners (`Ran npm test`), expand for arguments and output,
  failed rows are marked in amber. Before any of that arrives there is a gap - the prompt is
  uploaded, the agent starts, the model prefills (vLLM pads, a provider queues the request) - which
  used to look like the page had ignored the send: `waitingForModel` holds a `Working` line in the
  exact spot the run's summary will occupy (same margin, padding, type and spinner, with a spacer
  where the chevron goes), and it disappears the moment the answer text, its reasoning or the
  trailing run's `Working` label takes over
- the panel button collapses the sidebar (remembered in `localStorage`). When collapsed, the
  panel/search/new-chat tools move into a rounded pill at the left of the topbar; the brand area is
  unchanged. Under 820px the sidebar becomes an overlay, where a dimmed backdrop covers the page:
  tapping it, switching sessions, or Escape closes the overlay, and resizing back to a wide window
  clears the open state. Search from the compact pill expands the sidebar first, so the same filter
  input is used in both states
- model chip in the composer lists available/scoped models with a filter, `setModel` runs in the CLI
  session so the terminal switches too; models without credentials are reported, not switched
- `Manage models` in the model menu is the editor for `~/.nife/agent/models.json` (the path itself
  is only a tooltip on the header). A provider rail on the left, alphabetical with row counts,
  filters the catalog on the right, and the catalog is grouped by provider: each group opens with a
  plain header (provider id, its endpoint, an `Edit` link into the provider form) followed by its
  models - name, `current`/`override`/`no key` state, id, limits, resolved endpoint and how many
  advanced blocks it sets. `Add model` writes a new row (an existing provider, or a brand-new one
  with its base URL, API and optional key), the pencil opens the row's form, the bin deletes it
  (also removing an `modelOverrides` entry and the empty scaffolding, since an empty `models: []`
  would fail the whole file).
- Every field models.json accepts is editable: identity and endpoint, capabilities (reasoning,
  text/image input, context window, max output), pricing (four rates plus the `tiers` table), and an
  `Advanced` block with `thinkingLevelMap`, image/request limits, `promptCache`, `headers`,
  `compat`, `samplingParams` and `samplingParamsByThinkingLevel` (the last three as JSON, checked
  before saving). Editing a provider opens the shared entry: name, `baseUrl`, `api`, `oauth`,
  `authHeader`, `headers`, `compat` and the key (shown as `stored`, replaced only when typed,
  `Remove the stored key` clears it). A provider registered by an extension has no entry to edit and
  stays read-only; a `modelOverrides` row has no endpoint of its own, so its form points at the
  provider.
- Writes go through `GET/POST /api/models`, `/api/models/update`, `/api/models/provider` and
  `/api/models/delete`, which write the file atomically, re-compose the catalog, and roll back with
  the compose error when the change would not load (a pre-existing broken provider in the same file
  never blocks another row); a models.json that does not parse is read-only (409) and left untouched.
  Keys and the fields the form does not touch are preserved.
- `Compact context` sits in its own divided `Tools` section at the bottom of the model menu (below
  the Reasoning slider, with the current context percentage) and summarizes the context: `POST /api/compact` calls `ctx.compact()` and waits for the
  summarization call to finish, so the row shows `Compacting…` and reports the failure text when
  it fails. It is disabled while a turn streams (compaction aborts it).
  `session_before_compact` / `session_compact` / `session_compact_failed` are forwarded as
  `compaction_start` / `compaction_end`, so threshold and overflow compaction refresh the
  transcript and the context ring without a click
- `Proxy` in the menu's `Network` section switches the running session between "through the proxy"
  and "direct": nife builds its HTTP agent once at startup (`EnvHttpProxyAgent` in
  `core/http-dispatcher.ts`), so the address is fixed, but undici re-reads `NO_PROXY` on every
  request, so the bridge sets `no_proxy` and `NO_PROXY` to `*` for direct mode and restores the
  exact previous values (deleting them when they were unset) on the way back. Child processes
  inherit the same environment, so `bash` commands follow the same choice. A session started
  without `HTTP_PROXY`/`HTTPS_PROXY` shows `not set`: nothing to switch, and a plugin cannot add one
  either, because undici is bundled into nife's CLI build (`dist/bundle/chunks/*` holds its own
  copy), so `setGlobalDispatcher` from a plugin would touch a different module instance.
  undici keeps two agents - `http_proxy` for http targets and `https_proxy` for https targets, where
  https falls back to the http value but not the other way round - so the line under the switch
  shows both resolved addresses (`http + https host` when they match, `http direct · https host`
  when only one is set). The switch itself stays single: the bypass list matches hosts, and undici
  has no per-scheme bypass, so one row toggles both
- reasoning slider lives inside the model menu above the model list
  (visuals follow [dsh-codex-effort-slider](https://github.com/Microqian2th/dsh-codex-effort-slider)):
  blue -> violet -> deep violet fill, white knob, level ticks, and from one third upward an energy
  layer with sweep light and stardust; the level switches the moment the pointer passes a third of
  a step and needs two thirds back, so the knob does not chatter
- the transcript sticks to the newest line: a `ResizeObserver` on the scroll box and its content
  re-scrolls whenever streamed markdown, a collapsing row, an image or a growing textarea changes
  the height. Scrolling wins over incoming content: a `scroll` that moves the viewport up (wheel,
  drag, touch, keyboard) clears the follow flag immediately, `wheel` with `deltaY < 0` clears it even
  before the scroll lands, and it only comes back within 64px of the bottom. While detached, a
  `Latest` pill floats above the composer and jumps back down on click. Your own prompt, session
  load and session switch always re-stick, and a new user message - typed here, sent from the
  terminal, or drained from the queue - forces the view down, so a queued task starting is never
  missed
- thinking is collapsed by default, live and committed: the streaming block is a closed `Thinking`
  summary with a spinner, and opening it shows the same 132px viewport that eases to the newest
  line with a bottom fade
- the slider only offers levels the current model supports, and the label is grey for `off`,
  violet at higher efforts; `prefers-reduced-motion` disables the sweep and stardust
- the level label in the composer chip has a fixed `7ch` box (`minimal` is the widest), so dragging
  the slider cannot resize the chip - and with it the menu anchored to the chip's right edge
- Enter sends, Shift+Enter adds a line, the round button stops a run mid-flight
- composer follows the DSH/Codex pattern: one large rounded box with the controls on a row inside
  it; the dim stats line (`msgs · tools · context x/y (z%) · in/out · cache · cost`) sits inside
  that row right behind the model selector and hides under 900px. Stats come from `/api/state`
  (`usage` from `ctx.getContextUsage()`, totals summed from message usage including `cost.total`)
  and are pushed again as a `stats` event after every `turn_end`, so a long tool loop moves the
  numbers step by step instead of freezing until the agent settles; neither path touches scroll
- context usage is the composer outline: a 2px rounded-rect stroke drawn with `pathLength="100"`,
  so `stroke-dasharray="<pct> 100"` fills exactly that share of the perimeter (a conic sweep would
  drift with the box aspect ratio). It starts at the top-left corner and runs clockwise.
- pasting more than 10 lines or 1000 chars collapses into a `[paste #1 +48 lines]` marker in the
  textarea and is expanded again on send, same thresholds and wording as the TUI editor
- pasting or dropping an image attaches it to the message instead: png/jpeg/webp/gif plus bmp
  (converted to png, since no provider takes `image/bmp`), up to 4 per message, shown as removable
  thumbnails above the textarea and sent as `ImageContent` blocks through `sendUserMessage`.
  Anything over 2000px or 4.5MB of base64 is redrawn on a canvas first, which is nife's own
  clipboard-image cap (below the providers' 5MB per-image limit); animated GIFs are passed through
  unresized and rejected when too big. Images are refused with a notice when the current model's
  `input` does not include `image`. A picture that already fits (a clipboard screenshot) is passed
  through untouched - only a size probe plus a `FileReader` - while a full-resolution file dragged
  from disk has to be decoded, downscaled and re-encoded; that second pass now aims at the byte
  budget in one shot (the overshoot says how much smaller it has to be) instead of shrinking 25% per
  attempt and encoding up to six times. The thumbnail is a **placeholder that exists before the work**:
  `previewImage()` hands back a blob URL straight away (no decode, the chip is on screen at once),
  the picture is dimmed with a spinner while `prepareImage` runs, and the data URL replaces the blob
  when it is done (`?debug=1` on the page logs the milliseconds each attachment spent decoding and
  re-encoding, which is how to tell that time apart from the browser's own drag handover) - resizing a 2000px PNG used to mean seconds of nothing after a drop. The encode
  itself goes through `canvas.toBlob` instead of `toDataURL` so the resize does not block the main
  thread and the spinner keeps turning. Until the swap happens the send button is disabled
  (`Preparing the attachments…`), and `Cancel`/`×` drops the placeholder too
- files can be dropped anywhere on the page: the composer outline turns into the drop target, and
  dropped images land in the same thumbnail row as pasted ones. In Work, any other file is uploaded
  to `$TMPDIR/nife-webui/<pid>-<token>/` (`POST /api/upload`, 25MB cap) under a **generated** name,
  `<16 hex><sanitized extension>`; the uploaded name is only a label and never picks a path, a
  length or a collision. The endpoint returns `{ path, name }`, and the chip shows the name with a
  type icon (`web/src/files.js`: pdf, image, doc, sheet, slides, archive, code, text, audio,
  video, generic, each with its own accent colour). In Chat, text-like files are read with
  `TextDecoder` and selectable PDF text with lazy-loaded `pdfjs-dist`, then inlined into the prompt
  (150k characters per file, 300k per message, 2MB raw text / 25MB PDF); binary and Office formats
  are refused with a notice to use Work. A drag can also carry *no bytes* at all - a
  picture dragged out of the transcript, or a link dragged from another page. Our own pictures are
  `data:`/`blob:` URLs, so that case is fetched back into a File and attached like any other image
  (`attachLink`), and a remote link is refused with `that drag carried a link, not a file — paste
  the image instead` instead of silently doing nothing (left alone, the browser would navigate to
  it). A dragged file the browser could not type - no `type`, no telling extension - is recognised
  by its header (`sniffImageType`) so it can never fall through to the generic uploader.
  The chip appears from the first byte; while the
  upload runs it shows `Uploading…` and then a percentage plus a progress bar (`XMLHttpRequest`
  rather than `fetch`, because only XHR reports upload progress), and the send button stays disabled
  until the path is back.
  The textarea is untouched: on send the files are appended to the prompt as one
  `[attached] {"name":"<label>","path":"<file>"}` line each, which is what a terminal drop means
  for nife: the agent reads `path` with its own tools. Both the composer chips and the transcript
  hide the temp path (the message row shows the label; hover for the path).
  Files are deleted when the nife process exits, and abandoned directories from crashed runs are
  swept on the next start (a live pid keeps its own files)
- running subagents show as pills in the top bar (`explorer`, `explorer ×3`) while the `subagent`
  tool call is in flight, and as `Delegated explorer · task` rows in the transcript
- multi-agent on/off is still `/subagent` (or ctrl+y) in the terminal: the extension API exposes
  tools but not the `multiAgentEnabled` setting, so the web UI reports state instead of faking a toggle
- session switching survives autostart: `switchSession`/`newSession` exist only on the command
  context, which the runtime hands to command handlers, so the bridge dispatches a `webui-session`
  command through `sendUserMessage("/webui-session ...", { expandPromptTemplates: true })`. That
  command shows up in the terminal's command list; switching while a turn streams is refused with
  a notice instead of being queued mid-turn
- `/tree` is deliberately not exposed

## Rendering

Assistant output is rendered as markdown by `web/src/markdown.js`: ~120 lines, no dependency,
escapes everything before applying a fixed set of transforms (headings, lists, quotes, fences,
tables with column alignment, inline code, bold/italic/strike, http(s) links). Raw HTML from the model is always escaped, so
`v-html` is safe. Code blocks carry a language label and a copy button.

Streaming is batched so a token never invalidates the transcript:

- deltas accumulate and flush once per animation frame
- committed messages are plain objects in a `shallowRef`, invalidated only at message boundaries
- each message is a `MessageItem` child with stable props, so Vue skips it when text streams
- the live message is a `LiveMessage` child that owns its own throttled (120ms) markdown render,
  so the parent component does not re-render at all while tokens arrive
- tool calls are paired with their results once per message boundary via a `WeakMap` cache for
  rendered markdown, not per token

### Long names

A project or session name wider than the sidebar is not lost: the row's content is one strip
(`.session-scroll`) inside a clip, and while the pointer is on the row the strip slides left to its
end at ~150px/s and stays there; leaving returns it to the start in 0.22s. `--shift` is measured on
hover, so rows that fit never move, and there is no motion under `prefers-reduced-motion`. At rest the clip fades its last 14px, which says "there is
more" without an ellipsis cutting a glyph in half.

## UI

Layout follows the Codex app: session sidebar, single transcript column capped at 760px, sticky
composer at the bottom, one-line tool rows instead of raw JSON dumps. All styling lives in
`web/src/style.css`; nothing in the extension cares about presentation.

The bridge survives `/new`, `/resume` and `/fork`: port, token and open tabs stay valid, and the
page reloads the transcript of the newly active session. That is why the bridge lives on
`globalThis` instead of module scope — the extension factory runs again for every session.

## How it works

- `extensions/webui.ts` starts a `node:http` server on `127.0.0.1` when `/webui` runs.
- Events come from the extension API: `message_start`, `message_update` (deltas only),
  `message_end`, `agent_start`, `agent_settled`, `session_info_changed`, `tool_execution_*`.
- Initial transcript: `ctx.sessionManager.getBranch()` projected through
  `sessionEntryToContextMessages()`, i.e. the whole active branch. Compaction only removes messages
  from the model's context - the reader can still scroll through them - so a `compaction` entry
  becomes a `compactionMarker` row in the place where the rewrite happened
  (`Context compacted · 300.2k tokens`, summary expandable). The rail therefore starts on the first
  prompt of the session, not on the newest summary.
- Sending: `pi.sendUserMessage()`. While the session is busy the endpoint answers `409 busy` and
  the page keeps the item in its own strip - nothing is delivered as `steer`, so nife's mid-turn
  queue never holds anything the browser is still showing as pending.
- Drops: `POST /api/upload` writes the bytes to the OS temp dir and returns the path, which the page
  inserts as text. The same token and `Origin` checks guard it, and cleanup is described above.
- Dialogs: all extensions in a session share one mutable `ctx.ui` object, so the bridge wraps
  `confirm` / `select` / `input` / `editor`. With no browser attached, calls fall through to the
  terminal dialog unchanged.
- Extensions are reloaded on `/new`, `/resume`, `/fork`; the bridge rebinds on `session_start`
  and is *not* torn down on `session_shutdown`, so the URL keeps working across switches.
- Publishing asks nifetun over nife's event bus (`nifetun:request` / `nifetun:reply`) instead of
  guessing its state file: `{kind: "up", tunnels: ["127.0.0.1:<port>"]}` comes back with the entry
  list, and the entry whose local end is this port is the URL. `up` appends to the tunnels that are
  already running, so starting the web UI never drops a tunnel someone else is using.
- Session control (`switchSession`, `newSession`) needs a command-capable context. `/webui`
  captures one, and every replacement passes a fresh `withSession` context, so the next switch
  works without re-running `/webui`.

No build step for the extension itself: plain `node:http` + SSE, no runtime dependencies.

## Security

- Binds `127.0.0.1` only.
- Every request needs `?t=<token>`; the token is per bridge, 32 hex chars, regenerated each start.
- `Origin` is checked on requests that carry it, so another page cannot POST to the port.
- Uploaded bytes always land under a generated name inside `$TMPDIR/nife-webui/<pid>-<token>/`: the
  request's file name is reduced to a label (directory parts dropped, `<>:"|?*` and control
  characters replaced, 80 chars max) and only a `[a-z0-9]` extension is carried over, so a header
  cannot choose a directory, overwrite another drop, or smuggle a name into a shell command.
- `GET /api/groups` discovers every project from session headers across the global web-ui stores
  and every nife project directory, and returns only `{ path, name, count, modified, current }`
  metadata. The header index is cached for 4s; transcript bodies are not opened.
- `GET /api/sessions?cwd=<project>` parses full sessions for **one** expanded project only and
  returns its rows. Per-project result sets are cached for 2.5s. New first prompts, rename, title
  and delete invalidate both caches, so sidebar event bursts do not rescan the tree.
- `POST /api/delete` accepts `path` or a `paths` array; every target must be a session path the
  bridge lists for one of the two workspaces, so the endpoint cannot be pointed at an arbitrary
  file. The active session is allowed while idle: the runtime moves to a fresh session in the same
  project and workspace before any file is removed, and a batch is validated before the first
  unlink.
- `POST /api/rename` takes `path` and `name`; the target must be a session from either workspace.
  The active session goes through `api.setSessionName`, an inactive one through
  `SessionManager.open(path).appendSessionInfo(name)`, so the name the list shows is the same
  `session_info` entry the terminal writes.
- `POST /api/new` takes `{"cwd":"<project>","mode":"work"|"chat"}` (mode optional). It creates the
  directory when needed, writes a header-only session into the global work/chat store with that
  `cwd`, and switches the runtime to it, so the first prompt is already a project session. The
  body is limited to 16KB and `~`/relative paths are resolved server-side.
- `GET /api/projects` returns `{ default, projects: [{ path, name, kind }] }`: the default
  `~/.nife/project`, its child directories, the current project and projects that already have
  history. It is the picker's data source, not a filesystem-control endpoint.
- `POST /api/mode` takes `{"mode":"work"|"chat"}` and switches workspaces while staying in the
  current project directory: it remembers the current session, resumes a session for that `cwd` in
  the target workspace, or creates a header-only one. `state.mode` is derived from the active
  session file (`webui/work`, `webui/chat`, or a legacy `webui-chat/`). `before_agent_start` keeps
  Chat sessions tool-free and supplies the chat prompt. Because the extension API has no
  `setChatMode`, the workspace uses those public hooks instead.
- `GET /api/search?q=` scans the `allMessagesText` of the current workspace's sessions across all
  projects, opens only the sessions that can hit, and returns up to 40 groups with up to 6 snippets
  each. A snippet carries its `entryId`, so the page can reveal that message after switching
  sessions. The other workspace is not searched until the selector switches to it.
- There is no login: the URL carries the token, so treat a published URL as a credential. The port
  itself still binds `127.0.0.1`; the only public path is the nifetun tunnel (`/tunnel down` closes
  it). For anything else use an SSH tunnel or Tailscale rather than a reverse proxy.

## Long sessions

The transcript is windowed, not fully mounted: only the newest 60 rows are in the DOM, and the
height of everything above them is carried by a spacer, so the browser lays out a page, not a
session. Scrolling up renders 24 older rows at a time and gives their real height back to the
spacer, which is why nothing shifts under the cursor. Two things that were easy to get wrong:

- trimming only happens for rows that are already out of sight (`firstVisible()` bounds it), and the
  spacer grows by exactly the height that left the flow, measured before the update;
- jumping into old history parks the window around the target (`runEnd`), otherwise a jump to task 3
  of a 2000-row session would mount every row below it.

The spacer is an estimate per row, so a row has to stay around one screen tall: an open `Worked`
run can hold dozens of tool steps, and one that grows for pages makes every jump land at the wrong
offset. Its body therefore scrolls inside itself (`max-height: 60vh`, see `.process-body` in
`web/src/style.css`) - the summary stays put and the window keeps measuring rows it can anticipate.

Nothing inside the transcript draws a scrollbar (`.transcript *`), which an open run would otherwise
show several of: the row body, each tool output and the reasoning are all scroll areas. The wheel
goes to whatever is under the pointer and chains outward at the end of each area (`wheelTarget` in
`App.vue`), so the row body, one output inside it and the page behave like one scroller, and an
upward wheel inside an inner area no longer detaches the view from the newest message.

A row the reader expanded while the turn was streaming stays expanded when the message commits
(`claimLiveRow` in `App.vue`). The live body and the committed body are different elements, so
without that hand-over the body collapsed in the same frame the message landed and the page jumped
by its whole height. The live block is also only mounted once it has something to draw: an empty one
still carries its margins, which made the page blink at the start of every turn.

The history is paged as well as windowed: `/api/state` ships a tail slice of the context (at most
60 messages, ~400 KB, always starting on a user message so a tool call never loses its result),
together with `messageCount` and `loadedFrom`. Scrolling to the oldest loaded row asks
`/api/messages?before=<loadedFrom>` for the previous page, and the rows it brings in land above the
window, so nothing on screen moves. A megabyte of JSON used to be serialized, shipped and parsed
before the page could paint anything; now a page load costs the same whether the session has 30
messages or 3000. `/api/state?meta=1` returns the same header fields with an empty `messages` array,
which is what the event-driven refresh uses.

A "Worked" row is closed by default, so its contents are not in that page either: a thought arrives
as a bare marker, a tool call keeps its name and a truncated copy of its arguments (the label under
the row), a tool result keeps only its error flag, and the message carries `trimmed: true`. Opening
the row asks `GET /api/steps?from=<index>&to=<index>` for the real messages of that run - extended
forward while tool results still belong to it - and merges them back by absolute index, so the row
keeps its key, its open state and its place in the scroll. While that request is in flight the body
says `loading N steps`; a failure says so and retries on click. On a session with a megabyte of tool
output this is the difference between a 3 KB first page and an 800 KB one.

The scrollbar is hidden and replaced by a rail on the right with one dot per user prompt, since a
thumb over thousands of pixels was never precise. The rail is built from `state.tasks` - a message
index plus a label per prompt, no content - so it lists tasks whose messages are not loaded yet;
clicking such a dot pulls the pages it needs and only then scrolls. Message indices are absolute, so
they stay valid when a page is prepended (row indices do not, and the window shifts those). The rail
is a window of its own: a long session has hundreds of prompts, so the dots scroll inside
`max-height: min(60vh, 520px)` and two arrow buttons page it, with the active dot scrolled into view
as you read. Dots stay round - the task being read is marked by accent colour and a larger dot, never
by growing into a bar - and while the view follows the newest message that mark sits on the last
task, so opening the page shows the current prompt rather than something from the middle. The rail hides on narrow screens.

## Known limits

- The web UI's global sessions are not in nife's per-project `/resume` selector; open them from
  the page. The terminal keeps nife's project-local behavior.
- The new-session picker uses server-side paths and creates a missing directory recursively; a typo
  therefore creates an empty project directory instead of failing.
- Pasting both text and an image (rich content from an office app) attaches the image only; plain
  text paste is unaffected.
- Work files travel as `[attached] <path>` lines, so the terminal still shows them even though the
  web UI hides them behind chips: nife has no file content block to carry them any other way. Chat
  files are inlined as an `[attached-inline]` block instead, so they are part of the message and do
  not depend on a live temp path - the terminal transcript therefore shows the file text too.
- The rail marks user prompts only: a jump lands on what you asked, not on a particular answer, and
  it carries the newest 300 prompts (older ones fall out of `state.tasks`). A window parked inside
  the history shows an approximate scroll height until those rows are rendered again.
- The task queue lives in the page, not on the bridge: a reload or a closed tab drops it, and there
  is no background draining (a paused queue stays paused until you resume it in that tab).
- Work files are temporary: the path in the prompt only resolves while that nife process is
  alive, so a session resumed later sees a dead path. Chat's inlined text is part of the message
  and survives.
- A PDF dropped in Work reaches the model as a path, and nife's `read` treats it as UTF-8 text.
  Chat extracts selectable text with `pdfjs-dist`; a scanned/image-only PDF has no text layer and
  still needs Work (or converting its pages to images).
- `ctx.ui.custom()`, `setWidget`, `setFooter`, `setEditorComponent` receive TUI render functions
  and cannot render in a browser. Extensions that draw their own TUI screens (plan mode style)
  stay terminal-only.
- Slash commands are not sent as commands: `/model`, `/tree`, `/settings`, `/compact`, `/export`,
  `/hotkeys` and friends are handled by interactive-mode, which an extension cannot call, and the
  page sends text literally. Model, thinking level, compaction, new and resume have their own
  controls; the `Nife Chat` workspace uses the active-tool and system-prompt hooks, and typing
  `/chat` alone in the composer switches workspace instead of sending it. Terminal `/chat` still
  toggles nife's in-session flag; it does not move the web selector between workspaces.
- Dialog timeouts (`opts.timeout`) are not forwarded; a browser dialog waits until answered.
- If a browser tab closes while a dialog is open, the terminal dialog takes over on the next turn.
- Markdown is rendered as plain pre-wrapped text. No syntax highlighting yet.
- One bridge per CLI process; no landing page listing sessions across directories.
- A device session has no `subagent` tool: a subagent would run on this machine with local tools.
- `grep` on a device ignores `.gitignore` unless the device has `rg`; the built-in one always
  respects it, this one only when ripgrep is there to read it.
- A device form covers host/user/port/key/password/jump host; anything else (extra `-o` options) is
  still edited in `webui-hosts.json` by hand.
- A stored password is plain text in that file (mode `0600`). Keys avoid the question entirely.
- One connection per device, serialized requests: two conversations on the same router wait for each
  other's commands rather than interleaving their output.
- `/webui off` is the only way to close the port; quitting the CLI closes it with the process.
- A published URL needs a nifetun whose extension answers the event bus (the current `main`); an
  older install simply gets no public URL. Reloading the page keeps the token in the address bar,
  but opening the bare `/t/<id>/` URL without `?t=` answers `401 bad token`.
- SSE through a CDN is only as live as the CDN: a proxy that buffers responses turns the stream
  into a slow poll. The tunnel itself forwards bytes as they arrive.

## Dev check

`tsconfig.check.json` type-checks the extension against a nife source checkout; the `paths`
entry points at `/root/nife`, edit it for your layout:

```bash
/root/nife/node_modules/.bin/tsgo -p tsconfig.check.json
```

## Next steps if you keep going

1. Landing page: write `{port, token, pid, sessionId, cwd}` to `~/.nife/webui/instances/` and
   serve an index from a separate small daemon.
2. Tool cards from `tool_execution_start/update` for live progress instead of waiting for the
   final `toolResult` message.
3. Markdown + diff rendering for `edit` / `write` results.
4. Tool cards from `tool_execution_update` for live progress.
