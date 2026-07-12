import { AnyNull, DbNull, Decimal, JsonNull, skip as prismaSkip } from "@prisma/client/runtime/client";
import { describe, expect, it } from "vitest";

import {
  AtticCanonicalizationError,
  AtticSerializationError,
  SuperJsonCodec,
  buildCacheKey,
  canonicalize,
  normalizeGeneration,
} from "../../src/core/index.js";

describe("core canonicalization and codec", () => {
  it("round-trips Prisma and JavaScript scalar values losslessly", () => {
    const codec = new SuperJsonCodec();
    const input = {
      bigint: 9_007_199_254_740_993n,
      bytes: new Uint8Array([0, 127, 255]),
      date: new Date("2026-07-12T10:20:30.000Z"),
      decimal: new Decimal("1234567890.000000000123"),
      dbNull: DbNull,
      jsonNull: JsonNull,
      anyNull: AnyNull,
      skip: prismaSkip,
      missing: undefined,
    };

    const decoded = codec.decode(codec.encode(input)) as typeof input;

    expect(decoded.bigint).toBe(input.bigint);
    expect(decoded.bytes).toEqual(input.bytes);
    expect(decoded.date).toEqual(input.date);
    expect(Decimal.isDecimal(decoded.decimal)).toBe(true);
    expect(decoded.decimal.toFixed()).toBe(input.decimal.toFixed());
    expect(decoded.dbNull).toBe(DbNull);
    expect(decoded.jsonNull).toBe(JsonNull);
    expect(decoded.anyNull).toBe(AnyNull);
    expect(decoded.skip).toBe(prismaSkip);
    expect(Object.hasOwn(decoded, "missing")).toBe(true);
  });

  it("rejects malformed or unsupported codec envelopes", () => {
    const codec = new SuperJsonCodec();
    expect(() => codec.decode("not-json")).toThrow(AtticSerializationError);
    expect(() => codec.decode(JSON.stringify({ version: 2, payload: {} }))).toThrow(AtticSerializationError);
  });

  it("canonicalizes objects independently of property order", () => {
    expect(canonicalize({ z: 1, nested: { b: 2, a: 3 } })).toBe(canonicalize({ nested: { a: 3, b: 2 }, z: 1 }));
    expect(canonicalize(-0)).not.toBe(canonicalize(0));
    expect(canonicalize(new Decimal("1.2300"))).toBe(canonicalize(new Decimal("1.23")));
  });

  it("rejects circular and unsupported values instead of risking a key collision", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => canonicalize(circular)).toThrow(AtticCanonicalizationError);
    expect(() => canonicalize(Symbol("unsafe"))).toThrow(AtticCanonicalizationError);
  });

  it("hashes all sensitive key material and includes scope and generations", () => {
    const base = {
      namespace: "attic",
      model: "User",
      operation: "findUnique",
      args: { where: { email: "private@example.com" } },
      generations: { "$attic:all": "1", User: "4" },
    } as const;
    const first = buildCacheKey({ ...base, scope: "tenant-a" });
    const same = buildCacheKey({ ...base, scope: "tenant-a" });
    const otherScope = buildCacheKey({ ...base, scope: "tenant-b" });
    const otherGeneration = buildCacheKey({ ...base, scope: "tenant-a", generations: { User: "5" } });

    expect(first).toBe(same);
    expect(first).not.toContain("private@example.com");
    expect(first).not.toBe(otherScope);
    expect(first).not.toBe(otherGeneration);
  });

  it("normalizes arbitrary-precision generations without accepting unsafe numbers", () => {
    expect(normalizeGeneration("00000000000000000042")).toBe("42");
    expect(normalizeGeneration(42n)).toBe("42");
    expect(() => normalizeGeneration(Number.MAX_SAFE_INTEGER + 1)).toThrow();
    expect(() => normalizeGeneration("-1")).toThrow();
  });
});
