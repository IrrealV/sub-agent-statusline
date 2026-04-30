import { describe, expect, it } from "vitest";
import {
  capCandidates,
  hasRecentMessageActivity,
  nextBackoffState,
  shouldApplyStaleRunningFallback,
  shouldSkipCandidateForBackoff,
  summarizeSessionMessages,
  type RunningReconcileEvidence,
} from "./reconcile.js";

describe("reconcile fail-closed fallback gating", () => {
  it("does not allow stale fallback when probes fail or are inconclusive", () => {
    const staleThresholdMs = 24 * 60 * 60_000;
    const ages = { startedMs: staleThresholdMs + 1, updatedMs: staleThresholdMs + 1 };

    const probeFailed: RunningReconcileEvidence = {
      probeFailed: true,
      canApplyStaleFallback: false,
    };
    expect(
      shouldApplyStaleRunningFallback({
        staleThresholdMs,
        evidence: probeFailed,
        ...ages,
      }),
    ).toBe(false);

    const inconclusive: RunningReconcileEvidence = {
      probeFailed: false,
      canApplyStaleFallback: false,
    };
    expect(
      shouldApplyStaleRunningFallback({
        staleThresholdMs,
        evidence: inconclusive,
        ...ages,
      }),
    ).toBe(false);
  });
});

describe("recent activity across roles", () => {
  it("treats non-assistant message activity as recent activity", () => {
    const nowMs = Date.now();
    const activityAt = new Date(nowMs - 1_000).toISOString();
    const summary = summarizeSessionMessages([
      { info: { role: "user", time: { updated: activityAt } } },
      { info: { role: "tool", time: { created: activityAt } } },
    ]);

    expect(summary.latestAssistantActivityAtMs).toBeUndefined();
    expect(summary.latestMessageActivityAtMs).toBeDefined();
    expect(
      hasRecentMessageActivity({
        nowMs,
        latestMessageActivityAtMs: summary.latestMessageActivityAtMs,
        staleThresholdMs: 60_000,
      }),
    ).toBe(true);
  });
});

describe("terminal positive evidence", () => {
  it("marks done for assistant completed and error for assistant error", () => {
    const doneAt = new Date().toISOString();
    const doneSummary = summarizeSessionMessages([
      { info: { role: "assistant", time: { completed: doneAt } } },
    ]);
    expect(doneSummary.completedAt).toBe(doneAt);
    expect(doneSummary.hasError).toBe(false);

    const errorAt = new Date(Date.now() + 1_000).toISOString();
    const errorSummary = summarizeSessionMessages([
      { info: { role: "assistant", error: { message: "boom" }, time: { updated: errorAt } } },
    ]);
    expect(errorSummary.hasError).toBe(true);
    expect(errorSummary.evidenceAt).toBe(errorAt);
  });
});

describe("stale fallback thresholds", () => {
  it("applies fallback only after threshold and only when probes succeeded", () => {
    const staleThresholdMs = 10_000;
    const succeeded: RunningReconcileEvidence = {
      probeFailed: false,
      canApplyStaleFallback: true,
    };
    expect(
      shouldApplyStaleRunningFallback({
        staleThresholdMs,
        evidence: succeeded,
        startedMs: staleThresholdMs,
        updatedMs: staleThresholdMs,
      }),
    ).toBe(true);

    expect(
      shouldApplyStaleRunningFallback({
        staleThresholdMs,
        evidence: succeeded,
        startedMs: staleThresholdMs - 1,
        updatedMs: staleThresholdMs,
      }),
    ).toBe(false);
  });
});

describe("candidate cap and backoff", () => {
  it("caps candidates and exponentially backs off unresolved probes", () => {
    expect(capCandidates([1, 2, 3, 4], 2)).toEqual([1, 2]);

    const nowMs = Date.now();
    const initial = nextBackoffState({
      cache: undefined,
      nowMs,
      initialBackoffMs: 15_000,
      maxBackoffMs: 300_000,
    });
    expect(initial.backoffMs).toBe(15_000);
    expect(shouldSkipCandidateForBackoff(initial, nowMs + 1)).toBe(true);

    const doubled = nextBackoffState({
      cache: initial,
      nowMs,
      initialBackoffMs: 15_000,
      maxBackoffMs: 300_000,
    });
    expect(doubled.backoffMs).toBe(30_000);
  });
});
