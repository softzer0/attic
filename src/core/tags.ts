import { AtticConfigurationError, AtticManifestError } from "./errors.js";
import { ATTIC_GLOBAL_TAG, type AtticManifest, type CacheTag, type ModelManifest } from "./types.js";

function manifestModel(manifest: AtticManifest, modelName: string): ModelManifest {
  const model = manifest.models[modelName];
  if (model === undefined) {
    throw new AtticManifestError(`Model ${JSON.stringify(modelName)} is not present in the Attic manifest.`);
  }
  return model;
}

function normalizeTag(tag: CacheTag): CacheTag {
  const normalized = tag.trim();
  if (normalized.length === 0) throw new AtticConfigurationError("Cache tags must not be empty.");
  return normalized;
}

function addDependency(manifest: AtticManifest, tags: Set<CacheTag>, dependency: CacheTag): void {
  const model = manifest.models[dependency];
  tags.add(normalizeTag(model?.tag ?? dependency));
}

function alreadyVisited(visited: WeakMap<object, Set<string>>, value: object, modelName: string): boolean {
  const models = visited.get(value);
  if (models?.has(modelName) === true) return true;
  if (models === undefined) visited.set(value, new Set([modelName]));
  else models.add(modelName);
  return false;
}

export function modelTag(manifest: AtticManifest, modelName: string): CacheTag {
  return normalizeTag(manifestModel(manifest, modelName).tag);
}

export function normalizeTags(tags: readonly CacheTag[]): readonly CacheTag[] {
  return [...new Set(tags.map(normalizeTag))].sort();
}

/**
 * Resolves every model and join-table tag on which a Prisma query depends.
 * Relation fields are discovered recursively in filters, ordering and selections.
 */
export function resolveDependencyTags(
  manifest: AtticManifest,
  modelName: string,
  args: unknown,
  manualTags: readonly CacheTag[] = [],
): readonly CacheTag[] {
  const tags = new Set<CacheTag>([ATTIC_GLOBAL_TAG, modelTag(manifest, modelName)]);
  for (const tag of manualTags) tags.add(normalizeTag(tag));

  const visited = new WeakMap<object, Set<string>>();
  const visit = (currentModelName: string, value: unknown): void => {
    if (typeof value !== "object" || value === null) return;
    if (alreadyVisited(visited, value, currentModelName)) return;

    if (Array.isArray(value)) {
      for (const item of value) visit(currentModelName, item);
      return;
    }

    const currentModel = manifestModel(manifest, currentModelName);
    for (const [field, child] of Object.entries(value)) {
      const relation = currentModel.relations[field];
      if (relation === undefined || child === false || child === null || child === undefined) {
        visit(currentModelName, child);
        continue;
      }

      addDependency(manifest, tags, relation.model);
      for (const dependency of relation.dependencies) addDependency(manifest, tags, dependency);
      visit(relation.model, child);
    }
  };

  visit(modelName, args);
  return [...tags].sort();
}

export function tagsForModels(manifest: AtticManifest, modelNames: readonly string[]): readonly CacheTag[] {
  return normalizeTags([ATTIC_GLOBAL_TAG, ...modelNames.map((modelName) => modelTag(manifest, modelName))]);
}
