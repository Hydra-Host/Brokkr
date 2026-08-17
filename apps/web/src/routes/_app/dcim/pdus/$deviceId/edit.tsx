import { zodResolver } from '@hookform/resolvers/zod';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { Skeleton } from '@repo/ui/components/skeleton';
import { FormInput } from '@repo/ui/form/form-input';
import { FormSelect } from '@repo/ui/form/form-select';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { tsr } from '~/lib/api';

const wholeNumber = z.string().regex(/^\d*$/, 'Must be a whole number');

const editSchema = z.object({
  nickname: z.string(),
  outletCount: wholeNumber,
  ratedAmperage: wholeNumber,
  voltageType: z.string(),
  powerStatus: z.enum(['', 'On', 'Off']),
});

type EditFormData = z.infer<typeof editSchema>;

const POWER_OPTIONS = [
  { label: 'Unknown', value: '' },
  { label: 'On', value: 'On' },
  { label: 'Off', value: 'Off' },
] as const;

export const Route = createFileRoute('/_app/dcim/pdus/$deviceId/edit')({
  staticData: { breadcrumb: 'Edit' },
  component: EditPduPage,
});

function EditPduPage() {
  const { deviceId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isPending: isLoading } = tsr.getPduById.useQuery({
    queryKey: ['pdu', deviceId],
    queryData: { params: { deviceId } },
  });

  const updateMutation = tsr.updatePdu.useMutation({ meta: { successMessage: 'PDU updated' } });

  const pdu = data?.status === 200 ? data.body : null;

  const { control, handleSubmit, reset } = useForm<EditFormData>({
    resolver: zodResolver(editSchema),
    defaultValues: { nickname: '', outletCount: '', ratedAmperage: '', voltageType: '', powerStatus: '' },
  });

  useEffect(() => {
    if (pdu) {
      reset({
        nickname: pdu.nickname ?? '',
        outletCount: pdu.outletCount != null ? String(pdu.outletCount) : '',
        ratedAmperage: pdu.ratedAmperage != null ? String(pdu.ratedAmperage) : '',
        voltageType: pdu.voltageType ?? '',
        powerStatus: pdu.powerStatus ?? '',
      });
    }
  }, [pdu, reset]);

  if (isLoading) return <Skeleton className="h-64" />;
  if (!pdu) return null;

  if (pdu.deletedAt) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>PDU Decommissioned</CardTitle>
          <CardDescription>This PDU has been decommissioned and can no longer be modified.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" asChild>
            <Link to="/dcim/pdus/$deviceId" params={{ deviceId }}>
              Back to PDU
            </Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  const onSubmit = async (formData: EditFormData) => {
    const toNum = (s: string) => (s.trim() === '' ? null : Number(s));
    await updateMutation.mutateAsync({
      params: { deviceId },
      body: {
        nickname: formData.nickname.trim() || null,
        outletCount: toNum(formData.outletCount),
        ratedAmperage: toNum(formData.ratedAmperage),
        voltageType: formData.voltageType === '' ? null : formData.voltageType,
        powerStatus: formData.powerStatus === '' ? null : formData.powerStatus,
      },
    });
    await queryClient.invalidateQueries({ queryKey: ['pdu', deviceId] });
    await queryClient.invalidateQueries({ queryKey: ['pdus-active'] });
    navigate({ to: '/dcim/pdus/$deviceId', params: { deviceId } });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Edit PDU</CardTitle>
        <CardDescription>Update details for {pdu.nickname || pdu.name}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <FormInput control={control} name="nickname" label="Nickname" />
          <FormInput control={control} name="outletCount" label="Outlets" description="Total switched outlets." />
          <FormInput
            control={control}
            name="ratedAmperage"
            label="Rated amperage"
            description="Total rated amperage at the inlet."
          />
          <FormInput control={control} name="voltageType" label="Voltage" description="e.g. 120V, 208V, 240V." />
          <FormSelect control={control} name="powerStatus" label="Power status" options={POWER_OPTIONS} />
          <div className="flex gap-2 pt-2">
            <Button type="submit" disabled={updateMutation.isPending}>
              {updateMutation.isPending ? 'Saving...' : 'Save Changes'}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => navigate({ to: '/dcim/pdus/$deviceId', params: { deviceId } })}
            >
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
