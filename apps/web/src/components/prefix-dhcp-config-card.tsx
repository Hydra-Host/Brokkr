import { zodResolver } from '@hookform/resolvers/zod';
import {
  DhcpModeSchema,
  DhcpRelayAgentIpSchema,
  IpxeBuildTargetSchema,
  RESERVED_DHCP_OPTION_CODES,
  RESERVED_DHCP_OPTIONS,
  type PrefixDhcpConfig,
} from '@repo/api-client';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { Skeleton } from '@repo/ui/components/skeleton';
import { FormCheckbox } from '@repo/ui/form/form-checkbox';
import { FormInput } from '@repo/ui/form/form-input';
import { FormNumberInput } from '@repo/ui/form/form-number-input';
import { FormSelect } from '@repo/ui/form/form-select';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Plus, Trash2 } from 'lucide-react';
import { useEffect } from 'react';
import { useFieldArray, useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { tsr } from '~/lib/api';
import { enumOptions } from '~/lib/enum-options';

// ── Form schema ────────────────────────────────────────────────────────

const macPattern = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;
const isValidRelayAgentIp = (value: string) => DhcpRelayAgentIpSchema.safeParse(value).success;

// superRefine strict checks are MODE-SCOPED: a hidden inactive-mode row never blocks save.
// Values are preserved across mode switches (never cleared) so toggling modes can't wipe stored config.
export const dhcpConfigFormSchema = z
  .object({
    dhcpMode: DhcpModeSchema.or(z.literal('')),
    dhcpLeaseTtlSeconds: z.coerce
      .number()
      .int()
      .min(120, 'Minimum lease is 120 seconds')
      .max(0x7fffffff)
      .nullable()
      .or(z.literal('')),
    ipxeBuildTarget: IpxeBuildTargetSchema,
    dhcpOptions: z.array(z.object({ code: z.coerce.number(), value: z.string() })),
    dhcpProxyAllowedMacs: z.array(z.object({ value: z.string() })),
    dhcpProxyPeerAuthoritative: z.boolean(),
    dhcpRelayAgentIp: z.string(),
  })
  .superRefine((data, ctx) => {
    const hasMode = data.dhcpMode === 'AUTHORITATIVE' || data.dhcpMode === 'PROXY';
    if (hasMode) {
      // Validate everything formValuesToPayload filters, so a VISIBLE invalid row errors inline
      // rather than being silently dropped on save.
      const codes: number[] = [];
      data.dhcpOptions.forEach((o, i) => {
        if (o.value === '') return; // abandoned blank row — dropped at submit
        if (!Number.isInteger(o.code) || o.code < 1 || o.code > 254) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['dhcpOptions', i, 'code'],
            message: 'Code must be 1-254',
          });
        } else if (RESERVED_DHCP_OPTION_CODES.has(o.code)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['dhcpOptions', i, 'code'],
            message: `Code ${o.code} is reserved (${RESERVED_DHCP_OPTIONS[o.code] ?? 'auto-managed'}) and cannot be set manually`,
          });
        }
        if (o.value.length > 255) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['dhcpOptions', i, 'value'],
            message: 'Value must be at most 255 characters',
          });
        }
        codes.push(o.code);
      });
      if (new Set(codes).size !== codes.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['dhcpOptions'],
          message: 'Duplicate DHCP option codes are not allowed',
        });
      }
      const relayAgentIp = data.dhcpRelayAgentIp.trim();
      if (relayAgentIp !== '' && !isValidRelayAgentIp(relayAgentIp)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['dhcpRelayAgentIp'],
          message: 'Enter a valid IPv4 address',
        });
      }
    }
    if (data.dhcpMode === 'PROXY') {
      const seen = new Set<string>();
      data.dhcpProxyAllowedMacs.forEach((m, i) => {
        const v = m.value.trim().toLowerCase();
        if (v === '') return; // abandoned blank row — dropped at submit
        if (!macPattern.test(v)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['dhcpProxyAllowedMacs', i, 'value'],
            message: 'Must be a lowercase colon-hex MAC (e.g. aa:bb:cc:dd:ee:ff)',
          });
        } else if (seen.has(v)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['dhcpProxyAllowedMacs', i, 'value'],
            message: 'Duplicate MAC address',
          });
        }
        seen.add(v);
      });
    }
  });

type DhcpConfigFormData = z.infer<typeof dhcpConfigFormSchema>;

// ── Options ────────────────────────────────────────────────────────────

const modeOptions = [
  { label: 'None (disabled)', value: '' },
  { label: 'Authoritative', value: 'AUTHORITATIVE' },
  { label: 'Proxy (PXE only)', value: 'PROXY' },
  { label: 'Off', value: 'OFF' },
] as const;

