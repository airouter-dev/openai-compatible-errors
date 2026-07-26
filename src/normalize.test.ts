import { describe, expect, it } from "vitest";

import {
  normalizeOpenAICompatibleError,
  normalizeOpenAICompatibleResponse,
} from "./normalize.js";
import { OpenAICompatibleError } from "./error.js";

const syntheticOpenAIKey = (label: string): string =>
  ["sk", "test", label].join("-");
const syntheticProjectKey = ["sk", "proj", "abcdefghijk123456789"].join("-");
const syntheticGitHubPat = ["github", "pat", "abcdefghijklmnopqrstuvwxyz"].join(
  "_",
);
const syntheticNpmToken = ["npm", "abcdefghijklmnopqrstuvwxyz123456"].join("_");

class APIError extends Error {
  readonly status = 429;
  readonly headers = new Headers({
    "retry-after": "3",
    "x-request-id": "req_openai_123",
  });
  readonly requestID = "req_openai_123";
  readonly error = {
    message: `Too many requests for Bearer ${syntheticOpenAIKey("neverlog12345")}`,
    type: "requests",
    code: "rate_limit_exceeded",
  };
}

class APICallError extends Error {
  readonly statusCode = 429;
  readonly responseHeaders = {
    "retry-after-ms": "2500",
    "request-id": "req_ai_sdk_456",
  };
  readonly responseBody = JSON.stringify({
    error: {
      message: "Your account has insufficient_quota. private prompt follows",
      type: "billing_error",
      code: "insufficient_quota",
    },
  });
  readonly isRetryable = false;
  readonly requestBodyValues = { messages: ["must never survive"] };
}

describe("normalizeOpenAICompatibleError", () => {
  it("normalizes an OpenAI SDK error without retaining its raw payload", () => {
    const normalized = normalizeOpenAICompatibleError(new APIError("raw secret"));
    const serialized = JSON.stringify(normalized);

    expect(normalized.source).toBe("openai_sdk");
    expect(normalized.category).toBe("rate_limit");
    expect(normalized.status).toBe(429);
    expect(normalized.retryAfterMs).toBe(3_000);
    expect(normalized.requestId).toBe("req_openai_123");
    expect(normalized.providerMessage).toBeUndefined();
    expect(serialized).not.toContain("neverlog");
    expect(serialized).not.toContain("raw secret");
    expect(serialized).not.toContain("headers");
    expect(serialized).not.toContain("stack");
  });

  it("distinguishes exhausted quota from a transient rate limit", () => {
    const normalized = normalizeOpenAICompatibleError(
      new APICallError("provider message"),
    );
    const serialized = JSON.stringify(normalized);

    expect(normalized.source).toBe("ai_sdk");
    expect(normalized.category).toBe("quota");
    expect(normalized.retryAfterMs).toBe(2_500);
    expect(normalized.requestId).toBe("req_ai_sdk_456");
    expect(serialized).not.toContain("private prompt");
    expect(serialized).not.toContain("must never survive");
    expect(serialized).not.toContain("responseBody");
  });

  it("only includes a redacted provider message after explicit opt-in", () => {
    const normalized = normalizeOpenAICompatibleError(new APIError("ignored"), {
      includeProviderMessage: true,
    });
    expect(normalized.providerMessage).toContain("[REDACTED]");
    expect(normalized.providerMessage).not.toContain("neverlog");
  });

  it("classifies abort and fetch transport failures separately", () => {
    const aborted = normalizeOpenAICompatibleError(
      new DOMException("The operation was aborted", "AbortError"),
    );
    const network = normalizeOpenAICompatibleError(new TypeError("fetch failed"));

    expect(aborted.category).toBe("aborted");
    expect(aborted.source).toBe("fetch");
    expect(network.category).toBe("network");
    expect(network.source).toBe("fetch");
  });

  it("uses a stable generic message for unknown input", () => {
    const normalized = normalizeOpenAICompatibleError({
      body: "gateway returned an undocumented response",
    });
    expect(normalized.category).toBe("unknown");
    expect(normalized.message).toBe("OpenAI-compatible API request failed");
    expect(normalized.providerMessage).toBeUndefined();
  });

  it("treats authoritative HTTP status as stronger than retry-like text", () => {
    const unauthorized = normalizeOpenAICompatibleError({
      status: 401,
      code: "rate_limit_exceeded",
      message: "rate limit",
    });
    const invalid = normalizeOpenAICompatibleError({
      status: 400,
      code: "timeout",
      message: "timed out",
    });

    expect(unauthorized.category).toBe("authentication");
    expect(invalid.category).toBe("validation");
  });

  it("does not let free-form provider text authorize a quota/rate classification", () => {
    const normalized = normalizeOpenAICompatibleError({
      status: 429,
      message: "insufficient quota",
    });
    expect(normalized.category).toBe("rate_limit");
  });

  it("omits free-form code, type, and request ID metadata", () => {
    const normalized = normalizeOpenAICompatibleError({
      status: 500,
      code: "private prompt CANARY",
      type: "person@example.com",
      request_id: "customer name CANARY",
    });
    const serialized = JSON.stringify(normalized);
    expect(normalized.code).toBeUndefined();
    expect(normalized.type).toBeUndefined();
    expect(normalized.requestId).toBeUndefined();
    expect(serialized).not.toContain("CANARY");
    expect(serialized).not.toContain("person@example.com");
  });

  it("omits credential-shaped identifier metadata", () => {
    const normalized = normalizeOpenAICompatibleError({
      status: 500,
      code: syntheticProjectKey,
      type: syntheticGitHubPat,
      request_id: syntheticNpmToken,
    });
    const serialized = JSON.stringify(normalized);
    expect(normalized.code).toBeUndefined();
    expect(normalized.type).toBeUndefined();
    expect(normalized.requestId).toBeUndefined();
    expect(serialized).not.toContain("abcdefghijk123456789");
    expect(serialized).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });

  it("keeps direct construction on the same allowlisted schema", () => {
    const direct = new OpenAICompatibleError({
      category: "server",
      source: "http",
      code: "private prompt CANARY",
      requestId: "person@example.com",
    });
    expect(direct.message).toBe("Server request failed");
    expect(direct.code).toBeUndefined();
    expect(direct.requestId).toBeUndefined();
    expect(JSON.stringify(direct)).not.toContain("CANARY");
  });

  it("does not invoke throwing getters on unknown objects", () => {
    let calls = 0;
    const input = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(input, "message", {
      enumerable: true,
      get() {
        calls += 1;
        throw new Error("do not call");
      },
    });
    expect(() => normalizeOpenAICompatibleError(input)).not.toThrow();
    expect(calls).toBe(0);
  });

  it("fails safely on a revoked proxy", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(() => normalizeOpenAICompatibleError(proxy)).not.toThrow();
    expect(normalizeOpenAICompatibleError(proxy).category).toBe("unknown");
  });

  it("bounds malicious prototype cycles", () => {
    const target = Object.create(null) as Record<string, unknown>;
    let proxy: object;
    proxy = new Proxy(target, {
      getPrototypeOf: () => proxy,
    });
    expect(() => normalizeOpenAICompatibleError(proxy)).not.toThrow();
    expect(normalizeOpenAICompatibleError(proxy).category).toBe("unknown");
  });
});

