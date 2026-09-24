import { zodResolver } from '@hookform/resolvers/zod';
import { useSession } from '@repo/auth/client';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, redirect, useNavigate, useRouter } from '@tanstack/react-router';
import { load } from 'js-yaml';
import { ChevronLeft, MapPin, PlusCircle } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { AddSshKeyInlineForm } from '~/components/add-ssh-key-inline-form';
import { DetailListItem } from '~/components/detail-list-item';
import { usePluginRegistry } from '~/plugin-host/plugin-registry-provider';
import { PluginSlot } from '~/plugin-host/plugin-slot';

import {
  CloudInitSchema,
  isIpxeCustomOs,
  provisionDiskLayoutSchema,
  ProvisionRequestSchema,
  validateDiskLayoutEncryption,
  type ProvisionRequest,
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
import { Alert, AlertDescription } from '@repo/ui/components/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/components/card';
import { FormCheckbox } from '@repo/ui/form/form-checkbox';
import { FormInput } from '@repo/ui/form/form-input';
import { FormMultiSelect } from '@repo/ui/form/form-multi-select';
import { FormSelect } from '@repo/ui/form/form-select';
import { FormSubmitButton } from '@repo/ui/form/form-submit-button';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import {
  CONTRACT_TYPE_OPTIONS,
  ContractType,
  formatBillingFrequency,
  formatContractType,
  formatMillisecondsToDuration,
  formatReservationInviteBillingFrequencyInterval,
  formatSize,
  getContractTypeFinePrint,
  getHourlyOrInvitePrice,
  getWeeklyOrInvitePrice,
  unwrapErrorMessage,
} from '@repo/utils';
import { tsr } from '~/lib/api';
import {
  baseLayersToOsOptions,
  DEFAULT_OPERATING_SYSTEM,
  emptyCustomizations,
  flattenCustomizationsForSubmit,
  isClusterable,
  osCandidateForMode,
  resolveOperatingSystemSlug,
  shouldShowTeeCheckbox,
  TEE_CHECKBOX_DESCRIPTION,
  TEE_CHECKBOX_LABEL,
} from '~/lib/provision-customizations';
import { DEPLOYMENT_PROJECTS_KEY } from '~/lib/query-keys';

export const Route = createFileRoute('/_app/inventory/$deviceId')({
  staticData: { breadcrumb: 'Device' },
  loader: async ({ context: { queryClient }, params }) => {
    const { deviceId } = params;

    const [listingRes, sshKeysRes, projectsRes, orgRes] = await Promise.all([
      queryClient.ensureQueryData({
        queryKey: ['inventory-device', deviceId],
        queryFn: () =>
          tsr.getInventoryById.query({
            params: { id: deviceId },
          }),
      }),
      queryClient.ensureQueryData({
        queryKey: ['organization-ssh-keys'],
        queryFn: () => tsr.getOrganizationSshKeys.query({ query: { pageSize: 100 } }),
      }),
      queryClient.ensureQueryData({
        queryKey: ['deployment-projects'],
        queryFn: () => tsr.getDeploymentProjects.query({ query: { pageSize: 100 } }),
      }),
      queryClient.ensureQueryData({
        queryKey: ['organization', 'active'],
        queryFn: () => tsr.getOrganization.query({}),
      }),
    ]);

    if (listingRes.status === 404) {
      throw redirect({ to: '/inventory/categories' });
    }

    if (listingRes.status !== 200) {
      throw new Error('Failed to load device listing');
    }

    const sshKeys = sshKeysRes.status === 200 ? sshKeysRes.body.data : [];
    const projects = projectsRes.status === 200 ? projectsRes.body.data : [];
    const knownAccount = orgRes.status === 200 ? orgRes.body.knownAccount : false;

    return {
      device: listingRes.body,
      sshKeys,
      projects,
      knownAccount,
    };
  },
  component: InventoryDevicePage,
});

const provisionFormSchema = ProvisionRequestSchema.omit({ customizations: true })
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
        path: ['ipxeUrl'],
        message: 'iPXE URL is required for iPXE custom OS',
      });
    }

    if (data.ipxeUrl && !isIpxeCustomOs(data.operatingSystem)) {
      ctx.addIssue({
        code: 'custom',
        path: ['operatingSystem'],
        message: 'iPXE URL is only valid for iPXE custom OS',
      });
    }

    const effectiveLayouts = applyDirectModeToSubmission(data.diskLayouts);
    const mountpoints = effectiveLayouts.map((layout) => layout.mountpoint).filter(Boolean);
    const unique = new Set(mountpoints);
    if (mountpoints.length !== unique.size) {
      ctx.addIssue({
        code: 'custom',
        path: ['diskLayouts'],
        message: 'Disk layout mountpoints must be unique',
      });
    }

    if (data.cloudInit && data.cloudInit.trim()) {
      try {
        load(data.cloudInit);
      } catch (error) {
        ctx.addIssue({
          code: 'custom',
          path: ['cloudInit'],
          message: `Invalid cloud-init YAML: ${unwrapErrorMessage(error, 'Parse error').split('\n')[0]}`,
        });
      }
    }

    validateDiskLayoutEncryption(data.diskLayouts, ctx, 'provision');
    validateDiskLayoutSizeInputs(data.diskLayouts, ctx);
  });

