import { createHash } from "node:crypto";

import { Decimal, isAnyNull, isDbNull, isJsonNull, skip as prismaSkip } from "@prisma/client/runtime/client";

import { AtticCanonicalizationError, AtticConfigurationError } from "./errors.js";
import { normalizeNamespace } from "./namespace.js";
import type { CacheKeyInput, TagGeneration } from "./types.js";

type CanonicalNode = null | string | number | boolean | readonly CanonicalNode[];

function pathForProperty(path: string, property: string): string {
  return `${path}[${JSON.stringify(property)}]`;
}

function prismaNullName(value: unknown): "DbNull" | "JsonNull" | "AnyNull" | undefined {
  if (isDbNull(value)) return "DbNull";
  if (isJsonNull(value)) return "JsonNull";
  if (isAnyNull(value)) return "AnyNull";
  return undefined;
}

function canonicalNumber(value: number): CanonicalNode {
  if (Number.isNaN(value)) return ["number", "NaN"];
  if (value === Number.POSITIVE_INFINITY) return ["number", "Infinity"];
  if (value === Number.NEGATIVE_INFINITY) return ["number", "-Infinity"];
  if (Object.is(value, -0)) return ["number", "-0"];
  return ["number", value.toString()];
}

function toCanonicalNode(value: unknown, path: string, ancestors: WeakSet<object>): CanonicalNode {
  if (value === null) return ["null"];

  switch (typeof value) {
    case "string":
      return ["string", value];
    case "boolean":
      return ["boolean", value];
    case "number":
      return canonicalNumber(value);
    case "bigint":
      return ["bigint", value.toString()];
    case "undefined":
      return ["undefined"];
    case "function":
    case "symbol":
      throw new AtticCanonicalizationError(`Unsupported ${typeof value} value`, path);
    case "object":
      break;
  }

  if (value === prismaSkip) return ["prisma", "Skip"];

  const nullName = prismaNullName(value);
  if (nullName !== undefined) return ["prisma", nullName];

  if (Decimal.isDecimal(value)) return ["decimal", value.toFixed()];

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new AtticCanonicalizationError("Invalid Date", path);
    }
    return ["date", value.toISOString()];
  }

  if (value instanceof Uint8Array) {
    return ["bytes", Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64")];
  }

  if (ancestors.has(value)) {
    throw new AtticCanonicalizationError("Circular reference", path);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items: CanonicalNode[] = [];
      for (let index = 0; index < value.length; index += 1) {
        items.push(
          Object.hasOwn(value, index)
            ? toCanonicalNode(value[index], `${path}[${String(index)}]`, ancestors)
            : (["array-hole"] as const),
        );
      }
      return ["array", items];
    }

    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      const constructorValue: unknown = Reflect.get(value, "constructor");
      const constructorName = typeof constructorValue === "function" ? constructorValue.name : "unknown";
      throw new AtticCanonicalizationError(`Unsupported object type ${constructorName}`, path);
    }

    const symbolKeys = Object.getOwnPropertySymbols(value);
    if (symbolKeys.length > 0) {
      throw new AtticCanonicalizationError("Objects with symbol keys are unsupported", path);
    }

    const record = value as Record<string, unknown>;
    const entries: CanonicalNode[] = [];
    for (const key of Object.keys(record).sort()) {
      entries.push(["entry", key, toCanonicalNode(record[key], pathForProperty(path, key), ancestors)]);
    }
    return ["object", entries];
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalize(value: unknown): string {
  try {
    return JSON.stringify(toCanonicalNode(value, "$", new WeakSet()));
  } catch (error) {
    if (error instanceof AtticCanonicalizationError) throw error;
    throw new AtticCanonicalizationError("Unable to canonicalize value", "$", { cause: error });
  }
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hashCanonical(value: unknown): string {
  return sha256(canonicalize(value));
}

export function normalizeGeneration(value: string | number | bigint): TagGeneration {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new AtticConfigurationError("A tag generation must be a non-negative safe integer.");
    }
    return value.toString();
  }

  const serialized = value.toString();
  if (!/^\d+$/.test(serialized)) {
    throw new AtticConfigurationError("A tag generation must contain only decimal digits.");
  }

  return serialized.replace(/^0+(?=\d)/, "");
}

export function buildCacheKey(input: CacheKeyInput): string {
  const namespace = normalizeNamespace(input.namespace);
  const generations = Object.fromEntries(
    Object.entries(input.generations).map(([tag, generation]) => [tag, normalizeGeneration(generation)]),
  );
  const digest = hashCanonical({
    args: input.args,
    generations,
    model: input.model,
    operation: input.operation,
    scope: input.scope,
  });
  return `${namespace}:cache:${digest}`;
}

export function buildRawCacheKey(
  namespace: string,
  sql: string,
  values: readonly unknown[],
  scope: unknown,
  generations: Readonly<Record<string, TagGeneration>>,
): string {
  return buildCacheKey({ namespace, scope, model: "$raw", operation: sql, args: values, generations });
}

export function buildTagGenerationKey(namespace: string, tag: string): string {
  const normalizedTag = tag.trim();
  if (normalizedTag.length === 0) throw new AtticConfigurationError("Cache tags must not be empty.");
  return `${normalizeNamespace(namespace)}:generation:${sha256(normalizedTag)}`;
}

export function buildLockKey(namespace: string, cacheKey: string): string {
  return `${normalizeNamespace(namespace)}:lock:${sha256(cacheKey)}`;
}

export { normalizeNamespace } from "./namespace.js";
