# nife-webui

Attaches a browser UI to a **running** nife CLI session. The web page is another screen on the
same `AgentSession` — same messages, same streaming tokens, same approval dialogs. It does not
start a second agent and does not read the session file.

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
web/src/transcript.js  collapses thinking/tool runs into one row (unit tested)
web/src/images.js     pasted image -> canvas resize -> base64 ImageContent
web/src/paste.js      text-paste markers + image mime/size rules (unit tested)
web/src/files.js      dropped-file marker lines, names, sizes, type icons (unit tested)
web/src/FileIcon.vue  one stroked 16px glyph per file category
web/src/style.css     all styling
web/dist/             built output, served by the extension
scripts/files-test.mjs, paste-test.mjs, markdown-test.mjs, transcript-test.mjs   pure-function tests
scripts/smoke.mjs     fake ExtensionAPI + real HTTP server, no model needed
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

On launch the bridge starts by itself and the URL is opened once per process; the tab survives
`/reload`, `/new`, `/resume` and `/fork`, since the bridge keeps its port, token and session
binding. Autostart is skipped for headless runs (`nife --print`, subagents) and can be turned off
three ways: `/webui auto off` (persisted in `~/.nife/agent/webui.json`, honors
`NIFE_CODING_AGENT_DIR`), `NIFE_WEBUI=0` for a single launch, or `/webui off` for the current one.

Each running CLI process gets its own port and its own token, so several sessions can be open in
several tabs at once.

From the browser:

- left sidebar lists sessions for the current working directory, click to switch (`/resume`)
- hovering a session reveals a delete button: one click asks for confirmation in place
  (`Delete` / `Cancel`), then the row is removed and every open tab refreshes via the
  `sessions_changed` event. The bridge deletes with the `trash` CLI when it is installed and falls
  back to `unlink`, mirroring the TUI selector, and refuses the session that is currently running
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
- `+` starts a fresh session (`/new`)
- thinking and tool calls collapse into one row, not one row per step: consecutive process-only
  messages (`isProcessItem` in `web/src/transcript.js`) become a single closed `Worked · 3 tools ·
  1 thought` row, and inside a message that also carries text, adjacent thinking/tool blocks
  collapse the same way - so the transcript reads as answers only, with the working out one click
  away. A lone step keeps its own row. Single tool rows are flat one-liners (`Ran npm test`),
  expand for arguments and output, failed rows are marked in amber
- panel button collapses the sidebar (remembered in `localStorage`); it becomes an overlay under
  820px, where a dimmed backdrop covers the page: tapping it, switching sessions, or Escape closes
  the overlay, and resizing back to a wide window clears the open state
- model chip in the composer lists available/scoped models with a filter, `setModel` runs in the CLI
  session so the terminal switches too; models without credentials are reported, not switched
- `Compact context` sits in its own divided `Tools` section at the bottom of the model menu (below
  the Reasoning slider, with the current context percentage) and summarizes the context: `POST /api/compact` calls `ctx.compact()` and waits for the
  summarization call to finish, so the row shows `Compacting…` and reports the failure text when
  it fails. It is disabled while a turn streams (compaction aborts it).
  `session_before_compact` / `session_compact` / `session_compact_failed` are forwarded as
  `compaction_start` / `compaction_end`, so threshold and overflow compaction refresh the
  transcript and the context ring without a click
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
  and refresh after each turn without touching scroll
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
  `input` does not include `image`
- files can be dropped anywhere on the page: the composer outline turns into the drop target, and
  dropped images land in the same thumbnail row as pasted ones. Any other file is uploaded to
  `$TMPDIR/nife-webui/<pid>-<token>/` (`POST /api/upload`, 25MB cap) under a **generated** name,
  `<16 hex><sanitized extension>`; the uploaded name is only a label and never picks a path, a
  length or a collision. The endpoint returns `{ path, name }`, and the chip shows the name with a
  type icon (`web/src/files.js`: pdf, image, doc, sheet, slides, archive, code, text, audio,
  video, generic, each with its own accent colour). While the upload runs the chip shows a
  percentage and a progress bar, because the drop is sent with `XMLHttpRequest` rather than `fetch`.
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
- Initial transcript: `ctx.sessionManager.buildContextEntries()` projected through
  `sessionEntryToContextMessages()`, i.e. the same compaction-aware view the TUI renders, so a
  summary replaces the messages it squeezed out and shows up as a `Context compacted` row.
- Sending: `pi.sendUserMessage()`; while streaming it is delivered as `steer`.
- Drops: `POST /api/upload` writes the bytes to the OS temp dir and returns the path, which the page
  inserts as text. The same token and `Origin` checks guard it, and cleanup is described above.
- Dialogs: all extensions in a session share one mutable `ctx.ui` object, so the bridge wraps
  `confirm` / `select` / `input` / `editor`. With no browser attached, calls fall through to the
  terminal dialog unchanged.
- Extensions are reloaded on `/new`, `/resume`, `/fork`; the bridge rebinds on `session_start`
  and is *not* torn down on `session_shutdown`, so the URL keeps working across switches.
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
- `POST /api/delete` only accepts paths that `SessionManager.list(cwd)` returns for this project and
  never the active session, so the endpoint cannot be pointed at an arbitrary file.
- Do not expose the port publicly. For remote access use an SSH tunnel or Tailscale, not a
  reverse proxy with auth you wrote yourself.

## Known limits

- Pasting both text and an image (rich content from an office app) attaches the image only; plain
  text paste is unaffected.
- Dropped files travel as text, so the terminal still shows the `[attached] <path>` lines the web
  UI hides behind chips: nife has no file content block to carry them any other way.
- The task queue lives in the page, not on the bridge: a reload or a closed tab drops it, and there
  is no background draining (a paused queue stays paused until you resume it in that tab).
- Dropped files are temporary: the path in the prompt only resolves while that nife process is
  alive, so a session resumed later sees a dead path.
- A dropped PDF (or any binary) reaches the model as a path, not as content: nife's `read` treats
  it as UTF-8 text and there is no document block in the message model, so the agent has to run
  something like `pdftotext` itself. Extracting PDF text in the browser needs `pdfjs-dist` and is
  not implemented.
- `ctx.ui.custom()`, `setWidget`, `setFooter`, `setEditorComponent` receive TUI render functions
  and cannot render in a browser. Extensions that draw their own TUI screens (plan mode style)
  stay terminal-only.
- Slash commands are not sent as commands: `/model`, `/tree`, `/settings`, `/compact`, `/export`,
  `/hotkeys` and friends are handled by interactive-mode, which an extension cannot call, and the
  page sends text literally. Model, thinking level, compaction, new and resume have their own
  controls.
- Dialog timeouts (`opts.timeout`) are not forwarded; a browser dialog waits until answered.
- If a browser tab closes while a dialog is open, the terminal dialog takes over on the next turn.
- Markdown is rendered as plain pre-wrapped text. No syntax highlighting yet.
- One bridge per CLI process; no landing page listing sessions across directories.
- `/webui off` is the only way to close the port; quitting the CLI closes it with the process.

## Dev checks

```bash
npm run smoke              # markdown/files/paste unit tests, an SSR render of App.vue,
                           # then the HTTP/SSE bridge against a fake ExtensionAPI
```

`scripts/render-test.mjs` builds the real `App.vue` once for SSR and renders it with the initial
state. It exists because a template expression on a possibly-null computed blanks the page while
every HTTP test still passes: the palette's `slashMatches.length` did exactly that.

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
