import { describe, expect, it } from "vitest";

import {
  normalizeOpenAICompatibleSSEEvent,
  OpenAICompatibleSSEInspector,
} from "./sse.js";

const syntheticOpenAIKey = (label: string): string =>
  ["sk", "test", label].join("-");

describe("normalizeOpenAICompatibleSSEEvent", () => {
  it("normalizes Chat Completions and Responses error events", () => {
    const chat = normalizeOpenAICompatibleSSEEvent({
      data: {
        error: {
          message: "Too many requests",
          code: "rate_limit_exceeded",
        },
      },
    });
    const responses = normalizeOpenAICompatibleSSEEvent({
      data: {
        type: "response.failed",
        response: {
          error: {
            message: "insufficient quota",
            code: "insufficient_quota",
          },
        },
      },
    });

    expect(chat?.category).toBe("rate_limit");
    expect(chat?.source).toBe("sse");
    expect(responses?.category).toBe("quota");
  });

  it("ignores normal deltas and [DONE]", () => {
    expect(
      normalizeOpenAICompatibleSSEEvent({
        data: { choices: [{ delta: { content: "hello" } }] },
      }),
    ).toBeNull();
    expect(normalizeOpenAICompatibleSSEEvent({ data: "[DONE]" })).toBeNull();
  });

  it("turns malformed JSON and oversized events into protocol errors", () => {
    expect(
      normalizeOpenAICompatibleSSEEvent({ data: '{"error":' })?.category,
    ).toBe("schema");
    expect(
      normalizeOpenAICompatibleSSEEvent(
        { data: `{"error":"${"x".repeat(100)}"}` },
        { maxEventBytes: 20 },
      )?.category,
    ).toBe("schema");
  });

  it("uses the safe default limit when maxEventBytes is NaN", () => {
    const oversized = JSON.stringify({
      error: { message: "x".repeat(100_000) },
    });
    expect(
      normalizeOpenAICompatibleSSEEvent(
        { data: oversized },
        { maxEventBytes: Number.NaN },
      )?.category,
    ).toBe("schema");
  });
});

describe("OpenAICompatibleSSEInspector", () => {
  it("handles arbitrarily split UTF-8 chunks and a normal [DONE]", () => {
    const inspector = new OpenAICompatibleSSEInspector();
    const bytes = new TextEncoder().encode(
      'data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: [DONE]\n\n',
    );
    inspector.push(bytes.subarray(0, 17));
    inspector.push(bytes.subarray(17, 38));
    inspector.push(bytes.subarray(38));
    const state = inspector.finish();

    expect(state.hasOutput).toBe(true);
    expect(state.done).toBe(true);
    expect(state.eventsSeen).toBe(2);
    expect(state.error).toBeUndefined();
    expect(state.unexpectedEof).toBe(false);
  });

  it("accepts an initial BOM and CR-only SSE line endings", () => {
    const inspector = new OpenAICompatibleSSEInspector();
    inspector.push(
      '\uFEFFdata: {"choices":[{"delta":{"content":"hello"}}]}\r\rdata: [DONE]\r\r',
    );
    const state = inspector.finish();

    expect(state.eventsSeen).toBe(2);
    expect(state.hasOutput).toBe(true);
    expect(state.done).toBe(true);
    expect(state.error).toBeUndefined();
  });

  it("records an SSE error without retaining its raw secret", () => {
    const inspector = new OpenAICompatibleSSEInspector({
      includeProviderMessage: true,
    });
    const event = JSON.stringify({
      error: {
        message: `Bearer ${syntheticOpenAIKey("streamsecret123")}`,
        code: "server_error",
      },
    });
    inspector.push(
      `event: error\ndata: ${event}\n\n`,
    );
    const state = inspector.finish();
    const serialized = JSON.stringify(state);

    expect(state.error).toBeDefined();
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).not.toContain("streamsecret");
  });

  it("preserves partial-output state when a later stream error arrives", () => {
    const inspector = new OpenAICompatibleSSEInspector();
    inspector.push(
      'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
    );
    inspector.push(
      'data: {"error":{"message":"upstream failed","code":"server_error"}}\n\n',
    );
    const state = inspector.finish();

    expect(state.hasOutput).toBe(true);
    expect(state.error).toBeDefined();
  });

  it("treats refusal output as a replay boundary", () => {
    const inspector = new OpenAICompatibleSSEInspector();
    inspector.push(
      'data: {"choices":[{"delta":{"refusal":"I cannot help with that"}}]}\n\n',
    );
    inspector.push(
      'data: {"error":{"message":"rate limit","code":"rate_limit_exceeded"}}\n\n',
    );
    const state = inspector.finish();

    expect(state.hasOutput).toBe(true);
    expect(state.error?.category).toBe("rate_limit");
  });

  it("treats structured content arrays as output", () => {
    const inspector = new OpenAICompatibleSSEInspector();
    inspector.push(
      'data: {"choices":[{"delta":{"content":[{"type":"output_text","text":"hello"}]}}]}\n\n',
    );
    expect(inspector.state.hasOutput).toBe(true);
  });

  it("reports an unexpected EOF when a stream never completes", () => {
    const inspector = new OpenAICompatibleSSEInspector();
    inspector.push('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n');
    const state = inspector.finish();

    expect(state.done).toBe(false);
    expect(state.unexpectedEof).toBe(true);
    expect(state.error?.category).toBe("stream");
  });

  it("counts malformed events without retaining their contents", () => {
    const inspector = new OpenAICompatibleSSEInspector();
    inspector.push('data: {"error":"CANARY-SECRET"\n\n');
    const state = inspector.finish();
    expect(state.malformedEvents).toBe(1);
    expect(state.error?.category).toBe("schema");
    expect(JSON.stringify(state)).not.toContain("CANARY-SECRET");
  });

  it("treats an empty stream as an unexpected EOF", () => {
    const state = new OpenAICompatibleSSEInspector().finish();
    expect(state.unexpectedEof).toBe(true);
    expect(state.error?.category).toBe("stream");
  });
});
