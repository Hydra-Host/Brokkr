import { useIsInstanceOperator } from '~/hooks/use-is-instance-operator';
import { usePermissions } from '~/hooks/use-permissions';

export function useCanViewJobHistory(): { canView: boolean; isPending: boolean } {
  const { isInstanceOperator, isPending } = useIsInstanceOperator();
  const { can } = usePermissions();
  return { canView: isInstanceOperator && can('job', 'read'), isPending };
}
