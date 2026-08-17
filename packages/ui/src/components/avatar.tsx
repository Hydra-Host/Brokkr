import * as React from 'react';

import { cn } from './utils';

type AvatarProps = React.HTMLAttributes<HTMLSpanElement>;

const Avatar = React.forwardRef<HTMLSpanElement, AvatarProps>(({ className, ...props }, ref) => (
  <span
    ref={ref}
    className={cn('relative flex h-10 w-10 shrink-0 overflow-hidden', 'border-border border', className)}
    {...props}
  />
));
Avatar.displayName = 'Avatar';

type AvatarImageProps = React.ImgHTMLAttributes<HTMLImageElement>;

const AvatarImage = React.forwardRef<HTMLImageElement, AvatarImageProps>(({ className, ...props }, ref) => (
  <img ref={ref} className={cn('aspect-square h-full w-full object-cover', className)} {...props} />
));
AvatarImage.displayName = 'AvatarImage';

type AvatarFallbackProps = React.HTMLAttributes<HTMLSpanElement>;

const AvatarFallback = React.forwardRef<HTMLSpanElement, AvatarFallbackProps>(({ className, ...props }, ref) => (
  <span
    ref={ref}
    className={cn(
      'flex h-full w-full items-center justify-center',
      'bg-bg-secondary text-accent font-mono font-bold',
      className,
    )}
    {...props}
  />
));
AvatarFallback.displayName = 'AvatarFallback';

export { Avatar, AvatarFallback, AvatarImage };
