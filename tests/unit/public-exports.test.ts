import { describe, expect, it } from "vitest";

import * as publicApi from "../../src/index.js";

describe("root public exports", () => {
  it("exports the supported runtime API without exposing core implementation primitives", () => {
    expect(publicApi.ATTIC_GLOBAL_TAG).toBe("$attic:all");
    expect(publicApi.ATTIC_MANIFEST_VERSION).toBe(1);
    expect(publicApi.ATTIC_SQL_ABI_VERSION).toBe(1);
    expect(typeof publicApi.AtticCommittedSyncError).toBe("function");
    expect(typeof publicApi.AtticRecoveryRequiredError).toBe("function");
    expect(typeof publicApi.SuperJsonCodec).toBe("function");
    expect(typeof publicApi.createAtticWorker).toBe("function");
    expect(typeof publicApi.defaultCodec.encode).toBe("function");
    expect(typeof publicApi.withAttic).toBe("function");

    for (const internalName of [
      "ADVANCE_GENERATION_SCRIPT",
      "CacheKeyInput",
      "DistributedLockManager",
      "RedisCacheStore",
      "SingleFlight",
      "buildCacheKey",
      "resolveDependencyTags",
    ]) {
      expect(publicApi).not.toHaveProperty(internalName);
    }
  });
});
