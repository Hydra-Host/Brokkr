import { Toaster as Sonner, ToasterProps } from 'sonner';

import { useTheme } from './theme-provider';

const Toaster = ({ ...props }: ToasterProps) => {
  const { resolvedMode } = useTheme();
  return (
    <Sonner
      theme={resolvedMode}
      className="toaster group"
      toastOptions={{
        classNames: {
          toast:
            'group toast group-[.toaster]:bg-bg-secondary group-[.toaster]:text-text-primary group-[.toaster]:border-border group-[.toaster]:shadow-lg group-[.toaster]:font-mono group-[.toaster]:rounded-sm',
          description: 'group-[.toast]:text-text-muted',
          actionButton:
            'group-[.toast]:bg-accent group-[.toast]:text-primary-foreground group-[.toast]:font-mono group-[.toast]:font-bold',
          cancelButton: 'group-[.toast]:bg-bg-secondary group-[.toast]:text-text-muted group-[.toast]:font-mono',
          error: 'group-[.toaster]:border-status-offline/50 group-[.toaster]:text-status-offline',
          success: 'group-[.toaster]:border-status-online/50 group-[.toaster]:text-status-online',
          warning: 'group-[.toaster]:border-status-warning/50 group-[.toaster]:text-status-warning',
          info: 'group-[.toaster]:border-glow-cyan/50 group-[.toaster]:text-glow-cyan',
        },
      }}
      style={
        {
          '--normal-bg': 'var(--color-bg-secondary)',
          '--normal-text': 'var(--color-text-primary)',
          '--normal-border': 'var(--color-border)',
        } as React.CSSProperties
      }
      {...props}
    />
  );
};

export { Toaster };
