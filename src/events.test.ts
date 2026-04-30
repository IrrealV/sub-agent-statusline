import { describe, expect, it } from "vitest";
import { applySubagentEvent, extractTaskToolEvidence } from "./events.js";
import { createEmptyState } from "./state.js";

function upsertSubtask(state: ReturnType<typeof createEmptyState>, input: {
  partID: string;
  parentID: string;
  messageID: string;
  description: string;
}) {
  applySubagentEvent(state, {
    type: "message.part.updated",
    properties: {
      sessionID: input.parentID,
      part: {
        type: "subtask",
        id: input.partID,
        sessionID: input.parentID,
        messageID: input.messageID,
        description: input.description,
      },
    },
  });
}

describe("extractTaskToolEvidence", () => {
  it("extracts task tool terminal status and metadata session id", () => {
    const evidence = extractTaskToolEvidence({
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          tool: "task",
          state: {
            status: "completed",
            metadata: { sessionId: "ses_child_1" },
            time: { end: "2026-04-30T12:00:00.000Z" },
          },
        },
      },
    });

    expect(evidence).toMatchObject({
      status: "done",
      targetSessionID: "ses_child_1",
      endedAt: "2026-04-30T12:00:00.000Z",
    });
  });

  it("falls back to parsing task_id from output", () => {
    const evidence = extractTaskToolEvidence({
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          tool: "task",
          state: {
            status: "error",
            output: "worker exited; task_id: ses_child_2",
            time: { end: "2026-04-30T12:05:00.000Z" },
          },
        },
      },
    });

    expect(evidence).toMatchObject({
      status: "error",
      targetSessionID: "ses_child_2",
      endedAt: "2026-04-30T12:05:00.000Z",
    });
  });
});

describe("task tool to subtask mapping", () => {
  it("maps completed task tool evidence to matching subtask row", () => {
    const state = createEmptyState();
    upsertSubtask(state, {
      partID: "sub_1",
      parentID: "ses_parent",
      messageID: "msg_1",
      description: "Initialize project",
    });

    applySubagentEvent(state, {
      type: "message.part.updated",
      properties: {
        sessionID: "ses_parent",
        part: {
          type: "tool",
          tool: "task",
          id: "tool_1",
          sessionID: "ses_parent",
          messageID: "msg_1",
          state: {
            status: "completed",
            input: { description: "Initialize project" },
            metadata: { sessionId: "ses_child_1" },
            time: { end: "2026-04-30T12:00:00.000Z" },
          },
        },
      },
    });

    expect(state.children["subtask:sub_1"]?.status).toBe("done");
    expect(state.children["subtask:sub_1"]?.targetSessionID).toBe("ses_child_1");
    expect(state.children["subtask:sub_1"]?.endedAt).toBe("2026-04-30T12:00:00.000Z");
  });

  it("fails closed for ambiguous mapping", () => {
    const state = createEmptyState();
    upsertSubtask(state, {
      partID: "sub_a",
      parentID: "ses_parent",
      messageID: "msg_1",
      description: "Run checks",
    });
    upsertSubtask(state, {
      partID: "sub_b",
      parentID: "ses_parent",
      messageID: "msg_1",
      description: "Run checks",
    });

    applySubagentEvent(state, {
      type: "message.part.updated",
      properties: {
        sessionID: "ses_parent",
        part: {
          type: "tool",
          tool: "task",
          id: "tool_2",
          sessionID: "ses_parent",
          messageID: "msg_1",
          state: {
            status: "completed",
            input: { description: "Run checks" },
            metadata: { sessionId: "ses_child_2" },
          },
        },
      },
    });

    expect(state.children["subtask:sub_a"]?.status).toBe("running");
    expect(state.children["subtask:sub_b"]?.status).toBe("running");
  });

  it("resolves legacy stale subtask row from parent task tool evidence", () => {
    const state = createEmptyState();
    upsertSubtask(state, {
      partID: "sub_legacy",
      parentID: "ses_parent",
      messageID: "msg_legacy",
      description: "sdd-init",
    });

    applySubagentEvent(state, {
      type: "message.part.updated",
      properties: {
        sessionID: "ses_parent",
        part: {
          type: "tool",
          tool: "task",
          id: "tool_legacy",
          sessionID: "ses_parent",
          messageID: "msg_legacy",
          state: {
            status: "error",
            input: { description: "sdd-init" },
            output: "task failed\ntask_id: ses_legacy_child",
            time: { end: "2026-04-30T12:10:00.000Z" },
          },
        },
      },
    });

    expect(state.children["subtask:sub_legacy"]?.status).toBe("error");
    expect(state.children["subtask:sub_legacy"]?.targetSessionID).toBe(
      "ses_legacy_child",
    );
    expect(state.children["subtask:sub_legacy"]?.endedAt).toBe(
      "2026-04-30T12:10:00.000Z",
    );
  });
});
