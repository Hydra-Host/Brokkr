// Every table here must have `changelog_trigger` attached via migration (guarded by `audited-tables.test.ts`); `LegacyDevice` is deliberately not asserted.
export const AUDITED_TABLES = ['Device', 'Server'] as const;
