/** The extended Prisma client created by {@link AtticModule}. */
export const ATTIC_CLIENT = Symbol("prisma-extension-attic/client");

/** The `$attic` control plane exposed by the extended client. */
export const ATTIC_ENGINE = Symbol("prisma-extension-attic/engine");

/** The embedded worker, when one is exposed by the configured engine. */
export const ATTIC_WORKER = Symbol("prisma-extension-attic/worker");

/** The Redis client used by Attic. Useful for diagnostics and health modules. */
export const ATTIC_REDIS_CLIENT = Symbol("prisma-extension-attic/redis-client");

/** @internal */
export const ATTIC_MODULE_OPTIONS = Symbol("prisma-extension-attic/module-options");

/** @internal */
export const ATTIC_REDIS_RESOURCE = Symbol("prisma-extension-attic/redis-resource");
