import { zodResolver } from '@hookform/resolvers/zod';
import { DNS_DOMAIN_PATTERN, type ZoneDnsConfig } from '@repo/api-client';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { Skeleton } from '@repo/ui/components/skeleton';
import { FormCheckbox } from '@repo/ui/form/form-checkbox';
import { FormInput } from '@repo/ui/form/form-input';
import { FormNumberInput } from '@repo/ui/form/form-number-input';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { Globe } from 'lucide-react';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { tsr } from '~/lib/api';
import { isValidIpv4 } from '~/lib/ip-utils';

export const Route = createFileRoute('/_app/dcim/zones/$zoneId/dns/')({
  staticData: { breadcrumb: 'DNS' },
  component: ZoneDnsConfigPage,
});

export const dnsConfigFormSchema = z
  .object({
    enabled: z.boolean(),
    upstreamResolversText: z.string(),
    ttlSeconds: z.coerce.number().int().min(0),
    cacheSize: z.coerce.number().int().min(0),
    ownedDomain: z
      .string()
      .min(1, 'Owned domain is required')
      .max(253)
      .regex(DNS_DOMAIN_PATTERN, 'Must be a valid DNS domain')
      .refine(
        (val) => val.split('.').every((label) => label.length <= 63),
        'Each DNS label must be at most 63 characters',
      ),
    upstreamTimeoutMs: z.coerce.number().int().min(1),
    pollMs: z.coerce.number().int().min(1),
    tcpMaxConnections: z.coerce.number().int().min(1).optional(),
    tcpMaxQueriesPerConn: z.coerce.number().int().min(1).optional(),
    tcpIdleTimeoutMs: z.coerce.number().int().min(1).optional(),
    tcpMaxMessageBytes: z.coerce.number().int().min(1).optional(),
    maxTtlSeconds: z.coerce.number().int().min(0).optional(),
    maxCacheTtlSeconds: z.coerce.number().int().min(0).optional(),
    minCacheTtlSeconds: z.coerce.number().int().min(0).optional(),
    negTtlSeconds: z.coerce.number().int().min(0).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.upstreamResolversText.trim() !== '') {
      const ips = data.upstreamResolversText.split(',').map((s) => s.trim());
      for (const ip of ips) {
        if (ip === '') continue;
        if (!isValidIpv4(ip)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['upstreamResolversText'],
            message: `Invalid IP address: ${ip}`,
          });
          return;
        }
      }
    }
    const minCache = data.minCacheTtlSeconds ?? 0;
    const maxCache = data.maxCacheTtlSeconds ?? 0;
    if (minCache > 0 && maxCache > 0 && minCache > maxCache) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['minCacheTtlSeconds'],
        message: 'Min cache TTL must be <= max cache TTL',
      });
    }
  });

type DnsConfigFormData = z.infer<typeof dnsConfigFormSchema>;

export function apiToForm(config: ZoneDnsConfig): DnsConfigFormData {
  return {
    enabled: config.enabled,
    upstreamResolversText: config.upstreamResolvers.join(', '),
    ttlSeconds: config.ttlSeconds,
    cacheSize: config.cacheSize,
    ownedDomain: config.ownedDomain,
    upstreamTimeoutMs: config.upstreamTimeoutMs,
    pollMs: config.pollMs,
    tcpMaxConnections: config.tcpMaxConnections ?? undefined,
    tcpMaxQueriesPerConn: config.tcpMaxQueriesPerConn ?? undefined,
    tcpIdleTimeoutMs: config.tcpIdleTimeoutMs ?? undefined,
    tcpMaxMessageBytes: config.tcpMaxMessageBytes ?? undefined,
    maxTtlSeconds: config.maxTtlSeconds ?? undefined,
    maxCacheTtlSeconds: config.maxCacheTtlSeconds ?? undefined,
    minCacheTtlSeconds: config.minCacheTtlSeconds ?? undefined,
    negTtlSeconds: config.negTtlSeconds ?? undefined,
  };
}

export function formToPayload(formData: DnsConfigFormData) {
  const nullIfUnset = (v: number | undefined): number | null => v ?? null;
  return {
    enabled: formData.enabled,
    upstreamResolvers: formData.upstreamResolversText
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
    ttlSeconds: formData.ttlSeconds,
    cacheSize: formData.cacheSize,
    ownedDomain: formData.ownedDomain,
    upstreamTimeoutMs: formData.upstreamTimeoutMs,
    pollMs: formData.pollMs,
    tcpMaxConnections: nullIfUnset(formData.tcpMaxConnections),
    tcpMaxQueriesPerConn: nullIfUnset(formData.tcpMaxQueriesPerConn),
    tcpIdleTimeoutMs: nullIfUnset(formData.tcpIdleTimeoutMs),
    tcpMaxMessageBytes: nullIfUnset(formData.tcpMaxMessageBytes),
    maxTtlSeconds: nullIfUnset(formData.maxTtlSeconds),
    maxCacheTtlSeconds: nullIfUnset(formData.maxCacheTtlSeconds),
    minCacheTtlSeconds: nullIfUnset(formData.minCacheTtlSeconds),
    negTtlSeconds: nullIfUnset(formData.negTtlSeconds),
  };
}

