import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, getRouteApi, Link, useNavigate, useRouter } from '@tanstack/react-router';
import { load } from 'js-yaml';
import { AlertTriangle, Loader2, PlusCircle } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import {
  isIpxeCustomOs,
  provisionDiskLayoutSchema,
  ProvisionServerRequestSchema,
  validateDiskLayoutEncryption,
  type SshKeyWithUser,
} from '@repo/api-client';
import { CustomizationLayers, type CustomizationLayersData } from '@repo/domain-ui/provision/customization-layers';
import {
  applyDirectModeToSubmission,
  diskLayoutSizeToBytes,
  getDefaultDiskLayouts,
  validateDiskLayoutSizeInputs,
} from '@repo/domain-ui/provision/disk-layout-selector';
import { ProvisionAdvancedSettings } from '@repo/domain-ui/provision/provision-advanced-settings';
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
import { Card, CardContent, CardHeader } from '@repo/ui/components/card';
import { FormCheckbox } from '@repo/ui/form/form-checkbox';
import { FormInput } from '@repo/ui/form/form-input';
import { FormMultiSelect } from '@repo/ui/form/form-multi-select';
import { FormSelect } from '@repo/ui/form/form-select';
import { FormSubmitButton } from '@repo/ui/form/form-submit-button';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { formatPriceFromCentsToDollars, unwrapErrorMessage } from '@repo/utils';
import { AddSshKeyInlineForm } from '~/components/add-ssh-key-inline-form';
import { DecommissionedServerOverlay } from '~/components/decommissioned-server-overlay';
import { tsr } from '~/lib/api';
import {
  DEFAULT_OPERATING_SYSTEM,
  emptyCustomizations,
  flattenCustomizationsForSubmit,
  osCandidateForMode,
  resolveOperatingSystemSlug,
  shouldShowTeeCheckbox,
  TEE_CHECKBOX_DESCRIPTION,
  TEE_CHECKBOX_LABEL,
} from '~/lib/provision-customizations';
import { LIFECYCLE_JOBS_KEY } from '~/lib/query-keys';

const parentRoute = getRouteApi('/_app/dcim/servers/$deviceId');

export const Route = createFileRoute('/_app/dcim/servers/$deviceId/provision')({
  staticData: { breadcrumb: 'Provision' },
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
  component: ProvisionDevicePage,
});

const provisionFormSchema = ProvisionServerRequestSchema.omit({ customizations: true })
  .extend({
    cloudInit: z.string(),
    ipxeUrl: z.string(),
    customizations: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
    diskLayouts: z.array(provisionDiskLayoutSchema.omit({ size: true }).extend({ size: z.string().optional() })),
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

    validateDiskLayoutEncryption(data.diskLayouts, ctx, 'provision');
    validateDiskLayoutSizeInputs(data.diskLayouts, ctx);
  });

type ProvisionFormData = z.input<typeof provisionFormSchema>;

function ProvisionDevicePage() {
  const { deviceId } = Route.useParams();
  return <ProvisionDeviceForm key={deviceId} />;
}

