import { describe, expect, it } from "vitest";

import { redactSensitiveText, sanitizeForLogs } from "./redaction.js";

const syntheticOpenAIKey = (label: string): string =>
  ["sk", "test", label].join("-");
const syntheticNpmToken = ["npm", "abcdefghijklmnopqrstuvwxyz123456"].join("_");

describe("redactSensitiveText", () => {
  it("redacts credential shapes in free text and URLs", () => {
    const value = [
      `Authorization: Bearer ${syntheticOpenAIKey("abcdef1234567890")}`,
      `npm_token=${syntheticNpmToken}`,
      "https://alice:secret@example.com/v1?api_key=top-secret&model=x",
      "eyJabcdefghijk.abcdefghijklmnop.abcdefghijklmnop",
    ].join(" ");

    const result = redactSensitiveText(value);
    expect(result).not.toContain("abcdef1234567890");
    expect(result).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
    expect(result).not.toContain("alice:secret");
    expect(result).not.toContain("top-secret");
    expect(result).not.toContain("eyJabcdefghijk");
    expect(result).toContain("[REDACTED]");
  });

  it("omits an oversized string instead of keeping a potentially secret prefix", () => {
    const result = redactSensitiveText(`CANARY-${"x".repeat(200)}`, 40);
    expect(result).toBe("[String omitted: 207 chars]");
    expect(result).not.toContain("CANARY");
  });
});

describe("sanitizeForLogs", () => {
  it("redacts sensitive keys recursively without calling getters", () => {
    let getterCalls = 0;
    const input: Record<string, unknown> = {
      headers: {
        Authorization: `Bearer ${syntheticOpenAIKey("supersecret123")}`,
        "x-request-id": "req_123",
      },
      openaiApiKey: syntheticOpenAIKey("supersecret456"),
      messages: [{ role: "user", content: "private prompt" }],
      nested: { refresh_token: "refresh-secret" },
    };
    Object.defineProperty(input, "danger", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("must not run");
      },
    });
    input.circular = input;

    const result = sanitizeForLogs(input);
    const serialized = JSON.stringify(result);

    expect(getterCalls).toBe(0);
    expect(serialized).toContain("req_123");
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).toContain("[Getter]");
    expect(serialized).toContain("[Circular]");
    expect(serialized).not.toContain("supersecret");
    expect(serialized).not.toContain("private prompt");
    expect(serialized).not.toContain("refresh-secret");
  });

  it("never throws on a revoked proxy", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(() => sanitizeForLogs(proxy)).not.toThrow();
    expect(sanitizeForLogs(proxy)).toBe("[Uninspectable object]");
  });

  it("bounds malicious prototype cycles", () => {
    const target = Object.create(null);
    let proxy: object;
    proxy = new Proxy(target, {
      getPrototypeOf: () => proxy,
    });
    expect(() => sanitizeForLogs(proxy)).not.toThrow();
    expect(JSON.stringify(sanitizeForLogs(proxy))).toBe("{}");
  });

  it("does not invoke array index getters", () => {
    let getterCalls = 0;
    const input: unknown[] = [];
    Object.defineProperty(input, "0", {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        return "CANARY-PRIVATE";
      },
    });
    input.length = 1;

    const serialized = JSON.stringify(sanitizeForLogs(input));
    expect(getterCalls).toBe(0);
    expect(serialized).toContain("[Getter]");
    expect(serialized).not.toContain("CANARY-PRIVATE");
  });

  it("does not surface non-enumerable fields from generic objects", () => {
    const input = {};
    Object.defineProperty(input, "internal", {
      enumerable: false,
      value: "CANARY-PRIVATE",
    });
    expect(JSON.stringify(sanitizeForLogs(input))).toBe("{}");
  });

  it("honors depth, item, key, and node limits", () => {
    const input = {
      deep: { a: { b: { c: "hidden" } } },
      list: [1, 2, 3, 4],
      extraA: true,
      extraB: true,
    };
    const result = sanitizeForLogs(input, {
      maxDepth: 2,
      maxArrayItems: 2,
      maxObjectKeys: 2,
      maxNodes: 10,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).toContain("Depth limit reached");
    expect(serialized).toContain("truncatedKeys");
  });

  it("sanitizes URL credentials and structured Error metadata", () => {
    const url = new URL(
      "https://alice:secret@example.com/v1?access_token=private-token",
    );
    const error = new Error(
      `Bearer ${syntheticOpenAIKey("errorsecret123")}`,
    ) as Error & {
      code: string;
      status: number;
    };
    error.code = syntheticNpmToken;
    error.status = 503;

    const serialized = JSON.stringify(sanitizeForLogs({ url, error }));
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).toContain("503");
    expect(serialized).not.toContain("alice:secret");
    expect(serialized).not.toContain("private-token");
    expect(serialized).not.toContain("errorsecret");
    expect(serialized).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
  });

  it("represents sparse array entries without reading through the prototype", () => {
    const input = new Array<unknown>(2);
    input[1] = "safe";
    expect(sanitizeForLogs(input)).toEqual(["[Empty item]", "safe"]);
  });

  it("fails safely when object descriptor inspection throws", () => {
    const proxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("blocked");
        },
      },
    );
    expect(sanitizeForLogs(proxy)).toBe("[Uninspectable object]");
  });

  it("serializes a broad deterministic corpus without throwing", () => {
    const corpus: unknown[] = [
      null,
      undefined,
      true,
      1,
      1n,
      Symbol("x"),
      () => undefined,
      new Date("2026-01-01T00:00:00Z"),
      new Uint8Array([1, 2, 3]),
      new Error(`Bearer ${syntheticOpenAIKey("corpussecret")}`),
      new Map([["token", "secret"]]),
      new Set([1, 2]),
    ];
    for (let index = 0; index < 1_000; index += 1) {
      corpus.push({ index, nested: [index, { api_key: `secret-${index}` }] });
    }

    for (const value of corpus) {
      expect(() => JSON.stringify(sanitizeForLogs(value))).not.toThrow();
    }
    expect(JSON.stringify(sanitizeForLogs(corpus))).not.toContain("corpussecret");
  });
});
