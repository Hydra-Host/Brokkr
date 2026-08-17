import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router';
import { MoveUpRight } from 'lucide-react';
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
import { FormSelect } from '@repo/ui/form/form-select';
import { FormSubmitButton } from '@repo/ui/form/form-submit-button';
import { tsr } from '~/lib/api';
import { DEPLOYMENT_PROJECTS_KEY } from '~/lib/query-keys';

const moveDeploymentSchema = z.object({
  targetProjectId: z.string().min(1, 'Please select a destination project'),
});

type MoveDeploymentFormData = z.infer<typeof moveDeploymentSchema>;

export const Route = createFileRoute('/_app/deployments/_list/projects/$projectId/move-deployment/$deploymentId')({
  loader: async ({ context: { queryClient }, params }) => {
    const response = await queryClient.fetchQuery({
      queryKey: DEPLOYMENT_PROJECTS_KEY,
      queryFn: () => tsr.getDeploymentProjects.query({ query: { pageSize: 100 } }),
    });

    if (response.status !== 200) {
      throw new Error('Failed to load projects');
    }

    const projects = response.body.data;
    const sourceProject = projects.find((p) => p.id === params.projectId);
    if (!sourceProject) {
      throw new Error('Source project not found');
    }

    const deployment = sourceProject.deployments.find((d) => String(d.id) === params.deploymentId);
    if (!deployment) {
      throw new Error('Deployment not found in source project');
    }

    const otherProjects = projects.filter((p) => p.id !== params.projectId);

    return { sourceProject, deployment, otherProjects };
  },
  component: MoveDeploymentRoute,
});

function MoveDeploymentRoute() {
  const { sourceProject, deployment, otherProjects } = Route.useLoaderData();
  const navigate = useNavigate();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { mutateAsync: moveDeployments, isPending } = tsr.moveDeploymentsToProject.useMutation({
    meta: { successMessage: 'Deployment moved successfully' },
  });

  const form = useForm<MoveDeploymentFormData>({
    resolver: zodResolver(moveDeploymentSchema),
    defaultValues: {
      targetProjectId: '',
    },
  });

  const onClose = () => {
    navigate({ to: '/deployments' });
  };

  const onSubmit = async (data: MoveDeploymentFormData) => {
    await moveDeployments({
      params: { projectId: data.targetProjectId },
      body: {
        deploymentIds: [String(deployment.id)],
        sourceProjectId: sourceProject.id,
      },
    });

    queryClient.removeQueries({ queryKey: DEPLOYMENT_PROJECTS_KEY });
    await router.invalidate();
    navigate({ to: '/deployments' });
  };

  const projectOptions = otherProjects.map((project) => ({
    value: project.id,
    label: `${project.name} (${project.deployments.length} deployment${project.deployments.length !== 1 ? 's' : ''})`,
  }));

  return (
    <Dialog open={true} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form onSubmit={form.handleSubmit(onSubmit)}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MoveUpRight className="h-5 w-5" />
              Move Deployment
            </DialogTitle>
            <DialogDescription>
              Move{' '}
              <strong className="text-foreground">
                {deployment.customer?.deviceName || `Device ${deployment.id}`}
              </strong>{' '}
              from <strong className="text-foreground">{sourceProject.name}</strong> to another project.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <FormSelect
              control={form.control}
              name="targetProjectId"
              label="Destination Project"
              placeholder="Select a project"
              options={projectOptions}
            />

            <div className="bg-muted rounded-lg p-4">
              <p className="text-sm font-medium">Deployment to move:</p>
              <ul className="text-muted-foreground mt-2 space-y-1 text-sm">
                <li>
                  {deployment.customer?.deviceName || 'Unnamed Device'} (ID: {deployment.id})
                </li>
              </ul>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={isPending}>
              Cancel
            </Button>
            <FormSubmitButton pending={isPending}>Move Deployment</FormSubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
