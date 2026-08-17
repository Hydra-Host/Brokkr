import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { Building2, Globe, Mail, Save } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { useSession } from '@repo/auth/client';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { Separator } from '@repo/ui/components/separator';
import { FormCountrySelect } from '@repo/ui/form/form-country-select';
import { FormInput } from '@repo/ui/form/form-input';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { formatShortDate } from '@repo/utils';
import { BootScreen } from '~/components/boot-screen';
import { tsr } from '~/lib/api';

export const Route = createFileRoute('/_app/organizations/settings')({
  staticData: { breadcrumb: 'Settings', description: 'Update organization name, slug, and preferences' },
  component: SettingsPage,
});

const updateOrganizationSchema = z.object({
  name: z
    .string()
    .min(1, 'Organization name is required')
    .max(100, 'Organization name must be less than 100 characters'),
  email: z.string().email('Must be a valid email').or(z.literal('')).optional(),
  country: z.string().max(100).optional(),
});

type UpdateOrganizationFormData = z.infer<typeof updateOrganizationSchema>;

function SettingsSkeleton() {
  return <BootScreen />;
}

function SettingsPage() {
  useDocumentTitle('Organization Settings');

  const { data: session } = useSession();
  const queryClient = useQueryClient();
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const activeOrgId = (session?.session as { activeOrganizationId?: string } | undefined)?.activeOrganizationId;

  const { data: organizationsData } = tsr.listOrganizations.useQuery({
    queryKey: ['organizations'],
    queryData: { query: { pageSize: 100 } },
  });

  const activeOrg = organizationsData?.body?.data?.find((o) => o.id === activeOrgId);
  const canEdit = activeOrg?.permissions?.includes('organization:update') ?? false;

  const { data: orgData, isLoading } = tsr.getOrganization.useQuery({
    queryKey: ['organization', activeOrgId],
    queryData: {},
    enabled: !!activeOrgId,
  });

  const organization = orgData?.status === 200 ? orgData.body : null;

  const form = useForm<UpdateOrganizationFormData>({
    resolver: zodResolver(updateOrganizationSchema),
    defaultValues: {
      name: '',
      email: '',
      country: '',
    },
  });

  useEffect(() => {
    if (organization) {
      form.reset({
        name: organization.name,
        email: organization.email ?? '',
        country: organization.country ?? '',
      });
    }
  }, [organization, form]);

  const updateMutation = tsr.updateOrganization.useMutation();

  const onSubmit = async (data: UpdateOrganizationFormData) => {
    if (!activeOrgId) return;

    setSaveSuccess(false);
    setSaveError(null);

    const res = await updateMutation.mutateAsync({
      body: {
        name: data.name,
        email: data.email || null,
        country: data.country || null,
      },
    });

    if (res.status === 200) {
      setSaveSuccess(true);
      await queryClient.invalidateQueries({ queryKey: ['organization'] });
      await queryClient.invalidateQueries({ queryKey: ['organizations'] });
      setTimeout(() => setSaveSuccess(false), 3000);
    } else {
      setSaveError('Failed to update organization settings');
    }
  };

  if (isLoading || !organization) {
    return <SettingsSkeleton />;
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>General Settings</CardTitle>
          <CardDescription>Update your organization&apos;s basic information.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            <FormInput
              control={form.control}
              name="name"
              label="Organization Name"
              placeholder="My Organization"
              disabled={!canEdit}
            />
            <FormInput
              control={form.control}
              name="email"
              label="Contact Email"
              placeholder="contact@example.com"
              type="email"
              description="Primary contact email for your organization."
              disabled={!canEdit}
            />
            <FormCountrySelect
              control={form.control}
              name="country"
              label="Country"
              description="Country where your organization is based."
              disabled={!canEdit}
            />

            {canEdit && (
              <div className="flex items-center gap-3">
                <Button type="submit" disabled={updateMutation.isPending || !form.formState.isDirty}>
                  <Save className="mr-2 h-4 w-4" />
                  {updateMutation.isPending ? 'Saving...' : 'Save Changes'}
                </Button>
                {saveSuccess && (
                  <span className="text-status-online text-sm font-medium">Settings saved successfully!</span>
                )}
                {saveError && <span className="text-destructive text-sm font-medium">{saveError}</span>}
              </div>
            )}

            {!canEdit && (
              <p className="text-muted-foreground text-sm">
                You need the organization:update permission to edit organization settings.
              </p>
            )}
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Organization Details</CardTitle>
          <CardDescription>Read-only information about your organization.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <DetailRow icon={<Building2 className="h-4 w-4" />} label="Organization ID" value={organization.id} />
            <Separator />
            <DetailRow
              icon={<Globe className="h-4 w-4" />}
              label="Account Type"
              value={
                <Badge variant={organization.tenantType === 'SupplyCustomer' ? 'default' : 'secondary'}>
                  {organization.tenantType === 'SupplyCustomer' ? 'Supply Customer' : 'Demand Customer'}
                </Badge>
              }
            />
            <Separator />
            <DetailRow
              icon={<Mail className="h-4 w-4" />}
              label="Created"
              value={formatShortDate(organization.createdAt)}
            />
            {organization.updatedAt && (
              <>
                <Separator />
                <DetailRow
                  icon={<Mail className="h-4 w-4" />}
                  label="Last Updated"
                  value={formatShortDate(organization.updatedAt)}
                />
              </>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function DetailRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-3">
        <span className="text-muted-foreground">{icon}</span>
        <span className="text-sm font-medium">{label}</span>
      </div>
      <div className="text-muted-foreground font-mono text-sm">{value}</div>
    </div>
  );
}
