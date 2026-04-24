import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
  TuiThemeCurrent,
} from "@opencode-ai/plugin/tui";
import { appendFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { For, Show, createMemo, createSignal } from "solid-js";
import { applySubagentEvent } from "./events.js";
import { byPriority, formatContext, formatDuration } from "./render.js";
import {
  createEmptyState,
  getCounts,
  type ChildSessionState,
  type StatuslineState,
} from "./state.js";

const TUI_PLUGIN_ID = "subagent-statusline.tui";
const ELAPSED_TICK_MS = 1000;

function debugLog(input: Record<string, unknown>): void {
  if (!process.env.OPENCODE_SUBAGENT_STATUSLINE_DEBUG_EVENTS) return;
  try {
    const path = join(
      process.env.XDG_RUNTIME_DIR ?? os.tmpdir(),
      "opencode-subagent-statusline",
      "tui-events.log",
    );
    mkdirSync(dirname(path), { recursive: true });
    const line = JSON.stringify({ time: new Date().toISOString(), ...input });
    appendFileSync(path, `${line}\n`, "utf8");
  } catch {
    // Debug logging must never crash the TUI.
  }
}

function debugEvent(event: unknown): void {
  const e = event as {
    type?: unknown;
    properties?: { sessionID?: unknown; part?: unknown; info?: unknown };
  };
  const part = e.properties?.part as
    | { type?: unknown; tool?: unknown; state?: { status?: unknown } }
    | undefined;
  debugLog({
    kind: "event",
    type: e.type,
    sessionID: e.properties?.sessionID,
    partType: part?.type,
    tool: part?.tool,
    toolStatus: part?.state?.status,
  });
}

function cloneState(state: StatuslineState): StatuslineState {
  return {
    updatedAt: state.updatedAt,
    children: Object.fromEntries(
      Object.entries(state.children).map(([id, child]) => [
        id,
        {
          ...child,
          tokens: child.tokens ? { ...child.tokens } : undefined,
        },
      ]),
    ),
  };
}

function elapsedMs(child: ChildSessionState, nowMs: number): number {
  if (child.status !== "running") {
    return child.elapsedMs ?? 0;
  }
  const started = Date.parse(child.startedAt);
  if (Number.isNaN(started)) return child.elapsedMs ?? 0;
  return Math.max(0, nowMs - started);
}

function statusIcon(status: ChildSessionState["status"]): string {
  if (status === "done") return "✓";
  if (status === "error") return "✕";
  return "●";
}

function statusColor(
  status: ChildSessionState["status"],
  theme: TuiThemeCurrent,
): TuiThemeCurrent["warning"] {
  if (status === "done") return theme.success;
  if (status === "error") return theme.error;
  return theme.warning;
}

function normalizeTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s*\([^)]*\)\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function relatedTitles(a: string, b: string): boolean {
  const left = normalizeTitle(a);
  const right = normalizeTitle(b);
  if (!left || !right) return false;
  return left.includes(right) || right.includes(left);
}

function collapseToolWrappers(children: ChildSessionState[]): ChildSessionState[] {
  const realChildren = children.filter((child) => child.source !== "tool");
  return children.filter((child) => {
    if (child.source !== "tool") return true;
    return !realChildren.some(
      (real) =>
        real.parentID === child.parentID && relatedTitles(real.title, child.title),
    );
  });
}

