import { zodResolver } from '@hookform/resolvers/zod';
import type { InvitationWithOrganization } from '@repo/api-client';
import { useSession } from '@repo/auth/client';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { Label } from '@repo/ui/components/label';
import { RadioGroup, RadioGroupItem } from '@repo/ui/components/radio-group';
import { FormInput } from '@repo/ui/form/form-input';
import { FormSubmitButton } from '@repo/ui/form/form-submit-button';
import { Logo } from '@repo/ui/logo';
import { cn } from '@repo/ui/utils';
import { createFileRoute, Navigate, useNavigate, useSearch } from '@tanstack/react-router';
import { Building2, ChevronRight, Loader2, Mail } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { tsr } from '~/lib/api';
import { BRAND_NAME } from '~/lib/branding';
import { isLocalSimulationEnabled } from '~/lib/env';
import { getLandingRoute } from '~/lib/landing-route';
import { sanitizeRedirect } from '~/lib/safe-redirect';

const searchSchema = z.object({
  redirect: z.string().optional(),
  create: z.boolean().optional(),
});

export const Route = createFileRoute('/onboarding/organization')({
  validateSearch: searchSchema,
  component: OnboardingOrganization,
});

const createOrganizationSchema = z.object({
  organizationName: z
    .string()
    .min(1, 'Organization name is required')
    .max(100, 'Organization name must be less than 100 characters'),
  accountType: z.enum(['demand', 'supply']),
});

type CreateOrganizationFormData = z.infer<typeof createOrganizationSchema>;

