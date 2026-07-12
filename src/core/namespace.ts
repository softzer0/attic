import { AtticConfigurationError } from "./errors.js";

const NAMESPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,63}$/;

export function normalizeNamespace(namespace: string): string {
  if (!NAMESPACE_PATTERN.test(namespace)) {
    throw new AtticConfigurationError(
      "namespace must be 1-64 characters and contain only ASCII letters, numbers, colons, underscores, or hyphens.",
    );
  }
  return namespace;
}