// Derived from the canonical IpxeBuildTargetSchema (shared with the per-device override on the
// server settings page) so a new build target never leaves a hardcoded list stale.
const ipxeOptions = enumOptions(IpxeBuildTargetSchema, { IPXE: 'iPXE (default)', SNPONLY: 'SNP Only' });

// ── Helpers ────────────────────────────────────────────────────────────

export function apiToForm(config: PrefixDhcpConfig): DhcpConfigFormData {
  return {
    dhcpMode: config.dhcpMode ?? '',
    dhcpLeaseTtlSeconds: config.dhcpLeaseTtlSeconds ?? '',
    ipxeBuildTarget: config.ipxeBuildTarget,
    dhcpOptions: config.dhcpOptions.map((o) => ({ code: o.code, value: o.value })),
    // Load MACs regardless of mode so switching away from and back to PROXY preserves them.
    dhcpProxyAllowedMacs: config.dhcpProxyAllowedMacs.map((v) => ({ value: v })),
    dhcpProxyPeerAuthoritative: config.dhcpProxyPeerAuthoritative,
    dhcpRelayAgentIp: config.dhcpRelayAgentIp ?? '',
  };
}

const emptyDefaults: DhcpConfigFormData = {
  dhcpMode: '',
  dhcpLeaseTtlSeconds: '',
  ipxeBuildTarget: 'IPXE',
  dhcpOptions: [],
  dhcpProxyAllowedMacs: [],
  dhcpProxyPeerAuthoritative: false,
  dhcpRelayAgentIp: '',
};

export function formValuesToPayload(formData: DhcpConfigFormData) {
  return {
    dhcpMode: formData.dhcpMode === '' ? null : formData.dhcpMode,
    dhcpLeaseTtlSeconds: formData.dhcpLeaseTtlSeconds === '' ? null : Number(formData.dhcpLeaseTtlSeconds),
    ipxeBuildTarget: formData.ipxeBuildTarget,
    // Full-replace PUT: preserve every list regardless of mode (dropping on OFF/toggle would wipe stored config),
    // but send only VALID rows — inactive-mode fields skip the superRefine and would otherwise 400 the strict API.
    dhcpOptions: formData.dhcpOptions
      .filter(
        (o) =>
          o.value !== '' &&
          o.value.length <= 255 &&
          Number.isInteger(o.code) &&
          o.code >= 1 &&
          o.code <= 254 &&
          !RESERVED_DHCP_OPTION_CODES.has(o.code),
      )
      .map((o) => ({ code: o.code, value: o.value })),
    dhcpProxyAllowedMacs: formData.dhcpProxyAllowedMacs
      .map((m) => m.value.trim().toLowerCase())
      .filter((v) => macPattern.test(v)),
    dhcpProxyPeerAuthoritative: formData.dhcpProxyPeerAuthoritative,
    dhcpRelayAgentIp: (() => {
      const value = formData.dhcpRelayAgentIp.trim();
      return isValidRelayAgentIp(value) ? value : null;
    })(),
  };
}

// ── Component ──────────────────────────────────────────────────────────

