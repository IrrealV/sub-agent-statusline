import type { ChildTokenState, StatuslineState } from "./state.js";
import { markChildStatus, upsertChildDetails, upsertRunningChild } from "./state.js";

export type EventLike = {
  type?: unknown;
  title?: unknown;
  name?: unknown;
  sessionID?: unknown;
  sessionId?: unknown;
  properties?: {
    id?: unknown;
    sessionID?: unknown;
    sessionId?: unknown;
    title?: unknown;
    name?: unknown;
    info?: {
      id?: unknown;
      title?: unknown;
      name?: unknown;
      sessionID?: unknown;
      sessionId?: unknown;
      parentID?: unknown;
      role?: unknown;
      time?: unknown;
    };
    part?: unknown;
  };
  [key: string]: unknown;
};

type SubtaskChild = {
  id: string;
  title: string;
  parentID: string;
  messageID: string;
};

type ToolChild = SubtaskChild & {
  status: "running" | "done" | "error";
};

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function extractCreatedChild(event: EventLike): {
  id: string;
  title: string;
  parentID: string;
} | null {
  const info = event.properties?.info;
  const parentID = asString(info?.parentID);
  if (!parentID) return null;

  const id = asString(info?.id) ?? asString(event.properties?.id);
  if (!id) return null;

  const title = asString(info?.title) ?? "subagent";
  return { id, title, parentID };
}

