import type { VariantProps } from 'class-variance-authority';
import type { LucideIcon } from 'lucide-react';
import { Badge, type badgeVariants } from './badge';
import { cn } from './utils';

type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>['variant']>;

const JOB_TYPE_LABEL: Record<string, string> = {
  PowerOn: 'Power On',
  PowerOff: 'Power Off',
};

const JOB_TYPE_VARIANT: Record<string, BadgeVariant> = {
  Provision: 'success',
  Reprovision: 'info',
  Deprovision: 'destructive',
  Reboot: 'warning',
  PowerOn: 'outline',
  PowerOff: 'outline',
  Interrupted: 'destructive',
  Commission: 'purple',
  Decommission: 'destructive',
};

export function JobTypeBadge({
  jobType,
  icon: Icon,
  className,
}: {
  jobType: string;
  icon?: LucideIcon;
  className?: string;
}) {
  const variant = JOB_TYPE_VARIANT[jobType] ?? 'secondary';

  return (
    <Badge variant={variant} className={cn(className)}>
      {Icon && <Icon className="mr-1.5 h-3 w-3" />}
      {JOB_TYPE_LABEL[jobType] ?? jobType}
    </Badge>
  );
}
