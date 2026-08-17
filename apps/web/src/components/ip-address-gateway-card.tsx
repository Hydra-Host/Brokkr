import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { Skeleton } from '@repo/ui/components/skeleton';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { tsr } from '~/lib/api';
import { findContainingPrefix, isValidIpv4, stripHostMask } from '~/lib/ip-utils';

export function IpAddressGatewayCard({
  ipAddressId,
  address,
  vrfId,
}: {
  ipAddressId: string;
  address: string;
  vrfId: string | null;
}) {
  const queryClient = useQueryClient();

  const isIpv4 = isValidIpv4(stripHostMask(address));

  const { data: prefixesData, isPending } = tsr.listPrefixes.useQuery({
    queryKey: ['prefixes'],
    queryData: { query: {} },
    enabled: isIpv4,
  });

  const validateMutation = tsr.validatePrefixGateway.useMutation();
  const setMutation = tsr.setPrefixGateway.useMutation({ meta: { successMessage: 'Prefix gateway set' } });

  if (!isIpv4) return null;

  if (isPending) return <Skeleton className="h-40" />;

  const prefixes = prefixesData?.status === 200 ? prefixesData.body : [];
  const containingPrefix = findContainingPrefix(prefixes, address, vrfId);
  const isCurrentGateway = containingPrefix !== null && containingPrefix.gatewayIpId === ipAddressId;
  const pending = validateMutation.isPending || setMutation.isPending;

  const onSetGateway = async () => {
    if (!containingPrefix) return;
    const validation = await validateMutation.mutateAsync({
      body: { prefixId: containingPrefix.id, gatewayIpId: ipAddressId },
    });
    if (!(validation.status === 200 && validation.body.valid)) {
      toast.error(
        validation.status === 200
          ? (validation.body.reason ?? 'This IP address cannot be the prefix gateway.')
          : 'Failed to validate gateway.',
      );
      return;
    }
    await setMutation.mutateAsync({ params: { id: containingPrefix.id }, body: { gatewayIpId: ipAddressId } });
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['prefixes'] }),
      queryClient.invalidateQueries({ queryKey: ['prefix', containingPrefix.id] }),
    ]);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Prefix Gateway</CardTitle>
        <CardDescription>
          Make this address the default gateway of its containing prefix. The prefix&apos;s DHCP routers derive solely
          from the gateway assignment.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {containingPrefix ? (
          <>
            <p className="text-sm">
              Containing prefix: <span className="font-mono">{containingPrefix.prefix}</span>
            </p>
            <Button type="button" onClick={onSetGateway} disabled={isCurrentGateway || pending}>
              {isCurrentGateway ? 'Already the prefix gateway' : pending ? 'Setting...' : 'Set as prefix gateway'}
            </Button>
          </>
        ) : (
          <p className="text-muted-foreground text-sm">No prefix contains this address.</p>
        )}
      </CardContent>
    </Card>
  );
}
