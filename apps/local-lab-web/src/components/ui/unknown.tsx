/** Rendered wherever a value could not be determined, so an undetermined field is visibly absent
 *  rather than dressed as a measured zero. Pair it with a title saying what could not be read. */
export const UNKNOWN = '?';

export function Unknown({ title }: { title: string }) {
  return (
    <span className="text-text-dim" title={title}>
      {UNKNOWN}
    </span>
  );
}
