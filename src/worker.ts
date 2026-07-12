import { randomUUID } from "node:crypto";

import { AtticRecoveryRequiredError, type AtticGenerationDivergence } from "./core/errors.js";
import type { AtticEvent, AtticEventHandler } from "./core/types.js";
import type { AtticDatabase, OutboxEvent } from "./database.js";

export interface GenerationWriter {
  setGeneration(tag: string, generation: string): Promise<unknown>;
}

export interface GenerationStore extends GenerationWriter {
  getGenerationState(tag: string): Promise<{ readonly found: boolean; readonly generation: string }>;
}

export interface AtticWorkerOptions {
  readonly pollIntervalMs?: number;
  readonly batchSize?: number;
  readonly leaseMs?: number;
  readonly initialBackoffMs?: number;
  readonly maxBackoffMs?: number;
  readonly onEvent?: AtticEventHandler;
}

export interface AtticWorkerHealth {
  readonly running: boolean;
  readonly processing: boolean;
  readonly workerId: string;
  readonly lastRunAt?: Date;
  readonly lastSuccessAt?: Date;
  readonly lastError?: unknown;
  /** Process-local counters; they reset whenever this worker process restarts. */
  readonly processedEvents: number;
  readonly successfulBatches: number;
  readonly failedBatches: number;
  readonly retriedEvents: number;
}

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_INITIAL_BACKOFF_MS = 250;
const DEFAULT_MAX_BACKOFF_MS = 30_000;

function greaterGeneration(left: string, right: string): string {
  return BigInt(left) >= BigInt(right) ? left : right;
}

function groupLatest(events: readonly OutboxEvent[]): ReadonlyMap<string, string> {
  const generations = new Map<string, string>();
  for (const event of events) {
    const current = generations.get(event.tag);
    generations.set(event.tag, current === undefined ? event.generation : greaterGeneration(current, event.generation));
  }
  return generations;
}

export class AtticWorker {
  private readonly workerId = randomUUID();
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly leaseMs: number;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly onEvent: AtticEventHandler | undefined;
  private timer: NodeJS.Timeout | undefined;
  private processing: Promise<number> | undefined;
  private lastRunAt: Date | undefined;
  private lastSuccessAt: Date | undefined;
  private lastError: unknown;
  private processedEvents = 0;
  private successfulBatches = 0;
  private failedBatches = 0;
  private retriedEvents = 0;
  private running = false;

  public constructor(
    private readonly database: AtticDatabase,
    private readonly generations: GenerationStore,
    options: AtticWorkerOptions = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.initialBackoffMs = options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.onEvent = options.onEvent;
  }

  public async reconcileGenerations(expectedTags: readonly string[] = []): Promise<void> {
    const durable = new Map(await this.database.loadAllGenerations());
    for (const tag of expectedTags) if (!durable.has(tag)) durable.set(tag, "0");

    const entries = [...durable].sort(([left], [right]) => left.localeCompare(right));
    const states = await Promise.all(
      entries.map(async ([tag, durableGeneration]) => ({
        tag,
        durableGeneration,
        redis: await this.generations.getGenerationState(tag),
      })),
    );
    let divergences = generationDivergences(states);
    if (divergences.length > 0) {
      // A write may commit and another worker may advance Redis between the two
      // startup reads. Refresh only apparent divergences before classifying a
      // retained Redis value as newer than authoritative PostgreSQL.
      const refreshed = await this.database.loadGenerations(divergences.map(({ tag }) => tag));
      for (const [tag, generation] of refreshed) durable.set(tag, generation);
      divergences = generationDivergences(
        states.map((state) => ({
          ...state,
          durableGeneration: durable.get(state.tag) ?? state.durableGeneration,
        })),
      );
    }
    if (divergences.length > 0) throw new AtticRecoveryRequiredError(divergences);

    await Promise.all([...durable].map(([tag, generation]) => this.generations.setGeneration(tag, generation)));
  }

  public start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
    this.emit({ type: "worker.started" });
  }

  public async stop(): Promise<void> {
    this.running = false;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    await this.processing;
    this.emit({ type: "worker.stopped" });
  }

  public async runOnce(): Promise<number> {
    if (this.processing !== undefined) return this.processing;
    this.processing = this.processBatch();

    try {
      return await this.processing;
    } finally {
      this.processing = undefined;
      this.lastRunAt = new Date();
    }
  }

  public health(): AtticWorkerHealth {
    return {
      running: this.running,
      processing: this.processing !== undefined,
      workerId: this.workerId,
      ...(this.lastRunAt === undefined ? {} : { lastRunAt: this.lastRunAt }),
      ...(this.lastSuccessAt === undefined ? {} : { lastSuccessAt: this.lastSuccessAt }),
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
      processedEvents: this.processedEvents,
      successfulBatches: this.successfulBatches,
      failedBatches: this.failedBatches,
      retriedEvents: this.retriedEvents,
    };
  }

  private async processBatch(): Promise<number> {
    let events: readonly OutboxEvent[] = [];

    try {
      events = await this.database.claimEvents(this.workerId, this.batchSize, this.leaseMs);
      if (events.length === 0) {
        this.lastError = undefined;
        this.lastSuccessAt = new Date();
        return 0;
      }

      const generations = groupLatest(events);
      await Promise.all([...generations].map(([tag, generation]) => this.generations.setGeneration(tag, generation)));
      await this.database.acknowledgeEvents(
        this.workerId,
        events.map((event) => event.id),
      );
      this.lastError = undefined;
      this.lastSuccessAt = new Date();
      this.processedEvents += events.length;
      this.successfulBatches += 1;
      this.emit({ type: "worker.synchronized", eventCount: events.length, tagCount: generations.size });
      return events.length;
    } catch (error) {
      this.lastError = error;
      this.failedBatches += 1;
      this.retriedEvents += events.length;
      const highestAttempt = events.length === 0 ? 0 : Math.max(...events.map((event) => event.attempts));
      const backoffMs = Math.min(this.maxBackoffMs, this.initialBackoffMs * 2 ** Math.max(0, highestAttempt - 1));

      if (events.length > 0) {
        try {
          await this.database.releaseEvents(
            this.workerId,
            events.map((event) => event.id),
            backoffMs,
            error,
          );
        } catch (releaseError) {
          this.emit({ type: "worker.error", attempt: highestAttempt, error: releaseError });
        }
      }

      this.emit({ type: "worker.error", attempt: highestAttempt, error });
      throw error;
    }
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;

    this.timer = setTimeout(() => {
      void this.runOnce()
        .catch(() => undefined)
        .finally(() => this.schedule(this.pollIntervalMs));
    }, delayMs);
    this.timer.unref();
  }

  private emit(event: AtticEvent): void {
    this.onEvent?.(event);
  }
}

function generationDivergences(
  states: readonly {
    readonly tag: string;
    readonly durableGeneration: string;
    readonly redis: { readonly found: boolean; readonly generation: string };
  }[],
): AtticGenerationDivergence[] {
  return states.flatMap(({ tag, durableGeneration, redis }) =>
    redis.found && BigInt(redis.generation) > BigInt(durableGeneration)
      ? [{ tag, redisGeneration: redis.generation, durableGeneration }]
      : [],
  );
}

export function createAtticWorker(
  database: AtticDatabase,
  generations: GenerationStore,
  options?: AtticWorkerOptions,
): AtticWorker {
  return new AtticWorker(database, generations, options);
}
