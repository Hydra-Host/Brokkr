import { Calendar } from '@repo/ui/components/calendar';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

// Structural stand-in for react-day-picker's DateRange (stories only import
// from @repo/ui subpaths, react, and storybook types).
type DateRange = { from: Date | undefined; to?: Date | undefined };

const AUGUST = new Date(2026, 7, 1);

const meta = {
  title: 'Forms/Primitives/Calendar',
  component: Calendar,
  argTypes: {
    showOutsideDays: { control: 'boolean' },
  },
} satisfies Meta<typeof Calendar>;

export default meta;
type Story = StoryObj<typeof meta>;

const formatDay = (date: Date | undefined) => (date ? date.toISOString().slice(0, 10) : '—');

const SingleDemo = () => {
  const [date, setDate] = useState<Date | undefined>(new Date(2026, 7, 14));
  return (
    <div className="flex flex-col items-center gap-2">
      <Calendar mode="single" selected={date} onSelect={setDate} defaultMonth={AUGUST} />
      <p className="text-text-muted font-mono text-xs">Selected: {formatDay(date)}</p>
    </div>
  );
};

export const Single: Story = {
  render: () => <SingleDemo />,
};

const RangeDemo = () => {
  const [range, setRange] = useState<DateRange | undefined>({
    from: new Date(2026, 7, 4),
    to: new Date(2026, 7, 12),
  });
  return (
    <div className="flex flex-col items-center gap-2">
      <Calendar mode="range" selected={range} onSelect={(next) => setRange(next)} defaultMonth={AUGUST} />
      <p className="text-text-muted font-mono text-xs">
        {formatDay(range?.from)} → {formatDay(range?.to)}
      </p>
      <p className="text-text-dim max-w-64 text-center text-xs">
        The component replaces day-picker's addToRange with two-click selection: first click starts a fresh range,
        second click completes it.
      </p>
    </div>
  );
};

export const Range: Story = {
  render: () => <RangeDemo />,
};

export const DisabledDates: Story = {
  render: () => (
    <div className="flex flex-col items-center gap-2">
      <Calendar
        mode="single"
        defaultMonth={AUGUST}
        disabled={[{ dayOfWeek: [0, 6] }, { before: new Date(2026, 7, 5) }]}
      />
      <p className="text-text-dim max-w-64 text-center text-xs">
        Weekends and days before Aug 5 are disabled via matchers.
      </p>
    </div>
  ),
};
