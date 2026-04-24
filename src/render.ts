import type { ChildSessionState, StatuslineState } from "./state.js";

const ansi = {
  reset: "\u001B[0m",
  gray: "\u001B[90m",
  green: "\u001B[32m",
  yellow: "\u001B[33m",
  red: "\u001B[31m",
};

function colorsEnabled(): boolean {
  if (process.env.NO_COLOR) return false;
  const fromEnv = process.env.OPENCODE_SUBAGENT_STATUSLINE_COLOR;
  if (fromEnv === "0") return false;
  return true;
}

function paint(text: string, color: string, enabled: boolean): string {
  if (!enabled) return text;
  return `${color}${text}${ansi.reset}`;
}

export function formatDuration(elapsedMs: number | undefined): string {
  const totalSeconds = Math.max(0, Math.floor((elapsedMs ?? 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function compactNumber(value: number): string {
  if (value >= 1000) {
    return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k`;
  }
  return String(Math.round(value));
}

export function formatContext(child: ChildSessionState): string {
  const percent = child.tokens?.contextPercent;
  if (typeof percent === "number" && Number.isFinite(percent)) {
    return `ctx ${percent.toFixed(1)}%`;
  }

  const total = child.tokens?.total;
  if (typeof total === "number" && Number.isFinite(total)) {
    return `ctx ${compactNumber(total)}`;
  }

  const inTokens = child.tokens?.input;
  const outTokens = child.tokens?.output;
  if (typeof inTokens === "number" || typeof outTokens === "number") {
    const computedTotal = (inTokens ?? 0) + (outTokens ?? 0);
    return `ctx ${compactNumber(computedTotal)}`;
  }

  return "ctx ?";
}

function childColor(child: ChildSessionState): string {
  if (child.color === "green") return ansi.green;
  if (child.color === "red") return ansi.red;
  return ansi.yellow;
}

export function byPriority(a: ChildSessionState, b: ChildSessionState): number {
  const rank = (status: ChildSessionState["status"]): number => {
    if (status === "running") return 0;
    if (status === "error") return 1;
    return 2;
  };

  const diff = rank(a.status) - rank(b.status);
  if (diff !== 0) return diff;
  return b.updatedAt.localeCompare(a.updatedAt);
}

export function renderStatusLine(state: StatuslineState): string {
  const children = Object.values(state.children).sort(byPriority);
  const running = children.filter((c) => c.status === "running").length;
  const done = children.filter((c) => c.status === "done").length;
  const error = children.filter((c) => c.status === "error").length;
  const colorOn = colorsEnabled();

  const aggregate = `↳ ${running} running · ${done} done · ${error} error`;
  if (children.length === 0) return aggregate;

  const details = children
    .map((child) => {
      const label = `${child.title} ${formatDuration(child.elapsedMs)} ${formatContext(child)}`;
      return paint(label, childColor(child), colorOn);
    })
    .join(paint(" · ", ansi.gray, colorOn));

  return `${aggregate} · ${details}`;
}
