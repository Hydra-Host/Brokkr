import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@repo/ui/components/select';
import { useDocumentTitle } from '@repo/ui/hooks/use-document-title';
import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router';
import { FlaskConical } from 'lucide-react';
import { DeviceTestRunsTable } from './-components/device-test-runs-table';

const TEST_TYPE_VALUES = ['GpuBurnIn', 'NcclPerformance'] as const;
type TestTypeFilter = (typeof TEST_TYPE_VALUES)[number];

const TEST_STATUS_VALUES = ['Running', 'Completed'] as const;
type TestStatusFilter = (typeof TEST_STATUS_VALUES)[number];

interface DeviceTestRunsSearch {
  type?: TestTypeFilter;
  status?: TestStatusFilter;
}

export const Route = createFileRoute('/_app/dcim/test-runs')({
  staticData: {
    breadcrumb: 'Test Runs',
    description: 'View hardware test results from device burn-in and diagnostics.',
  },
  component: DeviceTestRunsPage,
  validateSearch: (search: Record<string, unknown>): DeviceTestRunsSearch => ({
    type: search.type as TestTypeFilter | undefined,
    status: search.status as TestStatusFilter | undefined,
  }),
});

const TYPE_ITEMS = [
  { value: 'all', label: 'All Types' },
  { value: 'GpuBurnIn', label: 'GPU Burn-in' },
  { value: 'NcclPerformance', label: 'NCCL Performance' },
];

const STATUS_ITEMS = [
  { value: 'all', label: 'All Statuses' },
  { value: 'Running', label: 'Running' },
  { value: 'Completed', label: 'Completed' },
];

function DeviceTestRunsPage() {
  useDocumentTitle('Test Runs');

  const { type: filterType, status: filterStatus } = useSearch({ from: '/_app/dcim/test-runs' });
  const navigate = useNavigate({ from: '/dcim/test-runs' });

  const setFilterType = (value: string) => {
    const type = TEST_TYPE_VALUES.includes(value as TestTypeFilter) ? (value as TestTypeFilter) : undefined;
    void navigate({ search: (prev) => ({ ...prev, type }), replace: true });
  };

  const setFilterStatus = (value: string) => {
    const status = TEST_STATUS_VALUES.includes(value as TestStatusFilter) ? (value as TestStatusFilter) : undefined;
    void navigate({ search: (prev) => ({ ...prev, status }), replace: true });
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <FlaskConical className="h-5 w-5" />
                Test Runs
              </CardTitle>
              <CardDescription>Hardware test results across all devices in your zones.</CardDescription>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground text-sm font-medium">Type:</span>
                <Select value={filterType ?? 'all'} onValueChange={setFilterType}>
                  <SelectTrigger className="w-[160px]">
                    {TYPE_ITEMS.find((i) => i.value === (filterType ?? 'all'))?.label}
                  </SelectTrigger>
                  <SelectContent>
                    {TYPE_ITEMS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground text-sm font-medium">Status:</span>
                <Select value={filterStatus ?? 'all'} onValueChange={setFilterStatus}>
                  <SelectTrigger className="w-[160px]">
                    {STATUS_ITEMS.find((i) => i.value === (filterStatus ?? 'all'))?.label}
                  </SelectTrigger>
                  <SelectContent>
                    {STATUS_ITEMS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <DeviceTestRunsTable tableName="dcim-device-test-runs" type={filterType} status={filterStatus} />
        </CardContent>
      </Card>
    </div>
  );
}
