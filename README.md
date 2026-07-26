# @airouter-dev/openai-compatible-errors

[![CI](https://github.com/airouter-dev/openai-compatible-errors/actions/workflows/ci.yml/badge.svg)](https://github.com/airouter-dev/openai-compatible-errors/actions/workflows/ci.yml)

Typed, safe-by-default error normalization and stream-aware retry decisions for OpenAI-compatible APIs.

This is not an API client. It does not send requests, log data, sleep, or retry automatically. It turns HTTP, SDK-style, Fetch, and SSE failures into a small error object, then helps the caller decide whether replay is safe.

## Install

```bash
npm install @airouter-dev/openai-compatible-errors
```

Node.js 18.18 or newer is required. Both ESM and CommonJS entry points include TypeScript declarations.

## Quick start

```ts
import {
  decideOpenAICompatibleRetry,
  normalizeOpenAICompatibleResponse,
} from "@airouter-dev/openai-compatible-errors";

const startedAt = Date.now();
const response = await fetch(`${baseURL}/v1/chat/completions`, requestInit);
const apiError = await normalizeOpenAICompatibleResponse(response);

if (apiError) {
  console.warn(JSON.stringify(apiError));

  const plan = decideOpenAICompatibleRetry(apiError, {
    method: "POST",
    phase: "http_error",
    // Use "safe" only when your endpoint contract guarantees safe replay.
    replaySafety: "unknown",
    attempt: 1,
    elapsedMs: Date.now() - startedAt,
  });

  // plan.action is "manual_decision" here. The library fails closed because
  // a generation POST can be accepted or billed before the connection fails.
  console.log(plan);
}
```

For a 429 response with a two-second `Retry-After`, the normalized error is safe to serialize:

```json
{
  "name": "OpenAICompatibleError",
  "message": "Rate limit exceeded",
  "category": "rate_limit",
  "source": "http",
  "status": 429,
  "requestId": "req_123",
  "retryAfterMs": 2000
}
```

The original body, complete headers, prompt, response content, cause, and stack are not stored on this object.

## When this package helps

Use it when one application talks to multiple OpenAI-compatible endpoints or mixes raw Fetch, OpenAI SDK-style errors, AI SDK-style errors, and SSE streams. It gives those paths one conservative error and retry contract.

Do not add it when a single SDK already gives your application all the error handling it needs. The official OpenAI Node SDK has its own typed errors and retry behavior. [`llm-errors`](https://www.npmjs.com/package/llm-errors) is broader when you need one taxonomy across OpenAI, Anthropic, and Gemini. AI SDK provider authors can often use [`@ai-sdk/provider-utils`](https://www.npmjs.com/package/@ai-sdk/provider-utils) directly.

This package is deliberately narrower: it focuses on safe diagnostics and the replay boundary around OpenAI-compatible streaming responses.

## Default-safe errors

`normalizeOpenAICompatibleError(error)` accepts an unknown thrown value. `normalizeOpenAICompatibleResponse(response)` reads a bounded clone of a non-2xx `Response`, leaving the original body untouched. The clone read defaults to 64 KiB and a two-second deadline; both are configurable.

Provider messages are excluded by default because a gateway can echo credentials, prompts, or response fragments into an error message. To include a credential-redacted provider message, opt in explicitly:

```ts
const error = normalizeOpenAICompatibleError(caught, {
  includeProviderMessage: true,
  maxProviderMessageLength: 1_000,
});

console.log(error.providerMessage);
```

Opt-in redaction is not PII anonymization. Do not treat arbitrary provider text as safe for public logs.

### Categories

| Category | Typical evidence | Default retry classification |
| --- | --- | --- |
| `authentication` | 401, invalid API key | Permanent |
| `permission` | 403, access denied | Permanent |
| `rate_limit` | 429, rate-limit code | Transient |
| `quota` | insufficient quota, billing/credit signal | Permanent |
| `validation` | 400/409/422 | Permanent |
| `not_found` | missing model, deployment, or resource | Permanent |
| `endpoint` | unknown 404 endpoint | Permanent |
| `payload_too_large` | 413 | Permanent |
| `timeout` | 408 or timeout signal | Transient |
| `network` | Fetch/network transport failure | Transient |
| `upstream` | 502/503/504 | Transient |
| `server` | other 5xx | Transient |
| `schema` | malformed JSON or SSE protocol | Manual decision |
| `stream` | incomplete SSE stream | Transient only if replay is safe |
| `aborted` | caller abort/cancel | Never retry |
| `unknown` | insufficient evidence | Manual decision |

Classification uses status, structured `code`/`type`, and a bounded provider message only as input. The default returned message is package-owned text.

### Request IDs and retry hints

Request IDs are selected in this order: SDK-style `requestID`, `request_id`, or `requestId`, then `x-request-id`, `request-id`, `x-correlation-id`, and `cf-ray`. `Retry-After` supports delay-seconds and HTTP-date values; `retry-after-ms` is also recognized.

The package does not normalize provider-specific rate-limit counters such as arbitrary `x-ratelimit-limit`, `remaining`, or `reset` headers. Keep those in a separate, explicitly allowlisted metrics path when needed.

## Stream-aware retry decisions

A boolean `retryable` flag is not enough for generation requests. A transient error can still be unsafe to replay after tokens or tool-call arguments were emitted.

```ts
const plan = decideOpenAICompatibleRetry(error, {
  method: "POST",
  phase: streamState.hasOutput
    ? "sse_after_output"
    : "sse_before_output",
  replaySafety: endpointGuaranteesReplay ? "safe" : "unknown",
  attempt: 2,
  elapsedMs: 4_200,
});
```

The result has one of three actions:

| Action | Meaning |
| --- | --- |
| `retry` | Transient error, replay explicitly marked safe, no partial output, and budgets allow it |
| `do_not_retry` | Permanent error, abort, partial output, unsafe replay, or exhausted budget |
| `manual_decision` | Error, phase, replay safety, or runtime context is not sufficiently known |

Only `action === "retry"` authorizes an automated caller to retry. The function never performs that retry.

`Retry-After` is honored without shortening it. If the server's delay exceeds `maxDelayMs` or the remaining elapsed-time budget, the result is `do_not_retry` with `retry_after_exceeds_budget`.

```ts
const plan = decideOpenAICompatibleRetry(error, context, {
  maxAttempts: 3,      // Includes the first request.
  maxElapsedMs: 30_000,
  baseDelayMs: 500,
  maxDelayMs: 10_000,
  jitter: "full",
});
```

An idempotency key alone does not prove safe replay. The caller owns `replaySafety` because only the endpoint contract and operation semantics can establish it.

## Inspect an SSE stream

`OpenAICompatibleSSEInspector` accepts arbitrary string or `Uint8Array` chunks. It tracks output without retaining event payloads.

```ts
import { OpenAICompatibleSSEInspector } from "@airouter-dev/openai-compatible-errors";

const inspector = new OpenAICompatibleSSEInspector();

for await (const chunk of response.body) {
  const state = inspector.push(chunk);
  if (state.error) break;
}

const state = inspector.finish();

if (state.error) {
  console.warn({
    error: state.error,
    partialOutput: state.hasOutput,
    unexpectedEof: state.unexpectedEof,
  });
}
```

The inspector recognizes:

- Chat Completions delta and `{ "error": ... }` events.
- Responses API `response.output_text.delta`, `error`, `response.failed`, and `response.completed` events.
- Refusal, reasoning, audio, tool-call, and other output-like delta events as conservative replay boundaries.
- `[DONE]`, CRLF/LF framing, multi-line `data:`, and chunks split inside UTF-8 characters.
- Malformed JSON, oversized buffered events, empty streams, and premature EOF.

Use `normalizeOpenAICompatibleSSEEvent()` instead when another parser already handles SSE framing.

## Sanitize other diagnostics

`sanitizeForLogs(value)` creates a bounded, JSON-serializable projection. Ordinary user-defined accessors are represented as `[Getter]` rather than invoked.

```ts
import { sanitizeForLogs } from "@airouter-dev/openai-compatible-errors";

logger.warn(sanitizeForLogs({
  headers,
  requestId,
  nestedError,
}));
```

It handles circular references, depth/node/item/key limits, throwing proxies, and common credentials such as Bearer/Basic values, API keys, npm/GitHub token shapes, JWTs, URL userinfo, and sensitive query parameters. Built-in sensitive field rules cannot be disabled.

The sanitizer is a best-effort defense for common secrets, not arbitrary personal data or a DLP system. Avoid passing prompts, model output, or customer records to logs in the first place.

## Input support

| Input | v0.1 evidence | Notes |
| --- | --- | --- |
| Native Fetch `Response` | Loopback HTTP integration plus Node fixtures | Non-2xx only; 64 KiB and 2 s clone-read defaults |
| OpenAI Node SDK error | `openai@6.49.0` loopback client catch, object tests, and structural fixtures | `APIError`, connection error, timeout, abort, `requestID` |
| AI SDK `APICallError` shape | Structural fixture tests | `statusCode`, `responseHeaders`, `responseBody`, `isRetryable` |
| Fetch/Undici exception | Node fixture tests | Abort, timeout, and common network signals |
| Chat Completions SSE | Chunked fixture tests | Output tracking, errors, `[DONE]` |
| Responses SSE | Event fixture tests | Delta, failed, completed, error |

The OpenAI SDK row records one pinned integration version, not support for every SDK release. The AI SDK row remains a structural fixture and does not claim a tested release matrix. Browser, Bun, and Deno support are not claimed in v0.1. Open an issue with a sanitized fixture when a compatible endpoint returns a shape the package misses.

## API

```ts
normalizeOpenAICompatibleError(input, options?)
normalizeOpenAICompatibleResponse(response, options?)
normalizeOpenAICompatibleSSEEvent(event, options?)
decideOpenAICompatibleRetry(error, context, policy?)
new OpenAICompatibleSSEInspector(options?)
sanitizeForLogs(value, options?)
redactSensitiveText(value, maxLength?)
parseRetryAfterMs(headers, options?)
extractRequestId(headers)
getHeader(headers, name)
```

The published TypeScript declarations are the complete API reference. Category additions are backward-compatible; renames or semantic changes follow SemVer.

## Security properties and limits

- Zero runtime dependencies.
- No network calls, retry execution, logging, telemetry, credential storage, or endpoint defaults.
- Default errors do not retain raw input, body, complete headers, cause, stack, prompt, or output.
- Accessor properties are not invoked during unknown-object inspection.
- Response and SSE reads have configurable hard limits.
- Unknown replay safety and unknown classifications fail closed to `manual_decision`.

Secret redaction is defense in depth, not a substitute for controlling what reaches your logger. Do not include real credentials, prompts, or customer data in public issue reports; use synthetic canaries and minimal fixtures.

Report suspected vulnerabilities through [GitHub private vulnerability reporting](https://github.com/airouter-dev/openai-compatible-errors/security/advisories/new), not a public issue. Contribution requirements and the synthetic-fixture policy are in [CONTRIBUTING.md](https://github.com/airouter-dev/openai-compatible-errors/blob/main/CONTRIBUTING.md).

## Development

The packed library targets Node 18.18+. Running the source test suite requires Node 20 or newer because the current Vitest release no longer supports Node 18.

```bash
npm install
npm run validate
npm pack --dry-run
```

The test suite covers loopback raw Fetch and OpenAI SDK catch paths, safe serialization, credential canaries, cyclic and hostile objects, pinned OpenAI Node SDK objects, OpenAI/AI SDK structural shapes, Retry-After seconds and dates, retry budgets, split UTF-8 SSE frames, errors after partial output, malformed events, and premature EOF.

## License and naming

MIT. Maintained by [airouter.dev](https://ai-router.dev/) contributors as a provider-neutral developer utility.

This project is independent and is not affiliated with or endorsed by OpenAI. “OpenAI” is used only to describe API compatibility.
