import { describe, expect, it } from "vitest";

import { extractRequestId, getHeader, parseRetryAfterMs } from "./headers.js";

describe("header helpers", () => {
  it("reads native Headers and plain data properties case-insensitively", () => {
    expect(getHeader(new Headers({ "X-Request-ID": "req_native" }), "x-request-id"))
      .toBe("req_native");
    expect(getHeader({ "Retry-After": "2" }, "retry-after")).toBe("2");
    expect(getHeader([["X-Trace", "trace_1"]], "x-trace")).toBe("trace_1");
    expect(getHeader({ "x-list": ["a", "b"] }, "x-list")).toBe("a, b");
  });

  it("does not invoke header object getters", () => {
    let calls = 0;
    const headers = Object.create(null) as Record<string, string>;
    Object.defineProperty(headers, "x-request-id", {
      enumerable: true,
      get() {
        calls += 1;
        return "CANARY-PRIVATE";
      },
    });

    expect(getHeader(headers, "x-request-id")).toBeUndefined();
    expect(calls).toBe(0);
  });

  it("does not invoke tuple index getters", () => {
    let calls = 0;
    const pair: string[] = [];
    Object.defineProperty(pair, "1", {
      enumerable: true,
      get() {
        calls += 1;
        return "CANARY-PRIVATE";
      },
    });
    pair[0] = "x-request-id";
    pair.length = 2;

    expect(getHeader([pair as [string, string]], "x-request-id")).toBeUndefined();
    expect(calls).toBe(0);
  });

  it("ignores malformed tuples and Headers-like get methods", () => {
    let calls = 0;
    const headersLike = {
      get() {
        calls += 1;
        return { toString: () => "CANARY-PRIVATE" };
      },
    };
    const malformed = [[null, "1"]] as unknown as ReadonlyArray<
      readonly [string, string]
    >;

    expect(() => getHeader(malformed, "retry-after")).not.toThrow();
    expect(getHeader(malformed, "retry-after")).toBeUndefined();
    expect(
      getHeader(
        headersLike as unknown as Readonly<Record<string, string>>,
        "retry-after",
      ),
    ).toBeUndefined();
    expect(calls).toBe(0);
  });

  it("extracts request IDs in a stable priority order", () => {
    expect(
      extractRequestId({
        "cf-ray": "ray_1",
        "request-id": "req_secondary",
        "x-request-id": "req_primary",
      }),
    ).toBe("req_primary");
  });

  it("parses millisecond, second, and HTTP-date retry hints", () => {
    expect(parseRetryAfterMs({ "retry-after-ms": "1250" })).toBe(1_250);
    expect(parseRetryAfterMs({ "retry-after": "2" })).toBe(2_000);
    expect(
      parseRetryAfterMs(
        { "retry-after": "Sun, 26 Jul 2026 00:00:05 GMT" },
        { now: new Date("2026-07-26T00:00:00Z") },
      ),
    ).toBe(5_000);
  });

  it("rejects invalid or negative retry hints", () => {
    expect(parseRetryAfterMs({ "retry-after": "not-a-date" })).toBeUndefined();
    expect(parseRetryAfterMs({ "retry-after": "-2" })).toBeUndefined();
    expect(parseRetryAfterMs({ "retry-after": "" })).toBeUndefined();
    expect(
      parseRetryAfterMs(
        { "retry-after": "Sun, 26 Jul 2026 00:00:05 GMT" },
        { now: Number.NaN },
      ),
    ).toBeUndefined();
  });

  it("falls back to a valid standard header when retry-after-ms is invalid", () => {
    expect(
      parseRetryAfterMs({
        "retry-after-ms": "invalid",
        "retry-after": "3",
      }),
    ).toBe(3_000);
  });
});
