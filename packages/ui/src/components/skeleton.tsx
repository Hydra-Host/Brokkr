import { cn } from './utils';

function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('bg-border/60 animate-pulse rounded-sm', className)} {...props} />;
}

export { Skeleton };
