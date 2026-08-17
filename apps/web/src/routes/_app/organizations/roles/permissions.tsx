import { Badge } from '@repo/ui/components/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@repo/ui/components/dialog';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useMemo } from 'react';
import { tsr } from '~/lib/api';

import type { PermissionDefinition } from '@repo/api-client';

export const Route = createFileRoute('/_app/organizations/roles/permissions')({
  staticData: { breadcrumb: 'Permissions' },
  component: PermissionsDialog,
});

function PermissionsDialog() {
  useDocumentTitle('All Permissions');
  const navigate = useNavigate();

  const { data: permissionsResponse } = tsr.listPermissions.useQuery({
    queryKey: ['permissions'],
  });

  const permissions = permissionsResponse?.status === 200 ? permissionsResponse.body : [];

  const grouped = useMemo(() => {
    const groups = new Map<string, PermissionDefinition[]>();
    for (const perm of permissions) {
      const existing = groups.get(perm.resource);
      if (existing) {
        existing.push(perm);
      } else {
        groups.set(perm.resource, [perm]);
      }
    }
    return groups;
  }, [permissions]);

  function onClose() {
    navigate({ to: '/organizations/roles' });
  }

  return (
    <Dialog open={true} onOpenChange={onClose}>
      <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>All Permissions</DialogTitle>
          <DialogDescription>Reference of all available permissions that can be assigned to roles.</DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {Array.from(grouped.entries()).map(([resource, perms]) => (
            <div key={resource}>
              <h3 className="mb-2 text-sm font-semibold capitalize">{resource}</h3>
              <div className="space-y-2">
                {perms.map((perm) => (
                  <div key={`${perm.resource}:${perm.action}`} className="flex items-start gap-3 rounded-md border p-3">
                    <Badge variant="outline" className="shrink-0 font-mono text-xs">
                      {perm.resource}:{perm.action}
                    </Badge>
                    <span className="text-muted-foreground text-sm">{perm.description ?? 'No description'}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}

          {grouped.size === 0 && (
            <p className="text-muted-foreground py-8 text-center text-sm">No permissions defined.</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
