import type { HeadersInput } from "./types.js";

function normalizeHeaderValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const strings: string[] = [];
    let length = 0;
    try {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      if (
        lengthDescriptor &&
        "value" in lengthDescriptor &&
        typeof lengthDescriptor.value === "number"
      ) {
        length = lengthDescriptor.value;
      }
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor && "value" in descriptor && typeof descriptor.value === "string") {
          strings.push(descriptor.value);
        }
      }
    } catch {
      return undefined;
    }
    return strings.length > 0 ? strings.join(", ") : undefined;
  }
  return undefined;
}

export function getHeader(
  headers: HeadersInput,
  requestedName: string,
): string | undefined {
  if (!headers) return undefined;
  const name = requestedName.toLowerCase();

  if (typeof Headers !== "undefined") {
    try {
      const value = Headers.prototype.get.call(headers, requestedName);
      return value === null ? undefined : value;
    } catch {
      // Continue with inert array/object inspection for non-native Headers.
    }
  }

  try {
    if (Array.isArray(headers)) {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(headers, "length");
      const length =
        lengthDescriptor &&
        "value" in lengthDescriptor &&
        typeof lengthDescriptor.value === "number"
          ? lengthDescriptor.value
          : 0;
      for (let index = 0; index < length; index += 1) {
        const pairDescriptor = Object.getOwnPropertyDescriptor(headers, String(index));
        if (!pairDescriptor || !("value" in pairDescriptor)) continue;
        const pair = pairDescriptor.value as unknown;
        if (!Array.isArray(pair)) continue;
        const keyDescriptor = Object.getOwnPropertyDescriptor(pair, "0");
        const valueDescriptor = Object.getOwnPropertyDescriptor(pair, "1");
        if (
          !keyDescriptor ||
          !("value" in keyDescriptor) ||
          typeof keyDescriptor.value !== "string" ||
          !valueDescriptor ||
          !("value" in valueDescriptor) ||
          typeof valueDescriptor.value !== "string"
        ) {
          continue;
        }
        if (keyDescriptor.value.toLowerCase() === name) {
          return valueDescriptor.value;
        }
      }
      return undefined;
    }
  } catch {
    return undefined;
  }

  try {
    const descriptors = Object.getOwnPropertyDescriptors(headers);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (key.toLowerCase() !== name || !("value" in descriptor)) continue;
      return normalizeHeaderValue(descriptor.value);
    }
  } catch {
    return undefined;
  }

  return undefined;
}

export function extractRequestId(headers: HeadersInput): string | undefined {
  const candidates = [
    "x-request-id",
    "request-id",
    "x-correlation-id",
    "cf-ray",
  ];
  for (const candidate of candidates) {
    const value = getHeader(headers, candidate);
    if (value) return value;
  }
  return undefined;
}

export function parseRetryAfterMs(
  headers: HeadersInput,
  options: { readonly now?: number | Date } = {},
): number | undefined {
  const retryAfterMs = getHeader(headers, "retry-after-ms");
  if (retryAfterMs !== undefined) {
    const trimmed = retryAfterMs.trim();
    if (/^\d+$/.test(trimmed)) {
      const milliseconds = Number(trimmed);
      if (
        Number.isFinite(milliseconds) &&
        milliseconds <= Number.MAX_SAFE_INTEGER
      ) {
        return Math.round(milliseconds);
      }
    }
  }

  const retryAfter = getHeader(headers, "retry-after");
  if (retryAfter === undefined) return undefined;

  const trimmed = retryAfter.trim();
  if (trimmed === "") return undefined;
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (
      Number.isFinite(seconds) &&
      seconds * 1_000 <= Number.MAX_SAFE_INTEGER
    ) {
      return Math.round(seconds * 1_000);
    }
    return undefined;
  }

  if (/^[+-]?\d/.test(trimmed)) return undefined;
  const target = Date.parse(trimmed);
  if (Number.isNaN(target)) return undefined;
  const now =
    options.now instanceof Date
      ? options.now.getTime()
      : (options.now ?? Date.now());
  if (!Number.isFinite(now)) return undefined;
  return Math.max(0, target - now);
}
