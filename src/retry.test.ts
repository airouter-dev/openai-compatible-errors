import { describe, expect, it } from "vitest";

import { OpenAICompatibleError } from "./error.js";
import { decideOpenAICompatibleRetry } from "./retry.js";

function error(
  category: ConstructorParameters<typeof OpenAICompatibleError>[0]["category"],
  retryAfterMs?: number,
): OpenAICompatibleError {
  return new OpenAICompatibleError({
    category,
    source: "http",
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}

const safeContext = {
  method: "POST",
  phase: "http_error" as const,
  replaySafety: "safe" as const,
  attempt: 1,
  elapsedMs: 1_000,
};

describe("decideOpenAICompatibleRetry", () => {
  it("honors an accepted server Retry-After exactly", () => {
    expect(
      decideOpenAICompatibleRetry(error("rate_limit", 2_500), safeContext),
    ).toEqual({
      action: "retry",
      reason: "transient_and_replay_safe",
      delayMs: 2_500,
      delaySource: "server",
    });
  });

  it("never retries after partial stream output", () => {
    expect(
      decideOpenAICompatibleRetry(error("rate_limit", 100), {
        ...safeContext,
        phase: "sse_after_output",
        hasStreamOutput: true,
      }),
    ).toEqual({
      action: "do_not_retry",
      reason: "partial_stream_output",
    });
  });

  it("fails closed when replay safety is unknown", () => {
    expect(
      decideOpenAICompatibleRetry(error("network"), {
        ...safeContext,
        phase: "awaiting_headers",
        replaySafety: "unknown",
      }),
    ).toEqual({
      action: "manual_decision",
      reason: "unknown_replay_safety",
    });
  });

  it("does not retry a replay-unsafe operation", () => {
    expect(
      decideOpenAICompatibleRetry(error("server"), {
        ...safeContext,
        replaySafety: "unsafe",
      }),
    ).toEqual({ action: "do_not_retry", reason: "replay_unsafe" });
  });

  it("does not retry permanent failures or user aborts", () => {
    expect(decideOpenAICompatibleRetry(error("quota"), safeContext)).toEqual({
      action: "do_not_retry",
      reason: "permanent_error",
    });
    expect(decideOpenAICompatibleRetry(error("aborted"), safeContext)).toEqual({
      action: "do_not_retry",
      reason: "caller_aborted",
    });
  });

  it("does not retry a completed request", () => {
    expect(
      decideOpenAICompatibleRetry(error("server"), {
        ...safeContext,
        phase: "completed",
      }),
    ).toEqual({ action: "do_not_retry", reason: "request_completed" });
  });

  it("requires review for an unknown request phase", () => {
    expect(
      decideOpenAICompatibleRetry(error("server"), {
        ...safeContext,
        phase: "unknown",
      }),
    ).toEqual({ action: "manual_decision", reason: "unknown_phase" });
  });

  it("refuses to shorten Retry-After to fit a policy budget", () => {
    expect(
      decideOpenAICompatibleRetry(error("rate_limit", 86_400_000), safeContext),
    ).toEqual({
      action: "do_not_retry",
      reason: "retry_after_exceeds_budget",
    });
  });

  it("enforces attempt and elapsed-time budgets", () => {
    expect(
      decideOpenAICompatibleRetry(error("server"), {
        ...safeContext,
        attempt: 3,
      }),
    ).toEqual({
      action: "do_not_retry",
      reason: "attempt_budget_exhausted",
    });
    expect(
      decideOpenAICompatibleRetry(error("server"), {
        ...safeContext,
        elapsedMs: 30_000,
      }),
    ).toEqual({
      action: "do_not_retry",
      reason: "time_budget_exhausted",
    });
  });

  it("rejects a backoff that would exceed the remaining time budget", () => {
    expect(
      decideOpenAICompatibleRetry(
        error("server"),
        { ...safeContext, elapsedMs: 29_900 },
        { jitter: "none", baseDelayMs: 500 },
      ),
    ).toEqual({ action: "do_not_retry", reason: "time_budget_exhausted" });
  });

  it("computes deterministic capped exponential backoff", () => {
    expect(
      decideOpenAICompatibleRetry(
        error("server"),
        { ...safeContext, attempt: 2 },
        { jitter: "none", baseDelayMs: 500, maxDelayMs: 10_000 },
      ),
    ).toEqual({
      action: "retry",
      reason: "transient_and_replay_safe",
      delayMs: 1_000,
      delaySource: "backoff",
    });
  });

  it("supports deterministic full jitter and rejects an invalid RNG", () => {
    expect(
      decideOpenAICompatibleRetry(error("network"), safeContext, {
        random: () => 0.5,
      }),
    ).toMatchObject({ action: "retry", delayMs: 250 });
    expect(
      decideOpenAICompatibleRetry(error("network"), safeContext, {
        random: () => 2,
      }),
    ).toEqual({ action: "manual_decision", reason: "invalid_context" });
  });

  it("fails closed when a custom RNG throws", () => {
    expect(
      decideOpenAICompatibleRetry(error("network"), safeContext, {
        random: () => {
          throw new Error("broken entropy source");
        },
      }),
    ).toEqual({ action: "manual_decision", reason: "invalid_context" });
  });

  it("requires manual review for unclassified errors", () => {
    expect(decideOpenAICompatibleRetry(error("unknown"), safeContext)).toEqual({
      action: "manual_decision",
      reason: "unclassified_error",
    });
  });

  it("rejects invalid runtime context and mutated retry metadata", () => {
    expect(
      decideOpenAICompatibleRetry(error("server"), {
        ...safeContext,
        attempt: 0,
      }),
    ).toEqual({ action: "manual_decision", reason: "invalid_context" });

    const mutated = error("server");
    (mutated as unknown as { retryAfterMs: number }).retryAfterMs = -1;
    expect(decideOpenAICompatibleRetry(mutated, safeContext)).toEqual({
      action: "manual_decision",
      reason: "invalid_context",
    });
  });
});
