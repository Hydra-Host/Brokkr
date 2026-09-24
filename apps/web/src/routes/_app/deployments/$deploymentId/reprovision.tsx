import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, getRouteApi, Link, useNavigate, useRouter } from '@tanstack/react-router';
import { load } from 'js-yaml';
import { Loader2, PlusCircle } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import {
  isIpxeCustomOs,
  ReprovisionDeploymentRequestSchema,
  ReprovisionDiskLayoutSchema,
  validateDiskLayoutEncryption,
} from '@repo/api-client';
import { CustomizationLayers, type CustomizationLayersData } from '@repo/domain-ui/provision/customization-layers';
import {
  applyDirectModeToSubmission,
  diskLayoutSizeToBytes,
  getDefaultDiskLayouts,
  validateDiskLayoutSizeInputs,
} from '@repo/domain-ui/provision/disk-layout-selector';
import { ProvisionAdvancedSettings } from '@repo/domain-ui/provision/provision-advanced-settings';
import { Alert, AlertDescription } from '@repo/ui/components/alert';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@repo/ui/components/alert-dialog';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { FormCheckbox } from '@repo/ui/form/form-checkbox';
import { FormInput } from '@repo/ui/form/form-input';
import { FormMultiSelect } from '@repo/ui/form/form-multi-select';
import { FormSelect } from '@repo/ui/form/form-select';
import { FormSubmitButton } from '@repo/ui/form/form-submit-button';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { unwrapErrorMessage } from '@repo/utils';
import { tsr } from '~/lib/api';
import { isLocalSimulationEnabled } from '~/lib/env';
import {
  baseLayersToOsOptions,
  DEFAULT_OPERATING_SYSTEM,
  emptyCustomizations,
  flattenCustomizationsForSubmit,
  osCandidateForMode,
  reprovisionTeeDefault,
  resolveOperatingSystemSlug,
  shouldShowTeeCheckbox,
  TEE_CHECKBOX_DESCRIPTION,
  TEE_CHECKBOX_LABEL,
} from '~/lib/provision-customizations';
import { DEPLOYMENT_PROJECTS_KEY, LIFECYCLE_JOBS_KEY } from '~/lib/query-keys';

const parentRoute = getRouteApi('/_app/deployments/$deploymentId');

export const Route = createFileRoute('/_app/deployments/$deploymentId/reprovision')({
  staticData: { breadcrumb: 'Reprovision' },
  loader: async ({ context: { queryClient } }) => {
    const sshKeysResponse = await queryClient.fetchQuery({
      queryKey: ['organization-ssh-keys'],
      queryFn: () => tsr.getOrganizationSshKeys.query({ query: { pageSize: 100 } }),
    });

    if (sshKeysResponse.status !== 200) {
      throw new Error('Failed to load SSH keys');
    }

    return { sshKeys: sshKeysResponse.body.data };
  },
  component: ReprovisionPage,
});

const reprovisionFormSchema = ReprovisionDeploymentRequestSchema.omit({ customizations: true })
  .extend({
    cloudInit: z.string(),
    ipxeUrl: z.string(),
    customizations: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
    diskLayouts: z.array(ReprovisionDiskLayoutSchema.omit({ size: true }).extend({ size: z.string().optional() })),
  })
  .superRefine((data, ctx) => {
    if (isIpxeCustomOs(data.operatingSystem) && !data.ipxeUrl) {
      ctx.addIssue({
        code: 'custom',
        message: 'iPXE URL is required when using iPXE Custom operating system',
        path: ['ipxeUrl'],
      });
    }

    if (data.ipxeUrl && !isIpxeCustomOs(data.operatingSystem)) {
      ctx.addIssue({
        code: 'custom',
        message: 'iPXE URL can only be used with iPXE Custom operating system',
        path: ['operatingSystem'],
      });
    }

    const effectiveLayouts = applyDirectModeToSubmission(data.diskLayouts);

    const mountpoints = effectiveLayouts.map((l) => l.mountpoint).filter(Boolean);
    const uniqueMountpoints = new Set(mountpoints);
    if (uniqueMountpoints.size !== mountpoints.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'Mountpoints must be unique across all disk layouts',
        path: ['diskLayouts'],
      });
    }

    const hasRoot = effectiveLayouts.some((l) => l.mountpoint === '/');
    if (!hasRoot && effectiveLayouts.length > 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'At least one disk layout must have "/" as the mountpoint',
        path: ['diskLayouts'],
      });
    }

    if (data.cloudInit && data.cloudInit.trim()) {
      try {
        load(data.cloudInit);
      } catch (e) {
        ctx.addIssue({
          code: 'custom',
          message: `Invalid YAML: ${unwrapErrorMessage(e, 'Parse error').split('\n')[0]}`,
          path: ['cloudInit'],
        });
      }
    }

    validateDiskLayoutEncryption(data.diskLayouts, ctx, 'reprovision');
    validateDiskLayoutSizeInputs(data.diskLayouts, ctx);
  });

