import type { OpenAICompatibleError } from "./error.js";
import type {
  RetryContext,
  RetryPlan,
  RetryPolicy,
  RetryReason,
} from "./types.js";

const TRANSIENT_CATEGORIES = new Set([
  "rate_limit",
  "timeout",
  "network",
  "upstream",
  "server",
  "stream",
]);

const PERMANENT_CATEGORIES = new Set([
  "authentication",
  "permission",
  "quota",
  "validation",
  "not_found",
  "payload_too_large",
  "endpoint",
]);

function decision(
  action: RetryPlan["action"],
  reason: RetryReason,
  delay?: { readonly delayMs: number; readonly delaySource: "server" | "backoff" },
): RetryPlan {
  return delay === undefined ? { action, reason } : { action, reason, ...delay };
}

function isFiniteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function validateContext(context: RetryContext, policy: Required<RetryPolicy>): boolean {
  return (
    typeof context.method === "string" &&
    context.method.trim() !== "" &&
    isPositiveInteger(context.attempt) &&
    isFiniteNonNegative(context.elapsedMs) &&
    isPositiveInteger(policy.maxAttempts) &&
    isFiniteNonNegative(policy.maxElapsedMs) &&
    isFiniteNonNegative(policy.baseDelayMs) &&
    isFiniteNonNegative(policy.maxDelayMs) &&
    policy.baseDelayMs <= policy.maxDelayMs &&
    (policy.jitter === "full" || policy.jitter === "none") &&
    typeof policy.random === "function" &&
    (context.replaySafety === "safe" ||
      context.replaySafety === "unsafe" ||
      context.replaySafety === "unknown") &&
    (context.hasStreamOutput === undefined ||
      typeof context.hasStreamOutput === "boolean") &&
    [
      "before_send",
      "awaiting_headers",
      "http_error",
      "sse_before_output",
      "sse_after_output",
      "completed",
      "unknown",
    ].includes(context.phase)
  );
}

export function decideOpenAICompatibleRetry(
  error: OpenAICompatibleError,
  context: RetryContext,
  policyInput: RetryPolicy = {},
): RetryPlan {
  const policy: Required<RetryPolicy> = {
    maxAttempts: policyInput.maxAttempts ?? 3,
    maxElapsedMs: policyInput.maxElapsedMs ?? 30_000,
    baseDelayMs: policyInput.baseDelayMs ?? 500,
    maxDelayMs: policyInput.maxDelayMs ?? 10_000,
    jitter: policyInput.jitter ?? "full",
    random: policyInput.random ?? Math.random,
  };

  if (!validateContext(context, policy)) {
    return decision("manual_decision", "invalid_context");
  }
  if (
    error.retryAfterMs !== undefined &&
    !isFiniteNonNegative(error.retryAfterMs)
  ) {
    return decision("manual_decision", "invalid_context");
  }

  if (
    context.hasStreamOutput === true ||
    context.phase === "sse_after_output"
  ) {
    return decision("do_not_retry", "partial_stream_output");
  }
  if (context.phase === "completed") {
    return decision("do_not_retry", "request_completed");
  }
  if (error.category === "aborted") {
    return decision("do_not_retry", "caller_aborted");
  }
  if (PERMANENT_CATEGORIES.has(error.category)) {
    return decision("do_not_retry", "permanent_error");
  }
  if (context.replaySafety === "unsafe") {
    return decision("do_not_retry", "replay_unsafe");
  }
  if (context.phase === "unknown") {
    return decision("manual_decision", "unknown_phase");
  }
  if (context.replaySafety === "unknown") {
    return decision("manual_decision", "unknown_replay_safety");
  }
  if (!TRANSIENT_CATEGORIES.has(error.category)) {
    return decision("manual_decision", "unclassified_error");
  }
  if (context.attempt >= policy.maxAttempts) {
    return decision("do_not_retry", "attempt_budget_exhausted");
  }
  if (context.elapsedMs >= policy.maxElapsedMs) {
    return decision("do_not_retry", "time_budget_exhausted");
  }

  let delayMs: number;
  let delaySource: "server" | "backoff";
  if (error.retryAfterMs !== undefined) {
    delayMs = error.retryAfterMs;
    delaySource = "server";
    if (
      delayMs > policy.maxDelayMs ||
      context.elapsedMs + delayMs > policy.maxElapsedMs
    ) {
      return decision("do_not_retry", "retry_after_exceeds_budget");
    }
  } else {
    const exponent = Math.min(context.attempt - 1, 30);
    const cap = Math.min(policy.baseDelayMs * 2 ** exponent, policy.maxDelayMs);
    let randomValue: number;
    try {
      randomValue = policy.random();
    } catch {
      return decision("manual_decision", "invalid_context");
    }
    if (!Number.isFinite(randomValue) || randomValue < 0 || randomValue > 1) {
      return decision("manual_decision", "invalid_context");
    }
    delayMs = Math.round(policy.jitter === "none" ? cap : cap * randomValue);
    delaySource = "backoff";
    if (context.elapsedMs + delayMs > policy.maxElapsedMs) {
      return decision("do_not_retry", "time_budget_exhausted");
    }
  }

  return decision("retry", "transient_and_replay_safe", {
    delayMs,
    delaySource,
  });
}
