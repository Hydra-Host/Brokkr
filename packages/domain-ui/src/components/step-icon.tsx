import { cn } from '@repo/ui/utils';
import { Circle, CircleCheck, CircleX, Loader2 } from 'lucide-react';

export function StepIcon({ status, size = 16, className }: { status: string; size?: number; className?: string }) {
  switch (status) {
    case 'complete':
      return <CircleCheck size={size} className={cn('text-green-500', className)} />;
    case 'running':
      return <Loader2 size={size} className={cn('animate-spin text-blue-500', className)} />;
    case 'failed':
      return <CircleX size={size} className={cn('text-destructive', className)} />;
    default:
      return <Circle size={size} className={cn('text-muted-foreground/40', className)} />;
  }
}
