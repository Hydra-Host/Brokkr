import { zodResolver } from '@hookform/resolvers/zod';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { Skeleton } from '@repo/ui/components/skeleton';
import { FormInput } from '@repo/ui/form/form-input';
import { FormSelect } from '@repo/ui/form/form-select';
import { useQueryClient } from '@tanstack/react-query';
import { Globe } from 'lucide-react';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { tsr } from '~/lib/api';
import { isValidIpv4 } from '~/lib/ip-utils';

const prefixDnsFormSchema = z
  .object({
    serveDns: z.enum(['inherit', 'true', 'false']),
    upstreamOverride: z.string(),
  })
  .superRefine((data, ctx) => {
    if (data.upstreamOverride.trim() === '') return;
    const ips = data.upstreamOverride.split(',').map((s) => s.trim());
    for (const ip of ips) {
      if (ip === '') continue;
      if (!isValidIpv4(ip)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['upstreamOverride'],
          message: `Invalid IP address: ${ip}`,
        });
        return;
      }
    }
  });

type PrefixDnsFormData = z.infer<typeof prefixDnsFormSchema>;

// ── Options ────────────────────────────────────────────────────────────

const serveDnsOptions = [
  { label: 'Inherit from zone', value: 'inherit' },
  { label: 'Enabled', value: 'true' },
  { label: 'Disabled', value: 'false' },
] as const;

// ── Helpers ────────────────────────────────────────────────────────────

export function apiToForm(serveDns: boolean | null, upstreamOverride: string[]): PrefixDnsFormData {
  return {
    serveDns: serveDns === null ? 'inherit' : serveDns ? 'true' : 'false',
    upstreamOverride: upstreamOverride.join(', '),
  };
}

const emptyDefaults: PrefixDnsFormData = {
  serveDns: 'inherit',
  upstreamOverride: '',
};

export function formValuesToPayload(formData: PrefixDnsFormData) {
  return {
    serveDns: formData.serveDns === 'inherit' ? null : formData.serveDns === 'true',
    upstreamOverride: formData.upstreamOverride
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '' && isValidIpv4(s)),
  };
}

// ── Component ──────────────────────────────────────────────────────────

export function PrefixDnsConfigCard({ prefixId }: { prefixId: string }) {
  const queryClient = useQueryClient();

  const { data, isPending, isError } = tsr.getPrefixDnsOverride.useQuery({
    queryKey: ['prefix', prefixId, 'dns-override'],
    queryData: { params: { id: prefixId } },
  });

  const updateMutation = tsr.updatePrefixDnsOverride.useMutation({
    meta: { successMessage: 'DNS override updated' },
  });

  const override = data?.status === 200 ? data.body : null;

  const { control, handleSubmit, reset } = useForm<PrefixDnsFormData>({
    resolver: zodResolver(prefixDnsFormSchema),
    defaultValues: emptyDefaults,
  });

  useEffect(() => {
    if (override) {
      reset(apiToForm(override.serveDns, override.upstreamOverride));
    }
  }, [override, reset]);

  if (isPending) return <Skeleton className="h-48" />;

  if (isError || (data !== undefined && data.status !== 200)) {
    return (
      <Card>
        <CardContent className="py-8 text-center">
          <p className="text-destructive">Failed to load DNS override. Try refreshing the page.</p>
        </CardContent>
      </Card>
    );
  }

  const onSubmit = async (formData: PrefixDnsFormData) => {
    await updateMutation.mutateAsync({
      params: { id: prefixId },
      body: formValuesToPayload(formData),
    });
    await queryClient.invalidateQueries({ queryKey: ['prefix', prefixId, 'dns-override'] });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Globe className="h-5 w-5" />
          DNS Override
        </CardTitle>
        <CardDescription>
          Override zone-level DNS settings for this prefix. &quot;Inherit&quot; uses the zone default.
          &quot;Enabled&quot; serves DNS on this prefix even when DHCP is not served here.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <FormSelect
            control={control}
            name="serveDns"
            label="Serve DNS"
            options={serveDnsOptions}
            description="Whether the bridge serves DNS on this prefix (IPv4 prefixes only). Enabled binds the bridge's local IPs in this prefix even without DHCP; Inherit defers to the zone setting."
          />

          <FormInput
            control={control}
            name="upstreamOverride"
            label="Upstream resolvers override"
            placeholder="e.g. 8.8.8.8, 1.1.1.1"
            description="Comma-separated list of upstream DNS resolvers. Leave empty to use the zone default."
          />

          <div className="pt-2">
            <Button type="submit" disabled={updateMutation.isPending}>
              {updateMutation.isPending ? 'Saving...' : 'Save DNS Override'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
