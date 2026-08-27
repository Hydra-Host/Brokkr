import { Badge } from '@repo/ui/components/badge';
import { cn } from '@repo/ui/utils';
import { capitalizeFirstLetter, getDeviceStatusBadgeVariant, getStatusPulseEffect } from '@repo/utils';
import type { LucideIcon } from 'lucide-react';

export function DeviceStatusBadge({
  status,
  icon: Icon,
  className,
}: {
  status: string;
  icon?: LucideIcon;
  className?: string;
}) {
  const variant = getDeviceStatusBadgeVariant(status);
  const pulse = getStatusPulseEffect(status);

  return (
    <Badge variant={variant} className={cn(pulse, className)}>
      {Icon && <Icon className="mr-1.5 h-3 w-3" />}
      {capitalizeFirstLetter(status) || 'Unknown'}
    </Badge>
  );
}
