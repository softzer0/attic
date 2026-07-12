import type {
  AtticCodec,
  AtticEvent,
  AtticHealth,
  AtticManifest,
  AtticOptions,
  AtticTransactionOptions,
  CacheStrategy,
  CacheTag,
  RedisLike,
  TagGeneration,
} from "../../src/index.js";

// @ts-expect-error Cache key construction is an internal implementation detail.
import type { CacheKeyInput } from "../../src/index.js";
// @ts-expect-error Redis storage scripts and adapters are internal implementation details.
import type { RedisCacheStore } from "../../src/index.js";
// @ts-expect-error Local request coalescing is an internal implementation detail.
import type { SingleFlight } from "../../src/index.js";

export type PublicRootTypeContract = [
  AtticCodec,
  AtticEvent,
  AtticHealth,
  AtticManifest,
  AtticOptions,
  AtticTransactionOptions,
  CacheStrategy,
  CacheTag,
  RedisLike,
  TagGeneration,
];

export type HiddenRootTypeContract = [CacheKeyInput, RedisCacheStore, SingleFlight];
