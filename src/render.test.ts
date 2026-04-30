import { describe, expect, it } from "vitest";
import {
  collapseSubagentWorkItems,
  visibleSubagentWorkItems,
} from "./render.js";
import type { ChildSessionState } from "./state.js";

function makeChild(overrides: Partial<ChildSessionState> & Pick<ChildSessionState, "id" | "title">): ChildSessionState {
  return {
    id: overrides.id,
    title: overrides.title,
    parentID: overrides.parentID ?? "ses_parent",
    status: overrides.status ?? "running",
    color: overrides.color ?? "yellow",
    startedAt: overrides.startedAt ?? "2026-04-30T12:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-04-30T12:00:00.000Z",
    source: overrides.source,
    messageID: overrides.messageID,
    targetSessionID: overrides.targetSessionID,
    endedAt: overrides.endedAt,
    elapsedMs: overrides.elapsedMs,
    tokens: overrides.tokens,
    summary: overrides.summary,
    agentName: overrides.agentName,
  };
}

describe("collapseSubagentWorkItems", () => {
  it("keeps one grouped row and avoids duplicate wrappers", () => {
    const children: ChildSessionState[] = [
      makeChild({
        id: "tool:task-wrapper",
        title: "task",
        source: "tool",
        messageID: "msg_1",
      }),
      makeChild({
        id: "subtask:work_1",
        title: "Implement grouping assertions",
        source: "subtask",
        messageID: "msg_1",
        targetSessionID: "ses_child_1",
      }),
      makeChild({
        id: "ses_child_1",
        title: "Implement grouping assertions (coder)",
        source: "session",
        messageID: "msg_1",
        status: "done",
        color: "green",
        endedAt: "2026-04-30T12:10:00.000Z",
        updatedAt: "2026-04-30T12:10:00.000Z",
      }),
    ];

    const collapsed = collapseSubagentWorkItems(children);

    expect(collapsed.map((child) => child.id)).toEqual(["subtask:work_1"]);
    expect(collapsed[0]).toMatchObject({
      status: "done",
      color: "green",
      targetSessionID: "ses_child_1",
      endedAt: "2026-04-30T12:10:00.000Z",
    });
  });
});

describe("visibleSubagentWorkItems", () => {
  it("keeps active running work visible and deprioritizes unrelated done rows", () => {
    const nowMs = Date.parse("2026-04-30T12:15:00.000Z");
    const children: ChildSessionState[] = [
      makeChild({
        id: "subtask:active",
        title: "Long running active work",
        source: "subtask",
        messageID: "msg_active",
        status: "running",
      }),
      makeChild({
        id: "subtask:active-done",
        title: "Recent completion in active thread",
        source: "subtask",
        messageID: "msg_active",
        status: "done",
        color: "green",
        endedAt: "2026-04-30T12:14:00.000Z",
        updatedAt: "2026-04-30T12:14:00.000Z",
      }),
      makeChild({
        id: "subtask:historical",
        title: "Historical completion",
        source: "subtask",
        messageID: "msg_old",
        status: "done",
        color: "green",
        endedAt: "2026-04-30T12:14:00.000Z",
        updatedAt: "2026-04-30T12:14:00.000Z",
      }),
    ];

    const visible = visibleSubagentWorkItems(children, nowMs);

    expect(visible.map((child) => child.id)).toEqual([
      "subtask:active",
      "subtask:active-done",
    ]);
    expect(visible.some((child) => child.id === "subtask:historical")).toBe(false);
  });
});
