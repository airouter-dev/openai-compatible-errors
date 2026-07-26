import {
  decideOpenAICompatibleRetry,
  normalizeOpenAICompatibleResponse,
} from "@airouter-dev/openai-compatible-errors";

const baseURL = process.env.OPENAI_BASE_URL;
const apiKey = process.env.OPENAI_API_KEY;

if (!baseURL || !apiKey) {
  throw new Error("Set OPENAI_BASE_URL and OPENAI_API_KEY before running this example.");
}

const startedAt = Date.now();
const response = await fetch(`${baseURL.replace(/\/$/, "")}/v1/models`, {
  headers: { Authorization: `Bearer ${apiKey}` },
});
const error = await normalizeOpenAICompatibleResponse(response);

if (!error) {
  console.log("The endpoint returned a successful response.");
  process.exit(0);
}

const plan = decideOpenAICompatibleRetry(error, {
  method: "GET",
  phase: "http_error",
  replaySafety: "safe",
  attempt: 1,
  elapsedMs: Date.now() - startedAt,
});

console.error(JSON.stringify({ error, plan }, null, 2));