describe("normalizeOpenAICompatibleResponse", () => {
  it("reads a bounded clone and leaves the original response body untouched", async () => {
    const response = new Response(
      JSON.stringify({
        error: {
          message: `invalid key ${syntheticOpenAIKey("responsesecret")}`,
          type: "invalid_request_error",
          code: "invalid_api_key",
        },
      }),
      {
        status: 401,
        headers: { "x-request-id": "req_response_789" },
      },
    );

    const normalized = await normalizeOpenAICompatibleResponse(response);
    expect(normalized?.category).toBe("authentication");
    expect(normalized?.requestId).toBe("req_response_789");
    expect(response.bodyUsed).toBe(false);
    expect(JSON.stringify(normalized)).not.toContain("responsesecret");
    expect(await response.text()).toContain("invalid_api_key");
  });

  it("returns null for a successful response", async () => {
    const response = new Response('{"ok":true}', { status: 200 });
    await expect(normalizeOpenAICompatibleResponse(response)).resolves.toBeNull();
    expect(response.bodyUsed).toBe(false);
  });

  it("preserves a large Retry-After value for the policy to reject safely", async () => {
    const response = new Response('{"error":{"message":"rate limit"}}', {
      status: 429,
      headers: { "retry-after": "86400" },
    });
    const normalized = await normalizeOpenAICompatibleResponse(response);
    expect(normalized?.retryAfterMs).toBe(86_400_000);
  });

  it("parses an HTTP-date Retry-After using an injected clock", async () => {
    const now = new Date("2026-07-26T00:00:00.000Z");
    const response = new Response("rate limit", {
      status: 429,
      headers: { "retry-after": "Sun, 26 Jul 2026 00:00:05 GMT" },
    });
    const normalized = await normalizeOpenAICompatibleResponse(response, { now });
    expect(normalized?.retryAfterMs).toBe(5_000);
  });

  it("does not hang on a response body that never produces a chunk", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => undefined),
    });
    const response = new Response(body, { status: 500 });
    const startedAt = Date.now();

    const normalized = await normalizeOpenAICompatibleResponse(response, {
      readTimeoutMs: 20,
      maxBodyBytes: 10,
    });

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(normalized?.category).toBe("server");
  });
});
