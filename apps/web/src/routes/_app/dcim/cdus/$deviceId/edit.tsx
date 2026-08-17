import { zodResolver } from '@hookform/resolvers/zod';
import { AirflowSchema } from '@repo/api-client';
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
const decimalNumber = z.string().regex(/^(\d+(\.\d*)?|\.\d+)?$/, 'Must be a number');

const editSchema = z.object({
  nickname: z.string(),
  coolantType: z.string(),
  ratedFlowRateLpm: decimalNumber,
  ratedThermalCapacityKw: wholeNumber,
  airflow: AirflowSchema,
  powerStatus: z.enum(['', 'On', 'Off']),
});

type EditFormData = z.infer<typeof editSchema>;

const AIRFLOW_OPTIONS = [
  { label: 'Front to rear', value: 'FrontToRear' },
  { label: 'Rear to front', value: 'RearToFront' },
  { label: 'Left to right', value: 'LeftToRight' },
  { label: 'Right to left', value: 'RightToLeft' },
  { label: 'Side to rear', value: 'SideToRear' },
  { label: 'Passive', value: 'Passive' },
  { label: 'Mixed', value: 'Mixed' },
] as const;

const POWER_OPTIONS = [
  { label: 'Unknown', value: '' },
  { label: 'On', value: 'On' },
  { label: 'Off', value: 'Off' },
] as const;

export const Route = createFileRoute('/_app/dcim/cdus/$deviceId/edit')({
  staticData: { breadcrumb: 'Edit' },
  component: EditCduPage,
});

function EditCduPage() {
  const { deviceId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isPending: isLoading } = tsr.getCduById.useQuery({
    queryKey: ['cdu', deviceId],
    queryData: { params: { deviceId } },
  });

  const updateMutation = tsr.updateCdu.useMutation({ meta: { successMessage: 'CDU updated' } });

  const cdu = data?.status === 200 ? data.body : null;

  const { control, handleSubmit, reset } = useForm<EditFormData>({
    resolver: zodResolver(editSchema),
    defaultValues: {
      nickname: '',
      coolantType: '',
      ratedFlowRateLpm: '',
      ratedThermalCapacityKw: '',
      airflow: 'FrontToRear',
      powerStatus: '',
    },
  });

  useEffect(() => {
    if (cdu) {
      reset({
        nickname: cdu.nickname ?? '',
        coolantType: cdu.coolantType ?? '',
        ratedFlowRateLpm: cdu.ratedFlowRateLpm != null ? String(cdu.ratedFlowRateLpm) : '',
        ratedThermalCapacityKw: cdu.ratedThermalCapacityKw != null ? String(cdu.ratedThermalCapacityKw) : '',
        airflow: cdu.airflow,
        powerStatus: cdu.powerStatus ?? '',
      });
    }
  }, [cdu, reset]);

  if (isLoading) return <Skeleton className="h-64" />;
  if (!cdu) return null;

  if (cdu.deletedAt) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>CDU Decommissioned</CardTitle>
          <CardDescription>This CDU has been decommissioned and can no longer be modified.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" asChild>
            <Link to="/dcim/cdus/$deviceId" params={{ deviceId }}>
              Back to CDU
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
        coolantType: formData.coolantType === '' ? null : formData.coolantType,
        ratedFlowRateLpm: toNum(formData.ratedFlowRateLpm),
        ratedThermalCapacityKw: toNum(formData.ratedThermalCapacityKw),
        airflow: formData.airflow,
        powerStatus: formData.powerStatus === '' ? null : formData.powerStatus,
      },
    });
    await queryClient.invalidateQueries({ queryKey: ['cdu', deviceId] });
    await queryClient.invalidateQueries({ queryKey: ['cdus-active'] });
    navigate({ to: '/dcim/cdus/$deviceId', params: { deviceId } });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Edit CDU</CardTitle>
        <CardDescription>Update details for {cdu.nickname || cdu.name}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <FormInput control={control} name="nickname" label="Nickname" />
          <FormInput control={control} name="coolantType" label="Coolant" description="e.g. water, glycol." />
          <FormInput
            control={control}
            name="ratedFlowRateLpm"
            label="Flow rate (L/min)"
            description="Rated coolant flow at design conditions."
          />
          <FormInput
            control={control}
            name="ratedThermalCapacityKw"
            label="Thermal capacity (kW)"
            description="Rated heat-rejection capacity."
          />
          <FormSelect control={control} name="airflow" label="Airflow" options={AIRFLOW_OPTIONS} />
          <FormSelect control={control} name="powerStatus" label="Power status" options={POWER_OPTIONS} />
          <div className="flex gap-2 pt-2">
            <Button type="submit" disabled={updateMutation.isPending}>
              {updateMutation.isPending ? 'Saving...' : 'Save Changes'}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => navigate({ to: '/dcim/cdus/$deviceId', params: { deviceId } })}
            >
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
