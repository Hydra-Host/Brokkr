import * as React from 'react';
import { cn } from './utils';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  hideCorners?: boolean;
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(({ className, type, hideCorners, ...props }, ref) => {
  const id = props.id || props.name;

  return (
    <div className="relative">
      <input
        id={id}
        type={type}
        className={cn(
          'peer h-10 w-full px-3 py-2 font-mono text-sm',
          'bg-bg-primary text-text-primary',
          'border-text-muted border-t border-r-0 border-b border-l-0',
          'placeholder:text-text-dim',
          'focus:border-accent focus:outline-none',
          'disabled:cursor-not-allowed disabled:opacity-50',
          'file:border-0 file:bg-transparent file:text-sm file:font-medium',
          '[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none',
          '[&::-webkit-calendar-picker-indicator]:cursor-pointer [&::-webkit-calendar-picker-indicator]:opacity-50 [&::-webkit-calendar-picker-indicator]:hover:opacity-100',
          'aria-invalid:border-status-offline aria-invalid:focus:border-status-offline',
          className,
        )}
        ref={ref}
        {...props}
      />
      {!hideCorners && (
        <>
          <span className="border-text-muted peer-focus:border-accent peer-aria-invalid:border-status-offline pointer-events-none absolute top-0 left-0 h-2 w-2 border-t border-l peer-disabled:opacity-50" />
          <span className="border-text-muted peer-focus:border-accent peer-aria-invalid:border-status-offline pointer-events-none absolute top-0 right-0 h-2 w-2 border-t border-r peer-disabled:opacity-50" />
          <span className="border-text-muted peer-focus:border-accent peer-aria-invalid:border-status-offline pointer-events-none absolute bottom-0 left-0 h-2 w-2 border-b border-l peer-disabled:opacity-50" />
          <span className="border-text-muted peer-focus:border-accent peer-aria-invalid:border-status-offline pointer-events-none absolute right-0 bottom-0 h-2 w-2 border-r border-b peer-disabled:opacity-50" />
        </>
      )}
    </div>
  );
});
Input.displayName = 'Input';

export { Input };
