import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@repo/ui/components/accordion';
import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
  title: 'Navigation/Accordion',
  component: Accordion,
} satisfies Meta<typeof Accordion>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SingleOpen: Story = {
  render: () => (
    <Accordion type="single" defaultValue={['specs']} className="w-[420px]">
      <AccordionItem value="specs">
        <AccordionTrigger>Specifications</AccordionTrigger>
        <AccordionContent>2x AMD EPYC 9654, 1.5TB DDR5, 8x H100 SXM5.</AccordionContent>
      </AccordionItem>
      <AccordionItem value="network">
        <AccordionTrigger>Network</AccordionTrigger>
        <AccordionContent>Dual 400GbE uplinks with redundant top-of-rack switching.</AccordionContent>
      </AccordionItem>
      <AccordionItem value="power">
        <AccordionTrigger>Power</AccordionTrigger>
        <AccordionContent>10.2kW draw at full load, A+B feeds.</AccordionContent>
      </AccordionItem>
    </Accordion>
  ),
};

export const Multiple: Story = {
  render: () => (
    <Accordion type="multiple" defaultValue={['first', 'second']} className="w-[420px]">
      <AccordionItem value="first">
        <AccordionTrigger>First section</AccordionTrigger>
        <AccordionContent>Multiple sections can stay open at once.</AccordionContent>
      </AccordionItem>
      <AccordionItem value="second">
        <AccordionTrigger>Second section</AccordionTrigger>
        <AccordionContent>This one is also open by default.</AccordionContent>
      </AccordionItem>
      <AccordionItem value="third">
        <AccordionTrigger>Third section</AccordionTrigger>
        <AccordionContent>Open this without closing the others.</AccordionContent>
      </AccordionItem>
    </Accordion>
  ),
};

const FAQ = [
  {
    q: 'How is usage billed?',
    a: 'Usage is metered hourly and invoiced monthly. All amounts are settled in USD.',
  },
  {
    q: 'Can I bring my own hardware?',
    a: 'Yes. Supplier onboarding covers colocation, remote hands, and revenue share terms.',
  },
  {
    q: 'What happens if a node fails?',
    a: 'Failed nodes are drained automatically and workloads reschedule to healthy capacity.',
  },
];

export const ComposedFaq: Story = {
  render: () => (
    <div className="w-[480px]">
      <h2 className="text-text-primary mb-2 font-mono text-lg font-bold">Frequently asked questions</h2>
      <Accordion type="single">
        {FAQ.map(({ q, a }) => (
          <AccordionItem key={q} value={q}>
            <AccordionTrigger>{q}</AccordionTrigger>
            <AccordionContent>{a}</AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </div>
  ),
};
