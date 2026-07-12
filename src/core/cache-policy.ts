import { AtticConfigurationError } from "./errors.js";
import type { CacheDefaults, CacheStrategy, EnabledCachePolicy, ResolvedCachePolicy } from "./types.js";

export const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1_000;
export const DEFAULT_NEGATIVE_CACHE_TTL_MS = 5_000;

function validateTtl(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AtticConfigurationError(`${name} must be a positive, safe integer.`);
  }

  return value;
}

function uniqueTags(...groups: readonly (readonly string[] | undefined)[]): readonly string[] {
  const tags = new Set<string>();

  for (const group of groups) {
    for (const tag of group ?? []) {
      const normalized = tag.trim();
      if (normalized.length === 0) {
        throw new AtticConfigurationError("Cache tags must not be empty.");
      }
      tags.add(normalized);
    }
  }

  return [...tags].sort();
}

export function resolveCachePolicy(
  strategy: CacheStrategy | undefined,
  defaults: CacheDefaults = {},
): ResolvedCachePolicy {
  if (strategy === false) {
    return { enabled: false };
  }

  const policy: EnabledCachePolicy = {
    enabled: true,
    ttlMs: validateTtl(strategy?.ttlMs ?? defaults.ttlMs ?? DEFAULT_CACHE_TTL_MS, "ttlMs"),
    negativeTtlMs: validateTtl(defaults.negativeTtlMs ?? DEFAULT_NEGATIVE_CACHE_TTL_MS, "negativeTtlMs"),
    tags: uniqueTags(defaults.tags, strategy?.tags),
  };

  return policy;
}

export function cacheTtlFor(value: unknown, policy: EnabledCachePolicy): number {
  return value === null || value === undefined ? policy.negativeTtlMs : policy.ttlMs;
}
