import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router';
import { Loader2, Trash2 } from 'lucide-react';
import { useState } from 'react';

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@repo/ui/components/alert-dialog';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { Label } from '@repo/ui/components/label';
import { tsr } from '~/lib/api';
import { DEPLOYMENT_PROJECTS_KEY } from '~/lib/query-keys';

export const Route = createFileRoute('/_app/deployments/_list/projects/$projectId/delete')({
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
  component: DeleteProjectRoute,
});

function DeleteProjectRoute() {
  const project = Route.useLoaderData();
  const navigate = useNavigate();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { mutateAsync: deleteProject, isPending } = tsr.deleteDeploymentProject.useMutation({
    meta: { successMessage: `Project "${project.name}" deleted` },
  });
  const [confirmation, setConfirmation] = useState('');

  const isConfirmed = confirmation === project.name;

  const onClose = () => {
    navigate({ to: '/deployments' });
  };

  const handleDelete = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isConfirmed) return;

    await deleteProject({ params: { projectId: project.id } });

    queryClient.removeQueries({ queryKey: DEPLOYMENT_PROJECTS_KEY });
    queryClient.removeQueries({ queryKey: ['deployment-project', project.id] });
    await router.invalidate();
    navigate({ to: '/deployments' });
  };

  return (
    <AlertDialog open={true} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <form onSubmit={handleDelete}>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-destructive flex items-center gap-2">
              <Trash2 className="h-5 w-5" />
              Delete Project
            </AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. This will permanently delete the project{' '}
              <strong className="text-foreground">{project.name}</strong> and all associated data.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2 py-4">
            <Label htmlFor="confirm-name">
              Type <strong>{project.name}</strong> to confirm
            </Label>
            <Input
              id="confirm-name"
              placeholder={project.name}
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              autoFocus
              className="mt-2"
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
            <Button type="submit" variant="destructive" disabled={isPending || !isConfirmed}>
              {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Delete Project
            </Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
