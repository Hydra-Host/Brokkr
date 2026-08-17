import { useNavigate } from '@tanstack/react-router';
import { Loader2, Plus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import type { ZoneListItem } from '@repo/api-client';

import { Button } from '@repo/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@repo/ui/components/dialog';
import { cn } from '@repo/ui/utils';

import { usePermissions } from '~/hooks/use-permissions';
import { tsr } from '~/lib/api';

export function formatZoneLocation(zone: ZoneListItem): string {
  const address = zone.primaryAddress;
  if (!address) return '';
  return [address.city, address.stateOrProvince, address.countryCode].filter(Boolean).join(', ');
}

export function CommissionServersButton({ className }: { className?: string }) {
  const { can } = usePermissions();
  const navigate = useNavigate();
  const [isLoadingZones, setIsLoadingZones] = useState(false);
  const [pickerZones, setPickerZones] = useState<ZoneListItem[] | null>(null);

  if (!can('device', 'create')) return null;

  const goToZoneCommission = (zoneId: string) => {
    setPickerZones(null);
    void navigate({ to: '/dcim/zones/$zoneId/commission', params: { zoneId } });
  };

  const handleClick = async () => {
    setIsLoadingZones(true);
    try {
      const res = await tsr.getZones.query({ query: { pageSize: 100 } });
      if (res.status !== 200) {
        toast.error('Failed to load zones. Please try again.');
        return;
      }
      const zones = res.body.data;
      if (zones.length === 0) {
        toast.info('Create a zone before commissioning servers.');
        void navigate({ to: '/dcim/zones/create' });
      } else if (zones.length === 1) {
        goToZoneCommission(zones[0].id);
      } else {
        setPickerZones(zones);
      }
    } catch {
      toast.error('Failed to load zones. Please try again.');
    } finally {
      setIsLoadingZones(false);
    }
  };

  return (
    <>
      <Button
        className={cn('flex items-center gap-2', className)}
        disabled={isLoadingZones}
        onClick={() => void handleClick()}
      >
        {isLoadingZones ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
        Commission Servers
      </Button>
      <Dialog
        open={pickerZones !== null}
        onOpenChange={(open) => {
          if (!open) setPickerZones(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Select a zone</DialogTitle>
            <DialogDescription>Commissioning is zone-scoped. Choose the zone the servers are in.</DialogDescription>
          </DialogHeader>
          <div className="max-h-80 space-y-2 overflow-y-auto">
            {(pickerZones ?? []).map((zone) => {
              const location = formatZoneLocation(zone);
              return (
                <Button
                  key={zone.id}
                  variant="outline"
                  className="h-auto w-full justify-start py-2"
                  onClick={() => goToZoneCommission(zone.id)}
                >
                  <div className="flex flex-col items-start">
                    <span className="font-medium">{zone.name}</span>
                    {location && <span className="text-muted-foreground text-xs font-normal">{location}</span>}
                  </div>
                </Button>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
