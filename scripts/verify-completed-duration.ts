import {
  createEmptyState,
  markChildStatus,
  upsertRunningChild,
} from "../src/state.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const parentID = "parent-1";
const toolID = "tool:tool-1";
const startedAt = "2026-04-24T01:00:00.000Z";
const endedAt = "2026-04-24T01:01:06.000Z";

const state = createEmptyState();

assert(
  upsertRunningChild(state, {
    id: toolID,
    title: "sync subagent",
    parentID,
    source: "tool",
    startedAt,
    updatedAt: startedAt,
  }),
  "running upsert should change state",
);

assert(markChildStatus(state, toolID, "done", endedAt), "completion should change state");

const child = state.children[toolID];
assert(child, "tool child should exist");
assert(child.status === "done", "tool child should be done");
assert(child.elapsedMs === 66_000, `expected elapsedMs=66000, got ${child.elapsedMs}`);

console.log("ok: completed child keeps real elapsedMs", {
  status: child.status,
  elapsedMs: child.elapsedMs,
  startedAt: child.startedAt,
  endedAt: child.endedAt,
});
