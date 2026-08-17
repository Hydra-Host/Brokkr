export type TeeAction = 'enable' | 'disable' | 'skip';

export function decideTeeAction({
  teeRequested,
  teeEnabled,
}: {
  teeRequested: boolean;
  teeEnabled: boolean;
}): TeeAction {
  if (teeRequested && !teeEnabled) return 'enable';
  if (!teeRequested && teeEnabled) return 'disable';
  return 'skip';
}