type ReprovisionFormData = z.infer<typeof reprovisionFormSchema>;

function ReprovisionPage() {
  const { deploymentId } = Route.useParams();
  return <ReprovisionForm key={deploymentId} />;
}

function ReprovisionForm() {
  const deployment = parentRoute.useLoaderData();
  const { sshKeys } = Route.useLoaderData();
  useDocumentTitle(`${deployment.customer?.deviceName ?? 'Deployment'} - Reprovision`);

  const navigate = useNavigate();
  const router = useRouter();
  const queryClient = useQueryClient();
  const deploymentId = String(deployment.id);

  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const EMPTY_CUSTOMIZATIONS = useMemo(
    () => emptyCustomizations(deployment.availableComponentLayersByBase),
    [deployment.availableComponentLayersByBase],
  );

  const { mutateAsync: reprovision, isPending } = tsr.reprovisionDeployment.useMutation({
    meta: {
      successMessage:
        'Device reprovisioned successfully. Your device is actively being reprovisioned and will come online soon.',
    },
  });

  const sshKeyOptions = sshKeys.map((key) => ({
    label: `[${key.user.firstName} ${key.user.lastName}] - ${key.name}`,
    value: key.id,
  }));

  const defaultOs = resolveOperatingSystemSlug(
    osCandidateForMode(deployment.availableBaseLayers),
    DEFAULT_OPERATING_SYSTEM,
  );

  const form = useForm<ReprovisionFormData>({
    resolver: zodResolver(reprovisionFormSchema),
    defaultValues: {
      deploymentName: deployment.customer?.deviceName || '',
      operatingSystem: defaultOs,
      sshKeyIds: [],
      diskLayouts: getDefaultDiskLayouts(deployment.storageLayouts),
      cloudInit: '',
      ipxeUrl: '',
      tee: reprovisionTeeDefault(defaultOs, deployment.isTeeCapable, deployment.teeEnabled),
      customizations: { ...EMPTY_CUSTOMIZATIONS },
    },
  });

  const operatingSystem = form.watch('operatingSystem');

  const osOptions = useMemo(
    () => baseLayersToOsOptions(deployment.availableBaseLayers),
    [deployment.availableBaseLayers],
  );

  const customizationsData: CustomizationLayersData | null = (() => {
    if (!operatingSystem) return null;
    const layers = deployment.availableComponentLayersByBase[operatingSystem];
    if (!layers || layers.length === 0) return null;
    return { layers };
  })();

  const hasNoOs = deployment.availableBaseLayers.length === 0;
  const isLocked = deployment.isLocked;
  const isQueued = deployment.status?.label?.toLowerCase() === 'queued';
  const isDisabled = ((isLocked || isQueued) && !isLocalSimulationEnabled()) || hasNoOs;

  const handleFormSubmit = () => {
    setShowConfirmDialog(true);
  };

  const handleConfirmReprovision = async () => {
    const data = form.getValues();

    const collapsed = applyDirectModeToSubmission(data.diskLayouts);
    const diskLayouts = collapsed.map((layout) => ({
      ...layout,
      size: diskLayoutSizeToBytes(layout.size),
      wipe: layout.wipe ?? true,
      encrypt: layout.encrypt ?? false,
    }));

    let cloudInit: any = null;
    if (data.cloudInit && data.cloudInit.trim()) {
      try {
        cloudInit = load(data.cloudInit);
      } catch {
        cloudInit = null;
      }
    }

    const customizations = flattenCustomizationsForSubmit(data.customizations);

    await reprovision({
      params: { id: deploymentId },
      body: {
        deploymentName: data.deploymentName,
        operatingSystem: data.operatingSystem,
        sshKeyIds: data.sshKeyIds,
        diskLayouts,
        cloudInit,
        ipxeUrl: data.ipxeUrl || null,
        tee: data.tee,
        customizations,
      },
    });

    setShowConfirmDialog(false);
    queryClient.removeQueries({ queryKey: ['deployment', deploymentId] });
    queryClient.removeQueries({ queryKey: DEPLOYMENT_PROJECTS_KEY });
    void queryClient.invalidateQueries({ queryKey: LIFECYCLE_JOBS_KEY });
    await router.invalidate();
    navigate({ to: '/deployments/$deploymentId', params: { deploymentId } });
  };

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Reprovision Deployment</CardTitle>
          <CardDescription>
            Reprovisioning will completely reset your deployment, erase all data, and reinstall the operating system.
            This action cannot be undone but does not affect your device rental.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={form.handleSubmit(handleFormSubmit)} className="max-w-4xl space-y-6">
            <div className="grid grid-cols-1 gap-6">
              <FormInput
                control={form.control}
                name="deploymentName"
                label="Name"
                placeholder="Add a name for your deployment"
                disabled={isDisabled}
              />

              {hasNoOs && (
                <Alert variant="warning">
                  <AlertDescription>
                    No operating system images are available for this device. Please contact support.
                  </AlertDescription>
                </Alert>
              )}

              <FormSelect
                control={form.control}
                name="operatingSystem"
                label="Operating System"
                placeholder="Select an operating system"
                options={osOptions}
                disabled={isDisabled}
                onValueChange={() => {
                  form.setValue('customizations', { ...EMPTY_CUSTOMIZATIONS });
                  form.setValue('tee', false);
                }}
              />

              {isIpxeCustomOs(operatingSystem) && (
                <FormInput
                  control={form.control}
                  name="ipxeUrl"
                  label="iPXE URL"
                  placeholder="Enter URL to iPXE script"
                  disabled={isDisabled}
                />
              )}

              {shouldShowTeeCheckbox(operatingSystem, deployment.isTeeCapable) && (
                <FormCheckbox
                  control={form.control}
                  name="tee"
                  label={TEE_CHECKBOX_LABEL}
                  description={TEE_CHECKBOX_DESCRIPTION}
                  disabled={isDisabled}
                />
              )}

              <div>
                <FormMultiSelect
                  control={form.control}
                  name="sshKeyIds"
                  label="SSH Keys"
                  placeholder="Select SSH keys"
                  options={sshKeyOptions}
                  disabled={isDisabled}
                  labelRight={
                    <Link
                      to="/account/ssh-keys/create"
                      search={{
                        redirect: `/deployments/${deploymentId}/reprovision`,
                      }}
                      className="text-primary hover:text-primary/80 flex items-center gap-1 text-sm"
                    >
                      <PlusCircle className="h-3.5 w-3.5" />
                      Add SSH Key
                    </Link>
                  }
                />
              </div>
            </div>

            <ProvisionAdvancedSettings
              storageLayouts={deployment.storageLayouts}
              control={form.control}
              setValue={form.setValue}
              mode="reprovision"
              disabled={isDisabled}
            />

            {customizationsData && (
              <CustomizationLayers
                data={customizationsData}
                control={form.control}
                setValue={form.setValue}
                getValues={form.getValues}
                osFieldName="operatingSystem"
                customizationsFieldName="customizations"
                gpuModel={deployment.specs?.gpu?.model}
                disabled={isDisabled}
              />
            )}

            <div className="pt-4">
              <FormSubmitButton pending={isPending} disabled={isDisabled} variant="destructive">
                Reprovision Device
              </FormSubmitButton>
            </div>
          </form>
        </CardContent>
      </Card>

      <AlertDialog open={showConfirmDialog} onOpenChange={setShowConfirmDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reprovision Device</AlertDialogTitle>
            <AlertDialogDescription>Are you sure you would like to reprovision this device?</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-4">
            <p className="text-sm">
              Reprovisioning resets the data on your deployment, reinstalls the operating system, and gives you a fresh
              install. This does not end your device rental. This action is irreversible.
            </p>
            <p className="text-sm">Please confirm this reprovision.</p>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
            <Button variant="destructive" onClick={handleConfirmReprovision} disabled={isPending}>
              {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {isPending ? 'Reprovisioning...' : 'Reprovision Device'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