const emptyDefaults: DnsConfigFormData = {
  enabled: false,
  upstreamResolversText: '',
  ttlSeconds: 300,
  cacheSize: 10000,
  ownedDomain: 'lan',
  upstreamTimeoutMs: 1000,
  pollMs: 2000,
  tcpMaxConnections: undefined,
  tcpMaxQueriesPerConn: undefined,
  tcpIdleTimeoutMs: undefined,
  tcpMaxMessageBytes: undefined,
  maxTtlSeconds: undefined,
  maxCacheTtlSeconds: undefined,
  minCacheTtlSeconds: undefined,
  negTtlSeconds: undefined,
};

function ZoneDnsConfigPage() {
  const { zoneId } = Route.useParams();
  const queryClient = useQueryClient();

  const { data, isPending, isError } = tsr.getZoneDnsConfig.useQuery({
    queryKey: ['zone', zoneId, 'dns-config'],
    queryData: { params: { zoneId } },
  });

  const updateMutation = tsr.updateZoneDnsConfig.useMutation();

  const config = data?.status === 200 ? data.body : null;

  const { control, handleSubmit, reset } = useForm<DnsConfigFormData>({
    resolver: zodResolver(dnsConfigFormSchema),
    defaultValues: emptyDefaults,
  });

  useEffect(() => {
    if (config) {
      reset(apiToForm(config));
    }
  }, [config, reset]);

  if (isPending) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (isError || (data !== undefined && data.status !== 200)) {
    return (
      <Card>
        <CardContent className="py-8 text-center">
          <p className="text-destructive">Failed to load DNS configuration. Try refreshing the page.</p>
        </CardContent>
      </Card>
    );
  }

  const onSubmit = async (formData: DnsConfigFormData) => {
    try {
      const res = await updateMutation.mutateAsync({
        params: { zoneId },
        body: formToPayload(formData),
      });
      if (res.status === 200) {
        toast.success('DNS configuration updated');
        await queryClient.invalidateQueries({ queryKey: ['zone', zoneId, 'dns-config'] });
      } else {
        toast.error('Failed to update DNS configuration.');
      }
    } catch {
      toast.error('Failed to update DNS configuration.');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm">
        <Link to="/dcim/zones/$zoneId" params={{ zoneId }} className="text-muted-foreground hover:text-foreground">
          Zone
        </Link>
        <span className="text-muted-foreground">/</span>
        <span>DNS Configuration</span>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Globe className="h-5 w-5" />
            DNS Configuration
          </CardTitle>
          <CardDescription>
            Configure zone-level DNS settings. Changes are published to all bridges in this zone.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
            <FormCheckbox
              control={control}
              name="enabled"
              label="Enable DNS"
              description="Activate the bridge DNS server for this zone."
            />

            <div className="grid gap-4 sm:grid-cols-2">
              <FormInput
                control={control}
                name="ownedDomain"
                label="Owned domain"
                description="Authoritative domain suffix (e.g. lan)."
              />
              <FormInput
                control={control}
                name="upstreamResolversText"
                label="Upstream resolvers"
                placeholder="8.8.8.8, 8.8.4.4"
                description="Comma-separated upstream DNS resolver IPs."
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <FormNumberInput
                control={control}
                name="ttlSeconds"
                label="Default TTL (s)"
                min={0}
                description="Default TTL for authoritative records."
              />
              <FormNumberInput
                control={control}
                name="cacheSize"
                label="Cache size"
                min={0}
                description="Max entries in the resolver cache (0 = disabled)."
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <FormNumberInput
                control={control}
                name="maxTtlSeconds"
                label="Max TTL (s)"
                min={0}
                description="Upper TTL clamp for cached records (empty = no clamp)."
              />
              <FormNumberInput
                control={control}
                name="negTtlSeconds"
                label="Negative TTL (s)"
                min={0}
                description="TTL for NXDOMAIN cache entries (empty = no caching)."
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <FormNumberInput
                control={control}
                name="maxCacheTtlSeconds"
                label="Max cache TTL (s)"
                min={0}
                description="Maximum TTL for cache entries (empty = no limit)."
              />
              <FormNumberInput
                control={control}
                name="minCacheTtlSeconds"
                label="Min cache TTL (s)"
                min={0}
                description="Minimum TTL floor for cache entries."
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <FormNumberInput
                control={control}
                name="upstreamTimeoutMs"
                label="Upstream timeout (ms)"
                min={1}
                description="Timeout for a single upstream resolver query."
              />
              <FormNumberInput
                control={control}
                name="pollMs"
                label="Config poll interval (ms)"
                min={1}
                description="How often bridges poll for DNS config and record changes."
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <FormNumberInput
                control={control}
                name="tcpMaxConnections"
                label="TCP max connections"
                min={1}
                description="Maximum concurrent TCP connections (empty = server default)."
              />
              <FormNumberInput
                control={control}
                name="tcpMaxQueriesPerConn"
                label="TCP max queries/conn"
                min={1}
                description="Maximum queries per TCP connection (empty = server default)."
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <FormNumberInput
                control={control}
                name="tcpIdleTimeoutMs"
                label="TCP idle timeout (ms)"
                min={1}
                description="Idle timeout in milliseconds before closing a TCP connection (empty = server default)."
              />
              <FormNumberInput
                control={control}
                name="tcpMaxMessageBytes"
                label="TCP max message size (bytes)"
                min={1}
                description="Maximum DNS message size over TCP (empty = server default)."
              />
            </div>

            <div className="pt-2">
              <Button type="submit" disabled={updateMutation.isPending}>
                {updateMutation.isPending ? 'Saving...' : 'Save DNS Config'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