export function extractSessionID(event: EventLike): string | undefined {
  return (
    asString(event.properties?.info?.id) ??
    asString(event.properties?.id) ??
    asString(event.properties?.sessionID) ??
    asString(event.properties?.sessionId) ??
    asString(event.properties?.info?.sessionID) ??
    asString(event.properties?.info?.sessionId) ??
    asString(event.sessionID) ??
    asString(event.sessionId)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function extractSubtaskChild(event: EventLike): SubtaskChild | null {
  const part = event.properties?.part;
  if (!isRecord(part) || part.type !== "subtask") return null;

  const partID = asString(part.id);
  const parentID = asString(part.sessionID) ?? extractSessionID(event);
  const messageID = asString(part.messageID);
  if (!partID || !parentID || !messageID) return null;

  const description = asString(part.description);
  const command = asString(part.command);
  const agent = asString(part.agent);
  const title = description || command || agent || "subtask";

  return {
    id: `subtask:${partID}`,
    title,
    parentID,
    messageID,
  };
}

function extractToolChild(event: EventLike): ToolChild | null {
  const part = event.properties?.part;
  if (!isRecord(part) || part.type !== "tool") return null;

  const tool = asString(part.tool);
  if (tool !== "delegate" && tool !== "task") return null;

  const partID = asString(part.id);
  const parentID = asString(part.sessionID) ?? extractSessionID(event);
  const messageID = asString(part.messageID);
  const state = isRecord(part.state) ? part.state : undefined;
  if (!partID || !parentID || !messageID || !state) return null;

  const rawStatus = asString(state.status);
  const status =
    rawStatus === "completed"
      ? "done"
      : rawStatus === "error"
        ? "error"
        : "running";

  const input = isRecord(state.input) ? state.input : {};
  const description = asString(input.description);
  const subagentType = asString(input.subagent_type);
  const title = asString(state.title) || description || subagentType || tool;

  return {
    id: `tool:${partID}`,
    title,
    parentID,
    messageID,
    status,
  };
}

function extractCompletedAssistantMessage(event: EventLike): {
  sessionID: string;
  messageID: string;
} | null {
  const info = event.properties?.info;
  if (!isRecord(info)) return null;
  if (info.role !== "assistant") return null;

  const time = info.time;
  if (!isRecord(time) || typeof time.completed !== "number") return null;

  const sessionID = asString(info.sessionID) ?? extractSessionID(event);
  const messageID = asString(info.id);
  if (!sessionID || !messageID) return null;
  return { sessionID, messageID };
}

function normalizePercent(value: number): number {
  if (value > 0 && value <= 1) {
    return value * 100;
  }
  return value;
}

export function extractChildDetails(event: EventLike): {
  title?: string;
  tokens?: ChildTokenState;
} {
  const details: {
    title?: string;
    tokens?: ChildTokenState;
  } = {};

  const titleCandidates = [
    event.properties?.info?.title,
    event.properties?.title,
    event.properties?.info?.name,
    event.properties?.name,
    event.title,
    event.name,
  ];

  for (const candidate of titleCandidates) {
    const title = asString(candidate);
    if (title) {
      details.title = title;
      break;
    }
  }

  const tokenHints: ChildTokenState = {};
  const visited = new Set<object>();

  const walk = (node: unknown, depth: number): void => {
    if (!isRecord(node) || depth > 6) return;
    if (visited.has(node)) return;
    visited.add(node);

    for (const [rawKey, rawValue] of Object.entries(node)) {
      const key = rawKey.toLowerCase();
      const asNumber =
        typeof rawValue === "number"
          ? rawValue
          : typeof rawValue === "string" && rawValue.trim().length > 0
            ? Number(rawValue)
            : undefined;

      if (typeof asNumber === "number" && Number.isFinite(asNumber)) {
        if (key.includes("context") && key.includes("percent")) {
          tokenHints.contextPercent = normalizePercent(asNumber);
        } else if (key.includes("context") && key.includes("usage")) {
          tokenHints.contextPercent = normalizePercent(asNumber);
        } else if (
          (key.includes("input") || key.includes("prompt")) &&
          key.includes("token")
        ) {
          tokenHints.input = asNumber;
        } else if (
          (key.includes("output") || key.includes("completion")) &&
          key.includes("token")
        ) {
          tokenHints.output = asNumber;
        } else if (key.includes("total") && key.includes("token")) {
          tokenHints.total = asNumber;
        }
      }

      if (isRecord(rawValue)) {
        walk(rawValue, depth + 1);
      }
    }
  };

  walk(event, 0);

  if (
    tokenHints.input !== undefined ||
    tokenHints.output !== undefined ||
    tokenHints.total !== undefined ||
    tokenHints.contextPercent !== undefined
  ) {
    details.tokens = tokenHints;
  }

  return details;
}

export function applySubagentEvent(state: StatuslineState, event: unknown): boolean {
  const e = (event ?? {}) as EventLike;
  const type = asString(e.type);
  if (!type) return false;

  if (type === "session.created") {
    const child = extractCreatedChild(e);
    if (child) {
      return upsertRunningChild(state, child);
    }
    return false;
  }

  if (type === "session.idle") {
    const childID = extractSessionID(e);
    return childID ? markChildStatus(state, childID, "done") : false;
  }

  if (type === "session.error") {
    const childID = extractSessionID(e);
    return childID ? markChildStatus(state, childID, "error") : false;
  }

  if (type === "message.part.updated") {
    const subtask = extractSubtaskChild(e);
    if (subtask) {
      return upsertRunningChild(state, { ...subtask, source: "subtask" });
    }

    const tool = extractToolChild(e);
    if (tool) {
      const changed = upsertRunningChild(state, { ...tool, source: "tool" });
      if (tool.status === "done" || tool.status === "error") {
        return markChildStatus(state, tool.id, tool.status) || changed;
      }
      return changed;
    }
  }

  if (type === "message.updated") {
    const completed = extractCompletedAssistantMessage(e);
    if (completed) {
      let changed = false;
      for (const child of Object.values(state.children)) {
        if (
          child.source === "subtask" &&
          child.status === "running" &&
          child.parentID === completed.sessionID &&
          child.messageID === completed.messageID
        ) {
          changed = markChildStatus(state, child.id, "done") || changed;
        }
      }
      if (changed) return true;
    }
  }

  if (type === "message.updated" || type === "message.part.updated") {
    const childID = extractSessionID(e);
    if (childID && state.children[childID]) {
      const details = extractChildDetails(e);
      return upsertChildDetails(state, childID, details);
    }
  }

  return false;
}
