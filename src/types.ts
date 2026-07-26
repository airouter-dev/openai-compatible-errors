export type OpenAIErrorCategory =
  | "authentication"
  | "permission"
  | "rate_limit"
  | "quota"
  | "validation"
  | "not_found"
  | "payload_too_large"
  | "timeout"
  | "network"
  | "upstream"
  | "server"
  | "schema"
  | "endpoint"
  | "aborted"
  | "stream"
  | "unknown";

export type OpenAIErrorSource =
  | "http"
  | "fetch"
  | "openai_sdk"
  | "ai_sdk"
  | "sse"
  | "unknown";

export type HeaderValue = string | readonly string[] | undefined;

export type HeadersInput =
  | Headers
  | Readonly<Record<string, HeaderValue>>
  | ReadonlyArray<readonly [string, string]>
  | undefined;

export interface SafeOpenAIErrorSnapshot {
  readonly name: "OpenAICompatibleError";
  readonly message: string;
  readonly category: OpenAIErrorCategory;
  readonly source: OpenAIErrorSource;
  readonly status?: number;
  readonly code?: string;
  readonly type?: string;
  readonly requestId?: string;
  readonly retryAfterMs?: number;
  /** Only present after an explicit `includeProviderMessage: true` opt-in. */
  readonly providerMessage?: string;
}

export interface OpenAIErrorFields {
  readonly category: OpenAIErrorCategory;
  readonly source: OpenAIErrorSource;
  readonly status?: number;
  readonly code?: string;
  readonly type?: string;
  readonly requestId?: string;
  readonly retryAfterMs?: number;
  readonly providerMessage?: string;
}

export interface NormalizeOpenAIErrorOptions {
  readonly source?: OpenAIErrorSource;
  readonly status?: number;
  readonly headers?: HeadersInput;
  readonly body?: unknown;
  readonly includeProviderMessage?: boolean;
  readonly maxProviderMessageLength?: number;
  readonly now?: number | Date;
}

export interface NormalizeResponseOptions
  extends Omit<NormalizeOpenAIErrorOptions, "status" | "headers" | "body"> {
  readonly maxBodyBytes?: number;
  readonly readTimeoutMs?: number;
}

export interface NormalizeSSEOptions
  extends Omit<NormalizeOpenAIErrorOptions, "source" | "body" | "headers"> {
  readonly maxEventBytes?: number;
}

export interface SSEEventInput {
  readonly event?: string;
  readonly data: string | unknown;
}

export interface SSEInspectorOptions extends NormalizeSSEOptions {
  readonly maxBufferBytes?: number;
}

export interface SanitizeForLogsOptions {
  readonly maxDepth?: number;
  readonly maxArrayItems?: number;
  readonly maxObjectKeys?: number;
  readonly maxStringLength?: number;
  readonly maxNodes?: number;
}

export type RetryAction = "retry" | "do_not_retry" | "manual_decision";

export type RetryReason =
  | "transient_and_replay_safe"
  | "partial_stream_output"
  | "request_completed"
  | "replay_unsafe"
  | "caller_aborted"
  | "permanent_error"
  | "attempt_budget_exhausted"
  | "time_budget_exhausted"
  | "retry_after_exceeds_budget"
  | "unclassified_error"
  | "unknown_phase"
  | "unknown_replay_safety"
  | "invalid_context";

export type RequestPhase =
  | "before_send"
  | "awaiting_headers"
  | "http_error"
  | "sse_before_output"
  | "sse_after_output"
  | "completed"
  | "unknown";

export type ReplaySafety = "safe" | "unsafe" | "unknown";

export interface RetryContext {
  readonly method: string;
  readonly phase: RequestPhase;
  /** Caller-owned determination based on the operation contract. */
  readonly replaySafety: ReplaySafety;
  readonly hasStreamOutput?: boolean;
  /** One-based number of the attempt that just failed. */
  readonly attempt: number;
  readonly elapsedMs: number;
}

export interface RetryPolicy {
  readonly maxAttempts?: number;
  readonly maxElapsedMs?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly jitter?: "full" | "none";
  /** Injectable for deterministic tests. Must return a value in [0, 1]. */
  readonly random?: () => number;
}

export interface RetryPlan {
  readonly action: RetryAction;
  readonly reason: RetryReason;
  readonly delayMs?: number;
  readonly delaySource?: "server" | "backoff";
}

export interface StreamInspectionState {
  readonly eventsSeen: number;
  readonly malformedEvents: number;
  readonly hasOutput: boolean;
  readonly done: boolean;
  readonly unexpectedEof: boolean;
  readonly error?: import("./error.js").OpenAICompatibleError;
}
