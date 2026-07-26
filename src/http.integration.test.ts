import { createServer, type Server } from "node:http";

import OpenAI, { APIError } from "openai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  normalizeOpenAICompatibleError,
  normalizeOpenAICompatibleResponse,
} from "./normalize.js";

describe("loopback HTTP integrations", () => {
  let server: Server;
  let origin: string;

  beforeAll(async () => {
    server = createServer((request, response) => {
      const requestId = request.url?.includes("chat/completions")
        ? "req_loopback_openai_sdk"
        : "req_loopback_fetch";

      response.writeHead(429, {
        "content-type": "application/json",
        "retry-after": "1",
        "x-request-id": requestId,
      });
      response.end(
        JSON.stringify({
          error: {
            message: "Synthetic loopback rate limit response",
            type: "requests",
            code: "rate_limit_exceeded",
          },
        }),
      );
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Loopback test server did not expose a TCP address");
    }
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("normalizes a raw Fetch response without consuming the original body", async () => {
    const response = await fetch(`${origin}/raw-fetch`);
    const normalized = await normalizeOpenAICompatibleResponse(response);

    expect(normalized?.source).toBe("http");
    expect(normalized?.category).toBe("rate_limit");
    expect(normalized?.requestId).toBe("req_loopback_fetch");
    expect(normalized?.retryAfterMs).toBe(1_000);
    expect(response.bodyUsed).toBe(false);
    expect(await response.json()).toMatchObject({
      error: { code: "rate_limit_exceeded" },
    });
  });

  it("normalizes an error caught from the current OpenAI Node SDK", async () => {
    const client = new OpenAI({
      apiKey: "synthetic-local-test-key",
      baseURL: `${origin}/v1`,
      maxRetries: 0,
    });

    let caught: unknown;
    try {
      await client.chat.completions.create({
        model: "synthetic-test-model",
        messages: [{ role: "user", content: "synthetic test prompt" }],
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(APIError);
    const normalized = normalizeOpenAICompatibleError(caught);
    const serialized = JSON.stringify(normalized);

    expect(normalized.source).toBe("openai_sdk");
    expect(normalized.category).toBe("rate_limit");
    expect(normalized.requestId).toBe("req_loopback_openai_sdk");
    expect(normalized.retryAfterMs).toBe(1_000);
    expect(normalized.providerMessage).toBeUndefined();
    expect(serialized).not.toContain("Synthetic loopback rate limit response");
    expect(serialized).not.toContain("synthetic test prompt");
  });
});
