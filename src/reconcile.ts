export interface RunningReconcileCacheEntry {
  nextAllowedAtMs: number;
  backoffMs: number;
}

export type RunningReconcileEvidence = {
  status?: "running" | "done" | "error";
  endedAt?: string;
  checkedMessages?: boolean;
  sawRunningEvidence?: boolean;
  probeFailed?: boolean;
  canApplyStaleFallback?: boolean;
};

export function summarizeSessionMessages(messages: unknown[]): {
  completedAt?: string;
  evidenceAt?: string;
  hasError: boolean;
  latestAssistantActivityAt?: string;
  latestAssistantActivityAtMs?: number;
  latestMessageActivityAt?: string;
  latestMessageActivityAtMs?: number;
} {
  let completedAt: string | undefined;
  let evidenceAt: string | undefined;
  let hasError = false;
  let latestAssistantActivityAt: string | undefined;
  let latestAssistantActivityAtMs: number | undefined;
  let latestMessageActivityAt: string | undefined;
  let latestMessageActivityAtMs: number | undefined;
  const messageInfos = messages
    .map((rawMessage) => asRecord(rawMessage))
    .map((message) => asRecord(message?.info));

  for (const info of messageInfos) {
    if (!info) continue;
    const activityMs = messageTimeMillis(info);
    if (
      activityMs > 0 &&
      (latestMessageActivityAtMs === undefined ||
        activityMs > latestMessageActivityAtMs)
    ) {
      latestMessageActivityAtMs = activityMs;
      latestMessageActivityAt = new Date(activityMs).toISOString();
    }
  }

  const assistantMessages = messageInfos
    .filter(
      (info): info is Record<string, unknown> => info?.role === "assistant",
    )
    .sort((left, right) => messageTimeMillis(left) - messageTimeMillis(right));

  for (const info of assistantMessages) {
    const time = asRecord(info.time);
    const activityMs = messageTimeMillis(info);
    if (
      activityMs > 0 &&
      (latestAssistantActivityAtMs === undefined ||
        activityMs > latestAssistantActivityAtMs)
    ) {
      latestAssistantActivityAtMs = activityMs;
      latestAssistantActivityAt = new Date(activityMs).toISOString();
    }
    const candidate = timestampFromUnknown(time?.completed);
    const errorAt =
      timestampFromUnknown(time?.updated) ??
      timestampFromUnknown(time?.completed) ??
      timestampFromUnknown(time?.created);
    if (info.error) {
      hasError = true;
      evidenceAt = errorAt ?? evidenceAt;
    } else if (candidate) {
      completedAt = candidate;
      evidenceAt = candidate;
      hasError = false;
    }
  }

  return {
    completedAt,
    evidenceAt,
    hasError,
    latestAssistantActivityAt,
    latestAssistantActivityAtMs,
    latestMessageActivityAt,
    latestMessageActivityAtMs,
  };
}

export function hasRecentMessageActivity(input: {
  nowMs: number;
  latestMessageActivityAtMs?: number;
  staleThresholdMs: number;
}): boolean {
  return (
    input.latestMessageActivityAtMs !== undefined &&
    input.nowMs - input.latestMessageActivityAtMs < input.staleThresholdMs
  );
}

export function shouldApplyStaleRunningFallback(input: {
  staleThresholdMs: number;
  evidence: RunningReconcileEvidence;
  startedMs: number;
  updatedMs: number;
}): boolean {
  return (
    input.staleThresholdMs > 0 &&
    input.evidence.canApplyStaleFallback === true &&
    input.evidence.probeFailed !== true &&
    input.startedMs >= input.staleThresholdMs &&
    input.updatedMs >= input.staleThresholdMs
  );
}

export function shouldSkipCandidateForBackoff(
  cache: RunningReconcileCacheEntry | undefined,
  nowMs: number,
): boolean {
  return cache !== undefined && nowMs < cache.nextAllowedAtMs;
}

export function nextBackoffState(input: {
  cache: RunningReconcileCacheEntry | undefined;
  nowMs: number;
  initialBackoffMs: number;
  maxBackoffMs: number;
}): RunningReconcileCacheEntry {
  const nextBackoffMs = input.cache
    ? Math.min(
        input.maxBackoffMs,
        Math.max(input.initialBackoffMs, input.cache.backoffMs * 2),
      )
    : input.initialBackoffMs;
  return {
    backoffMs: nextBackoffMs,
    nextAllowedAtMs: input.nowMs + nextBackoffMs,
  };
}

export function capCandidates<T>(candidates: T[], maxCandidates: number): T[] {
  if (maxCandidates <= 0) return [];
  return candidates.length <= maxCandidates
    ? candidates
    : candidates.slice(0, maxCandidates);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function messageTimeMillis(info: Record<string, unknown> | undefined): number {
  const time = asRecord(info?.time);
  return (
    timestampMillisFromUnknown(time?.completed) ??
    timestampMillisFromUnknown(time?.updated) ??
    timestampMillisFromUnknown(time?.created) ??
    0
  );
}

function timestampFromUnknown(value: unknown): string | undefined {
  const millis = timestampMillisFromUnknown(value);
  return millis === undefined ? undefined : new Date(millis).toISOString();
}

function timestampMillisFromUnknown(value: unknown): number | undefined {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const millis = value < 10_000_000_000 ? value * 1000 : value;
    const parsed = new Date(millis);
    return Number.isNaN(parsed.getTime()) ? undefined : millis;
  }
  return undefined;
}
