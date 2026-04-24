# opencode-subagent-statusline

TypeScript OpenCode plugin with **two surfaces**:

1. **Server/runtime plugin** (`src/index.ts`) that persists `state.json` + `status.txt` (fallback/statusline integration).
2. **TUI plugin** (`src/tui.tsx`) that renders live subagent progress in OpenCode UI slots.

---

## Behavior

Both plugin surfaces listen to the same event family:

- `session.created`
- `session.idle`
- `session.error`
- `message.updated`
- `message.part.updated`

Tracked lifecycle:

- `session.created` (with `parentID`) → `running`
- `session.idle` (known child) → `done`
- `session.error` (known child) → `error`

Best-effort details:

- title (`title`/`name` candidates)
- timing (`startedAt`, `updatedAt`, `endedAt`, `elapsedMs`)
- tokens/context (`input`, `output`, `total`, `contextPercent`)

---

## TUI behavior

`src/tui.tsx` exports a TUI plugin module:

- `id: "subagent-statusline.tui"`
- registers `sidebar_content` (session-scoped)
- registers a compact `home_bottom` summary

`sidebar_content` filters subagents by the active sidebar session:

- only children where `child.parentID === ctx.session_id`

Sidebar layout:

- Title: `Subagents`
- Aggregate: `● {running} running · ✓ {done} done · ✕ {error} error`
- Per child: status icon + title + elapsed + context (`ctx ?`, `ctx 12.4k`, `%`)

Theme usage:

- `warning` → running
- `success` → done
- `error` → error
- `textMuted` → secondary info

Elapsed time updates while OpenCode TUI is open via interval timer, and all timers/event handlers are disposed through plugin lifecycle cleanup.

---

## Server fallback behavior (files)

No manual `state.json` creation is required. The server plugin writes:

- `state.json` (full machine-readable state)
- `status.txt` (compact statusline line)

Example rendered line:

```txt
↳ 2 running · 1 done · 0 error · build-index 01:23 ctx 12.4k · reviewer 00:41 ctx ? · test-fixes 00:12 ctx 31.0%
```

Default path (per OpenCode process):

```txt
${XDG_RUNTIME_DIR ?? os.tmpdir()}/opencode-subagent-statusline/pid-${process.pid}/state.json
```

Optional instance override:

```txt
${XDG_RUNTIME_DIR ?? os.tmpdir()}/opencode-subagent-statusline/${OPENCODE_SUBAGENT_STATUSLINE_INSTANCE}/state.json
```

`status.txt` is written next to `state.json`.

---

## Configuration

### 1) Server/runtime plugin (`opencode.json`)

Use the server plugin for file output fallback:

```json
{
  "plugin": ["/home/joaquinvesapa/vesapa/sub-agent-statusline/dist/index.js"]
}
```

### 2) TUI plugin (`~/.config/opencode/tui.json`)

OpenCode TUI plugins are configured in `tui.json` (not `opencode.json`).

Example:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    "opencode-sdd-engram-manage",
    "/home/joaquinvesapa/vesapa/sub-agent-statusline/src/tui.tsx"
  ],
  "theme": "rosepine"
}
```

> This repository does **not** modify your global `tui.json` automatically.

---

## Environment variables (server plugin)

- `OPENCODE_SUBAGENT_STATUSLINE_STATE`: explicit `state.json` path
- `OPENCODE_SUBAGENT_STATUSLINE_INSTANCE`: isolated instance directory name
- `OPENCODE_SUBAGENT_STATUSLINE_PRESERVE_STATE=1`: do not reset on startup
- `OPENCODE_SUBAGENT_STATUSLINE_COLOR=0`: disable ANSI in `status.txt`
- `NO_COLOR`: standard ANSI opt-out

---

## Caveats: event shape + context extraction

OpenCode payloads can vary by event and version. This plugin intentionally uses defensive extraction:

- accepts `sessionID`/`sessionId` and nested `properties.info` variants
- extracts context/tokens by scanning nested payload keys
- updates message-derived details only for known child sessions
- unknown/missing fields are ignored instead of crashing

If token/context fields are unavailable, the UI/text rendering shows `ctx ?`.
