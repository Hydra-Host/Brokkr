import type { ChartConfig } from '@repo/ui/components/chart';
import type { SelectOption } from '@repo/ui/form/form-select';

// Deterministic, hand-written data shared across stories. Domain-heavy
// fixtures (storage layouts, customization layers, server prices) live inline
// in their own story files so each story stays portable on its own.

export interface Person {
  id: string;
  name: string;
  email: string;
  role: 'Admin' | 'Member' | 'Viewer';
  status: 'active' | 'invited' | 'disabled';
  createdAt: string;
}

const FIRST = [
  'Ada',
  'Grace',
  'Alan',
  'Edsger',
  'Barbara',
  'Donald',
  'Radia',
  'Vint',
  'Margaret',
  'Dennis',
  'Ken',
  'Linus',
  'Katherine',
  'Tim',
  'Brendan',
  'Anders',
  'Bjarne',
  'Guido',
  'James',
  'Yukihiro',
  'Rasmus',
  'Rich',
  'Graydon',
  'Ryan',
  'Evan',
] as const;
const LAST = [
  'Lovelace',
  'Hopper',
  'Turing',
  'Dijkstra',
  'Liskov',
  'Knuth',
  'Perlman',
  'Cerf',
  'Hamilton',
  'Ritchie',
  'Thompson',
  'Torvalds',
  'Johnson',
  'Berners-Lee',
  'Eich',
  'Hejlsberg',
  'Stroustrup',
  'Rossum',
  'Gosling',
  'Matsumoto',
  'Lerdorf',
  'Hickey',
  'Hoare',
  'Dahl',
  'You',
] as const;

export const people: Person[] = FIRST.map((first, index) => ({
  id: `usr_${String(index + 1).padStart(3, '0')}`,
  name: `${first} ${LAST[index]}`,
  email: `${first.toLowerCase()}@example.com`,
  role: (['Admin', 'Member', 'Viewer'] as const)[index % 3]!,
  status: (['active', 'active', 'invited', 'disabled'] as const)[index % 4]!,
  createdAt: `2026-0${(index % 6) + 1}-${String((index % 27) + 1).padStart(2, '0')}`,
}));

export const selectOptions: SelectOption[] = [
  { label: 'Ubuntu 24.04 LTS', value: 'ubuntu-24.04' },
  { label: 'Debian 13', value: 'debian-13' },
  { label: 'Rocky Linux 10', value: 'rocky-10' },
  { label: 'Talos', value: 'talos' },
  { label: 'Windows Server 2025', value: 'windows-2025' },
];

export const comboboxOptions = [
  { label: 'us-east-1 · Ashburn', value: 'us-east-1' },
  { label: 'us-west-2 · Portland', value: 'us-west-2' },
  { label: 'eu-central-1 · Frankfurt', value: 'eu-central-1' },
  { label: 'eu-west-1 · Dublin', value: 'eu-west-1' },
  { label: 'ap-southeast-1 · Singapore', value: 'ap-southeast-1' },
  { label: 'sa-east-1 · São Paulo', value: 'sa-east-1' },
];

export const multiSelectGroups = [
  {
    label: 'GPU',
    options: [
      { label: 'H100 SXM', value: 'h100-sxm' },
      { label: 'H200', value: 'h200' },
      { label: 'RTX 6000 Ada', value: 'rtx-6000-ada' },
    ],
  },
  {
    label: 'CPU',
    options: [
      { label: 'EPYC 9654', value: 'epyc-9654' },
      { label: 'Xeon Platinum 8592+', value: 'xeon-8592' },
    ],
  },
];

export const monthlyRevenue = [
  { month: 'Jan', revenue: 186_000, costs: 92_000 },
  { month: 'Feb', revenue: 205_000, costs: 98_000 },
  { month: 'Mar', revenue: 237_000, costs: 101_000 },
  { month: 'Apr', revenue: 228_000, costs: 112_000 },
  { month: 'May', revenue: 261_000, costs: 108_000 },
  { month: 'Jun', revenue: 290_000, costs: 121_000 },
  { month: 'Jul', revenue: 312_000, costs: 125_000 },
  { month: 'Aug', revenue: 334_000, costs: 131_000 },
  { month: 'Sep', revenue: 321_000, costs: 129_000 },
  { month: 'Oct', revenue: 356_000, costs: 138_000 },
  { month: 'Nov', revenue: 389_000, costs: 142_000 },
  { month: 'Dec', revenue: 412_000, costs: 149_000 },
];

export const revenueChartConfig = {
  revenue: { label: 'Revenue', color: 'var(--color-status-online)' },
  costs: { label: 'Costs', color: 'var(--color-status-warning)' },
} satisfies ChartConfig;

export const gpuUtilization = [
  { hour: '00:00', h100: 62, h200: 41 },
  { hour: '04:00', h100: 48, h200: 39 },
  { hour: '08:00', h100: 71, h200: 58 },
  { hour: '12:00', h100: 89, h200: 74 },
  { hour: '16:00', h100: 94, h200: 82 },
  { hour: '20:00', h100: 77, h200: 66 },
];

export const utilizationChartConfig = {
  h100: { label: 'H100 fleet', color: 'var(--color-accent)' },
  h200: { label: 'H200 fleet', color: 'var(--color-status-info)' },
} satisfies ChartConfig;

export const fleetDistribution = [
  { kind: 'GPU compute', devices: 412, fill: 'var(--color-accent)' },
  { kind: 'CPU compute', devices: 267, fill: 'var(--color-status-info)' },
  { kind: 'Storage', devices: 121, fill: 'var(--color-status-warning)' },
  { kind: 'Network', devices: 54, fill: 'var(--color-status-online)' },
];

// Live-relative on purpose: this Storybook is a dev tool. Freeze these before
// adopting visual-snapshot CI.
export const countdownEnd = () => new Date(Date.now() + 1000 * 60 * 90);
export const countdownExpired = () => new Date(Date.now() - 1000 * 60 * 5);
