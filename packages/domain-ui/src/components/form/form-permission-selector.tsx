import type { PermissionDefinition } from '@repo/api-client';
import { Field, FieldDescription, FieldError, FieldLabel } from '@repo/ui/components/field';
import { useEffect, useMemo } from 'react';
import { type Control, type FieldValues, type Path, useController } from 'react-hook-form';
import { PermissionGroup } from '../permission-group';

interface FormPermissionSelectorProps<T extends FieldValues, P extends PermissionDefinition> {
  control: Control<T>;
  name: Path<T>;
  label: string;
  permissions: P[];
  isPermissionCatalogAuthoritative: boolean;
  description?: string;
  emptyMessage?: string;
  isPermissionDisabled?: (permission: P) => boolean;
  resourcePriority?: (resource: string) => number;
}

function selectedPermissionKeys(
  value: unknown,
  availableKeys: ReadonlySet<string>,
  isPermissionCatalogAuthoritative: boolean,
): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is string =>
      typeof item === 'string' && (!isPermissionCatalogAuthoritative || availableKeys.has(item)),
  );
}

export function FormPermissionSelector<T extends FieldValues, P extends PermissionDefinition>({
  control,
  name,
  label,
  permissions,
  isPermissionCatalogAuthoritative,
  description,
  emptyMessage = 'No permissions available.',
  isPermissionDisabled = () => false,
  resourcePriority,
}: FormPermissionSelectorProps<T, P>) {
  const { field, fieldState } = useController({ control, name });
  const { onChange, value } = field;
  const availableKeys = useMemo(
    () => new Set<string>(permissions.map((permission) => `${permission.resource}:${permission.action}`)),
    [permissions],
  );
  const selectedValues = useMemo(
    () => selectedPermissionKeys(value, availableKeys, isPermissionCatalogAuthoritative),
    [availableKeys, isPermissionCatalogAuthoritative, value],
  );
  const selectedPermissions = new Set(selectedValues);
  const permissionGroups = new Map<string, P[]>();

  useEffect(() => {
    if (isPermissionCatalogAuthoritative && Array.isArray(value) && selectedValues.length !== value.length) {
      onChange(selectedValues);
    }
  }, [isPermissionCatalogAuthoritative, onChange, selectedValues, value]);

  for (const permission of permissions) {
    const group = permissionGroups.get(permission.resource);
    if (group) group.push(permission);
    else permissionGroups.set(permission.resource, [permission]);
  }
  const groupEntries = Array.from(permissionGroups.entries());
  if (resourcePriority) {
    groupEntries.sort(
      ([left], [right]) => resourcePriority(left) - resourcePriority(right) || left.localeCompare(right),
    );
  }

  const togglePermission = (key: string) => {
    const next = new Set(selectedPermissions);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    field.onChange(Array.from(next));
  };

  const toggleGroup = (groupPermissions: P[]) => {
    const next = new Set(selectedPermissions);
    const keys = groupPermissions
      .filter((permission) => !isPermissionDisabled(permission))
      .map((permission) => `${permission.resource}:${permission.action}`);
    const allSelected = keys.every((key) => next.has(key));
    for (const key of keys) {
      if (allSelected) next.delete(key);
      else next.add(key);
    }
    field.onChange(Array.from(next));
  };

  return (
    <Field data-invalid={fieldState.invalid}>
      <FieldLabel>{`${label} (${selectedPermissions.size} selected)`}</FieldLabel>
      {description && <FieldDescription>{description}</FieldDescription>}
      {permissionGroups.size === 0 ? (
        <p className="text-muted-foreground text-sm">{emptyMessage}</p>
      ) : (
        <div className="grid [grid-template-columns:repeat(auto-fit,minmax(min(100%,24rem),1fr))] gap-3">
          {groupEntries.map(([resource, groupPermissions]) => (
            <PermissionGroup
              key={resource}
              resource={resource}
              permissions={groupPermissions}
              selectedPermissions={selectedPermissions}
              onTogglePermission={togglePermission}
              onToggleGroup={toggleGroup}
              isPermissionDisabled={isPermissionDisabled}
            />
          ))}
        </div>
      )}
      {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
    </Field>
  );
}
