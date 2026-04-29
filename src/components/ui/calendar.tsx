import { DayPicker, type DayPickerProps } from 'react-day-picker';
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';

import { cn } from '@/src/lib/utils';

export type CalendarProps = DayPickerProps;

/**
 * Tailwind-styled wrapper around react-day-picker. We don't import the
 * library's default stylesheet — all presentation is driven by `classNames`
 * so the calendar inherits the app's tokens (primary color, muted borders,
 * etc.) and works in light + dark themes.
 */
export function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  ...props
}: CalendarProps) {
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn('p-3', className)}
      classNames={{
        months: 'flex flex-col sm:flex-row gap-4',
        month: 'flex flex-col gap-3',
        month_caption: 'flex justify-center pt-1 relative items-center',
        caption_label: 'text-sm font-medium',
        nav: 'flex items-center gap-1',
        button_previous: cn(
          'absolute left-1 inline-flex h-7 w-7 items-center justify-center rounded-md',
          'hover:bg-accent hover:text-accent-foreground disabled:opacity-40',
        ),
        button_next: cn(
          'absolute right-1 inline-flex h-7 w-7 items-center justify-center rounded-md',
          'hover:bg-accent hover:text-accent-foreground disabled:opacity-40',
        ),
        month_grid: 'w-full border-collapse space-y-1',
        weekdays: 'flex',
        weekday: 'text-muted-foreground rounded-md w-8 font-normal text-[0.75rem]',
        week: 'flex w-full mt-1',
        day: 'relative p-0 text-center text-sm h-8 w-8',
        day_button: cn(
          'inline-flex h-8 w-8 items-center justify-center rounded-md text-sm',
          'hover:bg-accent hover:text-accent-foreground',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        ),
        range_start: 'bg-primary text-primary-foreground',
        range_end: 'bg-primary text-primary-foreground',
        selected: '!bg-primary !text-primary-foreground hover:!bg-primary hover:!text-primary-foreground',
        today: 'ring-1 ring-primary ring-inset',
        outside: 'text-muted-foreground/50',
        disabled: 'text-muted-foreground/30 pointer-events-none',
        hidden: 'invisible',
        ...classNames,
      }}
      components={{
        Chevron: ({ orientation }) =>
          orientation === 'left'
            ? <ChevronLeftIcon className="h-4 w-4" />
            : <ChevronRightIcon className="h-4 w-4" />,
      }}
      {...props}
    />
  );
}
