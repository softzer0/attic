import { Prisma } from "@prisma/client/extension";
import type { Types } from "@prisma/client/runtime/client";

import { AtticConfigurationError, AtticTransactionError } from "./core/errors.js";
import type { AtticHealth, AtticOptions, AtticTransactionOptions, CacheStrategy, CacheTag } from "./core/types.js";
import type { PrismaRawClient } from "./database.js";
import { AtticEngine, type AtticEngineHealth, type InvalidateInput } from "./engine.js";
import type { AtticWorker } from "./worker.js";

const READ_OPERATIONS = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
]);

const WRITE_OPERATIONS = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
  "delete",
  "deleteMany",
]);

const RAW_WRITE_OPERATIONS = new Set(["$executeRaw", "$executeRawUnsafe", "executeRaw", "executeRawUnsafe"]);

export interface PrismaAtticCacheStrategy {
  readonly cacheStrategy?: CacheStrategy;
}

export interface RawCacheOptions {
  readonly tags: readonly CacheTag[];
  readonly ttlMs?: number;
}

export type AtticTransactionClient<TClient> = Omit<
  TClient,
  "$attic" | "$connect" | "$disconnect" | "$extends" | "$on" | "$transaction" | "$use"
>;

export interface AtticControl<TTransactionClient = Prisma.TransactionClient> {
  readonly worker: AtticWorker;
  start(): Promise<void>;
  stop(): Promise<void>;
  health(): Promise<AtticEngineHealth>;
  withScope<T>(scope: string, callback: () => T): T;
  transaction<T>(
    callback: (transaction: TTransactionClient) => Promise<T>,
    options?: AtticTransactionOptions,
  ): Promise<T>;
  queryRaw<T = unknown>(options: RawCacheOptions): (strings: TemplateStringsArray, ...values: unknown[]) => Promise<T>;
  invalidate(input: InvalidateInput): Promise<void>;
  invalidateAll(): Promise<void>;
}

type ArgsWithCacheStrategy<Model, Operation extends Types.Public.Operation> = Prisma.Args<Model, Operation> &
  PrismaAtticCacheStrategy;

type NativeFluentMembers<Model, Operation extends PropertyKey, Null> =
  Model extends Types.Extensions.DynamicModelExtensionThis<
    infer TypeMap,
    infer ModelName extends PropertyKey,
    infer ExtensionArgs
  >
    ? ExtensionArgs extends object
      ? Types.Extensions.DynamicModelExtensionFluentApi<TypeMap, ModelName, Operation, Null>
      : Record<never, never>
    : Record<never, never>;
type AtticFluentResult<
  Model,
  ActualArgs,
  Operation extends Types.Public.Operation,
  Null = never,
> = Prisma.PrismaPromise<Prisma.Result<Model, ActualArgs, Operation> | Null> &
  NativeFluentMembers<Model, Operation, Null>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function splitCacheStrategy(args: unknown): { readonly args: unknown; readonly strategy?: CacheStrategy } {
  if (!isRecord(args) || !("cacheStrategy" in args)) return { args };

  const { cacheStrategy, ...queryArgs } = args;
  if (
    cacheStrategy !== undefined &&
    cacheStrategy !== false &&
    (!isRecord(cacheStrategy) ||
      (cacheStrategy.ttlMs !== undefined && typeof cacheStrategy.ttlMs !== "number") ||
      (cacheStrategy.tags !== undefined && !Array.isArray(cacheStrategy.tags)))
  ) {
    throw new AtticConfigurationError("cacheStrategy must be false or an object containing ttlMs and/or tags.");
  }

  return {
    args: queryArgs,
    ...(cacheStrategy === undefined ? {} : { strategy: cacheStrategy as CacheStrategy }),
  };
}

function requiresModelOutboxEvent(operation: string, args: unknown): boolean {
  if (operation !== "createMany" && operation !== "createManyAndReturn") return true;
  return !isRecord(args) || !Array.isArray(args.data) || args.data.length > 0;
}

