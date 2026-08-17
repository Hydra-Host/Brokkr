import { useMemo } from 'react';
import { ASCII_LOGOS } from '../ascii-art/logos';
import { cn } from '../utils';

interface AsciiLogoProps {
  className?: string;
  logoIndex?: number;
}

const LINE_COLORS = [
  'text-text-muted',
  'text-text-dim',
  'text-text-label',
  'text-text-dim',
  'text-text-muted',
  'text-text-dim',
] as const;

function getLineColor(lineIndex: number, totalLines: number): string {
  if (totalLines <= LINE_COLORS.length) {
    const ratio = lineIndex / (totalLines - 1 || 1);
    const colorIndex = Math.round(ratio * (LINE_COLORS.length - 1));
    return LINE_COLORS[colorIndex];
  }
  return LINE_COLORS[lineIndex % LINE_COLORS.length];
}

export function AsciiLogo({ className, logoIndex }: AsciiLogoProps) {
  const stableIndex = useMemo(() => {
    if (logoIndex !== undefined) return logoIndex;
    return Math.floor(Math.random() * ASCII_LOGOS.length);
  }, [logoIndex]);

  const logo = ASCII_LOGOS[stableIndex % ASCII_LOGOS.length];
  const lines = logo.split('\n');

  return (
    <pre className={cn('overflow-hidden font-mono text-[0.5rem] leading-tight whitespace-pre select-none', className)}>
      {lines.map((line, index) => (
        <div key={index} className={getLineColor(index, lines.length)}>
          {line}
        </div>
      ))}
    </pre>
  );
}

export function AsciiLogoCompact({ className, logoIndex }: AsciiLogoProps) {
  const stableIndex = useMemo(() => {
    if (logoIndex !== undefined) return logoIndex;
    return Math.floor(Math.random() * ASCII_LOGOS.length);
  }, [logoIndex]);

  const logo = ASCII_LOGOS[stableIndex % ASCII_LOGOS.length];
  const lines = logo.split('\n');

  return (
    <pre
      className={cn('overflow-hidden font-mono text-[0.45rem] leading-[0.5rem] whitespace-pre select-none', className)}
    >
      {lines.map((line, index) => (
        <div key={index} className={getLineColor(index, lines.length)}>
          {line}
        </div>
      ))}
    </pre>
  );
}
