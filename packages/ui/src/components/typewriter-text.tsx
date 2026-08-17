import { useTypewriter } from '../hooks/use-typewriter';
import { cn } from './utils';

interface TypewriterTextProps {
  text: string;
  speed?: number;
  className?: string;
  as?: 'span' | 'h1' | 'h2' | 'h3' | 'p' | 'div';
}

export function TypewriterText({ text, speed = 40, className, as: Tag = 'span' }: TypewriterTextProps) {
  const { displayText, remainingText } = useTypewriter(text, speed);

  return (
    <Tag className={cn(className)}>
      {displayText}
      <span className="invisible" aria-hidden="true">
        {remainingText}
      </span>
    </Tag>
  );
}
