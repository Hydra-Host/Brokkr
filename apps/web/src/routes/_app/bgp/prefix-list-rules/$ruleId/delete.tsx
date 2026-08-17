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
import { Skeleton } from '@repo/ui/components/skeleton';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { tsr } from '~/lib/api';

export const Route = createFileRoute('/_app/bgp/prefix-list-rules/$ruleId/delete')({
  staticData: { breadcrumb: 'Delete' },
  component: DeletePrefixListRuleRoute,
});

function DeletePrefixListRuleRoute() {
  const { ruleId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isPending: isLoading } = tsr.getPrefixListRule.useQuery({
    queryKey: ['prefix-list-rule', ruleId],
    queryData: { params: { id: ruleId } },
  });

  const rule = data?.status === 200 ? data.body : null;

  useDocumentTitle(rule ? `Delete Rule #${rule.sequence}` : 'Delete Rule');

  const { mutateAsync: deleteRule, isPending } = tsr.deletePrefixListRule.useMutation({
    meta: { successMessage: 'Prefix list rule deleted' },
  });

  const onClose = () => {
    navigate({ to: '/bgp/prefix-list-rules/$ruleId', params: { ruleId } });
  };

  const onDelete = async () => {
    await deleteRule({
      params: { id: ruleId },
      body: {},
    });
    await queryClient.invalidateQueries({ queryKey: ['prefix-list-rules'] });
    navigate({ to: '/bgp/prefix-list-rules' });
  };

  if (isLoading) {
    return (
      <AlertDialog open={true} onOpenChange={(open) => !open && onClose()}>
        <AlertDialogContent className="sm:max-w-[425px]">
          <Skeleton className="h-24" />
        </AlertDialogContent>
      </AlertDialog>
    );
  }

  if (!rule) {
    return (
      <AlertDialog open={true} onOpenChange={(open) => !open && onClose()}>
        <AlertDialogContent className="sm:max-w-[425px]">
          <AlertDialogHeader>
            <AlertDialogTitle>Rule not found</AlertDialogTitle>
            <AlertDialogDescription>The prefix list rule could not be found.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Close</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );
  }

  return (
    <AlertDialog open={true} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent className="sm:max-w-[425px]">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete Rule #{rule.sequence}</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to delete rule <strong>#{rule.sequence}</strong> ({rule.action})? This action cannot
            be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <Button variant="destructive" onClick={onDelete} disabled={isPending}>
            {isPending ? 'Deleting...' : 'Delete Rule'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
