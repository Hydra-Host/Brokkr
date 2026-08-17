import * as React from 'react';

interface SlotProps extends React.HTMLAttributes<HTMLElement> {
  children?: React.ReactNode;
}

const Slot = React.forwardRef<HTMLElement, SlotProps>(({ children, ...props }, ref) => {
  if (!React.isValidElement(children)) {
    return null;
  }

  const childProps = children.props as { className?: string; style?: React.CSSProperties };
  return React.cloneElement(children, {
    ...props,
    ...childProps,
    ref: ref
      ? (node: HTMLElement | null) => {
          if (typeof ref === 'function') {
            ref(node);
          } else if (ref) {
            (ref as React.MutableRefObject<HTMLElement | null>).current = node;
          }
          const childRef = (children as React.ReactElement & { ref?: React.Ref<HTMLElement> }).ref;
          if (typeof childRef === 'function') {
            childRef(node);
          } else if (childRef) {
            (childRef as React.MutableRefObject<HTMLElement | null>).current = node;
          }
        }
      : (children as React.ReactElement & { ref?: React.Ref<HTMLElement> }).ref,
    className: props.className ? `${childProps.className || ''} ${props.className}`.trim() : childProps.className,
    style: props.style ? { ...childProps.style, ...props.style } : childProps.style,
  } as React.HTMLAttributes<HTMLElement>);
});
Slot.displayName = 'Slot';

export { Slot, type SlotProps };
