import { zodResolver } from '@hookform/resolvers/zod';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/components/card';
import { FormInput } from '@repo/ui/form/form-input';
import { FormSelect } from '@repo/ui/form/form-select';
import { FormTextarea } from '@repo/ui/form/form-textarea';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { filterPrefixesByZone, PrefixCombobox, ZoneCombobox } from '~/components/fk-comboboxes';
import { tsr } from '~/lib/api';

const statusOptions = [
  { label: 'Active', value: 'ACTIVE' },
  { label: 'Reserved', value: 'RESERVED' },
  { label: 'Deprecated', value: 'DEPRECATED' },
] as const;

export const UNASSIGNED_ZONE_VALUE = 'unassigned';

export function zoneFilterFromSelection(zoneValue: string): string | null | undefined {
  if (!zoneValue) return undefined;
  return zoneValue === UNASSIGNED_ZONE_VALUE ? null : zoneValue;
}

const createIpRangeSchema = z.object({
  start: z.string().min(1, 'Start address is required'),
  end: z.string().min(1, 'End address is required'),
  status: z.string(),
  purpose: z.string(),
  zoneId: z.string().min(1, 'Zone is required'),
  prefixId: z.string().min(1, 'Prefix is required'),
});

type CreateIpRangeFormData = z.infer<typeof createIpRangeSchema>;

export const Route = createFileRoute('/_app/ipam/ip-ranges/create')({
  staticData: { breadcrumb: 'Create' },
  component: CreateIpRangePage,
});

function CreateIpRangePage() {
  useDocumentTitle('Create IP Range');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { mutateAsync: createIpRange, isPending } = tsr.createIpRange.useMutation({
    meta: { successMessage: 'IP range created' },
  });

  const { control, handleSubmit, setValue } = useForm<CreateIpRangeFormData>({
    resolver: zodResolver(createIpRangeSchema),
    defaultValues: {
      start: '',
      end: '',
      status: 'ACTIVE',
      purpose: '',
      zoneId: '',
      prefixId: '',
    },
  });

  const selectedZoneId = useWatch({ control, name: 'zoneId' });
  const selectedPrefixId = useWatch({ control, name: 'prefixId' });
  const zoneFilter = zoneFilterFromSelection(selectedZoneId);

  const { data: prefixesData } = tsr.listPrefixes.useQuery({ queryKey: ['prefixes', 'fk'], queryData: { query: {} } });

  useEffect(() => {
    if (!selectedPrefixId || prefixesData?.status !== 200) return;
    if (!filterPrefixesByZone(prefixesData.body, zoneFilter).some((p) => p.id === selectedPrefixId)) {
      setValue('prefixId', '');
    }
  }, [selectedPrefixId, zoneFilter, prefixesData, setValue]);

  const onSubmit = async (data: CreateIpRangeFormData) => {
    await createIpRange({
      body: {
        start: data.start,
        end: data.end,
        status: data.status as 'ACTIVE' | 'RESERVED' | 'DEPRECATED',
        purpose: data.purpose || undefined,
        prefixId: data.prefixId,
      },
    });
    await queryClient.invalidateQueries({ queryKey: ['ip-ranges'] });
    navigate({ to: '/ipam/ip-ranges' });
  };

  return (
    <div className="space-y-6">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>IP Range Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <FormInput
              control={control}
              name="start"
              label="Start Address"
              description="Start of the IP range (e.g. 10.0.0.1)"
            />
            <FormInput
              control={control}
              name="end"
              label="End Address"
              description="End of the IP range (e.g. 10.0.0.254)"
            />
            <FormSelect
              control={control}
              name="status"
              label="Status"
              options={statusOptions}
              placeholder="Select status"
            />
            <ZoneCombobox
              control={control}
              name="zoneId"
              seedOption={{ value: UNASSIGNED_ZONE_VALUE, label: 'Unassigned' }}
              description="Zone whose prefixes to pick from. Choose Unassigned for prefixes without a zone."
            />
            <PrefixCombobox
              control={control}
              name="prefixId"
              zoneId={zoneFilter}
              disabled={!selectedZoneId}
              placeholder={selectedZoneId ? 'Select a prefix' : 'Select a zone first'}
            />
            <FormTextarea control={control} name="purpose" label="Purpose" />
          </CardContent>
        </Card>

        <div className="flex gap-2">
          <Button type="submit" disabled={isPending}>
            {isPending ? 'Creating...' : 'Create IP Range'}
          </Button>
          <Button type="button" variant="outline" onClick={() => navigate({ to: '/ipam/ip-ranges' })}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
