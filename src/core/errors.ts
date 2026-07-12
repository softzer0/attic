export type AtticErrorCode =
  | "ATTIC_CONFIGURATION"
  | "ATTIC_MANIFEST"
  | "ATTIC_SCHEMA_MISMATCH"
  | "ATTIC_INSTALLATION_INVALID"
  | "ATTIC_COMMITTED_INSTALLATION"
  | "ATTIC_RECOVERY_REQUIRED"
  | "ATTIC_SERIALIZATION"
  | "ATTIC_CANONICALIZATION"
  | "ATTIC_TRANSACTION"
  | "ATTIC_COMMITTED_SYNC";

export class AtticError extends Error {
  public readonly code: AtticErrorCode;

  public constructor(message: string, code: AtticErrorCode, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

export class AtticConfigurationError extends AtticError {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, "ATTIC_CONFIGURATION", options);
  }
}

export class AtticManifestError extends AtticError {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, "ATTIC_MANIFEST", options);
  }
}

export class AtticSchemaMismatchError extends AtticError {
  public readonly expectedChecksum: string;
  public readonly actualChecksum: string | null;

  public constructor(expectedChecksum: string, actualChecksum: string | null, options?: ErrorOptions) {
    const actual = actualChecksum ?? "not installed";
    super(
      `Attic schema mismatch: expected checksum ${expectedChecksum}, received ${actual}.`,
      "ATTIC_SCHEMA_MISMATCH",
      options,
    );
    this.expectedChecksum = expectedChecksum;
    this.actualChecksum = actualChecksum;
  }
}

export class AtticInstallationError extends AtticError {
  public readonly issues: readonly string[];

  public constructor(issues: readonly string[], options?: ErrorOptions) {
    const normalized = issues.length === 0 ? ["The PostgreSQL Attic installation is invalid."] : [...issues];
    super(`Attic installation validation failed: ${normalized.join(" ")}`, "ATTIC_INSTALLATION_INVALID", options);
    this.issues = normalized;
  }
}

export class AtticCommittedInstallationError extends AtticError {
  public readonly committed = true;
  public readonly requestId: string;

  public constructor(requestId: string, options?: ErrorOptions) {
    super(
      `PostgreSQL transaction ${requestId} committed without producing an Attic outbox event. A durable global fallback invalidation was attempted; verify the live trigger installation before continuing.`,
      "ATTIC_COMMITTED_INSTALLATION",
      options,
    );
    this.requestId = requestId;
  }
}

export interface AtticGenerationDivergence {
  readonly tag: string;
  readonly redisGeneration: string;
  readonly durableGeneration: string;
}

export class AtticRecoveryRequiredError extends AtticError {
  public readonly divergences: readonly AtticGenerationDivergence[];

  public constructor(divergences: readonly AtticGenerationDivergence[], options?: ErrorOptions) {
    const details = divergences
      .map(
        ({ tag, redisGeneration, durableGeneration }) =>
          `${JSON.stringify(tag)} is ${redisGeneration} in Redis but ${durableGeneration} in PostgreSQL`,
      )
      .join("; ");
    super(
      `Attic cannot reconcile generations because Redis is ahead of durable PostgreSQL state: ${details}. Restore the authoritative PostgreSQL state or remove the affected Attic Redis namespace before restarting.`,
      "ATTIC_RECOVERY_REQUIRED",
      options,
    );
    this.divergences = [...divergences];
  }
}

export class AtticSerializationError extends AtticError {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, "ATTIC_SERIALIZATION", options);
  }
}

export class AtticCanonicalizationError extends AtticError {
  public readonly path: string;

  public constructor(message: string, path: string, options?: ErrorOptions) {
    super(`${message} at ${path}.`, "ATTIC_CANONICALIZATION", options);
    this.path = path;
  }
}

export class AtticTransactionError extends AtticError {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, "ATTIC_TRANSACTION", options);
  }
}

export class AtticCommittedSyncError extends AtticError {
  public readonly committed = true;
  public readonly requestId: string;

  public constructor(requestId: string, options?: ErrorOptions) {
    super(
      `PostgreSQL transaction ${requestId} committed, but its Redis generations could not be synchronized.`,
      "ATTIC_COMMITTED_SYNC",
      options,
    );
    this.requestId = requestId;
  }
}
