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
web/src/style.css     all styling
web/dist/             built output, served by the extension
scripts/smoke.mjs     fake ExtensionAPI + real HTTP server, no model needed
```

## Install

```bash
nife install https://github.com/OliverMao/nife-webui   # persistent, writes ~/.nife/agent/settings.json
nife install -l https://github.com/OliverMao/nife-webui # project-local, writes .nife/settings.json
nife -e https://github.com/OliverMao/nife-webui         # this run only, nothing persisted
nife install /absolute/path/to/nife-webui              # local checkout
```

Then start a session and run `/webui`. nife clones the repo and runs
`npm install --omit=dev --legacy-peer-deps`, so the only thing it resolves is the manifest: there
are no runtime dependencies, and `web/dist` ships prebuilt. Nothing is compiled on install.

No build step for the user, and no runtime dependencies: the extension is plain `node:http` +
SSE, the UI is prebuilt into `web/dist`.

## Use

In the CLI session:

```
/webui        -> webui: http://127.0.0.1:51234/?t=...
/webui off
```

Open the printed URL. Each running CLI process gets its own port and its own token, so several
sessions can be open in several tabs at once.

From the browser:

- left sidebar lists sessions for the current working directory, click to switch (`/resume`)
- `+` starts a fresh session (`/new`)
- tool calls collapse into one-line rows (`Ran npm test`), expand for arguments and output,
  failed rows are marked in red
- panel button collapses the sidebar (remembered in `localStorage`); it becomes an overlay under 820px
- model chip in the composer lists available/scoped models with a filter, `setModel` runs in the CLI
  session so the terminal switches too; models without credentials are reported, not switched
- reasoning slider lives inside the model menu above the model list
  (visuals follow [dsh-codex-effort-slider](https://github.com/Microqian2th/dsh-codex-effort-slider)):
  blue -> violet -> deep violet fill, white knob, level ticks, and from one third upward an energy
  layer with sweep light and stardust; the level switches the moment the pointer passes a third of
  a step and needs two thirds back, so the knob does not chatter
- the streaming thinking block keeps a fixed 132px viewport that follows the newest line with an
  eased scroll and a bottom fade; scrolling up pauses the follow until you return to the bottom
- reply text does the opposite: when a reply starts, its first line is pinned about a fifth down
  the viewport and the transcript does **not** follow while it streams, so you read from the top.
  The view only moves for local actions: your own prompt, session load, session switch
- the slider only offers levels the current model supports, and the label is grey for `off`,
  violet at higher efforts; `prefers-reduced-motion` disables the sweep and stardust
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
- running subagents show as pills in the top bar (`explorer`, `explorer ×3`) while the `subagent`
  tool call is in flight, and as `Delegated explorer · task` rows in the transcript
- multi-agent on/off is still `/subagent` (or ctrl+y) in the terminal: the extension API exposes
  tools but not the `multiAgentEnabled` setting, so the web UI reports state instead of faking a toggle
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
- Initial transcript: `ctx.sessionManager.getBranch()`.
- Sending: `pi.sendUserMessage()`; while streaming it is delivered as `steer`.
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
- Do not expose the port publicly. For remote access use an SSH tunnel or Tailscale, not a
  reverse proxy with auth you wrote yourself.

## Known limits

- `ctx.ui.custom()`, `setWidget`, `setFooter`, `setEditorComponent` receive TUI render functions
  and cannot render in a browser. Extensions that draw their own TUI screens (plan mode style)
  stay terminal-only.
- Built-in TUI commands (`/settings`, `/hotkeys`, ...) are not available through the web.
- Dialog timeouts (`opts.timeout`) are not forwarded; a browser dialog waits until answered.
- If a browser tab closes while a dialog is open, the terminal dialog takes over on the next turn.
- Markdown is rendered as plain pre-wrapped text. No syntax highlighting yet.
- One bridge per CLI process; no landing page listing sessions across directories.
- `/webui off` is the only way to close the port; quitting the CLI closes it with the process.

## Dev checks

```bash
node scripts/smoke.mjs     # fake ExtensionAPI + real HTTP/SSE server, no model needed
```

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
