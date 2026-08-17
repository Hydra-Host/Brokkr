import { Clipboard, ClipboardCheck } from 'lucide-react';
import { useState } from 'react';

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip';
import { cn } from './utils';

interface ClickToCopyStringProps {
  value: string;
  displayValue?: string;
  className?: string;
  truncate?: boolean;
  maxWidth?: string;
  showIcon?: boolean;
  tooltipSide?: 'top' | 'right' | 'bottom' | 'left';
}

export function ClickToCopyString({
  value,
  displayValue,
  className,
  truncate = false,
  maxWidth = '300px',
  showIcon = true,
  tooltipSide = 'left',
}: ClickToCopyStringProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const shownText = displayValue ?? value;
  const needsTooltip = truncate || !!displayValue;

  const content = (
    <div className={cn('group flex cursor-pointer items-center gap-2', className)} onClick={handleCopy}>
      <span className={cn('font-mono text-sm', truncate && 'truncate')} style={truncate ? { maxWidth } : undefined}>
        {shownText}
      </span>
      {showIcon && (
        <div className="opacity-0 transition-opacity group-hover:opacity-100">
          {copied ? (
            <ClipboardCheck className="h-4 w-4 text-emerald-500" />
          ) : (
            <Clipboard className="text-muted-foreground h-4 w-4" />
          )}
        </div>
      )}
    </div>
  );

  if (needsTooltip) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>{content}</TooltipTrigger>
          <TooltipContent side={tooltipSide} className="break-all">
            {value}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return content;
}
