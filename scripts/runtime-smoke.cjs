const assert = require("node:assert/strict");

async function smoke(api) {
  const error = api.normalizeOpenAICompatibleError({
    status: 429,
    headers: { "retry-after": "2" },
    error: { code: "rate_limit_exceeded" },
  });
  assert.equal(error.category, "rate_limit");
  assert.equal(error.retryAfterMs, 2_000);

  const sdkError = api.normalizeOpenAICompatibleError({
    status: 429,
    requestID: "req_runtime_smoke",
    error: { code: "rate_limit_exceeded" },
  });
  assert.equal(sdkError.requestId, "req_runtime_smoke");

  const inspector = new api.OpenAICompatibleSSEInspector();
  inspector.push(
    'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
  );
  const state = inspector.finish();
  assert.equal(state.hasOutput, true);
  assert.equal(state.done, true);
  assert.equal(state.error, undefined);
}

async function main() {
  await smoke(require("../dist/index.cjs"));
  await smoke(await import("../dist/index.js"));
  console.log(`${process.version} ESM+CJS smoke passed`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
