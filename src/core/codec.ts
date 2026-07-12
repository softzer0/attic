import SuperJSON, { type SuperJSONResult, type SuperJSONValue } from "superjson";
import {
  AnyNull,
  DbNull,
  Decimal,
  JsonNull,
  isAnyNull,
  isDbNull,
  isJsonNull,
  skip as prismaSkip,
} from "@prisma/client/runtime/client";

import { AtticSerializationError } from "./errors.js";
import type { AtticCodec } from "./types.js";

const ENVELOPE_VERSION = 1;

interface CodecEnvelope {
  readonly version: typeof ENVELOPE_VERSION;
  readonly payload: SuperJSONResult;
}

type PrismaNullName = "DbNull" | "JsonNull" | "AnyNull";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCodecEnvelope(value: unknown): value is CodecEnvelope {
  return isRecord(value) && value.version === ENVELOPE_VERSION && isRecord(value.payload) && "json" in value.payload;
}

function isPrismaNull(value: unknown): value is object {
  return isDbNull(value) || isJsonNull(value) || isAnyNull(value);
}

function serializePrismaNull(value: object): PrismaNullName {
  if (isDbNull(value)) return "DbNull";
  if (isJsonNull(value)) return "JsonNull";
  return "AnyNull";
}

function deserializePrismaNull(value: PrismaNullName): object {
  switch (value) {
    case "DbNull":
      return DbNull;
    case "JsonNull":
      return JsonNull;
    case "AnyNull":
      return AnyNull;
  }
}

export class SuperJsonCodec implements AtticCodec {
  public readonly version = "attic-superjson-v1";
  readonly #superjson: SuperJSON;

  public constructor() {
    this.#superjson = new SuperJSON({ dedupe: true });
    this.#superjson.registerCustom<Decimal, string>(
      {
        isApplicable: (value): value is Decimal => Decimal.isDecimal(value),
        serialize: (value) => value.toFixed(),
        deserialize: (value) => new Decimal(value),
      },
      "attic.prisma-decimal",
    );
    this.#superjson.registerCustom<object, PrismaNullName>(
      {
        isApplicable: isPrismaNull,
        serialize: serializePrismaNull,
        deserialize: deserializePrismaNull,
      },
      "attic.prisma-null",
    );
    this.#superjson.registerCustom<typeof prismaSkip, true>(
      {
        isApplicable: (value): value is typeof prismaSkip => value === prismaSkip,
        serialize: () => true,
        deserialize: () => prismaSkip,
      },
      "attic.prisma-skip",
    );
  }

  public encode(value: unknown): string {
    try {
      const envelope: CodecEnvelope = {
        version: ENVELOPE_VERSION,
        payload: this.#superjson.serialize(value as SuperJSONValue),
      };
      return JSON.stringify(envelope);
    } catch (error) {
      throw new AtticSerializationError("Unable to encode cache value.", { cause: error });
    }
  }

  public decode(encoded: string): unknown {
    try {
      const envelope: unknown = JSON.parse(encoded);
      if (!isCodecEnvelope(envelope)) {
        throw new Error("Unsupported or malformed cache envelope.");
      }
      return this.#superjson.deserialize(envelope.payload);
    } catch (error) {
      if (error instanceof AtticSerializationError) throw error;
      throw new AtticSerializationError("Unable to decode cache value.", { cause: error });
    }
  }
}

export const defaultCodec: AtticCodec = new SuperJsonCodec();
