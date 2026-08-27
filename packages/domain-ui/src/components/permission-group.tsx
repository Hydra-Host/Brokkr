import type { PermissionDefinition } from '@repo/api-client';
import { Checkbox } from '@repo/ui/components/checkbox';
import { useId } from 'react';

export function PermissionGroup<T extends PermissionDefinition>({
  resource,
  permissions,
  selectedPermissions,
  onTogglePermission,
  onToggleGroup,
  isPermissionDisabled = () => false,
}: {
  resource: string;
  permissions: T[];
  selectedPermissions: Set<string>;
  onTogglePermission: (key: string) => void;
  onToggleGroup: (permissions: T[]) => void;
  isPermissionDisabled?: (permission: T) => boolean;
}) {
  const id = useId();
  const enabledPermissions = permissions.filter((permission) => !isPermissionDisabled(permission));
  const enabledKeys = enabledPermissions.map((permission) => `${permission.resource}:${permission.action}`);
  const enabledSelectedCount = enabledKeys.filter((key) => selectedPermissions.has(key)).length;
  const allSelected = enabledKeys.length > 0 && enabledSelectedCount === enabledKeys.length;
  const someSelected = enabledSelectedCount > 0 && !allSelected;

  return (
    <section className="rounded-md border" aria-labelledby={`${id}-title`}>
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Checkbox
          id={`${id}-all`}
          checked={allSelected ? true : someSelected ? 'indeterminate' : false}
          onCheckedChange={() => onToggleGroup(enabledPermissions)}
          disabled={enabledPermissions.length === 0}
          aria-label={`${allSelected ? 'Clear' : 'Select'} all ${resource} permissions`}
        />
        <h4 id={`${id}-title`} className="min-w-0 flex-1 truncate text-sm font-medium">
          {resource}
        </h4>
        <span className="text-muted-foreground text-xs tabular-nums">
          {enabledSelectedCount}/{enabledKeys.length}
        </span>
      </div>
      <div className="grid grid-cols-1 gap-x-4 gap-y-2 px-3 py-2.5 sm:grid-cols-2">
        {permissions.map((permission) => {
          const key = `${permission.resource}:${permission.action}`;
          return (
            <Checkbox
              key={key}
              id={`${id}-${permission.action}`}
              checked={selectedPermissions.has(key)}
              onCheckedChange={() => onTogglePermission(key)}
              disabled={isPermissionDisabled(permission)}
              label={permission.action}
              aria-label={`${permission.resource}: ${permission.action}`}
              tooltip={permission.description}
              tooltipDelay={100}
              labelClassName="break-words"
            />
          );
        })}
      </div>
    </section>
  );
}
