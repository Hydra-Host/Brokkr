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
import { FormInput } from '@repo/ui/form/form-input';
import { FormSubmitButton } from '@repo/ui/form/form-submit-button';
import { tsr } from '~/lib/api';
import { DEPLOYMENT_PROJECTS_KEY } from '~/lib/query-keys';

const createProjectSchema = z.object({
  name: z.string().min(1, 'Project name is required'),
});

type CreateProjectFormData = z.infer<typeof createProjectSchema>;

export const Route = createFileRoute('/_app/deployments/_list/projects/create')({
  component: CreateProjectRoute,
});

function CreateProjectRoute() {
  const navigate = useNavigate();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { mutateAsync: createProject, isPending } = tsr.createDeploymentProject.useMutation({
    meta: { successMessage: 'Project created' },
  });

  const form = useForm<CreateProjectFormData>({
    resolver: zodResolver(createProjectSchema),
    defaultValues: {
      name: '',
    },
  });

  const onClose = () => {
    navigate({ to: '/deployments' });
  };

  const onSubmit = async (data: CreateProjectFormData) => {
    await createProject({ body: { name: data.name } });

    queryClient.removeQueries({ queryKey: DEPLOYMENT_PROJECTS_KEY });
    await router.invalidate();
    navigate({ to: '/deployments' });
  };

  return (
    <Dialog open={true} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form onSubmit={form.handleSubmit(onSubmit)}>
          <DialogHeader>
            <DialogTitle>Create Deployment Project</DialogTitle>
            <DialogDescription>Projects help you organize and manage related deployments together.</DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <FormInput
              control={form.control}
              name="name"
              label="Project Name"
              placeholder="Example Project"
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={isPending}>
              Cancel
            </Button>
            <FormSubmitButton pending={isPending}>Create Project</FormSubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
