import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { Button } from '@repo/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@repo/ui/components/dialog';
import { FormCheckbox } from '@repo/ui/form/form-checkbox';
import { FormInput } from '@repo/ui/form/form-input';
import { FormSubmitButton } from '@repo/ui/form/form-submit-button';
import { tsr } from '~/lib/api';
import { DEPLOYMENT_PROJECTS_KEY } from '~/lib/query-keys';

const editProjectSchema = z.object({
  name: z.string().min(1, 'Project name is required'),
  isDefault: z.boolean(),
});

type EditProjectFormData = z.infer<typeof editProjectSchema>;

export const Route = createFileRoute('/_app/deployments/_list/projects/$projectId/edit')({
  loader: async ({ context: { queryClient }, params }) => {
    const response = await queryClient.fetchQuery({
      queryKey: ['deployment-project', params.projectId],
      queryFn: () =>
        tsr.getDeploymentProjectById.query({
          params: { projectId: params.projectId },
        }),
    });

    if (response.status !== 200) {
      throw new Error('Failed to load project');
    }

    return response.body;
  },
  component: EditProjectRoute,
});

function EditProjectRoute() {
  const project = Route.useLoaderData();
  const navigate = useNavigate();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { mutateAsync: updateProject, isPending } = tsr.updateDeploymentProject.useMutation({
    meta: { successMessage: 'Project updated' },
  });

  const form = useForm<EditProjectFormData>({
    resolver: zodResolver(editProjectSchema),
    defaultValues: {
      name: project.name,
      isDefault: project.isDefault,
    },
  });

  const onClose = () => {
    navigate({ to: '/deployments' });
  };

  const onSubmit = async (data: EditProjectFormData) => {
    await updateProject({
      params: { projectId: project.id },
      body: { name: data.name, isDefault: data.isDefault },
    });

    queryClient.removeQueries({ queryKey: DEPLOYMENT_PROJECTS_KEY });
    queryClient.removeQueries({ queryKey: ['deployment-project', project.id] });
    await router.invalidate();
    navigate({ to: '/deployments' });
  };

  return (
    <Dialog open={true} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form onSubmit={form.handleSubmit(onSubmit)}>
          <DialogHeader>
            <DialogTitle>Edit Project</DialogTitle>
            <DialogDescription>Update the project name or set it as the default project.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <FormInput
              control={form.control}
              name="name"
              label="Project Name"
              placeholder="Example Project"
              autoFocus
            />
            <FormCheckbox control={form.control} name="isDefault" label="Set as default project" />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={isPending}>
              Cancel
            </Button>
            <FormSubmitButton pending={isPending}>Save Changes</FormSubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
