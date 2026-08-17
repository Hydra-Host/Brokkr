import { zodResolver } from '@hookform/resolvers/zod';
import type { ZoneServiceTuning } from '@repo/api-client';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { Skeleton } from '@repo/ui/components/skeleton';
import { FormNumberInput } from '@repo/ui/form/form-number-input';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { SlidersHorizontal } from 'lucide-react';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { tsr } from '~/lib/api';

export const Route = createFileRoute('/_app/dcim/zones/$zoneId/service-tuning')({
  staticData: { breadcrumb: 'Service tuning' },
  component: ZoneServiceTuningPage,
});

const serviceTuningFormSchema = z.object({
  dhcpLeaderPollMs: z.coerce.number().int().min(1).max(300_000),
  dhcpPruneIntervalMs: z.coerce.number().int().min(1).max(3_600_000),
  dhcpDeclineBackoffSeconds: z.coerce.number().int().min(0).max(86_400),
  vrrpGarpCount: z.coerce.number().int().min(1).max(50),
});

type ServiceTuningFormData = z.infer<typeof serviceTuningFormSchema>;

const emptyDefaults: ServiceTuningFormData = {
  dhcpLeaderPollMs: 2000,
  dhcpPruneIntervalMs: 60000,
  dhcpDeclineBackoffSeconds: 600,
  vrrpGarpCount: 5,
};

function ZoneServiceTuningPage() {
  const { zoneId } = Route.useParams();
  const queryClient = useQueryClient();

  const { data, isPending, isError } = tsr.getZoneServiceTuning.useQuery({
    queryKey: ['zone', zoneId, 'service-tuning'],
    queryData: { params: { zoneId } },
  });

  const updateMutation = tsr.updateZoneServiceTuning.useMutation();

  const tuning = data?.status === 200 ? data.body : null;

  const { control, handleSubmit, reset } = useForm<ServiceTuningFormData>({
    resolver: zodResolver(serviceTuningFormSchema),
    defaultValues: emptyDefaults,
  });

  useEffect(() => {
    if (tuning) {
      reset(tuning);
    }
  }, [tuning, reset]);

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
          <p className="text-destructive">Failed to load service tuning. Try refreshing the page.</p>
        </CardContent>
      </Card>
    );
  }

  const onSubmit = async (formData: ServiceTuningFormData) => {
    try {
      const res = await updateMutation.mutateAsync({
        params: { zoneId },
        body: formData satisfies ZoneServiceTuning,
      });
      if (res.status === 200) {
        toast.success('Service tuning updated');
        await queryClient.invalidateQueries({ queryKey: ['zone', zoneId, 'service-tuning'] });
      } else {
        toast.error('Failed to update service tuning.');
      }
    } catch {
      toast.error('Failed to update service tuning.');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm">
        <Link to="/dcim/zones/$zoneId" params={{ zoneId }} className="text-muted-foreground hover:text-foreground">
          Zone
        </Link>
        <span className="text-muted-foreground">/</span>
        <span>Service Tuning</span>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <SlidersHorizontal className="h-5 w-5" />
            Bridge Service Tuning
          </CardTitle>
          <CardDescription>
            Runtime tuning for the bridge DHCP engine and VRRP failover in this zone. Changes are published to all
            bridges via config atoms.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-2">
              <FormNumberInput
                control={control}
                name="dhcpLeaderPollMs"
                label="DHCP leader poll (ms)"
                min={1}
                max={300_000}
                description="How often bridges check leader status and DHCP config atoms."
              />
              <FormNumberInput
                control={control}
                name="dhcpPruneIntervalMs"
                label="DHCP lease prune interval (ms)"
                min={1}
                max={3_600_000}
                description="How often expired DHCP leases are pruned."
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <FormNumberInput
                control={control}
                name="dhcpDeclineBackoffSeconds"
                label="DHCP decline backoff (s)"
                min={0}
                max={86_400}
                description="Quarantine window for an address after a client DHCPDECLINE."
              />
              <FormNumberInput
                control={control}
                name="vrrpGarpCount"
                label="VRRP gratuitous ARP count"
                min={1}
                max={50}
                description="Gratuitous ARPs sent when the leader binds a virtual IP."
              />
            </div>

            <div className="pt-2">
              <Button type="submit" disabled={updateMutation.isPending}>
                {updateMutation.isPending ? 'Saving...' : 'Save Service Tuning'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
