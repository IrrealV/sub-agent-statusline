import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
  TuiSlotContext,
  TuiThemeCurrent,
} from "@opencode-ai/plugin/tui";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, join } from "node:path";
import { For, Show, createMemo, createSignal } from "solid-js";
import type { Accessor } from "solid-js";
import { applySubagentEvent, extractChildDetails } from "./events.js";
import { byPriority, formatDuration, renderStatusLine } from "./render.js";
import {
  createEmptyState,
  getCounts,
  resolveStatePath,
  resolveTextPath,
  saveState,
  type ChildTokenState,
  type ChildSessionState,
  type StatuslineState,
} from "./state.js";

const TUI_PLUGIN_ID = "subagent-statusline.tui";
const ELAPSED_TICK_MS = 1000;
const FALLBACK_SIDEBAR_WIDTH = 46;
const MIN_ROW_WIDTH = 24;
const MIN_LABEL_WIDTH = 8;
const DONE_TOKEN_REHYDRATE_THROTTLE_MS = 2000;
const DONE_TOKEN_REHYDRATE_MAX_ATTEMPTS = 15;
const CLOCK_ICON = "";
const TOKEN_ICON = "";

type SidebarContentContext = TuiSlotContext & { session_id?: string };
type HomeBottomContext = TuiSlotContext;

interface RehydratedTokenCacheEntry {
  attempts: number;
  checkedAtMs: number;
  tokens?: ChildTokenState;
}

const doneTokenCache = new Map<string, RehydratedTokenCacheEntry>();

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

function mergeTokenState(
  existing: ChildTokenState | undefined,
  incoming: ChildTokenState | undefined,
): ChildTokenState | undefined {
  if (!existing && !incoming) return undefined;
  return {
    input: incoming?.input ?? existing?.input,
    output: incoming?.output ?? existing?.output,
    total: incoming?.total ?? existing?.total,
    contextPercent: incoming?.contextPercent ?? existing?.contextPercent,
  };
}

function hasTokenTotal(tokens: ChildTokenState | undefined): boolean {
  return typeof tokens?.total === "number" && Number.isFinite(tokens.total);
}

