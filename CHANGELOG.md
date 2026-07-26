# Changelog

## 0.1.0 - 2026-07-26

- Normalize native Fetch, OpenAI SDK-style, AI SDK-style, HTTP, and SSE errors.
- Read the current OpenAI Node SDK `requestID` field and verify `APIError`, connection, timeout, and abort objects against pinned `openai@6.49.0`.
- Exercise both raw Fetch and a real `openai@6.49.0` client catch path against a loopback HTTP server.
- Return safe-by-default errors without raw bodies, prompts, or full headers.
- Add conservative, stream-aware retry planning with retry budgets.
- Add a stateful OpenAI-compatible SSE inspector.
- Add bounded recursive log sanitization and credential redaction.
- Bound `Response` clone reads by both bytes and time.
- Treat refusal and other output-like SSE deltas as replay boundaries.
- Give authoritative HTTP status precedence over retry-like free text.
- Omit credential-shaped or free-form code/type/request-ID metadata.
- Support BOM plus LF, CRLF, and CR-only SSE framing.
- Fail closed for hostile getters, proxies, invalid limits, clocks, and retry RNGs.
