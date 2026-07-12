import { buildTagGenerationKey, normalizeGeneration, normalizeNamespace } from "./canonical.js";
import { defaultCodec } from "./codec.js";
import { AtticConfigurationError, AtticSerializationError } from "./errors.js";
import type { AtticCodec, CacheTag, RedisLike, TagGeneration } from "./types.js";

const ADVANCE_GENERATION_SCRIPT = `
local incoming = ARGV[1]
if not string.match(incoming, '^%d+$') then
  return redis.error_reply('Attic generation must contain only decimal digits')
end

local current = redis.call('GET', KEYS[1])
if current and not string.match(current, '^%d+$') then
  return redis.error_reply('Stored Attic generation is invalid')
end

if current then
  current = string.gsub(current, '^0+', '')
  if current == '' then current = '0' end
end

if not current or string.len(incoming) > string.len(current) or
   (string.len(incoming) == string.len(current) and incoming > current) then
  redis.call('SET', KEYS[1], incoming)
  return incoming
end

return current
`;

const INCREMENT_GENERATION_SCRIPT = `
local current = redis.call('GET', KEYS[1]) or '0'
if not string.match(current, '^%d+$') then
  return redis.error_reply('Stored Attic generation is invalid')
end
current = string.gsub(current, '^0+', '')
if current == '' then current = '0' end

local digits = {}
local carry = 1
for index = string.len(current), 1, -1 do
  local digit = string.byte(current, index) - 48 + carry
  if digit >= 10 then
    digit = digit - 10
    carry = 1
  else
    carry = 0
  end
  table.insert(digits, 1, string.char(digit + 48))
end
if carry == 1 then
  table.insert(digits, 1, '1')
end

local next = table.concat(digits)
redis.call('SET', KEYS[1], next)
return next
`;

export interface RedisCacheStoreOptions {
  readonly namespace: string;
  readonly codec?: AtticCodec;
}

export interface TagGenerationUpdate {
  readonly tag: CacheTag;
  readonly generation: string | number | bigint;
}

export interface TagGenerationState {
  readonly found: boolean;
  readonly generation: TagGeneration;
}

export type CacheReadResult<T> =
  | { readonly hit: true; readonly value: T }
  | { readonly hit: false; readonly reason: "missing" | "corrupt" };

function validateTtl(ttlMs: number): number {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new AtticConfigurationError("Cache ttlMs must be a positive, safe integer.");
  }
  return ttlMs;
}

function redisString(value: unknown): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (typeof value === "number" || typeof value === "bigint") return value.toString();
  throw new AtticSerializationError("Redis returned an unsupported generation value.");
}

function compareGenerations(left: TagGeneration, right: TagGeneration): number {
  if (left.length !== right.length) return left.length - right.length;
  return left.localeCompare(right);
}

function isGenerationUpdateArray(value: unknown): value is readonly TagGenerationUpdate[] {
  return Array.isArray(value);
}

function normalizeUpdates(
  updates: readonly TagGenerationUpdate[] | Readonly<Record<CacheTag, string | number | bigint>>,
): readonly TagGenerationUpdate[] {
  const entries = isGenerationUpdateArray(updates)
    ? updates
    : Object.entries(updates).map(([tag, generation]) => ({ tag, generation }));
  const highest = new Map<CacheTag, TagGeneration>();

  for (const entry of entries) {
    const tag = entry.tag.trim();
    if (tag.length === 0) throw new AtticConfigurationError("Cache tags must not be empty.");
    const generation = normalizeGeneration(entry.generation);
    const existing = highest.get(tag);
    if (existing === undefined || compareGenerations(generation, existing) > 0) highest.set(tag, generation);
  }

  return [...highest].map(([tag, generation]) => ({ tag, generation }));
}

export class RedisCacheStore {
  public readonly namespace: string;
  readonly #redis: RedisLike;
  readonly #codec: AtticCodec;

  public constructor(redis: RedisLike, options: RedisCacheStoreOptions) {
    this.#redis = redis;
    this.namespace = normalizeNamespace(options.namespace);
    this.#codec = options.codec ?? defaultCodec;
  }

  public async get<T>(key: string): Promise<CacheReadResult<T>> {
    const encoded = await this.#redis.get(key);
    if (encoded === null) return { hit: false, reason: "missing" };

    try {
      return { hit: true, value: this.#codec.decode(encoded) as T };
    } catch {
      try {
        await this.#redis.del(key);
      } catch {
        // A corrupt value is already treated as a miss; deletion is best-effort.
      }
      return { hit: false, reason: "corrupt" };
    }
  }

  public async set(key: string, value: unknown, ttlMs: number): Promise<void> {
    const encoded = this.#codec.encode(value);
    await this.#redis.set(key, encoded, {
      expiration: { type: "PX", value: validateTtl(ttlMs) },
    });
  }

  public async delete(key: string): Promise<void> {
    await this.#redis.del(key);
  }

  public async getGenerationState(tag: CacheTag): Promise<TagGenerationState> {
    const stored = await this.#redis.get(buildTagGenerationKey(this.namespace, tag));
    if (stored === null) return { found: false, generation: "0" };

    try {
      return { found: true, generation: normalizeGeneration(stored) };
    } catch (error) {
      throw new AtticSerializationError(`Stored generation for tag ${JSON.stringify(tag)} is invalid.`, {
        cause: error,
      });
    }
  }

  public async getGeneration(tag: CacheTag): Promise<TagGeneration> {
    return (await this.getGenerationState(tag)).generation;
  }

  public async getGenerationStates(tags: readonly CacheTag[]): Promise<Readonly<Record<CacheTag, TagGenerationState>>> {
    const uniqueTags = [...new Set(tags)].sort();
    const values = await Promise.all(uniqueTags.map(async (tag) => [tag, await this.getGenerationState(tag)] as const));
    return Object.fromEntries(values);
  }

  public async getGenerations(tags: readonly CacheTag[]): Promise<Readonly<Record<CacheTag, TagGeneration>>> {
    const states = await this.getGenerationStates(tags);
    return Object.fromEntries(Object.entries(states).map(([tag, state]) => [tag, state.generation]));
  }

  /** Atomically stores a generation only when it is newer than Redis' current value. */
  public async setGeneration(tag: CacheTag, generation: string | number | bigint): Promise<TagGeneration> {
    const normalized = normalizeGeneration(generation);
    const result = await this.#redis.eval(ADVANCE_GENERATION_SCRIPT, {
      keys: [buildTagGenerationKey(this.namespace, tag)],
      arguments: [normalized],
    });
    return normalizeGeneration(redisString(result));
  }

  public async setGenerations(
    updates: readonly TagGenerationUpdate[] | Readonly<Record<CacheTag, string | number | bigint>>,
  ): Promise<Readonly<Record<CacheTag, TagGeneration>>> {
    const results = await Promise.all(
      normalizeUpdates(updates).map(
        async ({ tag, generation }) => [tag, await this.setGeneration(tag, generation)] as const,
      ),
    );
    return Object.fromEntries(results);
  }

  /** Atomically increments an arbitrary-precision decimal generation. */
  public async incrementGeneration(tag: CacheTag): Promise<TagGeneration> {
    const result = await this.#redis.eval(INCREMENT_GENERATION_SCRIPT, {
      keys: [buildTagGenerationKey(this.namespace, tag)],
      arguments: [],
    });
    return normalizeGeneration(redisString(result));
  }
}

export { ADVANCE_GENERATION_SCRIPT, INCREMENT_GENERATION_SCRIPT };
