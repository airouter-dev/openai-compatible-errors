import { OpenAICompatibleError } from "./error.js";
import { normalizeOpenAICompatibleError } from "./normalize.js";
import type {
  NormalizeSSEOptions,
  SSEEventInput,
  SSEInspectorOptions,
  StreamInspectionState,
} from "./types.js";

function readField(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function streamProtocolError(): OpenAICompatibleError {
  return new OpenAICompatibleError({
    category: "schema",
    source: "sse",
  });
}

function unexpectedEofError(): OpenAICompatibleError {
  return new OpenAICompatibleError({
    category: "stream",
    source: "sse",
  });
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  minimum = 0,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(Math.floor(value), maximum));
}

function parseEventData(data: string | unknown): {
  readonly parsed?: unknown;
  readonly malformed: boolean;
  readonly done: boolean;
} {
  if (typeof data !== "string") return { parsed: data, malformed: false, done: false };
  const trimmed = data.trim();
  if (trimmed === "[DONE]") return { malformed: false, done: true };
  if (trimmed === "") return { malformed: false, done: false };
  try {
    return { parsed: JSON.parse(trimmed) as unknown, malformed: false, done: false };
  } catch {
    return {
      ...(trimmed.startsWith("{") || trimmed.startsWith("[")
        ? { malformed: true }
        : { malformed: false, parsed: trimmed }),
      done: false,
    };
  }
}

function isErrorPayload(payload: unknown, eventName: string | undefined): boolean {
  if (eventName?.toLowerCase() === "error") return true;
  if (readField(payload, "error") !== undefined) return true;
  const type = readField(payload, "type");
  if (type === "error" || type === "response.failed") return true;
  const response = readField(payload, "response");
  return (
    readField(response, "status") === "failed" ||
    readField(response, "error") !== undefined
  );
}

function hasMeaningfulOutput(payload: unknown): boolean {
  const type = readField(payload, "type");
  if (
    typeof type === "string" &&
    (type.endsWith(".delta") ||
      type.endsWith("-delta") ||
      type.startsWith("response.output_") ||
      type.startsWith("response.refusal.") ||
      type.startsWith("response.content_part.") ||
      type.startsWith("response.reasoning_"))
  ) {
    // Treat any output-like event as the replay boundary. A false positive only
    // prevents an automatic retry; a false negative can duplicate output.
    return true;
  }

  const choices = readField(payload, "choices");
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      const delta = readField(choice, "delta");
      const content = readField(delta, "content");
      const refusal = readField(delta, "refusal");
      const reasoning = firstOutputField(delta, ["reasoning", "reasoning_content"]);
      const audio = readField(delta, "audio");
      const toolCalls = readField(delta, "tool_calls");
      const functionCall = readField(delta, "function_call");
      const message = readField(choice, "message");
      const text = readField(choice, "text");
      if (
        (content !== undefined && content !== null && content !== "") ||
        (refusal !== undefined && refusal !== null && refusal !== "") ||
        reasoning !== undefined ||
        audio !== undefined ||
        (Array.isArray(toolCalls) && toolCalls.length > 0) ||
        functionCall !== undefined ||
        message !== undefined ||
        (typeof text === "string" && text.length > 0)
      ) {
        return true;
      }
    }
  }

  const delta = readField(payload, "delta");
  return typeof delta === "string" && delta.length > 0;
}

function firstOutputField(
  value: unknown,
  keys: readonly string[],
): unknown {
  for (const key of keys) {
    const candidate = readField(value, key);
    if (candidate !== undefined && candidate !== null && candidate !== "") {
      return candidate;
    }
  }
  return undefined;
}

function isCompletionEvent(payload: unknown): boolean {
  const type = readField(payload, "type");
  return type === "response.completed" || type === "finish";
}

export function normalizeOpenAICompatibleSSEEvent(
  event: SSEEventInput,
  options: NormalizeSSEOptions = {},
): OpenAICompatibleError | null {
  const maxEventBytes = boundedInteger(
    options.maxEventBytes,
    65_536,
    1_048_576,
  );
  if (typeof event.data === "string" && byteLength(event.data) > maxEventBytes) {
    return streamProtocolError();
  }

  const parsed = parseEventData(event.data);
  if (parsed.malformed) return streamProtocolError();
  if (parsed.done || parsed.parsed === undefined) return null;
  if (!isErrorPayload(parsed.parsed, event.event)) return null;

  const error = normalizeOpenAICompatibleError(parsed.parsed, {
    ...options,
    source: "sse",
    body: parsed.parsed,
  });
  if (error.category !== "unknown") return error;

  return new OpenAICompatibleError({
    category: "stream",
    source: "sse",
    ...(error.code === undefined ? {} : { code: error.code }),
    ...(error.type === undefined ? {} : { type: error.type }),
    ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
    ...(error.providerMessage === undefined
      ? {}
      : { providerMessage: error.providerMessage }),
  });
}

export class OpenAICompatibleSSEInspector {
  readonly #options: SSEInspectorOptions;
  readonly #decoder = new TextDecoder();
  #buffer = "";
  #atStart = true;
  #eventName: string | undefined;
  #dataLines: string[] = [];
  #eventBytes = 0;
  #discardEvent = false;
  #eventsSeen = 0;
  #malformedEvents = 0;
  #hasOutput = false;
  #done = false;
  #unexpectedEof = false;
  #error: OpenAICompatibleError | undefined;
  #finished = false;