function SidebarSubagents(props: {
  sessionID: string;
  state: () => StatuslineState;
  nowMs: () => number;
  theme: TuiThemeCurrent;
}) {
  const children = createMemo(() =>
    collapseToolWrappers(
      Object.values(props.state().children).filter(
        (child) => child.parentID === props.sessionID,
      ),
    ).sort(byPriority),
  );

  const otherChildren = createMemo(() =>
    collapseToolWrappers(
      Object.values(props.state().children).filter(
        (child) => child.parentID !== props.sessionID,
      ),
    ).sort(byPriority),
  );

  const counts = createMemo(() => {
    const result = { running: 0, done: 0, error: 0 };
    for (const child of children()) {
      if (child.status === "running") result.running += 1;
      if (child.status === "done") result.done += 1;
      if (child.status === "error") result.error += 1;
    }
    return result;
  });

  return (
    <box flexDirection="column" padding={{ left: 1, right: 1 }}>
      <text fg={props.theme.textMuted}>Subagents</text>
      <box flexDirection="row">
        <text fg={props.theme.warning}>{`● ${counts().running} running`}</text>
        <text fg={props.theme.textMuted}> · </text>
        <text fg={props.theme.success}>{`✓ ${counts().done} done`}</text>
        <text fg={props.theme.textMuted}> · </text>
        <text fg={props.theme.error}>{`✕ ${counts().error} error`}</text>
      </box>

      <For each={children()}>
        {(child) => (
          <box flexDirection="row">
            <text fg={statusColor(child.status, props.theme)}>
              {statusIcon(child.status)}
            </text>
            <text>{` ${child.title}`}</text>
            <text fg={props.theme.textMuted}>{` ${formatDuration(
              elapsedMs(child, props.nowMs()),
            )}`}</text>
            <text fg={props.theme.textMuted}>{` ${formatContext(child)}`}</text>
          </box>
        )}
      </For>

      <Show when={children().length === 0 && otherChildren().length > 0}>
        <text fg={props.theme.textMuted}>Other sessions</text>
        <For each={otherChildren()}>
          {(child) => (
            <box flexDirection="row">
              <text fg={statusColor(child.status, props.theme)}>
                {statusIcon(child.status)}
              </text>
              <text>{` ${child.title}`}</text>
              <text fg={props.theme.textMuted}>{` ${formatDuration(
                elapsedMs(child, props.nowMs()),
              )}`}</text>
              <text fg={props.theme.textMuted}>{` ${formatContext(child)}`}</text>
            </box>
          )}
        </For>
      </Show>
    </box>
  );
}

function HomeBottomStatus(props: {
  state: () => StatuslineState;
  theme: TuiThemeCurrent;
}) {
  const counts = createMemo(() => getCounts(props.state()));
  const visible = createMemo(
    () => counts().running > 0 || counts().error > 0,
  );

  return (
    <Show when={visible()}>
      <box padding={{ left: 1, right: 1 }}>
        <box flexDirection="row">
          <text fg={props.theme.warning}>{`● ${counts().running}`}</text>
          <text fg={props.theme.textMuted}> · </text>
          <text fg={props.theme.success}>{`✓ ${counts().done}`}</text>
          <text fg={props.theme.textMuted}> · </text>
          <text fg={props.theme.error}>{`✕ ${counts().error}`}</text>
        </box>
      </box>
    </Show>
  );
}

const tui: TuiPlugin = async (api: TuiPluginApi) => {
  const [state, setState] = createSignal<StatuslineState>(createEmptyState());
  const [nowMs, setNowMs] = createSignal(Date.now());

  const tick = setInterval(() => {
    setNowMs(Date.now());
  }, ELAPSED_TICK_MS);

  const applyEvent = (event: unknown): void => {
    debugEvent(event);
    setState((current) => {
      const next = cloneState(current);
      const changed = applySubagentEvent(next, event);
      if (changed) {
        debugLog({
          kind: "state.changed",
          children: Object.values(next.children).map((child) => ({
            id: child.id,
            parentID: child.parentID,
            title: child.title,
            status: child.status,
            source: child.source,
          })),
        });
      }
      return changed ? next : current;
    });
  };

  const disposers = [
    api.event.on("session.created", applyEvent),
    api.event.on("session.idle", applyEvent),
    api.event.on("session.error", applyEvent),
    api.event.on("message.updated", applyEvent),
    api.event.on("message.part.updated", applyEvent),
  ];

  api.lifecycle.onDispose(() => {
    clearInterval(tick);
    for (const dispose of disposers) {
      dispose();
    }
  });

  api.slots.register({
    slots: {
      sidebar_content(ctx) {
        const routeSessionID =
          api.route.current.name === "session"
            ? api.route.current.params.sessionID
            : undefined;
        const sessionID = ctx.session_id ?? routeSessionID ?? "";
        debugLog({
          kind: "slot.sidebar_content",
          ctxSessionID: ctx.session_id,
          resolvedSessionID: sessionID,
          route: api.route.current,
          childCount: Object.keys(state().children).length,
        });
        return (
          <SidebarSubagents
            sessionID={sessionID}
            state={state}
            nowMs={nowMs}
            theme={ctx.theme.current}
          />
        );
      },
      home_bottom(ctx) {
        return <HomeBottomStatus state={state} theme={ctx.theme.current} />;
      },
    },
  });
};

const plugin: TuiPluginModule = {
  id: TUI_PLUGIN_ID,
  tui,
};

export default plugin;
