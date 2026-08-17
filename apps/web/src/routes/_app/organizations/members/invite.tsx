import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { AlertCircle } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { CreateInvitationRequestSchema, type CreateInvitationRequest } from '@repo/api-client';
import { useSession } from '@repo/auth/client';
import { Alert, AlertDescription, AlertTitle } from '@repo/ui/components/alert';
import { Button } from '@repo/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@repo/ui/components/dialog';
import { FormInput } from '@repo/ui/form/form-input';
import { FormSelect } from '@repo/ui/form/form-select';
import { FormSubmitButton } from '@repo/ui/form/form-submit-button';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { isRecord, unwrapErrorMessage } from '@repo/utils';
import { usePermissions } from '~/hooks/use-permissions';
import { tsr } from '~/lib/api';

export const Route = createFileRoute('/_app/organizations/members/invite')({
  staticData: { breadcrumb: 'Invite Member' },
  component: InviteMemberPage,
});

function InviteMemberPage() {
  useDocumentTitle('Invite Member');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: session } = useSession();
  const activeOrgId =
    isRecord(session?.session) && typeof session.session.activeOrganizationId === 'string'
      ? session.session.activeOrganizationId
      : undefined;
  const { permissions } = usePermissions();

  const rolesQuery = tsr.listOrganizationRoles.useQuery({
    queryKey: ['organization-roles', activeOrgId],
    enabled: !!activeOrgId,
  });
  const roles = rolesQuery.data?.status === 200 ? rolesQuery.data.body : [];
  const permissionsQuery = tsr.listPermissions.useQuery({
    queryKey: ['permissions'],
    enabled: !!activeOrgId,
  });
  const catalog = permissionsQuery.data?.status === 200 ? permissionsQuery.data.body : [];
  const canManageOwners =
    catalog.length > 0 && catalog.every(({ resource, action }) => permissions.has(`${resource}:${action}`));
  const roleOptions = roles
    .filter((role) => !role.isOwnerCapable || canManageOwners)
    .map((role) => ({ label: role.name, value: role.id }));
  const rolesFailed = rolesQuery.isError || (rolesQuery.data !== undefined && rolesQuery.data.status !== 200);

  const [submissionError, setSubmissionError] = useState<string>();
  const { mutateAsync: createInvitation, isPending } = tsr.createInvitation.useMutation({ meta: { silent: true } });
  const { control, handleSubmit, reset, watch } = useForm<CreateInvitationRequest>({
    resolver: zodResolver(CreateInvitationRequestSchema),
    defaultValues: { email: '', roleId: '' },
  });
  const selectedRoleId = watch('roleId');

  function onClose() {
    navigate({ to: '/organizations/members' });
  }

  const onSubmit = handleSubmit(
    async (formData) => {
      setSubmissionError(undefined);

      try {
        const response = await createInvitation({ body: formData });
        if (response.status !== 200) {
          const message = unwrapErrorMessage(response, 'Failed to send invitation');
          setSubmissionError(message);
          toast.error(message);
          return;
        }
      } catch (error) {
        const message = unwrapErrorMessage(error, 'Failed to send invitation');
        setSubmissionError(message);
        toast.error(message);
        return;
      }

      reset();
      await queryClient.invalidateQueries({ queryKey: ['invitations'] });
      toast.success('Invitation sent successfully');
      onClose();
    },
    () => setSubmissionError('Please correct the highlighted fields.'),
  );

  return (
    <Dialog open={true} onOpenChange={(open) => !open && !isPending && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Invite Member</DialogTitle>
          <DialogDescription>Enter the email address and select a role to invite a new member.</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <FormInput control={control} name="email" label="Email" placeholder="colleague@example.com" type="email" />
          <FormSelect
            control={control}
            name="roleId"
            label="Role"
            options={roleOptions}
            placeholder={
              !activeOrgId
                ? 'No organization selected'
                : rolesQuery.isLoading
                  ? 'Loading roles...'
                  : roleOptions.length === 0
                    ? 'No roles available'
                    : 'Select a role'
            }
            description={
              activeOrgId && !rolesQuery.isLoading && !rolesFailed && roleOptions.length === 0
                ? 'This organization has no assignable roles.'
                : undefined
            }
            disabled={!activeOrgId || rolesQuery.isLoading || rolesFailed || roleOptions.length === 0}
          />
          {rolesFailed && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Could not load organization roles</AlertTitle>
              <AlertDescription>Refresh the page or try again in a moment.</AlertDescription>
            </Alert>
          )}
          {submissionError && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Invitation not sent</AlertTitle>
              <AlertDescription>{submissionError}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={isPending}>
              Cancel
            </Button>
            <FormSubmitButton
              pending={isPending}
              disabled={
                !activeOrgId || rolesQuery.isLoading || rolesFailed || roleOptions.length === 0 || !selectedRoleId
              }
            >
              Send Invitation
            </FormSubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