function sameTokens(
  left: ChildTokenState | undefined,
  right: ChildTokenState | undefined,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function tokenStateFromMessageData(data: string): ChildTokenState | undefined {
  const parsed = safeRead(() => JSON.parse(data) as { tokens?: ChildTokenState });
  return parsed?.tokens;
}

function resolveOpenCodeDataDir(): string {
  return join(process.env.XDG_DATA_HOME ?? join(os.homedir(), ".local", "share"), "opencode");
}

function resolveOpenCodeDbPath(): string {
  return process.env.OPENCODE_SUBAGENT_STATUSLINE_OPENCODE_DB ?? join(resolveOpenCodeDataDir(), "opencode.db");
}

function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

function readDoneTokensFromOpenCodeDb(sessionID: string): ChildTokenState | undefined {
  const dbPath = resolveOpenCodeDbPath();
  if (!existsSync(dbPath)) return undefined;

  const output = safeRead(() =>
    execFileSync(
      "sqlite3",
      [
        dbPath,
        `select data from message where session_id='${escapeSqlString(sessionID)}' and json_extract(data, '$.tokens.total') is not null order by time_created desc;`,
      ],
      { encoding: "utf8", timeout: 1000, maxBuffer: 1024 * 1024 },
    ),
  );
  if (!output) return undefined;

  let tokens: ChildTokenState | undefined;
  for (const line of output.split("\n")) {
    const hydrated = tokenStateFromMessageData(line.trim());
    tokens = mergeTokenState(tokens, hydrated);
    if (hasTokenTotal(tokens)) break;
  }
  return tokens;
}

function readDoneTokensFromOpenCodeLogs(sessionID: string): ChildTokenState | undefined {
  const logDir = join(resolveOpenCodeDataDir(), "log");
  if (!existsSync(logDir)) return undefined;

  const files = safeRead(() =>
    readdirSync(logDir)
      .filter((file) => file.endsWith(".log"))
      .sort()
      .reverse()
      .slice(0, 8),
  );
  if (!files) return undefined;

  const tokenPattern = /"tokens"\s*:\s*(\{[^\n]*?\})/g;
  let tokens: ChildTokenState | undefined;
  for (const file of files) {
    const contents = safeRead(() => readFileSync(join(logDir, file), "utf8"));
    if (!contents || !contents.includes(sessionID)) continue;

    for (const line of contents.split("\n")) {
      if (!line.includes(sessionID) || !line.includes('"tokens"')) continue;
      for (const match of line.matchAll(tokenPattern)) {
        const hydrated = safeRead(() => JSON.parse(match[1] ?? "{}") as ChildTokenState);
        tokens = mergeTokenState(tokens, hydrated);
        if (hasTokenTotal(tokens)) return tokens;
      }
    }
  }
  return tokens;
}

function rehydrateDoneChildTokens(child: ChildSessionState): ChildTokenState | undefined {
  if (child.status !== "done") return undefined;
  if (hasTokenTotal(child.tokens)) return undefined;
  if (!child.id.startsWith("ses_")) return undefined;

  const nowMs = Date.now();
  const cached = doneTokenCache.get(child.id);
  if (cached?.tokens) return cached.tokens;
  if (
    cached &&
    cached.attempts >= DONE_TOKEN_REHYDRATE_MAX_ATTEMPTS
  ) {
    return undefined;
  }
  if (
    cached &&
    nowMs - cached.checkedAtMs < DONE_TOKEN_REHYDRATE_THROTTLE_MS
  ) {
    return undefined;
  }

  const tokens =
    readDoneTokensFromOpenCodeDb(child.id) ?? readDoneTokensFromOpenCodeLogs(child.id);
  doneTokenCache.set(child.id, {
    attempts: (cached?.attempts ?? 0) + 1,
    checkedAtMs: nowMs,
    tokens,
  });

  if (tokens) {
    debugLog({
      kind: "state.tokens.rehydrated.done",
      id: child.id,
      title: child.title,
      tokens,
    });
  }

  return tokens;
}

function safeRead<Value>(read: () => Value): Value | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

function messageIDOf(message: unknown): string | undefined {
  const record = asRecord(message);
  if (!record) return undefined;
  const id = record.id ?? record.messageID ?? record.messageId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function pushSessionCandidates(
  api: TuiPluginApi,
  sessionID: string | undefined,
  candidates: unknown[],
): void {
  if (!sessionID) return;

  const status = safeRead(() => api.state.session.status(sessionID));
  if (status) candidates.push(status);

  const messages = safeRead(() => api.state.session.messages(sessionID));
  if (!messages) return;

  candidates.push(messages);
  for (const message of messages) {
    const messageID = messageIDOf(message);
    if (!messageID) continue;
    const parts = safeRead(() => api.state.part(messageID));
    if (parts) candidates.push(parts);
  }
}

function hydrateChildTokensFromTuiState(
  api: TuiPluginApi,
  child: ChildSessionState,
): ChildTokenState | undefined {
  const candidates: unknown[] = [];

  pushSessionCandidates(api, child.id, candidates);

  if (child.messageID) {
    const parentParts = safeRead(() => api.state.part(child.messageID as string));
    if (parentParts) candidates.push(parentParts);

    const parentMessages = safeRead(() => api.state.session.messages(child.parentID));
    const parentMessage = parentMessages?.find(
      (message) => messageIDOf(message) === child.messageID,
    );
    if (parentMessage) candidates.push(parentMessage);
  }

  let tokens: ChildTokenState | undefined;
  for (const candidate of candidates) {
    tokens = mergeTokenState(
      tokens,
      extractChildDetails(candidate as Parameters<typeof extractChildDetails>[0]).tokens,
    );
  }

  tokens = mergeTokenState(tokens, rehydrateDoneChildTokens(child));

  return tokens;
}

function hydrateStateTokensFromTuiState(
  api: TuiPluginApi,
  state: StatuslineState,
): boolean {
  let changed = false;

  for (const child of Object.values(state.children)) {
    const hydrated = hydrateChildTokensFromTuiState(api, child);
    const nextTokens = mergeTokenState(child.tokens, hydrated);
    if (!sameTokens(child.tokens, nextTokens)) {
      child.tokens = nextTokens;
      child.updatedAt = new Date().toISOString();
      changed = true;
    }
  }

  if (changed) {
    state.updatedAt = new Date().toISOString();
    debugLog({
      kind: "state.tokens.hydrated",
      children: Object.values(state.children).map((child) => ({
        id: child.id,
        title: child.title,
        tokens: child.tokens,
      })),
    });
  }

  return changed;
}

function persistStateSnapshot(statePath: string, textPath: string, state: StatuslineState): void {
  const snapshot = cloneState(state);
  void (async () => {
    try {
      await saveState(statePath, snapshot);
      await writeFile(textPath, renderStatusLine(snapshot), "utf8");
    } catch {
      // Persistence is best-effort; TUI rendering must not fail because of files.
    }
  })();
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

function isGenericToolWrapper(child: ChildSessionState): boolean {
  if (child.source !== "tool") return false;
  const title = normalizeTitle(child.title);
  return title === "delegate" || title === "task";
}

function collapseToolWrappers(children: ChildSessionState[]): ChildSessionState[] {
  const realChildren = children.filter((child) => child.source !== "tool");
  return children.filter((child) => {
    if (child.source !== "tool") return true;
    if (
      isGenericToolWrapper(child) &&
      realChildren.some((real) => real.parentID === child.parentID)
    ) {
      return false;
    }
    return !realChildren.some(
      (real) =>
        real.parentID === child.parentID && relatedTitles(real.title, child.title),
    );
  });
}

function toFinitePositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const rounded = Math.floor(value);
  return rounded > 0 ? rounded : undefined;
}

function resolveSidebarWidth(ctx: unknown): number | undefined {
  const source = asRecord(ctx);
  if (!source) return undefined;

  const direct =
    toFinitePositiveInt(source.width) ??
    toFinitePositiveInt(source.columns) ??
    toFinitePositiveInt(source.cols);
  if (direct) return direct;

  const size = asRecord(source.size);
  const viewport = asRecord(source.viewport);
  const bounds = asRecord(source.bounds);

  return (
    toFinitePositiveInt(size?.width) ??
    toFinitePositiveInt(viewport?.width) ??
    toFinitePositiveInt(bounds?.width)
  );
}

function ellipsize(value: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (value.length <= maxChars) return value;
  if (maxChars <= 1) return "…";
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function splitParentheticalTitle(title: string): {
  label: string;
  parenthetical?: string;
} {
  const match = title.match(/^(.*?)\s*(\([^)]*\))\s*$/);
  if (!match) return { label: title };

  const label = match[1]?.trim();
  const parenthetical = match[2]?.trim();
  if (!label || !parenthetical) return { label: title };

  return { label, parenthetical };
}

function resolveTokenTotal(child: ChildSessionState): number | undefined {
  const total = child.tokens?.total;
  if (typeof total === "number" && Number.isFinite(total)) {
    return total;
  }
  const input = child.tokens?.input;
  const output = child.tokens?.output;
  if (typeof input === "number" || typeof output === "number") {
    return Math.max(0, (input ?? 0) + (output ?? 0));
  }
  return undefined;
}

function formatCompactTokenCount(total: number): string {
  const value = Math.max(0, total);
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M tok`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k tok`;
  return `${Math.round(value)} tok`;
}

function formatCompactPercent(percent: number): string {
  return `${Math.max(0, Math.round(percent))}%`;
}

function contextVariants(child: ChildSessionState): string[] {
  const total = resolveTokenTotal(child);
  const percent = child.tokens?.contextPercent;
  const hasTotal = typeof total === "number" && Number.isFinite(total);
  const hasPercent = typeof percent === "number" && Number.isFinite(percent);

  if (!hasTotal && !hasPercent) return [""];

  const tokenPart = hasTotal ? formatCompactTokenCount(total) : "";
  const percentPart = hasPercent ? formatCompactPercent(percent) : "";

  if (tokenPart && percentPart) {
    return [`${tokenPart} ${percentPart}`, percentPart, tokenPart, ""];
  }

  return [tokenPart || percentPart, ""];
}

function rowWidthBudget(sidebarWidth: number | undefined): number {
  const width = sidebarWidth ?? FALLBACK_SIDEBAR_WIDTH;
  return Math.max(MIN_ROW_WIDTH, Math.min(width, 120));
}

function formatChildRowLine(input: {
  child: ChildSessionState;
  nowMs: number;
  sidebarWidth?: number;
}): { label: string; parenthetical?: string; elapsed: string; meta: string } {
  const elapsed = formatDuration(elapsedMs(input.child, input.nowMs));
  const width = rowWidthBudget(input.sidebarWidth);
  const title = splitParentheticalTitle(input.child.title);

  for (const meta of contextVariants(input.child)) {
    const detailChars = 2 + elapsed.length + (meta ? 3 + meta.length : 0);
    const labelBudget = Math.min(width - 2, width - Math.max(0, detailChars - width));
    if (labelBudget >= MIN_LABEL_WIDTH || meta.length === 0) {
      return {
        label: ellipsize(title.label, Math.max(1, labelBudget)),
        parenthetical: title.parenthetical,
        elapsed,
        meta,
      };
    }
  }

  return {
    label: ellipsize(title.label, MIN_LABEL_WIDTH),
    parenthetical: title.parenthetical,
    elapsed,
    meta: "",
  };
}

function SidebarSubagents(props: {
  sessionID: string;
  state: () => StatuslineState;
  nowMs: () => number;
  sidebarWidth?: () => number | undefined;
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

  const ChildRow = (rowProps: { child: ChildSessionState }) => {
    const child = () => rowProps.child;
    const line = createMemo(() =>
      formatChildRowLine({
        child: child(),
        nowMs: props.nowMs(),
        sidebarWidth: props.sidebarWidth?.(),
      }),
    );

    return (
      <box flexDirection="column">
        <box flexDirection="row">
          <text fg={statusColor(child().status, props.theme)}>
            {statusIcon(child().status)}
          </text>
          <text fg={props.theme.text}>{` ${line().label}`}</text>
        </box>
        <Show when={line().parenthetical}>
          {(parenthetical: Accessor<string>) => (
            <text fg={props.theme.textMuted}>{`  ${parenthetical()}`}</text>
          )}
        </Show>
        <box flexDirection="row" paddingLeft={2}>
          <text fg={props.theme.textMuted}>{`${CLOCK_ICON} ${line().elapsed}`}</text>
          <Show when={line().meta.length > 0}>
            <text fg={props.theme.textMuted}>{` ${TOKEN_ICON} ${line().meta}`}</text>
          </Show>
        </box>
      </box>
    );
  };

  const AggregateBar = () => (
    <box flexDirection="row" paddingRight={1}>
      <text fg={props.theme.warning}>{`● ${counts().running} running`}</text>
      <text fg={props.theme.textMuted}> · </text>
      <text fg={props.theme.success}>{`✓ ${counts().done} done`}</text>
      <text fg={props.theme.textMuted}> · </text>
      <text fg={props.theme.error}>{`✕ ${counts().error} error`}</text>
    </box>
  );

  return (
    <box flexDirection="column">
      <text fg={props.theme.text}>Subagents</text>
      <AggregateBar />

      <box flexDirection="column">
        <For each={children()}>
          {(child: ChildSessionState) => <ChildRow child={child} />}
        </For>

        <Show when={children().length === 0 && otherChildren().length > 0}>
          <text fg={props.theme.textMuted}>Other sessions</text>
          <For each={otherChildren()}>
            {(child: ChildSessionState) => <ChildRow child={child} />}
          </For>
        </Show>
      </box>
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
      <box paddingLeft={1} paddingRight={1}>
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
  const statePath = resolveStatePath();
  const textPath = resolveTextPath(statePath);
  const [state, setState] = createSignal<StatuslineState>(createEmptyState());
  const [nowMs, setNowMs] = createSignal(Date.now());

  const tick = setInterval(() => {
    setNowMs(Date.now());
    setState((current: StatuslineState) => {
      const next = cloneState(current);
      if (!hydrateStateTokensFromTuiState(api, next)) return current;
      persistStateSnapshot(statePath, textPath, next);
      return next;
    });
  }, ELAPSED_TICK_MS);

  const applyEvent = (event: unknown): void => {
    debugEvent(event);
    setState((current: StatuslineState) => {
      const next = cloneState(current);
      const changed = applySubagentEvent(next, event);
      const hydrated = hydrateStateTokensFromTuiState(api, next);
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
      if (!changed && !hydrated) return current;
      persistStateSnapshot(statePath, textPath, next);
      return next;
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
      sidebar_content(ctx: SidebarContentContext) {
        const routeSessionID =
          api.route.current.name === "session" &&
          typeof api.route.current.params?.sessionID === "string"
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
            sidebarWidth={() => resolveSidebarWidth(ctx)}
            theme={ctx.theme.current}
          />
        );
      },
      home_bottom(ctx: HomeBottomContext) {
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
