import { cn } from '@repo/ui/utils';
import type { ReactNode } from 'react';

interface GradientBorderProps {
  children: ReactNode;
  className?: string;
}

export function GradientBorder({ children, className }: GradientBorderProps) {
  return <div className={cn('bg-primary rounded-lg p-px', className)}>{children}</div>;
}
