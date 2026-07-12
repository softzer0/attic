import { describe, expect, it } from "vitest";

import { AtticTransactionError } from "../../src/core/errors.js";
import { withAttic } from "../../src/extension.js";
import { FakeRedis, TEST_MANIFEST } from "./attic-fakes.js";

class CapturingExtensionClient {
  public readonly definitions: unknown[] = [];

  public $extends(definition: unknown): this {
    this.definitions.push(definition);
    return this;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

describe("withAttic", () => {
  it("rejects ordinary Prisma transactions before executing a callback", () => {
    const client = new CapturingExtensionClient();
    const extension = withAttic({ manifest: TEST_MANIFEST, redis: new FakeRedis(), worker: false });
    (extension as unknown as (value: CapturingExtensionClient) => unknown)(client);

    const definition = client.definitions[1];
    if (!isRecord(definition) || !isRecord(definition.client)) {
      throw new Error("Expected the Attic client extension definition.");
    }
    const transactionValue = definition.client.$transaction;
    if (typeof transactionValue !== "function") throw new Error("Expected the Attic transaction override.");
    const transaction = transactionValue as (...args: unknown[]) => unknown;
    let callbackExecuted = false;

    expect(() => transaction(() => (callbackExecuted = true))).toThrow(AtticTransactionError);
    expect(callbackExecuted).toBe(false);
    expect(() => transaction([])).toThrow(/\$attic\.transaction/u);
  });
});
