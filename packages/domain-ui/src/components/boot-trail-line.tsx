import type { BootTrail } from '@repo/api-client';
import { bootTrailLine } from '@repo/utils';

export function BootTrailLine({ trail, className }: { trail: BootTrail; className?: string }) {
  return (
    <span className={className}>
      <span className="text-muted-foreground">boot trail </span>
      <span>{bootTrailLine(trail)}</span>
    </span>
  );
}
