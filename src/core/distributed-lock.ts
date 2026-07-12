import { randomUUID } from "node:crypto";

import { buildLockKey } from "./canonical.js";
import { AtticConfigurationError } from "./errors.js";
import type { RedisLike } from "./types.js";

const RELEASE_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

export interface DistributedLockLease {
  readonly key: string;
  readonly token: string;
  release(): Promise<boolean>;
}

function validateLockTtl(ttlMs: number): number {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new AtticConfigurationError("Distributed lock ttlMs must be a positive, safe integer.");
  }
  return ttlMs;
}

export class DistributedLockManager {
  readonly #redis: RedisLike;
  readonly #namespace: string;

  public constructor(redis: RedisLike, namespace: string) {
    this.#redis = redis;
    this.#namespace = namespace;
  }

  public async acquire(resource: string, ttlMs: number): Promise<DistributedLockLease | null> {
    const key = buildLockKey(this.#namespace, resource);
    const token = randomUUID();
    const acquired = await this.#redis.set(key, token, {
      expiration: { type: "PX", value: validateLockTtl(ttlMs) },
      condition: "NX",
    });

    if (acquired === null) return null;

    let released = false;
    return {
      key,
      token,
      release: async (): Promise<boolean> => {
        if (released) return false;
        released = true;
        const result = await this.#redis.eval(RELEASE_LOCK_SCRIPT, { keys: [key], arguments: [token] });
        return result === 1 || result === "1";
      },
    };
  }
}

export { RELEASE_LOCK_SCRIPT };
