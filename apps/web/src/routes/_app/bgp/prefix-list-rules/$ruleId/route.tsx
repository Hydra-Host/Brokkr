import type { PrefixListRule } from '@repo/api-client';
import { Button } from '@repo/ui/components/button';
import { Skeleton } from '@repo/ui/components/skeleton';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { Link, Outlet, createFileRoute } from '@tanstack/react-router';
import { tsr } from '~/lib/api';

export const Route = createFileRoute('/_app/bgp/prefix-list-rules/$ruleId')({
  staticData: {
    breadcrumb: (data) => {
      const rule = data as PrefixListRule;
      return rule?.sequence != null ? `Rule #${rule.sequence}` : 'Rule';
    },
  },
  loader: async ({ context: { queryClient }, params }) => {
    const response = await queryClient.fetchQuery({
      queryKey: ['prefix-list-rule', params.ruleId],
      queryFn: () => tsr.getPrefixListRule.query({ params: { id: params.ruleId } }),
    });
    if (response.status !== 200) throw new Error('Failed to load prefix list rule');
    return response.body;
  },
  component: PrefixListRuleLayout,
});

function PrefixListRuleLayout() {
  const { ruleId } = Route.useParams();

  const { data, isPending } = tsr.getPrefixListRule.useQuery({
    queryKey: ['prefix-list-rule', ruleId],
    queryData: { params: { id: ruleId } },
  });

  useDocumentTitle(data?.status === 200 ? `Rule #${data.body.sequence}` : 'Rule Detail');

  if (isPending) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!data || data.status !== 200) {
    return <p className="text-muted-foreground py-8 text-center">Prefix list rule not found.</p>;
  }

  const rule = data.body;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-lg font-medium">
            Rule #{rule.sequence} ({rule.action})
          </span>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" asChild>
            <Link to="/bgp/prefix-list-rules/$ruleId/edit" params={{ ruleId }}>
              Edit
            </Link>
          </Button>
          <Button variant="destructive" asChild>
            <Link to="/bgp/prefix-list-rules/$ruleId/delete" params={{ ruleId }}>
              Delete
            </Link>
          </Button>
        </div>
      </div>
      <Outlet />
    </div>
  );
}
