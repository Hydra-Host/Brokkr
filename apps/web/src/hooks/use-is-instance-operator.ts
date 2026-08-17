import { tsr } from '~/lib/api';

export function useIsInstanceOperator(): { isInstanceOperator: boolean; isPending: boolean } {
  const { data, isPending } = tsr.getPluginHostContext.useQuery({
    queryKey: ['plugin-host-context'],
    queryData: {},
  });

  return {
    isInstanceOperator: data?.status === 200 && data.body.isInstanceOperator,
    isPending,
  };
}