function ProvisionDeviceForm() {
  const device = parentRoute.useLoaderData();
  const { sshKeys } = Route.useLoaderData();
  const params = Route.useParams();
  const navigate = useNavigate();
  const router = useRouter();
  const queryClient = useQueryClient();

  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [showAddSshKeyForm, setShowAddSshKeyForm] = useState(false);
  const EMPTY_CUSTOMIZATIONS = useMemo(
    () => emptyCustomizations(device.availableComponentLayersByBase),
    [device.availableComponentLayersByBase],
  );

  useDocumentTitle('Provision Server');

  const { mutateAsync: provisionDevice, isPending } = tsr.provisionBaremetalServer.useMutation({
    meta: {
      successMessage:
        'Server provisioned successfully. Your server is actively being provisioned and will come online soon.',
    },
  });

  const interruptibleOnly = device.listing.isInterruptibleOnly ?? false;
  const interruptibleAllowed = interruptibleOnly || (device.listing.interruptiblePrice?.perWeek?.total ?? 0) > 0;

  const sshKeyOptions = useMemo(
    () =>
      (sshKeys as SshKeyWithUser[]).map((key) => ({
        label: `[${key.user.firstName} ${key.user.lastName}] - ${key.name}`,
        value: key.id,
      })),
    [sshKeys],
  );

  const form = useForm<ProvisionFormData>({
    resolver: zodResolver(provisionFormSchema),
    defaultValues: {
      deploymentName: '',
      operatingSystem: resolveOperatingSystemSlug(
        osCandidateForMode(device.availableBaseLayers),
        DEFAULT_OPERATING_SYSTEM,
      ),
      sshKeyIds: [],
      isInterruptible: interruptibleOnly,
      diskLayouts: getDefaultDiskLayouts(device.storageLayouts),
      cloudInit: '',
      ipxeUrl: '',
      tee: false,
      customizations: { ...EMPTY_CUSTOMIZATIONS },
    },
  });

  const operatingSystem = form.watch('operatingSystem');
  const isInterruptible = form.watch('isInterruptible');

  const osOptions = device.availableBaseLayers
    .map((layer) => ({ label: layer.name, value: layer.slug }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));

  const customizationsData: CustomizationLayersData | null = (() => {
    if (!operatingSystem) return null;
    const layers = device.availableComponentLayersByBase[operatingSystem];
    if (!layers || layers.length === 0) return null;
    return { layers };
  })();

  const hasNoOs = device.availableBaseLayers.length === 0;
  const isNotProvisionable =
    !!device.deployment || device.status?.label?.toLowerCase() !== 'inventory' || !!device.reservationInvite || hasNoOs;

  const handleFormSubmit = () => {
    setShowConfirmDialog(true);
  };

  const handleConfirmProvision = async () => {
    const data = form.getValues();

    const collapsed = applyDirectModeToSubmission(data.diskLayouts);
    const diskLayouts = collapsed.map((layout) => ({
      ...layout,
      size: diskLayoutSizeToBytes(layout.size),
      wipe: true,
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

    await provisionDevice({
      params: { deviceId: params.deviceId },
      body: {
        deploymentName: data.deploymentName,
        operatingSystem: data.operatingSystem,
        sshKeyIds: data.sshKeyIds,
        isInterruptible: data.isInterruptible,
        diskLayouts,
        cloudInit,
        ipxeUrl: data.ipxeUrl || null,
        tee: data.tee,
        customizations,
      },
    });

    setShowConfirmDialog(false);
    queryClient.removeQueries({ queryKey: ['server', params.deviceId] });
    void queryClient.invalidateQueries({ queryKey: LIFECYCLE_JOBS_KEY });
    await router.invalidate();
    navigate({
      to: '/dcim/servers/$deviceId',
      params: { deviceId: params.deviceId },
    });
  };

  return (
    <>
      <div className="relative">
        <DecommissionedServerOverlay deletedAt={device.deletedAt} />
        <Card>
          <CardHeader>
            <h2 className="text-base leading-7 font-semibold">Provision</h2>
            <p className="text-muted-foreground mt-1 text-sm leading-6">
              Provisioning installs the operating system and configures the server for use. This action is irreversible.
            </p>
            {isNotProvisionable && (
              <div className="bg-muted mt-4 rounded-lg p-4 font-semibold">
                <p>This server is not available for provisioning.</p>
                <ul className="list-disc pl-4 text-sm text-amber-500">
                  {hasNoOs && (
                    <li>
                      <p className="mt-2">
                        No operating system images are available for this server. Please contact support or seed the
                        layer catalog.
                      </p>
                    </li>
                  )}
                  {!!device.deployment && (
                    <li>
                      <p className="mt-2">
                        This server has an active deployment. End the current deployment before provisioning.
                      </p>
                    </li>
                  )}
                  {device.status?.label?.toLowerCase() !== 'inventory' && (
                    <li>
                      <p className="mt-2">This server is not in inventory status.</p>
                    </li>
                  )}
                  {!!device.reservationInvite && (
                    <li>
                      <p className="mt-2">This server has a pending reservation invite.</p>
                    </li>
                  )}
                </ul>
              </div>
            )}
          </CardHeader>
          <CardContent>
            {showAddSshKeyForm ? (
              <AddSshKeyInlineForm
                onCancel={() => setShowAddSshKeyForm(false)}
                onSuccess={async () => {
                  queryClient.removeQueries({ queryKey: ['organization-ssh-keys'] });
                  await router.invalidate();
                  setShowAddSshKeyForm(false);
                }}
              />
            ) : (
              <form onSubmit={form.handleSubmit(handleFormSubmit)} className="max-w-4xl space-y-6">
                <FormInput
                  control={form.control}
                  name="deploymentName"
                  label="Name"
                  placeholder="Add a name for your deployment"
                  disabled={isNotProvisionable}
                />

                <FormSelect
                  control={form.control}
                  name="operatingSystem"
                  label="Operating System"
                  placeholder="Select an operating system"
                  options={osOptions}
                  disabled={isNotProvisionable}
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
                    disabled={isNotProvisionable}
                  />
                )}

                {shouldShowTeeCheckbox(operatingSystem, device.isTeeCapable) && (
                  <FormCheckbox
                    control={form.control}
                    name="tee"
                    label={TEE_CHECKBOX_LABEL}
                    description={TEE_CHECKBOX_DESCRIPTION}
                    disabled={isNotProvisionable}
                  />
                )}

                <FormMultiSelect
                  control={form.control}
                  name="sshKeyIds"
                  label="SSH Keys"
                  placeholder="Select SSH keys"
                  options={sshKeyOptions}
                  disabled={isNotProvisionable}
                  labelRight={
                    <button
                      type="button"
                      onClick={() => setShowAddSshKeyForm(true)}
                      className="text-primary hover:text-primary/80 flex items-center gap-1 text-sm"
                    >
                      <PlusCircle className="h-3.5 w-3.5" />
                      Add SSH Key
                    </button>
                  }
                />

                {interruptibleAllowed && (
                  <FormCheckbox
                    control={form.control}
                    name="isInterruptible"
                    label="Interruptible"
                    description={
                      interruptibleOnly
                        ? 'This server is only available as interruptible.'
                        : 'Rent as interruptible — cheaper, but can be evicted after a notice period.'
                    }
                    disabled={isNotProvisionable || interruptibleOnly}
                  />
                )}

                {isInterruptible && (
                  <Card className="border-amber-500/20 bg-amber-500/5">
                    <CardHeader className="flex flex-row items-center gap-2">
                      <AlertTriangle className="h-4 w-4 text-amber-500" />
                      <p className="text-sm font-medium">Interruptible Self-Provisioning</p>
                    </CardHeader>
                    <CardContent className="space-y-3 text-sm">
                      <div>
                        <p>When you set this server to self-provision as interruptible:</p>
                        <ul className="list-disc space-y-1 pl-6">
                          <li>Server will remain listed and rentable on-demand at the LISTED price.</li>
                          <li>Server will remain listed and rentable as interruptible at the set FLOOR price.</li>
                          <li>
                            If the server is rented, your current workload will be terminated after a 5 minute delay.
                          </li>
                          <li>The server will be fully wiped and re-imaged before being handed over to the renter.</li>
                          <li>Any unsaved data will be lost permanently.</li>
                        </ul>
                      </div>
                      <div>
                        <p className="font-semibold">Current price configuration:</p>
                        <p>
                          LISTED:{' '}
                          <span className="text-emerald-500">
                            {formatPriceFromCentsToDollars(
                              device.specs.gpu.count
                                ? device.listing.onDemandPrice.perHour.perGpu!
                                : device.listing.onDemandPrice.perHour.total!,
                            )}{' '}
                            {device.specs.gpu.count ? 'GPU/Hr' : 'Server/Hr'}
                          </span>
                        </p>
                        <p>
                          FLOOR:{' '}
                          <span className="text-emerald-500">
                            {formatPriceFromCentsToDollars(
                              device.specs.gpu.count
                                ? device.listing.interruptiblePrice.perHour.perGpu!
                                : device.listing.interruptiblePrice.perHour.total!,
                            )}{' '}
                            {device.specs.gpu.count ? 'GPU/Hr' : 'Server/Hr'}
                          </span>
                        </p>
                      </div>
                      <Link
                        to="/dcim/servers/$deviceId/settings"
                        params={{ deviceId: params.deviceId }}
                        className="text-primary text-sm hover:underline"
                      >
                        Configure your price settings
                      </Link>
                    </CardContent>
                  </Card>
                )}

                <ProvisionAdvancedSettings
                  storageLayouts={device.storageLayouts}
                  control={form.control}
                  setValue={form.setValue}
                  disabled={isNotProvisionable}
                />

                {customizationsData && (
                  <CustomizationLayers
                    data={customizationsData}
                    control={form.control}
                    setValue={form.setValue}
                    getValues={form.getValues}
                    osFieldName="operatingSystem"
                    customizationsFieldName="customizations"
                    gpuModel={device.specs?.gpu?.model}
                    disabled={isNotProvisionable}
                  />
                )}

                <div className="pt-4">
                  <FormSubmitButton pending={isPending} disabled={isNotProvisionable}>
                    Provision Server
                  </FormSubmitButton>
                </div>
              </form>
            )}
          </CardContent>
        </Card>
      </div>

      <AlertDialog open={showConfirmDialog} onOpenChange={setShowConfirmDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Provision Server</AlertDialogTitle>
            <AlertDialogDescription>Are you sure you would like to provision this server?</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-4">
            <p className="text-sm">
              Provisioning installs the operating system and configures the server for use. This action is irreversible.
            </p>
            <p className="text-sm">Please confirm this provision.</p>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
            <Button onClick={handleConfirmProvision} disabled={isPending}>
              {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {isPending ? 'Provisioning...' : 'Provision Server'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