function OnboardingOrganization() {
  const { data: session, isPending: sessionPending, refetch: refetchSession } = useSession();
  const { mutate: createOrganization, isPending: createOrganizationPending } = tsr.createOrganization.useMutation();
  const { mutateAsync: acceptInvitationMutation } = tsr.acceptMyInvitation.useMutation();
  const { mutateAsync: setActiveOrgMutation } = tsr.setActiveOrganization.useMutation();
  const { mutateAsync: rejectInvitationMutation } = tsr.rejectMyInvitation.useMutation({
    meta: { successMessage: 'Invitation declined' },
  });
  const [setActiveOrganizationPending, setSetActiveOrganizationPending] = useState(false);
  const [acceptingInvitationId, setAcceptingInvitationId] = useState<string | null>(null);
  const [rejectingInvitationId, setRejectingInvitationId] = useState<string | null>(null);
  const autoRedirectAttempted = useRef(false);

  const navigate = useNavigate();
  const api = tsr.useQueryClient();
  const { redirect: redirectTo, create: createMode } = useSearch({
    from: '/onboarding/organization',
  });

  const { data: organizations, isPending: organizationsPending } = tsr.listOrganizations.useQuery({
    queryKey: ['organizations'],
    queryData: { query: { pageSize: 100 } },
  });

  const { data: invitations, isPending: invitationsPending } = tsr.listMyInvitations.useQuery({
    queryKey: ['my-invitations'],
    queryData: { query: { pageSize: 100 } },
  });

  const { data: allowedTypes } = tsr.getAllowedOrganizationTypes.useQuery({
    queryKey: ['organization-allowed-types'],
    queryData: {},
  });
  const canSelectSupply = allowedTypes?.status === 200 ? allowedTypes.body.types.includes('SupplyCustomer') : false;

  const getDestination = (orgId: string) => {
    const safeRedirect = sanitizeRedirect(redirectTo);
    if (safeRedirect) return safeRedirect;
    const org = organizations?.body?.data?.find((o) => o.id === orgId);
    return getLandingRoute(org?.tenantType);
  };

  const form = useForm<CreateOrganizationFormData>({
    resolver: zodResolver(createOrganizationSchema),
    defaultValues: {
      organizationName: '',
      accountType: 'demand',
    },
  });

  const handleSetActiveOrganization = async (organizationId: string) => {
    try {
      setSetActiveOrganizationPending(true);
      await setActiveOrgMutation({ params: { id: organizationId }, body: {} });
      // Session must reflect the new activeOrganizationId before navigating, or the _app gate bounces.
      await refetchSession();
      await api.refetchQueries({ queryKey: ['organizations'] });
      navigate({ to: getDestination(organizationId) });
    } catch (err) {
      console.error('Failed to set active organization:', err);
    } finally {
      setSetActiveOrganizationPending(false);
    }
  };

  const handleAcceptInvitation = async (invitation: InvitationWithOrganization) => {
    try {
      setAcceptingInvitationId(invitation.id);
      await acceptInvitationMutation({
        params: { invitationId: invitation.id },
        body: {},
      });
      await setActiveOrgMutation({ params: { id: invitation.organizationId }, body: {} });
      await refetchSession();
      await api.refetchQueries({ queryKey: ['organizations'] });
      void api.invalidateQueries({ queryKey: ['my-invitations'] });
      navigate({ to: getDestination(invitation.organizationId) });
    } catch (err) {
      console.error('Failed to accept invitation:', err);
    } finally {
      setAcceptingInvitationId(null);
    }
  };

  const handleRejectInvitation = async (invitation: InvitationWithOrganization) => {
    setRejectingInvitationId(invitation.id);
    try {
      await rejectInvitationMutation({
        params: { invitationId: invitation.id },
        body: {},
      });
      void api.invalidateQueries({ queryKey: ['my-invitations'] });
    } finally {
      setRejectingInvitationId(null);
    }
  };

  const handleCreateOrganization = (data: CreateOrganizationFormData) => {
    const type = data.accountType === 'demand' ? 'DemandCustomer' : 'SupplyCustomer';

    createOrganization(
      {
        body: {
          name: data.organizationName,
          type,
        },
      },
      {
        onSuccess: async (response) => {
          if (response.status !== 201) return;
          try {
            setSetActiveOrganizationPending(true);
            await setActiveOrgMutation({ params: { id: response.body.id }, body: {} });
            await refetchSession();
            await api.refetchQueries({ queryKey: ['organizations'] });
            const destination = sanitizeRedirect(redirectTo) || getLandingRoute(type);
            navigate({ to: destination });
          } catch (err) {
            console.error('Failed to set active organization:', err);
          } finally {
            setSetActiveOrganizationPending(false);
          }
        },
      },
    );
  };

  const defaultOrg =
    organizations?.status === 200 ? organizations.body.data.find((o) => o.isDefaultOrg === true) : undefined;

  useEffect(() => {
    if (defaultOrg && !autoRedirectAttempted.current && !createMode) {
      autoRedirectAttempted.current = true;
      handleSetActiveOrganization(defaultOrg.id);
    }
  }, [defaultOrg, createMode]); // eslint-disable-line react-hooks/exhaustive-deps

  if (sessionPending) {
    return (
      <div className="flex min-h-svh flex-col items-center justify-center">
        <Loader2 className="text-muted-foreground h-8 w-8 animate-spin" />
      </div>
    );
  }

  if (!session) {
    return <Navigate to="/auth/login" />;
  }

  if (!session.user.twoFactorEnabled && !import.meta.env.DEV && !isLocalSimulationEnabled()) {
    const redirect = sanitizeRedirect(redirectTo);
    return <Navigate to="/auth/setup-two-factor" search={redirect ? { redirect } : {}} />;
  }

  if (organizationsPending || invitationsPending) {
    return (
      <div className="flex min-h-svh flex-col items-center justify-center">
        <Loader2 className="text-muted-foreground h-8 w-8 animate-spin" />
      </div>
    );
  }

  if (defaultOrg && !createMode) {
    return (
      <div className="flex min-h-svh flex-col items-center justify-center">
        <Loader2 className="text-muted-foreground h-8 w-8 animate-spin" />
      </div>
    );
  }

  const hasOrganizations = organizations && organizations.body.data.length > 0;
  const pendingInvitations = invitations?.status === 200 ? invitations.body.data : [];
  const hasPendingInvitations = pendingInvitations.length > 0;

  if (hasOrganizations) {
    return (
      <div className="flex min-h-svh flex-col items-center justify-center p-4">
        <div className="w-full max-w-lg space-y-6">
          <Logo className="mx-auto h-8 w-auto" />
          <Card>
            <CardHeader className="text-center">
              <CardTitle>Select Organization</CardTitle>
              <CardDescription>Choose an organization to continue to your dashboard</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid gap-3">
                {organizations.body.data
                  .slice()
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map((org) => (
                    <button
                      key={org.id}
                      type="button"
                      onClick={() => handleSetActiveOrganization(org.id)}
                      disabled={setActiveOrganizationPending}
                      className={cn(
                        'flex w-full items-center justify-between rounded-lg border p-4 text-left transition-all',
                        'hover:bg-muted/50 hover:border-primary/50',
                        'focus:ring-primary focus:ring-2 focus:ring-offset-2 focus:outline-none',
                        'disabled:cursor-not-allowed disabled:opacity-50',
                      )}
                    >
                      <div className="flex items-center gap-3">
                        <Building2 className="text-muted-foreground h-5 w-5" />
                        <div>
                          <div className="font-medium">{org.name}</div>
                          <div className="text-muted-foreground text-sm">{org.role}</div>
                        </div>
                      </div>
                      {setActiveOrganizationPending ? (
                        <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
                      ) : (
                        <ChevronRight className="text-muted-foreground h-4 w-4" />
                      )}
                    </button>
                  ))}
              </div>
            </CardContent>
          </Card>

          {hasPendingInvitations && (
            <PendingInvitationsCard
              invitations={pendingInvitations}
              onAccept={handleAcceptInvitation}
              onReject={handleRejectInvitation}
              acceptingInvitationId={acceptingInvitationId}
              rejectingInvitationId={rejectingInvitationId}
            />
          )}

          {createMode && (
            <CreateOrganizationCard
              form={form}
              onSubmit={handleCreateOrganization}
              isPending={createOrganizationPending}
              canSelectSupply={canSelectSupply}
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-svh flex-col items-center justify-center p-4">
      <div className="w-full max-w-lg space-y-6">
        <Logo className="mx-auto h-8 w-auto" />

        {hasPendingInvitations && (
          <>
            <PendingInvitationsCard
              invitations={pendingInvitations}
              onAccept={handleAcceptInvitation}
              onReject={handleRejectInvitation}
              acceptingInvitationId={acceptingInvitationId}
              rejectingInvitationId={rejectingInvitationId}
            />
            <div className="text-center">
              <p className="text-muted-foreground text-sm">Or create a new organization below</p>
            </div>
          </>
        )}

        <CreateOrganizationCard
          form={form}
          onSubmit={handleCreateOrganization}
          isPending={createOrganizationPending}
          canSelectSupply={canSelectSupply}
        />
      </div>
    </div>
  );
}

interface PendingInvitationsCardProps {
  invitations: InvitationWithOrganization[];
  onAccept: (invitation: InvitationWithOrganization) => void;
  onReject: (invitation: InvitationWithOrganization) => void;
  acceptingInvitationId: string | null;
  rejectingInvitationId: string | null;
}

function PendingInvitationsCard({
  invitations,
  onAccept,
  onReject,
  acceptingInvitationId,
  rejectingInvitationId,
}: PendingInvitationsCardProps) {
  const isBusy = acceptingInvitationId !== null || rejectingInvitationId !== null;

  return (
    <Card>
      <CardHeader className="text-center">
        <CardTitle>Pending Invitations</CardTitle>
        <CardDescription>You&apos;ve been invited to join the following organizations</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3">
          {invitations.map((invitation) => (
            <div key={invitation.id} className="flex w-full items-center justify-between rounded-lg border p-4">
              <div className="flex items-center gap-3">
                <Mail className="text-muted-foreground h-5 w-5" />
                <div>
                  <div className="font-medium">{invitation.organizationName}</div>
                  <div className="text-muted-foreground text-sm capitalize">Invited as {invitation.role}</div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => onReject(invitation)} disabled={isBusy}>
                  {rejectingInvitationId === invitation.id ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Decline'}
                </Button>
                <Button size="sm" onClick={() => onAccept(invitation)} disabled={isBusy}>
                  {acceptingInvitationId === invitation.id ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Accept'}
                </Button>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

interface CreateOrganizationCardProps {
  form: ReturnType<typeof useForm<CreateOrganizationFormData>>;
  onSubmit: (data: CreateOrganizationFormData) => void;
  isPending: boolean;
  canSelectSupply: boolean;
}

function CreateOrganizationCard({ form, onSubmit, isPending, canSelectSupply }: CreateOrganizationCardProps) {
  return (
    <Card>
      <CardHeader className="text-center">
        <CardTitle>Create Your Organization</CardTitle>
        <CardDescription>Start your own organization to begin using {BRAND_NAME}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
          <FormInput
            control={form.control}
            name="organizationName"
            label="Organization Name"
            placeholder="Give a name to your organization"
          />

          {canSelectSupply && (
            <Controller
              name="accountType"
              control={form.control}
              render={({ field }) => (
                <div className="space-y-3">
                  <Label>Account Type</Label>
                  <RadioGroup value={field.value} onValueChange={field.onChange} className="grid gap-4">
                    <div className="bg-card has-[button[data-state='checked']]:bg-muted/50 cursor-pointer rounded-md border p-4">
                      <Label htmlFor="demand" className="w-full cursor-pointer">
                        <div className="flex items-start gap-4">
                          <RadioGroupItem id="demand" value="demand" className="my-auto" />
                          <div className="grid gap-2">
                            <div className="text-base font-semibold">Rent GPU compute</div>
                            <div className="text-muted-foreground text-sm">
                              Ideal for individuals and companies looking to rent GPU compute resources for their
                              projects.
                            </div>
                          </div>
                        </div>
                      </Label>
                    </div>

                    <div className="bg-card has-[button[data-state='checked']]:bg-muted/50 cursor-pointer rounded-md border p-4">
                      <Label htmlFor="supply" className="w-full cursor-pointer">
                        <div className="flex items-start gap-4">
                          <RadioGroupItem id="supply" value="supply" className="my-auto" />
                          <div className="grid gap-2">
                            <div className="text-base font-semibold">Become a supplier</div>
                            <div className="text-muted-foreground text-sm">
                              Suitable for those who wish to offer GPU compute resources and connect with those in need
                              of these services.
                            </div>
                          </div>
                        </div>
                      </Label>
                    </div>
                  </RadioGroup>
                </div>
              )}
            />
          )}

          <FormSubmitButton className="w-full" pending={isPending}>
            Create Organization
          </FormSubmitButton>
        </form>
      </CardContent>
    </Card>
  );
}