function modelDelegate(context: unknown, queryClient: object): Record<string, (...args: unknown[]) => unknown> {
  const value = context as {
    readonly $name?: string;
    readonly name?: string;
    readonly $parent?: Record<string, unknown>;
  };
  const name = value.$name ?? value.name;
  if (name === undefined) throw new AtticConfigurationError("Unable to resolve the current Prisma model delegate.");
  const delegate: unknown = value.$parent?.[name] ?? (Reflect.get(queryClient, name) as unknown);
  if (!isRecord(delegate)) throw new AtticConfigurationError(`Unable to resolve Prisma model ${JSON.stringify(name)}.`);
  return delegate as Record<string, (...args: unknown[]) => unknown>;
}

function modelMethod(operation: string, queryClient: object, context: unknown, args: unknown): unknown {
  const method = modelDelegate(context, queryClient)[operation];
  if (typeof method !== "function") {
    throw new AtticConfigurationError(`Prisma model does not expose ${operation}.`);
  }
  return method(args);
}

function rawSql(strings: TemplateStringsArray): string {
  let sql = strings[0] ?? "";
  for (let index = 1; index < strings.length; index += 1) sql += `$${String(index)}${strings[index] ?? ""}`;
  return sql;
}

function createModelExtensions(queryClient: object) {
  return {
    aggregate<This, const ActualArgs>(
      this: This,
      args: Prisma.Exact<ActualArgs, ArgsWithCacheStrategy<This, "aggregate">>,
    ): Prisma.PrismaPromise<Prisma.Result<This, ActualArgs, "aggregate">> {
      return modelMethod("aggregate", queryClient, Prisma.getExtensionContext(this), args) as never;
    },
    count<This, const ActualArgs = Record<never, never>>(
      this: This,
      args?: Prisma.Exact<ActualArgs, ArgsWithCacheStrategy<This, "count">>,
    ): Prisma.PrismaPromise<Prisma.Result<This, ActualArgs, "count">> {
      return modelMethod("count", queryClient, Prisma.getExtensionContext(this), args ?? {}) as never;
    },
    findFirst<This, const ActualArgs = Record<never, never>>(
      this: This,
      args?: Prisma.Exact<ActualArgs, ArgsWithCacheStrategy<This, "findFirst">>,
    ): AtticFluentResult<This, ActualArgs, "findFirst", null> {
      return modelMethod("findFirst", queryClient, Prisma.getExtensionContext(this), args ?? {}) as never;
    },
    findFirstOrThrow<This, const ActualArgs = Record<never, never>>(
      this: This,
      args?: Prisma.Exact<ActualArgs, ArgsWithCacheStrategy<This, "findFirstOrThrow">>,
    ): AtticFluentResult<This, ActualArgs, "findFirstOrThrow"> {
      return modelMethod("findFirstOrThrow", queryClient, Prisma.getExtensionContext(this), args ?? {}) as never;
    },
    findMany<This, const ActualArgs = Record<never, never>>(
      this: This,
      args?: Prisma.Exact<ActualArgs, ArgsWithCacheStrategy<This, "findMany">>,
    ): Prisma.PrismaPromise<Prisma.Result<This, ActualArgs, "findMany">> {
      return modelMethod("findMany", queryClient, Prisma.getExtensionContext(this), args ?? {}) as never;
    },
    findUnique<This, const ActualArgs>(
      this: This,
      args: Prisma.Exact<ActualArgs, ArgsWithCacheStrategy<This, "findUnique">>,
    ): AtticFluentResult<This, ActualArgs, "findUnique", null> {
      return modelMethod("findUnique", queryClient, Prisma.getExtensionContext(this), args) as never;
    },
    findUniqueOrThrow<This, const ActualArgs>(
      this: This,
      args: Prisma.Exact<ActualArgs, ArgsWithCacheStrategy<This, "findUniqueOrThrow">>,
    ): AtticFluentResult<This, ActualArgs, "findUniqueOrThrow"> {
      return modelMethod("findUniqueOrThrow", queryClient, Prisma.getExtensionContext(this), args) as never;
    },
    groupBy<This, const ActualArgs>(
      this: This,
      args: Prisma.Exact<ActualArgs, ArgsWithCacheStrategy<This, "groupBy">>,
    ): Prisma.PrismaPromise<Prisma.Result<This, ActualArgs, "groupBy">> {
      return modelMethod("groupBy", queryClient, Prisma.getExtensionContext(this), args) as never;
    },
  };
}

