import type { Plugin } from "@opencode-ai/plugin";
import { writeFile } from "node:fs/promises";
import { applySubagentEvent } from "./events.js";
import { renderStatusLine } from "./render.js";
import {
  createEmptyState,
  loadState,
  resolveStatePath,
  resolveTextPath,
  saveState,
  shouldPreserveStateOnStartup,
} from "./state.js";

export const SubagentStatusline: Plugin = async () => {
  const statePath = resolveStatePath();
  const textPath = resolveTextPath(statePath);

  if (!shouldPreserveStateOnStartup()) {
    try {
      const emptyState = createEmptyState();
      await saveState(statePath, emptyState);
      await writeFile(textPath, renderStatusLine(emptyState), "utf8");
    } catch {
      // Defensive by design: initialization failure should not crash OpenCode startup.
    }
  }

  return {
    event: async ({ event }: { event?: unknown }) => {
      try {
        const state = await loadState(statePath);
        const changed = applySubagentEvent(state, event);

        if (changed) {
          await saveState(statePath, state);
          const line = renderStatusLine(state);
          await writeFile(textPath, line, "utf8");
        }
      } catch {
        // Defensive by design: plugin should never crash OpenCode on bad event shape.
      }
    },
  };
};
