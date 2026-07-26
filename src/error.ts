import type {
  OpenAIErrorCategory,
  OpenAIErrorFields,
  OpenAIErrorSource,
  SafeOpenAIErrorSnapshot,
} from "./types.js";
import { redactSensitiveText } from "./redaction.js";

const DEFAULT_MESSAGES: Readonly<Record<OpenAIErrorCategory, string>> = {
  authentication: "Authentication failed",
  permission: "Permission denied",
  rate_limit: "Rate limit exceeded",
  quota: "Quota exhausted",
  validation: "Request validation failed",
  not_found: "Requested resource was not found",
  payload_too_large: "Request payload is too large",
  timeout: "Request timed out",
  network: "Network request failed",
  upstream: "Upstream service failed",
  server: "Server request failed",
  schema: "Response schema was invalid",
  endpoint: "API endpoint was not found",
  aborted: "Request was aborted",
  stream: "Response stream ended unexpectedly",
  unknown: "OpenAI-compatible API request failed",
};

const SOURCES = new Set<OpenAIErrorSource>([
  "http",
  "fetch",
  "openai_sdk",
  "ai_sdk",
  "sse",
  "unknown",
]);

function safeIdentifier(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (
    trimmed === "" ||
    trimmed.length > maxLength ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(trimmed)
  ) {
    return undefined;
  }
  if (redactSensitiveText(trimmed, maxLength) !== trimmed) return undefined;
  return trimmed;
}

export class OpenAICompatibleError extends Error {
  #brand = true;
  override readonly name = "OpenAICompatibleError";
  readonly category: OpenAIErrorCategory;
  readonly source: OpenAIErrorSource;
  readonly status: number | undefined;
  readonly code: string | undefined;
  readonly type: string | undefined;
  readonly requestId: string | undefined;
  readonly retryAfterMs: number | undefined;
  readonly providerMessage: string | undefined;

  constructor(fields: OpenAIErrorFields) {
    const category = Object.hasOwn(DEFAULT_MESSAGES, fields.category)
      ? fields.category
      : "unknown";
    super(DEFAULT_MESSAGES[category]);
    Object.setPrototypeOf(this, new.target.prototype);
    this.category = category;
    this.source = SOURCES.has(fields.source) ? fields.source : "unknown";
    this.status =
      typeof fields.status === "number" &&
      Number.isInteger(fields.status) &&
      fields.status >= 100 &&
      fields.status <= 599
        ? fields.status
        : undefined;
    this.code = safeIdentifier(fields.code, 200);
    this.type = safeIdentifier(fields.type, 200);
    this.requestId = safeIdentifier(fields.requestId, 300);
    this.retryAfterMs =
      typeof fields.retryAfterMs === "number" &&
      Number.isFinite(fields.retryAfterMs) &&
      fields.retryAfterMs >= 0
        ? fields.retryAfterMs
        : undefined;
    this.providerMessage =
      typeof fields.providerMessage === "string" &&
      fields.providerMessage.trim() !== ""
        ? redactSensitiveText(fields.providerMessage.trim(), 1_000)
        : undefined;
  }

  static is(value: unknown): value is OpenAICompatibleError {
    return (
      (typeof value === "object" && value !== null) || typeof value === "function"
    )
      ? #brand in value
      : false;
  }

  toJSON(): SafeOpenAIErrorSnapshot {
    const snapshot: {
      name: "OpenAICompatibleError";
      message: string;
      category: OpenAIErrorCategory;
      source: OpenAIErrorSource;
      status?: number;
      code?: string;
      type?: string;
      requestId?: string;
      retryAfterMs?: number;
      providerMessage?: string;
    } = {
      name: "OpenAICompatibleError",
      message: this.message,
      category: this.category,
      source: this.source,
    };

    if (this.status !== undefined) snapshot.status = this.status;
    if (this.code !== undefined) snapshot.code = this.code;
    if (this.type !== undefined) snapshot.type = this.type;
    if (this.requestId !== undefined) snapshot.requestId = this.requestId;
    if (this.retryAfterMs !== undefined) snapshot.retryAfterMs = this.retryAfterMs;
    if (this.providerMessage !== undefined) {
      snapshot.providerMessage = this.providerMessage;
    }

    return snapshot;
  }
}

export function isOpenAICompatibleError(
  value: unknown,
): value is OpenAICompatibleError {
  return OpenAICompatibleError.is(value);
}
