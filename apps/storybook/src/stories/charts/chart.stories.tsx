import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@repo/ui/components/chart';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, Pie, PieChart, XAxis } from 'recharts';

import {
  fleetDistribution,
  gpuUtilization,
  monthlyRevenue,
  revenueChartConfig,
  utilizationChartConfig,
} from '../../lib/fixtures';

const fleetChartConfig = {
  devices: { label: 'Devices' },
  'GPU compute': { label: 'GPU compute' },
  'CPU compute': { label: 'CPU compute' },
  Storage: { label: 'Storage' },
  Network: { label: 'Network' },
} satisfies ChartConfig;

const meta = {
  title: 'Charts/Chart',
  component: ChartContainer,
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'Recharts wrapper: `ChartContainer` takes a `ChartConfig` and exposes ' +
          'each series color as `--color-<key>`. ChartConfig’s ' +
          '`theme: { light, dark }` variant predates the data-theme system ' +
          '— always use `color` with CSS vars (e.g. ' +
          '`var(--color-accent)`) so charts follow the active theme. Every ' +
          '`ChartContainer` needs an explicit height class (e.g. `h-64 w-full` ' +
          'or an aspect class) or nothing renders.',
      },
    },
  },
} satisfies Meta<typeof ChartContainer>;

export default meta;
// ChartContainer requires config/children props; stories are render-only, so
// use the untyped StoryObj to avoid a mandatory `args`.
type Story = StoryObj;

export const BarStory: Story = {
  name: 'Bar',
  render: () => (
    <ChartContainer config={revenueChartConfig} className="h-64 w-full">
      <BarChart accessibilityLayer data={monthlyRevenue}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="month" tickLine={false} tickMargin={8} axisLine={false} />
        <ChartTooltip content={<ChartTooltipContent />} />
        <ChartLegend content={<ChartLegendContent />} />
        <Bar dataKey="revenue" fill="var(--color-revenue)" />
        <Bar dataKey="costs" fill="var(--color-costs)" />
      </BarChart>
    </ChartContainer>
  ),
};

export const LineStory: Story = {
  name: 'Line',
  render: () => (
    <ChartContainer config={utilizationChartConfig} className="h-64 w-full">
      <LineChart accessibilityLayer data={gpuUtilization}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="hour" tickLine={false} tickMargin={8} axisLine={false} />
        <ChartTooltip content={<ChartTooltipContent />} />
        <ChartLegend content={<ChartLegendContent />} />
        {/* Animation off: the draw-in dasharray goes stale when the
            ResponsiveContainer resizes mid-animation, clipping the lines. */}
        <Line
          dataKey="h100"
          type="monotone"
          stroke="var(--color-h100)"
          strokeWidth={2}
          dot={false}
          isAnimationActive={false}
        />
        <Line
          dataKey="h200"
          type="monotone"
          stroke="var(--color-h200)"
          strokeWidth={2}
          dot={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ChartContainer>
  ),
};

export const AreaStory: Story = {
  name: 'Area',
  render: () => (
    <ChartContainer config={utilizationChartConfig} className="h-64 w-full">
      <AreaChart accessibilityLayer data={gpuUtilization}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="hour" tickLine={false} tickMargin={8} axisLine={false} />
        <ChartTooltip content={<ChartTooltipContent />} />
        <ChartLegend content={<ChartLegendContent />} />
        <Area
          dataKey="h200"
          type="monotone"
          stackId="a"
          stroke="var(--color-h200)"
          fill="var(--color-h200)"
          fillOpacity={0.3}
        />
        <Area
          dataKey="h100"
          type="monotone"
          stackId="a"
          stroke="var(--color-h100)"
          fill="var(--color-h100)"
          fillOpacity={0.3}
        />
      </AreaChart>
    </ChartContainer>
  ),
};

export const DonutStory: Story = {
  name: 'Donut',
  render: () => (
    <ChartContainer config={fleetChartConfig} className="mx-auto aspect-square h-72">
      <PieChart accessibilityLayer>
        <ChartTooltip content={<ChartTooltipContent nameKey="kind" hideLabel />} />
        <Pie data={fleetDistribution} dataKey="devices" nameKey="kind" innerRadius={60} strokeWidth={2} />
        {/* Explicit payload: this ChartLegendContent copy resolves config by
            key only (it never dereferences payload[nameKey]), so pie slices
            would otherwise render swatches without labels. */}
        <ChartLegend
          content={<ChartLegendContent />}
          payload={fleetDistribution.map((slice) => ({
            value: slice.kind,
            dataKey: slice.kind,
            color: slice.fill,
          }))}
        />
      </PieChart>
    </ChartContainer>
  ),
};
