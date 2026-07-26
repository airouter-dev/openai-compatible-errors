import type { SanitizeForLogsOptions } from "./types.js";

const REDACTED = "[REDACTED]";
const SENSITIVE_KEY = /^(?:authorization|proxyauthorization|apikey|xapikey|cookie|setcookie|token|accesstoken|refreshtoken|idtoken|password|passphrase|secret|clientsecret|prompt|messages|requestbodyvalues|responsebody|body)$/;

function clampInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `[String omitted: ${value.length} chars]`;
}

export function redactSensitiveText(value: string, maxLength = 2_000): string {
  const safeLength = clampInteger(maxLength, 2_000);
  if (value.length > safeLength) return truncate(value, safeLength);
  const redacted = value
    .replace(
      /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi,
      (_match, scheme: string) => `${scheme} ${REDACTED}`,
    )
    .replace(
      /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b|\bnpm_[A-Za-z0-9]{16,}\b|\bghp_[A-Za-z0-9]{16,}\b|\bgithub_pat_[A-Za-z0-9_]{16,}\b|\bxox[baprs]-[A-Za-z0-9-]{8,}\b/gi,
      REDACTED,
    )
    .replace(
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
      REDACTED,
    )
    .replace(
      /([?&](?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password|authorization)=)[^&#\s]*/gi,
      `$1${REDACTED}`,
    )
    .replace(
      /((?:authorization|api[-_]?key|x-api-key|access[-_]?token|refresh[-_]?token|token|secret|password)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      `$1${REDACTED}`,
    )
    .replace(
      /([a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/gi,
      `$1${REDACTED}:${REDACTED}@`,
    );

  return truncate(redacted, safeLength);
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[-_\s]/g, "").toLowerCase();
  return (
    SENSITIVE_KEY.test(normalized) ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("accesstoken") ||
    normalized.endsWith("refreshtoken") ||
    normalized.endsWith("clientsecret")
  );
}

function dataProperty(value: object, key: PropertyKey): unknown {
  let current: object | null = value;
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

function hasPrototype(value: object, expected: object): boolean {
  let current: object | null = value;
  const seen = new Set<object>();
  try {
    while (current && seen.size < 32) {
      if (current === expected) return true;
      if (seen.has(current)) return false;
      seen.add(current);
      current = Object.getPrototypeOf(current) as object | null;
    }
  } catch {
    return false;
  }
  return false;
}

export function sanitizeForLogs(
  value: unknown,
  options: SanitizeForLogsOptions = {},
): unknown {
  const limits = {
    maxDepth: clampInteger(options.maxDepth, 5),
    maxArrayItems: clampInteger(options.maxArrayItems, 25),
    maxObjectKeys: clampInteger(options.maxObjectKeys, 40),
    maxStringLength: clampInteger(options.maxStringLength, 2_000),
    maxNodes: clampInteger(options.maxNodes, 500),
  };
  const seen = new WeakSet<object>();
  let nodes = 0;

  const visit = (current: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > limits.maxNodes) return "[Node limit reached]";
    if (current === null) return null;
    if (typeof current === "string") {
      return redactSensitiveText(current, limits.maxStringLength);
    }
    if (
      typeof current === "number" ||
      typeof current === "boolean" ||
      typeof current === "undefined"
    ) {
      return current;
    }
    if (typeof current === "bigint") return current.toString();
    if (typeof current === "symbol") return "[Symbol]";
    if (typeof current === "function") return "[Function]";
    if (depth >= limits.maxDepth) return "[Depth limit reached]";
    if (typeof current !== "object") return String(current);
    if (seen.has(current)) return "[Circular]";
    seen.add(current);

    try {
      if (hasPrototype(current, Date.prototype)) {
        const time = Date.prototype.getTime.call(current);
        return Number.isNaN(time)
          ? "Invalid Date"
          : Date.prototype.toISOString.call(current);
      }
      if (hasPrototype(current, URL.prototype)) {
        return redactSensitiveText(
          URL.prototype.toString.call(current),
          limits.maxStringLength,
        );
      }
      if (hasPrototype(current, Error.prototype)) {
        const errorRecord: Record<string, unknown> = Object.create(null) as Record<
          string,
          unknown
        >;
        const name = dataProperty(current, "name");
        const message = dataProperty(current, "message");
        errorRecord.name = redactSensitiveText(
          typeof name === "string" ? name : "Error",
          100,
        );
        errorRecord.message = redactSensitiveText(
          typeof message === "string" ? message : "",
          limits.maxStringLength,
        );
        const code = dataProperty(current, "code");
        const status = dataProperty(current, "status");
        const statusCode = dataProperty(current, "statusCode");
        if (typeof code === "string") {
          errorRecord.code = redactSensitiveText(code, 200);
        }
        if (typeof status === "number") errorRecord.status = status;
        if (typeof statusCode === "number") errorRecord.statusCode = statusCode;
        return errorRecord;
      }
      if (hasPrototype(current, Uint8Array.prototype)) {
        return "[Uint8Array]";
      }

      if (Array.isArray(current)) {
        const lengthDescriptor = Object.getOwnPropertyDescriptor(current, "length");
        const length =
          lengthDescriptor &&
          "value" in lengthDescriptor &&
          typeof lengthDescriptor.value === "number"
            ? lengthDescriptor.value
            : 0;
        const result: unknown[] = [];
        const inspectedItems = Math.min(length, limits.maxArrayItems);
        for (let index = 0; index < inspectedItems; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
          if (!descriptor) {
            result.push("[Empty item]");
          } else if (!("value" in descriptor)) {
            result.push("[Getter]");
          } else {
            result.push(visit(descriptor.value, depth + 1));
          }
        }
        if (length > limits.maxArrayItems) {
          result.push(`[${length - limits.maxArrayItems} more items]`);
        }
        return result;
      }
    } catch {
      return "[Uninspectable object]";
    }

    const result: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    let descriptors: PropertyDescriptorMap;
    try {
      descriptors = Object.getOwnPropertyDescriptors(current);
    } catch {
      return "[Uninspectable object]";
    }

    const enumerableKeys = Object.entries(descriptors)
      .filter(([, descriptor]) => descriptor.enumerable === true)
      .map(([key]) => key);
    const keys = enumerableKeys.slice(0, limits.maxObjectKeys);
    for (const key of keys) {
      if (isSensitiveKey(key)) {
        result[key] = REDACTED;
        continue;
      }
      const descriptor = descriptors[key];
      if (!descriptor) continue;
      if (!("value" in descriptor)) {
        result[key] = "[Getter]";
        continue;
      }
      result[key] = visit(descriptor.value, depth + 1);
    }
    const totalKeys = enumerableKeys.length;
    if (totalKeys > limits.maxObjectKeys) {
      result["[truncatedKeys]"] = totalKeys - limits.maxObjectKeys;
    }
    return result;
  };

  return visit(value, 0);
}
