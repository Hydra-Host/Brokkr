import { LayerBuildStatus } from '@repo/database';

type ImportAction = 'CREATE' | 'REIMPORT';

export function resolveImportAction(existingStatus: LayerBuildStatus | null): ImportAction {
  if (existingStatus === null) return 'CREATE';
  if (existingStatus === LayerBuildStatus.IMPORTING || existingStatus === LayerBuildStatus.FAILED) return 'REIMPORT';
  throw new Error(
    `Cannot re-import: existing build has status=${existingStatus}. ` +
      `Each manifest version creates a single immutable build.`,
  );
}
