import { ChevronLeft, ChevronRight } from 'lucide-react';
import * as React from 'react';
import { DayPicker, type ActiveModifiers, type DateRange } from 'react-day-picker';

import { buttonVariants } from './button';
import { cn } from './utils';

export type CalendarProps = React.ComponentProps<typeof DayPicker>;

function Calendar({ className, classNames, showOutsideDays = false, ...props }: CalendarProps) {
  // Range mode replaces addToRange with two-click selection; pendingRange shadows `selected` mid-selection so consumers committing to external state (e.g. URL params) don't break the second click.
  const [pendingRange, setPendingRange] = React.useState<DateRange | undefined>(undefined);

  let dayPickerProps: CalendarProps = props;
  if (props.mode === 'range') {
    const userOnSelect = props.onSelect;
    const isAwaitingSecondClick = Boolean(pendingRange?.from && !pendingRange?.to);
    const effectiveSelected = pendingRange ?? props.selected;

    const handleRangeSelect = (
      _range: DateRange | undefined,
      selectedDay: Date,
      activeModifiers: ActiveModifiers,
      e: React.MouseEvent,
    ) => {
      if (isAwaitingSecondClick && pendingRange?.from) {
        const from = pendingRange.from;
        const completed: DateRange = selectedDay < from ? { from: selectedDay, to: from } : { from, to: selectedDay };
        setPendingRange(undefined);
        userOnSelect?.(completed, selectedDay, activeModifiers, e);
        return;
      }
      const fresh: DateRange = { from: selectedDay, to: undefined };
      setPendingRange(fresh);
      userOnSelect?.(fresh, selectedDay, activeModifiers, e);
    };

    dayPickerProps = { ...props, selected: effectiveSelected, onSelect: handleRangeSelect };
  }

  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn('p-3', className)}
      classNames={{
        months: 'flex flex-col sm:flex-row space-y-4 sm:space-x-4 sm:space-y-0',
        month: 'space-y-4',
        caption: 'flex justify-center pt-1 relative items-center',
        caption_label: 'text-sm font-medium',
        nav: 'space-x-1 flex items-center',
        nav_button: cn(
          buttonVariants({ variant: 'outline' }),
          'h-7 w-7 bg-transparent p-0 opacity-50 hover:opacity-100',
        ),
        nav_button_previous: 'absolute left-1',
        nav_button_next: 'absolute right-1',
        table: 'w-full border-collapse space-y-1',
        head_row: 'flex',
        head_cell: 'text-muted-foreground rounded-md w-9 font-normal text-[0.8rem]',
        row: 'flex w-full mt-2',
        cell: 'h-9 w-9 text-center text-sm p-0 relative [&:has([aria-selected])]:bg-accent first:[&:has([aria-selected])]:rounded-l-md last:[&:has([aria-selected])]:rounded-r-md focus-within:relative focus-within:z-20',
        day: cn(buttonVariants({ variant: 'ghost' }), 'h-9 w-9 p-0 font-normal aria-selected:opacity-100'),
        day_selected:
          'bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground focus:bg-primary focus:text-primary-foreground',
        day_today: 'ring-1 ring-inset ring-accent-dim text-accent font-semibold aria-selected:ring-0',
        day_outside: 'text-muted-foreground opacity-50',
        day_disabled: 'text-muted-foreground opacity-50',
        day_range_middle: 'aria-selected:bg-accent aria-selected:text-accent-foreground',
        day_hidden: 'invisible',
        ...classNames,
      }}
      components={{
        IconLeft: () => <ChevronLeft className="h-4 w-4" />,
        IconRight: () => <ChevronRight className="h-4 w-4" />,
      }}
      {...dayPickerProps}
    />
  );
}
Calendar.displayName = 'Calendar';

export { Calendar };
