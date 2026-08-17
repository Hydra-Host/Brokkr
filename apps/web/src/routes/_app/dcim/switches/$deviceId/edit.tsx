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
  switchRole: z.enum(['', 'leaf', 'spine', 'management', 'serial-console']),
  fabric: z.enum(['', 'east-west', 'north-south']),
  portCount: wholeNumber,
  powerStatus: z.enum(['', 'On', 'Off']),
});

type EditFormData = z.infer<typeof editSchema>;

const ROLE_OPTIONS = [
  { label: 'Unspecified', value: '' },
  { label: 'Leaf', value: 'leaf' },
  { label: 'Spine', value: 'spine' },
  { label: 'Management', value: 'management' },
  { label: 'Serial console', value: 'serial-console' },
] as const;

const FABRIC_OPTIONS = [
  { label: 'Unspecified', value: '' },
  { label: 'East-west', value: 'east-west' },
  { label: 'North-south', value: 'north-south' },
] as const;

const POWER_OPTIONS = [
  { label: 'Unknown', value: '' },
  { label: 'On', value: 'On' },
  { label: 'Off', value: 'Off' },
] as const;

export const Route = createFileRoute('/_app/dcim/switches/$deviceId/edit')({
  staticData: { breadcrumb: 'Edit' },
  component: EditSwitchPage,
});

function EditSwitchPage() {
  const { deviceId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isPending: isLoading } = tsr.getSwitchById.useQuery({
    queryKey: ['switch', deviceId],
    queryData: { params: { deviceId } },
  });

  const updateMutation = tsr.updateSwitch.useMutation({ meta: { successMessage: 'Switch updated' } });

  const sw = data?.status === 200 ? data.body : null;

  const { control, handleSubmit, reset } = useForm<EditFormData>({
    resolver: zodResolver(editSchema),
    defaultValues: {
      nickname: '',
      switchRole: '',
      fabric: '',
      portCount: '',
      powerStatus: '',
    },
  });

  useEffect(() => {
    if (sw) {
      const role = editSchema.shape.switchRole.safeParse(sw.switchRole);
      const fabric = editSchema.shape.fabric.safeParse(sw.fabric);
      reset({
        nickname: sw.nickname ?? '',
        switchRole: role.success ? role.data : '',
        fabric: fabric.success ? fabric.data : '',
        portCount: sw.portCount != null ? String(sw.portCount) : '',
        powerStatus: sw.powerStatus ?? '',
      });
    }
  }, [sw, reset]);

  if (isLoading) return <Skeleton className="h-64" />;
  if (!sw) return null;

  if (sw.deletedAt) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Switch Decommissioned</CardTitle>
          <CardDescription>This switch has been decommissioned and can no longer be modified.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" asChild>
            <Link to="/dcim/switches/$deviceId" params={{ deviceId }}>
              Back to Switch
            </Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  const onSubmit = async (formData: EditFormData) => {
    const preserveLegacyRole =
      formData.switchRole === '' &&
      sw.switchRole != null &&
      !editSchema.shape.switchRole.safeParse(sw.switchRole).success;
    const preserveLegacyFabric =
      formData.fabric === '' && sw.fabric != null && !editSchema.shape.fabric.safeParse(sw.fabric).success;
    await updateMutation.mutateAsync({
      params: { deviceId },
      body: {
        nickname: formData.nickname.trim() || null,
        ...(preserveLegacyRole ? {} : { switchRole: formData.switchRole === '' ? null : formData.switchRole }),
        ...(preserveLegacyFabric ? {} : { fabric: formData.fabric === '' ? null : formData.fabric }),
        portCount: formData.portCount.trim() === '' ? null : Number(formData.portCount),
        powerStatus: formData.powerStatus === '' ? null : formData.powerStatus,
      },
    });
    await queryClient.invalidateQueries({ queryKey: ['switch', deviceId] });
    await queryClient.invalidateQueries({ queryKey: ['switches-active'] });
    navigate({ to: '/dcim/switches/$deviceId', params: { deviceId } });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Edit Switch</CardTitle>
        <CardDescription>Update details for {sw.nickname || sw.name}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <FormInput control={control} name="nickname" label="Nickname" />
          <FormSelect control={control} name="switchRole" label="Role" options={ROLE_OPTIONS} />
          <FormSelect control={control} name="fabric" label="Fabric" options={FABRIC_OPTIONS} />
          <FormInput
            control={control}
            name="portCount"
            label="Port count"
            description="Physical port count on the chassis."
          />
          <FormSelect control={control} name="powerStatus" label="Power status" options={POWER_OPTIONS} />
          <div className="flex gap-2 pt-2">
            <Button type="submit" disabled={updateMutation.isPending}>
              {updateMutation.isPending ? 'Saving...' : 'Save Changes'}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => navigate({ to: '/dcim/switches/$deviceId', params: { deviceId } })}
            >
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