  constructor(options: SSEInspectorOptions = {}) {
    this.#options = options;
  }

  push(chunk: string | Uint8Array): StreamInspectionState {
    if (this.#finished) return this.state;
    this.#buffer +=
      typeof chunk === "string" ? chunk : this.#decoder.decode(chunk, { stream: true });
    this.#stripInitialBom();
    this.#drainLines();

    const maxBufferBytes = boundedInteger(
      this.#options.maxBufferBytes,
      131_072,
      2_097_152,
      1,
    );
    if (byteLength(this.#buffer) > maxBufferBytes) {
      this.#buffer = "";
      this.#dataLines = [];
      this.#eventBytes = 0;
      this.#discardEvent = true;
      this.#malformedEvents += 1;
      this.#error ??= streamProtocolError();
    }
    return this.state;
  }

  finish(): StreamInspectionState {
    if (this.#finished) return this.state;
    this.#buffer += this.#decoder.decode();
    this.#stripInitialBom();
    this.#drainLines(true);
    if (this.#buffer.length > 0) {
      this.#consumeLine(this.#buffer);
      this.#buffer = "";
    }
    this.#dispatchEvent();
    this.#finished = true;

    if (!this.#done && this.#error === undefined) {
      this.#unexpectedEof = true;
      this.#error = unexpectedEofError();
    }
    return this.state;
  }

  get state(): StreamInspectionState {
    const state: {
      eventsSeen: number;
      malformedEvents: number;
      hasOutput: boolean;
      done: boolean;
      unexpectedEof: boolean;
      error?: OpenAICompatibleError;
    } = {
      eventsSeen: this.#eventsSeen,
      malformedEvents: this.#malformedEvents,
      hasOutput: this.#hasOutput,
      done: this.#done,
      unexpectedEof: this.#unexpectedEof,
    };
    if (this.#error !== undefined) state.error = this.#error;
    return state;
  }

  #stripInitialBom(): void {
    if (!this.#atStart || this.#buffer.length === 0) return;
    if (this.#buffer.startsWith("\uFEFF")) this.#buffer = this.#buffer.slice(1);
    this.#atStart = false;
  }

  #drainLines(final = false): void {
    while (true) {
      const carriageReturn = this.#buffer.indexOf("\r");
      const lineFeed = this.#buffer.indexOf("\n");
      let newline: number;
      if (carriageReturn < 0) newline = lineFeed;
      else if (lineFeed < 0) newline = carriageReturn;
      else newline = Math.min(carriageReturn, lineFeed);
      if (newline < 0) return;

      const character = this.#buffer[newline];
      if (character === "\r" && newline === this.#buffer.length - 1 && !final) {
        return;
      }
      const newlineWidth =
        character === "\r" && this.#buffer[newline + 1] === "\n" ? 2 : 1;
      const rawLine = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + newlineWidth);
      this.#consumeLine(rawLine);
    }
  }

  #consumeLine(line: string): void {
    if (line === "") {
      this.#dispatchEvent();
      return;
    }
    if (this.#discardEvent) return;
    if (line.startsWith(":")) return;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") {
      if (byteLength(value) > 1_024) {
        this.#rejectCurrentEvent();
      } else {
        this.#eventName = value;
      }
    }
    if (field === "data") {
      const maxEventBytes = boundedInteger(
        this.#options.maxEventBytes,
        65_536,
        1_048_576,
      );
      this.#eventBytes += byteLength(value) + 1;
      if (this.#eventBytes > maxEventBytes) {
        this.#rejectCurrentEvent();
      } else {
        this.#dataLines.push(value);
      }
    }
  }

  #dispatchEvent(): void {
    if (this.#discardEvent) {
      this.#discardEvent = false;
      this.#eventName = undefined;
      this.#dataLines = [];
      this.#eventBytes = 0;
      return;
    }
    if (this.#dataLines.length === 0) {
      this.#eventName = undefined;
      this.#eventBytes = 0;
      return;
    }
    const data = this.#dataLines.join("\n");
    const eventName = this.#eventName;
    this.#dataLines = [];
    this.#eventName = undefined;
    this.#eventBytes = 0;
    this.#eventsSeen += 1;

    const parsed = parseEventData(data);
    if (parsed.done) {
      this.#done = true;
      return;
    }
    if (parsed.malformed) {
      this.#malformedEvents += 1;
      this.#error ??= streamProtocolError();
      return;
    }
    if (parsed.parsed === undefined) return;

    if (hasMeaningfulOutput(parsed.parsed)) this.#hasOutput = true;
    if (isCompletionEvent(parsed.parsed)) this.#done = true;
    const error = normalizeOpenAICompatibleSSEEvent(
      {
        ...(eventName === undefined ? {} : { event: eventName }),
        data: parsed.parsed,
      },
      this.#options,
    );
    if (error) this.#error ??= error;
  }

  #rejectCurrentEvent(): void {
    this.#dataLines = [];
    this.#eventName = undefined;
    this.#eventBytes = 0;
    this.#discardEvent = true;
    this.#malformedEvents += 1;
    this.#error ??= streamProtocolError();
  }
}
