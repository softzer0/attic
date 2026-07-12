import type { AtticManifest, AtticTriggerManifest } from "../core/types.js";

import { triggerName } from "./sql-escaping.js";

export interface TriggerTarget {
  readonly schema: string;
  readonly table: string;
  readonly tags: readonly string[];
}

type TriggerSource = Pick<AtticManifest, "models" | "implicitJoinTables">;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Coalesces model and implicit-join triggers that resolve to one physical table. */
export function collectTriggerTargets(source: TriggerSource): TriggerTarget[] {
  const targets = new Map<string, { schema: string; table: string; tags: Set<string> }>();
  const add = (schema: string, table: string, tags: readonly string[]): void => {
    const key = `${schema}\0${table}`;
    const existing = targets.get(key);
    if (existing !== undefined) {
      for (const tag of tags) existing.tags.add(tag);
      return;
    }

    targets.set(key, { schema, table, tags: new Set(tags) });
  };

  for (const model of Object.values(source.models)) add(model.schema, model.dbName, [model.tag]);
  for (const join of source.implicitJoinTables) add(join.schema, join.name, join.tags);

  return [...targets.values()]
    .map(({ schema, table, tags }) => ({ schema, table, tags: [...tags].sort(compareText) }))
    .sort((left, right) => compareText(`${left.schema}\0${left.table}`, `${right.schema}\0${right.table}`));
}

export function buildTriggerManifest(source: TriggerSource, namespace: string): AtticTriggerManifest[] {
  return collectTriggerTargets(source).map(({ schema, table, tags }) => ({
    name: triggerName(schema, table, namespace),
    schema,
    table,
    tags,
  }));
}
