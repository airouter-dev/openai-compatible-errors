import {
  isOpenAICompatibleError,
  OpenAICompatibleError,
} from "./error.js";
import { extractRequestId, parseRetryAfterMs } from "./headers.js";
import { redactSensitiveText } from "./redaction.js";
import type {
  HeadersInput,
  NormalizeOpenAIErrorOptions,
  NormalizeResponseOptions,
  OpenAIErrorCategory,
  OpenAIErrorFields,
  OpenAIErrorSource,
} from "./types.js";

function ownDataProperty(value: unknown, key: PropertyKey): unknown {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    return undefined;
  }
  let current: object | null = value as object;
  const seen = new Set<object>();
  try {
    while (current && seen.size < 32) {
      if (seen.has(current)) return undefined;
      seen.add(current);
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor) return "value" in descriptor ? descriptor.value : undefined;
      current = Object.getPrototypeOf(current) as object | null;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function firstDefined(...values: readonly unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null);
}

function safeString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return redactSensitiveText(value.trim(), maxLength);
}

function safeIdentifier(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (
    trimmed === "" ||
    trimmed.length > maxLength ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(trimmed)
  ) {
    return undefined;
  }
  if (redactSensitiveText(trimmed, maxLength) !== trimmed) return undefined;
  return trimmed;
}

function safeNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(Math.floor(value), maximum));
}

function normalizeStatus(value: unknown): number | undefined {
  const status = safeNumber(value);
  if (status === undefined) return undefined;
  const integer = Math.round(status);
  return integer >= 100 && integer <= 599 ? integer : undefined;
}

function parseJsonIfPossible(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (value.length > 1_048_576) return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function nested(value: unknown, ...path: readonly PropertyKey[]): unknown {
  let current = value;
  for (const key of path) {
    current = ownDataProperty(current, key);
    if (current === undefined || current === null) return current;
  }
  return current;
}

function extractPayload(body: unknown): unknown {
  const parsed = parseJsonIfPossible(body);
  const responseFailure = nested(parsed, "response", "error");
  if (responseFailure !== undefined) return responseFailure;
  const directError = ownDataProperty(parsed, "error");
  return directError ?? parsed;
}

function inputConstructorName(input: unknown): string | undefined {
  const constructor = ownDataProperty(input, "constructor");
  return safeIdentifier(ownDataProperty(constructor, "name"), 100);
}

function platformErrorField(
  input: unknown,
  field: "name" | "message",
): string | undefined {
  if (typeof DOMException === "undefined") return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(DOMException.prototype, field);
    if (!descriptor?.get) return undefined;
    return safeString(
      descriptor.get.call(input),
      field === "name" ? 100 : 1_000,
    );
  } catch {
    return undefined;
  }
}

function nativeResponseParts(input: unknown):
  | { readonly status: number; readonly headers: Headers }
  | undefined {
  if (typeof Response === "undefined") return undefined;
  try {
    const statusGetter = Object.getOwnPropertyDescriptor(
      Response.prototype,
      "status",
    )?.get;
    const headersGetter = Object.getOwnPropertyDescriptor(
      Response.prototype,
      "headers",
    )?.get;
    if (!statusGetter || !headersGetter) return undefined;
    const status = statusGetter.call(input) as unknown;
    const headers = headersGetter.call(input) as unknown;
    if (typeof status !== "number") return undefined;
    Headers.prototype.get.call(headers, "x-request-id");
    return { status, headers: headers as Headers };
  } catch {
    return undefined;
  }
}

function isNativeErrorLike(input: unknown): boolean {
  const constructor = ownDataProperty(input, "constructor");
  return [
    Error,
    TypeError,
    RangeError,
    ReferenceError,
    SyntaxError,
    URIError,
    EvalError,
    ...(typeof AggregateError === "undefined" ? [] : [AggregateError]),
  ].includes(constructor as ErrorConstructor);
}

function detectSource(
  input: unknown,
  status: number | undefined,
  explicit: OpenAIErrorSource | undefined,
): OpenAIErrorSource {
  if (explicit) return explicit;
  if (nativeResponseParts(input)) return "http";

  const name = inputConstructorName(input)?.toLowerCase() ?? "";
  if (
    name.includes("apierror") ||
    name.includes("ratelimiterror") ||
    /^api(?:connection(?:timeout)?|userabort)error$/.test(name) ||
    ownDataProperty(input, "requestID") !== undefined ||
    ownDataProperty(input, "request_id") !== undefined
  ) {
    return "openai_sdk";
  }
  if (
    name.includes("apicallerror") ||
    (ownDataProperty(input, "statusCode") !== undefined &&
      ownDataProperty(input, "isRetryable") !== undefined)
  ) {
    return "ai_sdk";
  }
  if (isNativeErrorLike(input) || platformErrorField(input, "name") !== undefined) {
    return "fetch";
  }
  return status === undefined ? "unknown" : "http";
}

