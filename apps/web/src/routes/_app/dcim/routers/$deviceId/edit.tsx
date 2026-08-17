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
  routerType: z.enum(['', 'edge', 'core', 'border', 'internal']),
  bgpAsn: wholeNumber
    .refine((v) => v === '' || Number(v) >= 1, 'ASN must be at least 1')
    .refine((v) => v === '' || Number(v) <= 2147483647, 'ASN must be at most 2147483647'),
  powerStatus: z.enum(['', 'On', 'Off']),
});

type EditFormData = z.infer<typeof editSchema>;

const TYPE_OPTIONS = [
  { label: 'Unspecified', value: '' },
  { label: 'Edge', value: 'edge' },
  { label: 'Core', value: 'core' },
  { label: 'Border', value: 'border' },
  { label: 'Internal', value: 'internal' },
] as const;

const POWER_OPTIONS = [
  { label: 'Unknown', value: '' },
  { label: 'On', value: 'On' },
  { label: 'Off', value: 'Off' },
] as const;

export const Route = createFileRoute('/_app/dcim/routers/$deviceId/edit')({
  staticData: { breadcrumb: 'Edit' },
  component: EditRouterPage,
});

function EditRouterPage() {
  const { deviceId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isPending: isLoading } = tsr.getRouterById.useQuery({
    queryKey: ['router', deviceId],
    queryData: { params: { deviceId } },
  });

  const updateMutation = tsr.updateRouter.useMutation({ meta: { successMessage: 'Router updated' } });

  const rtr = data?.status === 200 ? data.body : null;

  const { control, handleSubmit, reset } = useForm<EditFormData>({
    resolver: zodResolver(editSchema),
    defaultValues: {
      nickname: '',
      routerType: '',
      bgpAsn: '',
      powerStatus: '',
    },
  });

  useEffect(() => {
    if (rtr) {
      const type = editSchema.shape.routerType.safeParse(rtr.routerType);
      reset({
        nickname: rtr.nickname ?? '',
        routerType: type.success ? type.data : '',
        bgpAsn: rtr.bgpAsn != null ? String(rtr.bgpAsn) : '',
        powerStatus: rtr.powerStatus ?? '',
      });
    }
  }, [rtr, reset]);

  if (isLoading) return <Skeleton className="h-64" />;
  if (!rtr) return null;

  if (rtr.deletedAt) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Router Decommissioned</CardTitle>
          <CardDescription>This router has been decommissioned and can no longer be modified.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" asChild>
            <Link to="/dcim/routers/$deviceId" params={{ deviceId }}>
              Back to Router
            </Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  const onSubmit = async (formData: EditFormData) => {
    const preserveLegacyType =
      formData.routerType === '' &&
      rtr.routerType != null &&
      !editSchema.shape.routerType.safeParse(rtr.routerType).success;
    await updateMutation.mutateAsync({
      params: { deviceId },
      body: {
        nickname: formData.nickname.trim() || null,
        ...(preserveLegacyType ? {} : { routerType: formData.routerType === '' ? null : formData.routerType }),
        bgpAsn: formData.bgpAsn.trim() === '' ? null : Number(formData.bgpAsn),
        powerStatus: formData.powerStatus === '' ? null : formData.powerStatus,
      },
    });
    await queryClient.invalidateQueries({ queryKey: ['router', deviceId] });
    await queryClient.invalidateQueries({ queryKey: ['routers-active'] });
    navigate({ to: '/dcim/routers/$deviceId', params: { deviceId } });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Edit Router</CardTitle>
        <CardDescription>Update details for {rtr.nickname || rtr.name}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <FormInput control={control} name="nickname" label="Nickname" />
          <FormSelect control={control} name="routerType" label="Type" options={TYPE_OPTIONS} />
          <FormInput
            control={control}
            name="bgpAsn"
            label="BGP ASN"
            description="BGP autonomous system number this router announces from."
          />
          <FormSelect control={control} name="powerStatus" label="Power status" options={POWER_OPTIONS} />
          <div className="flex gap-2 pt-2">
            <Button type="submit" disabled={updateMutation.isPending}>
              {updateMutation.isPending ? 'Saving...' : 'Save Changes'}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => navigate({ to: '/dcim/routers/$deviceId', params: { deviceId } })}
            >
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
