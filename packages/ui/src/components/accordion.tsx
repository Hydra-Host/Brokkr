import { Accordion as BaseAccordion } from '@base-ui/react/accordion';
import { ChevronDown } from 'lucide-react';
import * as React from 'react';

import { cn } from './utils';

interface AccordionProps extends Omit<React.ComponentPropsWithoutRef<typeof BaseAccordion.Root>, 'ref'> {
  type?: 'single' | 'multiple';
  collapsible?: boolean;
}

const Accordion = React.forwardRef<HTMLDivElement, AccordionProps>(({ type, collapsible, ...props }, ref) => {
  void collapsible;
  const multiple = type === 'multiple';
  return <BaseAccordion.Root ref={ref} multiple={multiple} {...props} />;
});
Accordion.displayName = 'Accordion';

const AccordionItem = React.forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<typeof BaseAccordion.Item>>(
  ({ className, ...props }, ref) => (
    <BaseAccordion.Item ref={ref} className={cn('border-border border-b', className)} {...props} />
  ),
);
AccordionItem.displayName = 'AccordionItem';

const AccordionTrigger = React.forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<typeof BaseAccordion.Trigger>
>(({ className, children, ...props }, ref) => (
  <BaseAccordion.Header className="flex">
    <BaseAccordion.Trigger
      ref={ref}
      className={cn(
        'text-text-primary flex flex-1 items-center justify-between py-4 font-mono font-medium',
        'hover:text-accent transition-all',
        '[&[data-panel-open]>svg]:rotate-180',
        className,
      )}
      {...props}
    >
      {children}
      <ChevronDown className="text-text-muted h-4 w-4 shrink-0 transition-transform duration-200" />
    </BaseAccordion.Trigger>
  </BaseAccordion.Header>
));
AccordionTrigger.displayName = 'AccordionTrigger';

const AccordionContent = React.forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<typeof BaseAccordion.Panel>>(
  ({ className, children, ...props }, ref) => (
    <BaseAccordion.Panel
      ref={ref}
      className={cn(
        'text-text-primary overflow-hidden font-mono text-sm transition-all',
        'data-[panel-open]:animate-accordion-down data-[panel-closed]:animate-accordion-up',
        className,
      )}
      {...props}
    >
      <div className="pt-0 pb-4">{children}</div>
    </BaseAccordion.Panel>
  ),
);
AccordionContent.displayName = 'AccordionContent';

export { Accordion, AccordionContent, AccordionItem, AccordionTrigger };
