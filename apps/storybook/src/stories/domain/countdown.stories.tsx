import { CountdownCell } from '@repo/ui/components/countdown-cell';
import { CountdownTimer } from '@repo/ui/components/countdown-timer';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { countdownEnd, countdownExpired } from '../../lib/fixtures';

const meta = {
  title: 'Domain/Countdown',
  component: CountdownTimer,
  parameters: {
    docs: {
      description: {
        component:
          'Two consumers of `useCountdown`: the banner-style `CountdownTimer` (takes a `Date`) and the compact table `CountdownCell` (takes an ISO string). Both tick every second and settle on `0s` once the end time passes.',
      },
    },
  },
  args: {
    endTime: countdownEnd(),
    title: 'Maintenance window closing',
    subtext: 'Devices reboot automatically when the countdown ends.',
  },
  argTypes: { endTime: { control: false } },
} satisfies Meta<typeof CountdownTimer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Timer: Story = {
  render: () => (
    <div className="w-[36rem]">
      <CountdownTimer
        endTime={countdownEnd()}
        title="Maintenance window closing"
        subtext="Devices reboot automatically when the countdown ends."
      />
    </div>
  ),
};

export const Cell: Story = {
  render: () => (
    <div className="rounded-md border px-3 py-2">
      <CountdownCell endTime={countdownEnd().toISOString()} />
    </div>
  ),
};

export const Expired: Story = {
  render: () => (
    <div className="w-[36rem] space-y-4">
      <CountdownTimer
        endTime={countdownExpired()}
        title="Maintenance window closed"
        subtext="The end time is in the past, so the timer settles on 0s."
      />
      <div className="w-fit rounded-md border px-3 py-2">
        <CountdownCell endTime={countdownExpired().toISOString()} />
      </div>
    </div>
  ),
};
