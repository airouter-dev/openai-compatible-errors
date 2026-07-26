import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from "openai";
import { describe, expect, it } from "vitest";

import { normalizeOpenAICompatibleError } from "./normalize.js";

const syntheticOpenAIKey = (label: string): string =>
  ["sk", "test", label].join("-");

describe("OpenAI Node SDK integration", () => {
  it("normalizes a current SDK APIError without retaining its raw payload", () => {
    const sdkError = APIError.generate(
      429,
      {
        error: {
          message: `Too many requests for Bearer ${syntheticOpenAIKey("sdk-canary-12345")}`,
          type: "requests",
          code: "rate_limit_exceeded",
        },
      },
      undefined,
      new Headers({
        "retry-after": "3",
        "x-request-id": "req_current_openai_sdk",
      }),
    );

    expect(sdkError.requestID).toBe("req_current_openai_sdk");

    const normalized = normalizeOpenAICompatibleError(sdkError);
    const serialized = JSON.stringify(normalized);

    expect(normalized.source).toBe("openai_sdk");
    expect(normalized.category).toBe("rate_limit");
    expect(normalized.status).toBe(429);
    expect(normalized.retryAfterMs).toBe(3_000);
    expect(normalized.requestId).toBe("req_current_openai_sdk");
    expect(normalized.providerMessage).toBeUndefined();
    expect(serialized).not.toContain("sdk-canary");
    expect(serialized).not.toContain("headers");
    expect(serialized).not.toContain("stack");
  });

  it.each([
    [
      "connection error",
      new APIConnectionError({
        cause: new Error("transport-canary must not survive"),
      }),
      "network",
    ],
    ["connection timeout", new APIConnectionTimeoutError(), "timeout"],
    ["user abort", new APIUserAbortError(), "aborted"],
  ] as const)("classifies a current SDK %s", (_label, sdkError, category) => {
    const normalized = normalizeOpenAICompatibleError(sdkError);
    const serialized = JSON.stringify(normalized);

    expect(normalized.source).toBe("openai_sdk");
    expect(normalized.category).toBe(category);
    expect(normalized.providerMessage).toBeUndefined();
    expect(serialized).not.toContain("transport-canary");
    expect(serialized).not.toContain("cause");
    expect(serialized).not.toContain("stack");
  });
});
