import { zodResolver } from '@hookform/resolvers/zod';
import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { useSession } from '@repo/auth/client';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@repo/ui/components/card';
import { Label } from '@repo/ui/components/label';
import { FormInput } from '@repo/ui/form/form-input';
import { FormSelect } from '@repo/ui/form/form-select';
import { FormSubmitButton } from '@repo/ui/form/form-submit-button';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { tsr } from '~/lib/api';

const profileFormSchema = z.object({
  firstName: z.string().min(1, 'First name is required'),
  lastName: z.string().min(1, 'Last name is required'),
});

type ProfileFormData = z.infer<typeof profileFormSchema>;

export const Route = createFileRoute('/_app/account/profile')({
  staticData: { breadcrumb: 'User Profile' },
  component: ProfilePage,
});

function ProfilePage() {
  useDocumentTitle('User Profile');
  const { data: session, refetch: refetchSession } = useSession();

  const user = session?.user as
    | { id: string; name: string; email: string; firstName?: string; lastName?: string }
    | undefined;

  const { mutateAsync: updateProfile, isPending } = tsr.updateUserProfile.useMutation({
    meta: { successMessage: 'Profile updated successfully' },
  });

  const form = useForm<ProfileFormData>({
    resolver: zodResolver(profileFormSchema),
    defaultValues: {
      firstName: user?.firstName || user?.name?.split(' ')[0] || '',
      lastName: user?.lastName || user?.name?.split(' ')[1] || '',
    },
  });

  const onSubmit = async (data: ProfileFormData) => {
    await updateProfile({ body: data });

    await refetchSession();
  };

  return (
    <div className="space-y-6">
      <Card>
        <form onSubmit={form.handleSubmit(onSubmit)}>
          <CardHeader>
            <CardTitle>User Profile</CardTitle>
            <CardDescription>Update your personal information.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid max-w-lg grid-cols-2 gap-4">
              <FormInput
                control={form.control}
                name="firstName"
                label="First Name"
                placeholder="First name"
                autoFocus
              />
              <FormInput control={form.control} name="lastName" label="Last Name" placeholder="Last name" />
            </div>
            <div className="max-w-lg space-y-2">
              <Label htmlFor="profile-email">Email</Label>
              <p id="profile-email" className="text-muted-foreground text-sm">
                {user?.email}
              </p>
            </div>
          </CardContent>
          <CardFooter className="px-4 py-4">
            <FormSubmitButton pending={isPending}>Save Changes</FormSubmitButton>
          </CardFooter>
        </form>
      </Card>

      <DefaultOrganizationCard />
    </div>
  );
}

const defaultOrgFormSchema = z.object({
  organizationId: z.string().min(1),
});

type DefaultOrgFormData = z.infer<typeof defaultOrgFormSchema>;

function DefaultOrganizationCard() {
  const queryClient = tsr.useQueryClient();

  const { data: organizations } = tsr.listOrganizations.useQuery({
    queryKey: ['organizations'],
    queryData: { query: { pageSize: 100 } },
  });

  const { mutateAsync: setDefaultOrg, isPending } = tsr.setDefaultOrganization.useMutation({
    meta: { successMessage: 'Default organization updated successfully' },
  });

  const orgList = useMemo(() => (organizations?.status === 200 ? organizations.body.data : []), [organizations]);
  const defaultOrg = orgList.find((o) => o.isDefaultOrg === true);

  const form = useForm<DefaultOrgFormData>({
    resolver: zodResolver(defaultOrgFormSchema),
    defaultValues: {
      organizationId: defaultOrg?.id ?? orgList[0]?.id ?? '',
    },
  });

  useEffect(() => {
    const currentDefault = defaultOrg?.id ?? orgList[0]?.id ?? '';
    if (currentDefault && !form.formState.isDirty) {
      form.reset({ organizationId: currentDefault });
    }
  }, [defaultOrg?.id, orgList, form]);

  if (orgList.length <= 1) {
    return null;
  }

  const selectedOrgId = form.watch('organizationId');
  const hasChanged = selectedOrgId !== (defaultOrg?.id ?? orgList[0]?.id);

  const options = orgList.map((org) => ({
    value: org.id,
    label: org.isDefaultOrg ? `${org.name} (Current)` : org.name,
  }));

  const onSubmit = async (data: DefaultOrgFormData) => {
    await setDefaultOrg({ body: { organizationId: data.organizationId } });
    await queryClient.invalidateQueries({ queryKey: ['organizations'] });
    form.reset({ organizationId: data.organizationId });
  };

  return (
    <Card>
      <form onSubmit={form.handleSubmit(onSubmit)}>
        <CardHeader>
          <CardTitle>Default Organization</CardTitle>
          <CardDescription>
            Choose your default organization. This will be automatically selected when you log in.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="max-w-lg">
            <FormSelect
              control={form.control}
              name="organizationId"
              label="Default Organization"
              options={options}
              placeholder="Select an organization"
            />
            {defaultOrg && (
              <p className="text-muted-foreground mt-2 text-sm">
                Current default: <span className="font-medium">{defaultOrg.name}</span>
              </p>
            )}
          </div>
        </CardContent>
        {hasChanged && (
          <CardFooter className="px-4 py-4">
            <FormSubmitButton pending={isPending}>Save Default Organization</FormSubmitButton>
          </CardFooter>
        )}
      </form>
    </Card>
  );
}