type ProvisionFormData = z.input<typeof provisionFormSchema>;

function InventoryDevicePage() {
  const navigate = useNavigate();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: session } = useSession();
  const pluginRegistry = usePluginRegistry();
  const { deviceId } = Route.useParams();
  const { device, sshKeys, projects, knownAccount } = Route.useLoaderData();

  const title = device.specs.gpu?.model ?? device.specs.cpu?.model ?? 'Hardware not discovered yet';

  useDocumentTitle(title);

  const [showAddSshKeyForm, setShowAddSshKeyForm] = useState(false);
  const [provisionSubmitted, setProvisionSubmitted] = useState(false);
  const hasManagedProvisionGate = (pluginRegistry.slots.get('inventory-device-provision') ?? []).length > 0;
  const hasActiveInvite = device.activeReservationInvite != null;
  const showContractPricingInsteadOfProvision = hasManagedProvisionGate && !knownAccount && !hasActiveInvite;
  const userEmail = session?.user?.email;

  const { mutateAsync: provisionDevice } = tsr.provisionDevice.useMutation({
    meta: { successMessage: 'Your device has been successfully provisioned' },
  });

  const EMPTY_CUSTOMIZATIONS = useMemo(
    () => emptyCustomizations(device.availableComponentLayersByBase),
    [device.availableComponentLayersByBase],
  );

  const osOptions = useMemo(() => baseLayersToOsOptions(device.availableBaseLayers), [device.availableBaseLayers]);

  const hasNoOs = osOptions.length === 0;

  // Only Reserved Rolling is offered until commerce billing is ready. Interruptible-only listings
  // and hosts occupied by an interruptible deployment cannot take that path — block the invalid CTA.
  const interruptibleOnly = device.listing.isInterruptibleOnly ?? false;
  const reservedRollingBlocked = interruptibleOnly || device.isInterruptibleDeployment;

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
      contractType: ContractType.RESERVED_ROLLING,
      isInterruptible: false,
      operatingSystem: resolveOperatingSystemSlug(
        osCandidateForMode(device.availableBaseLayers),
        DEFAULT_OPERATING_SYSTEM,
      ),
      sshKeyIds: [],
      projectId: projects[0]?.id,
      diskLayouts: getDefaultDiskLayouts(device.storageLayouts),
      cloudInit: '',
      ipxeUrl: '',
      tee: false,
      customizations: { ...EMPTY_CUSTOMIZATIONS },
    },
  });

  const contractType = form.watch('contractType') ?? ContractType.RESERVED_ROLLING;
  const operatingSystem = form.watch('operatingSystem');

  const customizationsData: CustomizationLayersData | null = (() => {
    if (!operatingSystem) return null;
    const layers = device.availableComponentLayersByBase[operatingSystem];
    if (!layers || layers.length === 0) return null;
    return { layers };
  })();

  const onSubmit = async (values: ProvisionFormData) => {
    const cloudInit = values.cloudInit?.trim() ? CloudInitSchema.parse(load(values.cloudInit)) : null;
    const customizations = flattenCustomizationsForSubmit(values.customizations);

    const body: ProvisionRequest = {
      deploymentName: values.deploymentName,
      contractType: values.contractType ?? ContractType.RESERVED_ROLLING,
      isInterruptible: values.contractType === ContractType.INTERRUPTIBLE,
      operatingSystem: values.operatingSystem,
      sshKeyIds: values.sshKeyIds,
      projectId: values.projectId || undefined,
      diskLayouts: applyDirectModeToSubmission(values.diskLayouts).map((layout) => ({
        config: layout.config,
        format: layout.format,
        mountpoint: layout.mountpoint,
        diskType: layout.diskType,
        disks: layout.disks,
        size: diskLayoutSizeToBytes(layout.size),
        encrypt: layout.encrypt ?? false,
        wipe: true,
      })),
      cloudInit,
      ipxeUrl: values.ipxeUrl || null,
      tee: values.tee,
      customizations,
    };

    try {
      setProvisionSubmitted(true);
      queryClient.setQueryDefaults(['inventory-device', deviceId], {
        staleTime: Infinity,
        refetchOnWindowFocus: false,
      });
      await provisionDevice({ params: { id: deviceId }, body });

      queryClient.invalidateQueries({ queryKey: DEPLOYMENT_PROJECTS_KEY });
      queryClient.invalidateQueries({ queryKey: ['interruptible-claims'] });
      await navigate({ to: '/deployments' });
    } catch {
      setProvisionSubmitted(false);
    }
  };

  const isPriceUnavailable =
    !device.listing.onDemandPrice.perWeek.total ||
    device.listing.onDemandPrice.perWeek.total === 0 ||
    (interruptibleOnly &&
      (!device.listing.interruptiblePrice.perWeek.total || device.listing.interruptiblePrice.perWeek.total === 0));

  return (
    <>
      <Link to="/inventory/categories" className="mb-6 flex items-center gap-1 text-sm">
        <ChevronLeft className="h-5 w-5" /> Back To Inventory
      </Link>

      <div className="grid grid-cols-12 gap-8">
        <div className="col-span-12 xl:col-span-6">
          <p className="mb-8 text-3xl font-bold">{title}</p>
          <p className="mb-4 text-xl text-teal-400">Overview</p>

          <dl className="mb-6 flex flex-col divide-y">
            <DetailListItem name="Memory" value={formatSize(device.specs.memory.total, 'GB', 2)} />
            <DetailListItem
              name="HDD Storage"
              value={device.specs.storage?.hddSize ? formatSize(device.specs.storage.hddSize, 'GB', 2) : null}
            />
            <DetailListItem name="HDD Disks" value={device.specs.storage?.hddCount} />
            <DetailListItem
              name="NVME Storage"
              value={device.specs.storage?.nvmeSize ? formatSize(device.specs.storage.nvmeSize, 'GB', 2) : null}
            />
            <DetailListItem name="NVME Disks" value={device.specs.storage?.nvmeCount} />
            <DetailListItem
              name="SSD Storage"
              value={device.specs.storage?.ssdSize ? formatSize(device.specs.storage.ssdSize, 'GB', 2) : null}
            />
            <DetailListItem name="SSD Disks" value={device.specs.storage?.ssdCount} />
            <DetailListItem name="CPU" value={device.specs.cpu?.model} />
            <DetailListItem name="Cores" value={device.specs.cpu?.totalCores} />
            <DetailListItem name="Threads" value={device.specs.cpu?.totalThreads} />
            <DetailListItem name="GPU" value={device.specs.gpu?.model} />
            <DetailListItem name="GPU Count" value={device.specs.gpu?.count} />
          </dl>
        </div>

        <div className="col-span-12 xl:col-span-6">
          <div className="mb-6 flex flex-col gap-4">
            <p className="text-xl text-teal-400">Provider Information</p>
            <div className="flex items-center gap-2">
              <MapPin className="h-4 w-4" />
              <span>{device.location ?? 'Unknown'}</span>
            </div>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="font-normal text-teal-400">
                {showContractPricingInsteadOfProvision ? 'Contract pricing' : 'Configure your device'}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {showContractPricingInsteadOfProvision ? (
                <div className="space-y-6">
                  <p className="text-muted-foreground text-sm">
                    Contact sales for contract pricing on this device. Inventory self-serve provision is not available
                    for this organization.
                  </p>
                  <div className="space-y-4 border-t pt-6">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <p className="font-medium">On Demand</p>
                      </div>
                      {isPriceUnavailable ? (
                        <span className="text-muted-foreground">Price unavailable</span>
                      ) : (
                        <div className="text-right">
                          <p className="text-2xl">
                            {getHourlyOrInvitePrice(device, false, undefined)}
                            <span className="text-muted-foreground ml-1 text-sm">
                              {formatBillingFrequency(device.specs.gpu.count)}
                            </span>
                          </p>
                          <p className="text-2xl">
                            {getWeeklyOrInvitePrice(device, false, undefined)}
                            <span className="text-muted-foreground ml-1 text-sm">per week</span>
                          </p>
                        </div>
                      )}
                    </div>
                    <PluginSlot
                      name="inventory-device-provision"
                      knownAccount={knownAccount}
                      hasActiveInvite={hasActiveInvite}
                      userEmail={userEmail}
                      deviceName={title}
                      pending={false}
                      disabled={false}
                      device={{
                        name: device.name,
                        gpuModel: device.specs.gpu?.model,
                        gpuCount: device.specs.gpu?.count,
                        cpuModel: device.specs.cpu?.model,
                        cpuCount: device.specs.cpu?.count,
                        cpuCoreCount: device.specs.cpu?.totalCores,
                        memory: device.specs.memory.total,
                        ssdSize: device.specs.storage?.ssdSize,
                        hddSize: device.specs.storage?.hddSize,
                        nvmeSize: device.specs.storage?.nvmeSize,
                      }}
                    />
                  </div>
                </div>
              ) : showAddSshKeyForm ? (
                <AddSshKeyInlineForm
                  onCancel={() => setShowAddSshKeyForm(false)}
                  onSuccess={async () => {
                    queryClient.removeQueries({ queryKey: ['organization-ssh-keys'] });
                    await router.invalidate();
                    setShowAddSshKeyForm(false);
                  }}
                />
              ) : (
                <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
                  <FormInput
                    control={form.control}
                    name="deploymentName"
                    label="Deployment Name"
                    placeholder="Add a name"
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
                    options={osOptions}
                    placeholder="Select an operating system"
                    disabled={hasNoOs}
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
                    />
                  )}

                  {shouldShowTeeCheckbox(operatingSystem, device.isTeeCapable) && (
                    <FormCheckbox
                      control={form.control}
                      name="tee"
                      label={TEE_CHECKBOX_LABEL}
                      description={TEE_CHECKBOX_DESCRIPTION}
                    />
                  )}

                  {isClusterable(device.networking.vpcCapable) && (
                    <div className="border-border bg-muted/40 text-muted-foreground rounded-md border p-3 text-sm">
                      This machine joins your organization&apos;s private cluster network in this data center, giving it
                      isolated east/west connectivity to your other machines here.
                    </div>
                  )}

                  <FormMultiSelect
                    control={form.control}
                    name="sshKeyIds"
                    label="SSH Keys"
                    options={sshKeyOptions}
                    placeholder="Select SSH keys"
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

                  {reservedRollingBlocked && (
                    <Alert variant="warning">
                      <AlertDescription>
                        {interruptibleOnly
                          ? 'This device is interruptible-only and cannot be provisioned with Reserved Rolling until commerce billing is ready.'
                          : 'This host has an active interruptible deployment and cannot be provisioned with Reserved Rolling until commerce billing is ready.'}
                      </AlertDescription>
                    </Alert>
                  )}

                  <FormSelect
                    control={form.control}
                    name="contractType"
                    label="Contract Type"
                    options={CONTRACT_TYPE_OPTIONS}
                    placeholder="Select contract type"
                    disabled={reservedRollingBlocked}
                  />

                  <FormSelect
                    control={form.control}
                    name="projectId"
                    label="Project"
                    options={projects.map((project) => ({
                      label: project.name,
                      value: project.id,
                    }))}
                    placeholder="Select project"
                    labelRight={
                      <Link to="/deployments/projects/create" className="text-primary hover:text-primary/80 text-sm">
                        Create Project
                      </Link>
                    }
                  />

                  <ProvisionAdvancedSettings
                    storageLayouts={device.storageLayouts}
                    control={form.control}
                    setValue={form.setValue}
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
                    />
                  )}

                  <div className="space-y-4 border-t pt-6">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <p className="font-medium">{formatContractType(contractType)}</p>
                        {device.interruptibleNoticePeriod != null && device.interruptibleNoticePeriod > 0 && (
                          <p className="text-muted-foreground text-sm">
                            {formatMillisecondsToDuration(device.interruptibleNoticePeriod)} notice period
                          </p>
                        )}
                        {device.activeReservationInvite?.interruptibleNoticePeriod != null &&
                          device.activeReservationInvite?.interruptibleNoticePeriod > 0 && (
                            <p className="text-muted-foreground text-sm">
                              {formatMillisecondsToDuration(device.activeReservationInvite?.interruptibleNoticePeriod)}{' '}
                              notice period
                            </p>
                          )}
                      </div>
                      {isPriceUnavailable ? (
                        <span className="text-muted-foreground">Price unavailable</span>
                      ) : (
                        <div className="text-right">
                          <p className="text-2xl">
                            {getHourlyOrInvitePrice(device, false, device.activeReservationInvite ?? undefined)}
                            <span className="text-muted-foreground ml-1 text-sm">
                              {formatBillingFrequency(device.specs.gpu.count)}
                            </span>
                          </p>
                          <p className="text-2xl">
                            {getWeeklyOrInvitePrice(device, false, device.activeReservationInvite ?? undefined)}
                            <span className="text-muted-foreground ml-1 text-sm">
                              {device.activeReservationInvite
                                ? formatReservationInviteBillingFrequencyInterval(device.activeReservationInvite)
                                : 'per week'}
                            </span>
                          </p>
                        </div>
                      )}
                    </div>

                    <p className="text-muted-foreground text-sm">{getContractTypeFinePrint(contractType)}</p>

                    {hasManagedProvisionGate ? (
                      <PluginSlot
                        name="inventory-device-provision"
                        knownAccount={knownAccount}
                        hasActiveInvite={hasActiveInvite}
                        userEmail={userEmail}
                        deviceName={title}
                        pending={form.formState.isSubmitting}
                        disabled={hasNoOs || provisionSubmitted || reservedRollingBlocked || isPriceUnavailable}
                        device={{
                          name: device.name,
                          gpuModel: device.specs.gpu?.model,
                          gpuCount: device.specs.gpu?.count,
                          cpuModel: device.specs.cpu?.model,
                          cpuCount: device.specs.cpu?.count,
                          cpuCoreCount: device.specs.cpu?.totalCores,
                          memory: device.specs.memory.total,
                          ssdSize: device.specs.storage?.ssdSize,
                          hddSize: device.specs.storage?.hddSize,
                          nvmeSize: device.specs.storage?.nvmeSize,
                        }}
                      />
                    ) : (
                      <FormSubmitButton
                        pending={form.formState.isSubmitting}
                        disabled={hasNoOs || provisionSubmitted || reservedRollingBlocked || isPriceUnavailable}
                      >
                        Provision
                      </FormSubmitButton>
                    )}
                  </div>
                </form>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
