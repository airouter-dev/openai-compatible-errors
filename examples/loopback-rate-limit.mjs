import { once } from "node:events";
import { createServer } from "node:http";

import {
  decideOpenAICompatibleRetry,
  normalizeOpenAICompatibleResponse,
} from "@ai-router/openai-compatible-errors";

// A local fixture keeps the example deterministic and requires no API key.
const server = createServer((_request, response) => {
  response.writeHead(429, {
    "content-type": "application/json",
    "retry-after": "2",
    "x-request-id": "req_loopback_demo",
  });
  response.end(
    JSON.stringify({
      error: {
        type: "rate_limit_error",
        code: "rate_limit_exceeded",
        message: "Synthetic fixture; this text is excluded by default.",
      },
    }),
  );
});

server.listen(0, "127.0.0.1");
await once(server, "listening");

const address = server.address();
if (!address || typeof address === "string") {
  throw new Error("The loopback server did not expose a TCP port.");
}

try {
  const startedAt = Date.now();
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/demo`, {
    method: "POST",
  });
  const error = await normalizeOpenAICompatibleResponse(response);

  if (!error) {
    throw new Error("Expected the fixture to normalize into an API error.");
  }

  const context = {
    method: "POST",
    phase: "http_error",
    attempt: 1,
    elapsedMs: Date.now() - startedAt,
  };

  // Safe only because this synthetic endpoint has no side effects.
  const safePlan = decideOpenAICompatibleRetry(error, {
    ...context,
    replaySafety: "safe",
  });

  // A real generation POST is commonly ambiguous after it leaves the client.
  const unknownPlan = decideOpenAICompatibleRetry(error, {
    ...context,
    replaySafety: "unknown",
  });

  console.log(JSON.stringify({ error, safePlan, unknownPlan }, null, 2));
} finally {
  await new Promise((resolve, reject) => {
    server.close((closeError) => {
      if (closeError) reject(closeError);
      else resolve();
    });
  });
}
