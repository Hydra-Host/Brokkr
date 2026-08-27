import { JobTypeBadge } from '@repo/ui/components/job-type-badge';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Power, Zap } from 'lucide-react';

// Every key of the component's internal JOB_TYPE_VARIANT map.
const JOB_TYPES = [
  'Provision',
  'Reprovision',
  'Decommission',
  'Reboot',
  'PowerOn',
  'PowerOff',
  'Interrupted',
  'Onboard',
  'Deprecate',
] as const;

const meta = {
  title: 'Domain/JobTypeBadge',
  component: JobTypeBadge,
  parameters: {
    docs: {
      description: {
        component:
          'Badge for device job types. `PowerOn`/`PowerOff` get spaced labels; unmapped job types render as-is with the secondary variant.',
      },
    },
  },
  argTypes: {
    jobType: { control: 'select', options: JOB_TYPES },
    icon: { control: false },
  },
  args: { jobType: 'Provision' },
} satisfies Meta<typeof JobTypeBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const AllJobTypes: Story = {
  render: () => (
    <div className="grid grid-cols-[auto_auto] items-center gap-x-6 gap-y-3">
      {JOB_TYPES.map((jobType) => (
        <div key={jobType} className="contents">
          <span className="text-text-muted font-mono text-xs">{jobType}</span>
          <div>
            <JobTypeBadge jobType={jobType} />
          </div>
        </div>
      ))}
    </div>
  ),
};

export const WithIcon: Story = {
  render: () => (
    <div className="flex gap-3">
      <JobTypeBadge jobType="Provision" icon={Zap} />
      <JobTypeBadge jobType="PowerOff" icon={Power} />
    </div>
  ),
};

export const UnknownJobType: Story = {
  args: { jobType: 'SnapshotRestore' },
};