export function PrefixDhcpConfigCard({ prefixId }: { prefixId: string }) {
  const queryClient = useQueryClient();

  const { data, isPending } = tsr.getPrefixDhcpConfig.useQuery({
    queryKey: ['prefix', prefixId, 'dhcp-config'],
    queryData: { params: { id: prefixId } },
  });

  const updateMutation = tsr.updatePrefixDhcpConfig.useMutation({
    meta: { successMessage: 'DHCP config updated' },
  });

  const config = data?.status === 200 ? data.body : null;

  const { control, handleSubmit, reset } = useForm<DhcpConfigFormData>({
    resolver: zodResolver(dhcpConfigFormSchema),
    defaultValues: emptyDefaults,
  });

  const watchedMode = useWatch({ control, name: 'dhcpMode' });
  const isProxy = watchedMode === 'PROXY';
  const isAuthoritative = watchedMode === 'AUTHORITATIVE';
  const hasMode = isProxy || isAuthoritative;

  const {
    fields: optionFields,
    append: appendOption,
    remove: removeOption,
  } = useFieldArray({ control, name: 'dhcpOptions' });

  const {
    fields: macFields,
    append: appendMac,
    remove: removeMac,
  } = useFieldArray({ control, name: 'dhcpProxyAllowedMacs' });

  useEffect(() => {
    if (config) {
      reset(apiToForm(config));
    }
  }, [config, reset]);

  if (isPending) return <Skeleton className="h-64" />;

  // Never render the form against a failed load — the empty defaults would let a save wipe stored config.
  if (!config) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>DHCP Configuration</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-muted-foreground flex items-center gap-2 text-sm">
            <AlertTriangle className="h-4 w-4" />
            Failed to load DHCP config. Refresh to retry.
          </div>
        </CardContent>
      </Card>
    );
  }

  const onSubmit = async (formData: DhcpConfigFormData) => {
    await updateMutation.mutateAsync({
      params: { id: prefixId },
      body: formValuesToPayload(formData),
    });
    await queryClient.invalidateQueries({ queryKey: ['prefix', prefixId, 'dhcp-config'] });
    // Also refresh any zone DHCP-prefix summary (the zone overview card) so its mode badge/switch isn't stale.
    // Matched by predicate: this card renders in both zone-detail and IPAM prefix-edit contexts and doesn't know the zoneId.
    await queryClient.invalidateQueries({
      predicate: (q) => q.queryKey[0] === 'zone' && q.queryKey[2] === 'dhcp-prefixes',
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>DHCP Configuration</CardTitle>
        <CardDescription>
          Control how this prefix serves DHCP. Authoritative assigns addresses; Proxy provides PXE boot info only.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <FormSelect
            control={control}
            name="dhcpMode"
            label="DHCP mode"
            options={modeOptions}
            placeholder="Select a mode"
          />

          {hasMode && (
            <>
              {isAuthoritative && (
                <FormNumberInput
                  control={control}
                  name="dhcpLeaseTtlSeconds"
                  label="Lease TTL (seconds)"
                  placeholder="600 (default)"
                  description="Duration each lease is valid, in seconds (minimum 120)."
                  min={120}
                />
              )}

              <FormSelect
                control={control}
                name="ipxeBuildTarget"
                label="iPXE boot target"
                options={ipxeOptions}
                placeholder="iPXE (default)"
                description="PXE firmware flavor: standard iPXE, SNP, or SNP-only."
              />

              <FormInput
                control={control}
                name="dhcpRelayAgentIp"
                label="DHCP relay agent IP"
                placeholder="192.168.1.1"
                description="Enter the relay agent IPv4 address. An active associated prefix requires this address."
              />

              {/* Custom DHCP options */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Custom DHCP options</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={optionFields.length >= 32}
                    onClick={() => appendOption({ code: 0, value: '' })}
                  >
                    <Plus className="mr-2 h-4 w-4" />
                    Add option
                  </Button>
                </div>
                {optionFields.length === 0 && (
                  <p className="text-muted-foreground text-sm">
                    No custom DHCP options. Reserved codes are auto-managed by the bridge.
                  </p>
                )}
                {optionFields.map((field, index) => (
                  <div key={field.id} className="flex items-end gap-2 rounded-lg border p-3">
                    <div className="grid flex-1 grid-cols-[100px_1fr] gap-3">
                      <FormNumberInput
                        control={control}
                        name={`dhcpOptions.${index}.code`}
                        label="Code"
                        placeholder="e.g. 42"
                        min={1}
                        max={254}
                      />
                      <FormInput
                        control={control}
                        name={`dhcpOptions.${index}.value`}
                        label="Value"
                        placeholder="e.g. 192.168.1.1"
                      />
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => removeOption(index)}
                      aria-label="Remove DHCP option"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* Proxy-only: allowed MACs for PXE boot */}
          {isProxy && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Allowed PXE boot MACs</span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={macFields.length >= 1024}
                  onClick={() => appendMac({ value: '' })}
                >
                  <Plus className="mr-2 h-4 w-4" />
                  Add MAC
                </Button>
              </div>
              <p className="text-muted-foreground text-sm">
                Devices already known to this prefix are allowed to PXE-boot automatically. Add extra MAC addresses here
                for devices not yet discovered (e.g. new hardware awaiting commissioning). Leave empty to allow only
                known devices.
              </p>
              {macFields.map((field, index) => (
                <div key={field.id} className="flex items-end gap-2">
                  <div className="flex-1">
                    <FormInput
                      control={control}
                      name={`dhcpProxyAllowedMacs.${index}.value`}
                      label={`MAC address ${index + 1}`}
                      placeholder="e.g. aa:bb:cc:dd:ee:ff"
                    />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => removeMac(index)}
                    aria-label="Remove MAC address"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}

              <FormCheckbox
                control={control}
                name="dhcpProxyPeerAuthoritative"
                label="External authoritative DHCP server on this segment"
                description="Declare that another server owns lease assignment here, silencing the bridge's no-lease-authority warning for this prefix."
              />
            </div>
          )}

          <div className="pt-2">
            <Button type="submit" disabled={updateMutation.isPending}>
              {updateMutation.isPending ? 'Saving...' : 'Save DHCP Config'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
