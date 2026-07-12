import type { AtticOptions } from "./core/types.js";
import type { PrismaRawClient } from "./database.js";
import { AtticEngine } from "./engine.js";
import type { AtticWorkerHealth } from "./worker.js";

export interface StandaloneWorkerOptions extends Omit<AtticOptions, "worker"> {
  /** Existing application Prisma client. No additional PostgreSQL pool is created. */
  readonly prisma: PrismaRawClient;
}

export interface StandaloneAtticWorker {
  start(): Promise<void>;
  stop(): Promise<void>;
  runOnce(): Promise<number>;
  health(): AtticWorkerHealth;
}

export function createAtticWorker(options: StandaloneWorkerOptions): StandaloneAtticWorker {
  const { prisma, ...atticOptions } = options;
  const engine = new AtticEngine(prisma, { ...atticOptions, worker: false });

  return {
    async start(): Promise<void> {
      await engine.start();
      engine.worker.start();
    },
    async stop(): Promise<void> {
      await engine.stop();
    },
    async runOnce(): Promise<number> {
      await engine.start();
      return engine.worker.runOnce();
    },
    health(): AtticWorkerHealth {
      return engine.worker.health();
    },
  };
}
