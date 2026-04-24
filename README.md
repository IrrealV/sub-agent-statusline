# opencode-subagent-statusline

OpenCode plugin para ver qué subagentes están corriendo, cuáles terminaron y cuánto contexto/tokens consumieron.

Sirve en dos modos:

- **TUI plugin**: muestra el panel `Subagents` dentro de la UI de OpenCode.
- **Server/runtime plugin**: escribe `state.json` y `status.txt` para integrarlo como fallback/statusline externa.

---

## Probarlo desde este repo

### Requisitos

- Node.js moderno compatible con TypeScript ESM.
- `pnpm`.
- OpenCode instalado y funcionando.
- Opcional: `sqlite3` si querés que el TUI intente rehidratar tokens de sesiones ya finalizadas desde la base local de OpenCode.

### 1) Instalar dependencias

```sh
pnpm install
```

### 2) Compilar el plugin server/runtime

```sh
pnpm build
```

Esto genera `dist/index.js` y `dist/tui.js`.

### 3) Activar el TUI plugin

Editá `~/.config/opencode/tui.json` y agregá el plugin. Para probar rápido podés apuntar directo al source:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    "/home/joaquinvesapa/vesapa/sub-agent-statusline/src/tui.tsx"
  ]
}
```

Si preferís probar lo compilado:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    "/home/joaquinvesapa/vesapa/sub-agent-statusline/dist/tui.js"
  ]
}
```

> Este repo **no modifica tu `tui.json` automáticamente**. Lo editás vos, lo probás, y si no te gusta sacás esa línea. Es así de simple.

### 4) Activar el plugin server/runtime opcional

Si además querés que se escriban archivos para una statusline externa, agregá el runtime plugin en tu `opencode.json`:

```json
{
  "plugin": [
    "/home/joaquinvesapa/vesapa/sub-agent-statusline/dist/index.js"
  ]
}
```

### 5) Verificar que funciona

Abrí OpenCode y dispará 2 o 3 subagentes/tareas en paralelo. Deberías ver:

- En el sidebar: `Subagents` con `running`, `done` y `error`.
- En la parte inferior/home: un resumen compacto.
- Si activaste el runtime plugin: `state.json` y `status.txt` en el directorio runtime.

Para limpiar la prueba, quitá la entrada del plugin en `tui.json`/`opencode.json` y reiniciá OpenCode.

---

## Qué hace

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
- Per child: status icon + title + elapsed + context when available (tokens and/or `%`)

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
↳ 2 running · 1 done · 0 error · build-index 01:23 ctx 12.4k tok · reviewer 00:41 · test-fixes 00:12 ctx 31.0%
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

If token/context fields are unavailable, the UI/text rendering omits context for that child.
