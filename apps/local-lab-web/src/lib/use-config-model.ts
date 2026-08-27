import { useMemo } from 'react';

import type { ConfigTreeEntry } from '@/contract';

import { tsr } from '@/lib/api';
import { fieldProvenance, type FieldProvenance } from '@/lib/config-tree';
import { errorMessage } from '@/lib/errors';

export interface ConfigModel {
  /** Null while the answer is still unknown, so a page can tell "not yet" from "the seed failed". */
  seeded: boolean | null;
  error: string | null;
  entries: ConfigTreeEntry[];
  entry: (path: string) => ConfigTreeEntry | undefined;
  provenanceOf: (path: string) => FieldProvenance | null;
  refetch: () => void;
}

/** One query for the whole surface, joined by path — a per-field fetch would make a page of forty
 *  knobs forty requests. */
export function useConfigModel(): ConfigModel {
  const q = tsr.getConfigTree.useQuery({ queryKey: ['config-tree'] });
  const body = q.data?.status === 200 ? q.data.body : null;
  const entries = useMemo(() => body?.entries ?? [], [body]);
  const byPath = useMemo(() => new Map(entries.map((e) => [e.path, e])), [entries]);

  return {
    seeded: body ? body.seeded : null,
    error: errorMessage(q.error),
    entries,
    entry: (path) => byPath.get(path),
    provenanceOf: (path) => fieldProvenance(byPath.get(path)),
    refetch: () => void q.refetch(),
  };
}