function classify(
  status: number | undefined,
  code: string | undefined,
  type: string | undefined,
  providerMessage: string | undefined,
  inputName: string | undefined,
  thrownError: boolean,
): OpenAIErrorCategory {
  const structuredSignal = [code, type, inputName]
    .filter((value): value is string => value !== undefined)
    .join(" ")
    .toLowerCase();
  const transportSignal = [structuredSignal, thrownError ? providerMessage : undefined]
    .filter((value): value is string => value !== undefined)
    .join(" ")
    .toLowerCase();

  switch (status) {
    case 400:
    case 409:
    case 422:
      return "validation";
    case 401:
      return "authentication";
    case 403:
      return "permission";
    case 404:
      return /model|deployment|resource/.test(structuredSignal)
        ? "not_found"
        : "endpoint";
    case 408:
      return "timeout";
    case 413:
      return "payload_too_large";
    case 429:
      return /insufficient[_ -]?quota|quota[_ -]?(?:exhausted|exceeded)|billing|credit/.test(
        structuredSignal,
      )
        ? "quota"
        : "rate_limit";
    case 502:
    case 503:
    case 504:
      return "upstream";
    default:
      if (status !== undefined && status >= 500) return "server";
      if (status !== undefined && status >= 400) return "validation";
  }

  if (/abort(?:ed|error)?|cancel(?:led|ed)/.test(transportSignal)) return "aborted";
  if (/insufficient[_ -]?quota|quota[_ -]?(?:exhausted|exceeded)|billing|credit/.test(structuredSignal)) {
    return "quota";
  }
  if (/invalid[_ -]?api[_ -]?key|authentication|unauthori[sz]ed/.test(structuredSignal)) {
    return "authentication";
  }
  if (/permission|forbidden|access[_ -]?denied/.test(structuredSignal)) {
    return "permission";
  }
  if (/rate[_ -]?limit/.test(structuredSignal)) return "rate_limit";
  if (/timed?[_ -]?out|timeout|etimedout/.test(transportSignal)) return "timeout";
  if (
    /econnreset|econnrefused|enotfound|fetch failed|network|apiconnectionerror/.test(
      transportSignal,
    )
  ) {
    return "network";
  }
  if (/json|schema|parse[_ -]?error|malformed/.test(structuredSignal)) {
    return "schema";
  }
  return "unknown";
}

function responseParts(input: unknown): {
  readonly status?: number;
  readonly headers?: HeadersInput;
} {
  const nativeResponse = nativeResponseParts(input);
  if (nativeResponse) return nativeResponse;

  const response = ownDataProperty(input, "response");
  const status = normalizeStatus(ownDataProperty(response, "status"));
  const headers = ownDataProperty(response, "headers") as HeadersInput;
  const result: { status?: number; headers?: HeadersInput } = {};
  if (status !== undefined) result.status = status;
  if (headers !== undefined) result.headers = headers;
  return result;
}