type AtticModelExtensions = ReturnType<typeof createModelExtensions>;
interface AtticClientExtensions<TClient> {
  readonly $attic: AtticControl<AtticTransactionClient<TClient>>;
  $transaction(...args: readonly unknown[]): never;
}
interface AtticExtensionResult<TClient> {
  readonly $extends: {
    readonly extArgs: Types.Extensions.InternalArgs<
      Record<never, never>,
      { readonly $allModels: AtticModelExtensions },
      Record<never, never>,
      AtticClientExtensions<TClient>
    >;
  };
}
type AtticExtensionFactory<TClient> = (client: unknown) => AtticExtensionResult<TClient>;

export function withAttic<TClient>(options: AtticOptions<TClient>): AtticExtensionFactory<TClient> {
  return Prisma.defineExtension((client) => {
    const engine = new AtticEngine(client as unknown as PrismaRawClient, options);

    const queryClient = client.$extends({
      name: "prisma-extension-attic-query",
      query: {
        async $allOperations({ args, model, operation, query }) {
          const split = splitCacheStrategy(args);

          if (model !== undefined && READ_OPERATIONS.has(operation)) {
            return engine.readModel({
              model,
              operation,
              args: split.args,
              ...(split.strategy === undefined ? {} : { cacheStrategy: split.strategy }),
              load: () => query(split.args as never),
            });
          }

          if (model !== undefined && WRITE_OPERATIONS.has(operation)) {
            return engine.write(() => query(split.args as never), requiresModelOutboxEvent(operation, split.args));
          }

          if (RAW_WRITE_OPERATIONS.has(operation)) {
            return engine.write(() => query(split.args as never), false);
          }

          return query(split.args as never);
        },
      },
    });

    const control: AtticControl = {
      worker: engine.worker,
      start: () => engine.start(),
      stop: () => engine.stop(),
      health: () => engine.health(),
      withScope: (scope, callback) => engine.withScope(scope, callback),
      transaction: (callback, transactionOptions) =>
        engine.transaction(
          callback as (transaction: PrismaRawClient) => Promise<unknown>,
          transactionOptions,
        ) as Promise<never>,
      queryRaw:
        <T>(rawOptions: RawCacheOptions) =>
        (strings: TemplateStringsArray, ...values: unknown[]): Promise<T> => {
          const rawMethod: unknown = Reflect.get(queryClient, "$queryRaw") as unknown;
          if (typeof rawMethod !== "function") {
            throw new AtticConfigurationError("The wrapped Prisma client does not expose $queryRaw.");
          }

          return engine.readRaw({
            sql: rawSql(strings),
            values,
            tags: rawOptions.tags,
            ...(rawOptions.ttlMs === undefined ? {} : { ttlMs: rawOptions.ttlMs }),
            load: () => Reflect.apply(rawMethod, queryClient, [strings, ...values]) as unknown as Promise<T>,
          });
        },
      invalidate: (input) => engine.invalidate(input),
      invalidateAll: () => engine.invalidateAll(),
    };

    return queryClient.$extends({
      name: "prisma-extension-attic",
      client: {
        $attic: control,
        $transaction(): never {
          throw new AtticTransactionError(
            "Prisma $transaction is disabled by Attic. Use prisma.$attic.transaction(async (tx) => ...) instead; batch-array transactions are unsupported in v0.1.",
          );
        },
      },
      model: {
        $allModels: createModelExtensions(queryClient),
      },
    });
  }) as unknown as AtticExtensionFactory<TClient>;
}

export type { AtticEngineHealth, AtticHealth, AtticOptions, CacheStrategy };