export function normalizeOpenAICompatibleError(
  input: unknown,
  options: NormalizeOpenAIErrorOptions = {},
): OpenAICompatibleError {
  if (isOpenAICompatibleError(input) && Object.keys(options).length === 0) {
    return input;
  }

  const response = responseParts(input);
  const status = normalizeStatus(
    firstDefined(
      options.status,
      ownDataProperty(input, "status"),
      ownDataProperty(input, "statusCode"),
      response.status,
    ),
  );
  const headers = firstDefined(
    options.headers,
    ownDataProperty(input, "headers"),
    ownDataProperty(input, "responseHeaders"),
    response.headers,
  ) as HeadersInput;
  const body = firstDefined(
    options.body,
    ownDataProperty(input, "responseBody"),
    ownDataProperty(input, "body"),
    ownDataProperty(input, "data"),
    ownDataProperty(input, "error"),
  );
  const payload = extractPayload(body);
  const maxProviderMessageLength = boundedInteger(
    options.maxProviderMessageLength,
    1_000,
    10_000,
  );
  const providerMessage = safeString(
    firstDefined(
      ownDataProperty(payload, "message"),
      ownDataProperty(input, "message"),
      platformErrorField(input, "message"),
      nested(input, "cause", "message"),
      typeof body === "string" ? body : undefined,
    ),
    maxProviderMessageLength,
  );
  const code = safeIdentifier(
    firstDefined(
      ownDataProperty(payload, "code"),
      ownDataProperty(input, "code"),
    ),
    200,
  );
  const type = safeIdentifier(
    firstDefined(
      ownDataProperty(payload, "type"),
      ownDataProperty(input, "type"),
    ),
    200,
  );
  const constructorName =
    platformErrorField(input, "name") ?? inputConstructorName(input);
  const category = classify(
    status,
    code,
    type,
    providerMessage,
    constructorName,
    isNativeErrorLike(input) || platformErrorField(input, "name") !== undefined,
  );
  const source = detectSource(input, status, options.source);
  const requestId = safeIdentifier(
    firstDefined(
      ownDataProperty(input, "requestID"),
      ownDataProperty(input, "request_id"),
      ownDataProperty(input, "requestId"),
      ownDataProperty(payload, "request_id"),
      extractRequestId(headers),
    ),
    300,
  );
  const retryAfterMs = parseRetryAfterMs(headers, {
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  const fields: {
    category: OpenAIErrorCategory;
    source: OpenAIErrorSource;
    status?: number;
    code?: string;
    type?: string;
    requestId?: string;
    retryAfterMs?: number;
    providerMessage?: string;
  } = {
    category,
    source,
  };
  if (status !== undefined) fields.status = status;
  if (code !== undefined) fields.code = code;
  if (type !== undefined) fields.type = type;
  if (requestId !== undefined) fields.requestId = requestId;
  if (retryAfterMs !== undefined) fields.retryAfterMs = retryAfterMs;
  if (options.includeProviderMessage && providerMessage !== undefined) {
    fields.providerMessage = providerMessage;
  }
  return new OpenAICompatibleError(fields as OpenAIErrorFields);
}

async function readResponseBody(
  response: Response,
  maxBodyBytes: number,
  readTimeoutMs: number,
): Promise<string | undefined> {
  if (maxBodyBytes === 0 || readTimeoutMs === 0) return undefined;
  let clone: Response;
  try {
    clone = response.clone();
  } catch {
    return undefined;
  }
  if (!clone.body) return undefined;

  const reader = clone.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let bytesRead = 0;
  const deadline = Date.now() + readTimeoutMs;
  try {
    while (bytesRead < maxBodyBytes) {
      const remainingTimeMs = Math.max(0, deadline - Date.now());
      if (remainingTimeMs === 0) return undefined;
      const result = await new Promise<
        ReadableStreamReadResult<Uint8Array> | undefined
      >((resolve) => {
        let settled = false;
        const timeout = setTimeout(() => {
          settled = true;
          resolve(undefined);
        }, remainingTimeMs);
        try {
          void reader.read().then(
            (readResult) => {
              if (settled) return;
              settled = true;
              clearTimeout(timeout);
              resolve(readResult);
            },
            () => {
              if (settled) return;
              settled = true;
              clearTimeout(timeout);
              resolve(undefined);
            },
          );
        } catch {
          settled = true;
          clearTimeout(timeout);
          resolve(undefined);
        }
      });
      if (result === undefined) return undefined;
      if (result.done) break;
      const remaining = maxBodyBytes - bytesRead;
      const chunk = result.value.subarray(0, remaining);
      bytesRead += chunk.byteLength;
      parts.push(decoder.decode(chunk, { stream: bytesRead < maxBodyBytes }));
      if (result.value.byteLength > remaining) break;
    }
    parts.push(decoder.decode());
  } catch {
    return undefined;
  } finally {
    try {
      void reader.cancel().catch(() => undefined);
    } catch {
      // A fully consumed, locked, or already closed stream needs no cancellation.
    }
  }
  return parts.join("");
}

export async function normalizeOpenAICompatibleResponse(
  response: Response,
  options: NormalizeResponseOptions = {},
): Promise<OpenAICompatibleError | null> {
  if (response.ok) return null;
  const maxBodyBytes = boundedInteger(options.maxBodyBytes, 65_536, 1_048_576);
  const readTimeoutMs = boundedInteger(options.readTimeoutMs, 2_000, 30_000);
  const body = await readResponseBody(response, maxBodyBytes, readTimeoutMs);
  return normalizeOpenAICompatibleError(response, {
    ...options,
    source: options.source ?? "http",
    status: response.status,
    headers: response.headers,
    ...(body === undefined ? {} : { body }),
  });
}
