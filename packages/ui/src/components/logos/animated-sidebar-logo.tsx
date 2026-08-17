import { useEffect, useMemo, useRef, useState } from 'react';
import { ASCII_LOGOS } from '../ascii-art/logos';
import { MatrixReveal } from '../matrix-reveal';
import { cn } from '../utils';
import { Logo } from './logo';

interface AnimatedSidebarLogoProps {
  className?: string;
  collapsed?: boolean;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type AnimationPhase = 'logo' | 'deconstruct' | 'matrix' | 'complete';

export function AnimatedSidebarLogo({ className, collapsed }: AnimatedSidebarLogoProps) {
  const [phase, setPhase] = useState<AnimationPhase>('logo');
  const [deconstructProgress, setDeconstructProgress] = useState<number[]>([]);
  const deconstructRef = useRef<boolean>(false);
  const prevCollapsed = useRef(collapsed);
  const [matrixKey, setMatrixKey] = useState(0);

  const logoIndex = useMemo(() => Math.floor(Math.random() * ASCII_LOGOS.length), []);
  const asciiLogo = ASCII_LOGOS[logoIndex];
  const lines = useMemo(() => asciiLogo.split('\n'), [asciiLogo]);

  useEffect(() => {
    if (prevCollapsed.current && !collapsed) {
      setMatrixKey((k) => k + 1);
      setPhase('matrix');
    }
    prevCollapsed.current = collapsed;
  }, [collapsed]);

  useEffect(() => {
    const timer = setTimeout(() => setPhase('deconstruct'), 3000);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (phase !== 'deconstruct' || deconstructRef.current) return;
    deconstructRef.current = true;

    const deconstruct = async () => {
      const progress = lines.map(() => 0);
      const lineDelays = lines.map(() => Math.random() * 80);
      const lineSpeeds = lines.map(() => 8 + Math.random() * 12);

      setDeconstructProgress([...progress]);

      const animateLine = async (lineIndex: number) => {
        await sleep(lineDelays[lineIndex]);
        const lineLength = lines[lineIndex].length;

        while (progress[lineIndex] < lineLength) {
          const charsToReveal = 1 + Math.floor(Math.random() * 2);
          progress[lineIndex] = Math.min(progress[lineIndex] + charsToReveal, lineLength);
          setDeconstructProgress([...progress]);
          await sleep(lineSpeeds[lineIndex]);
        }
      };

      await Promise.all(lines.map((_, i) => animateLine(i)));
      setPhase('matrix');
    };

    deconstruct();
  }, [phase, lines]);

  if (collapsed) {
    return <span className="text-accent text-sm font-bold">B</span>;
  }

  if (phase === 'logo') {
    return (
      <div className={cn('flex items-center justify-center', className)}>
        <Logo className="h-12 w-auto" />
      </div>
    );
  }

  if (phase === 'deconstruct') {
    return (
      <div className={cn('relative isolate flex items-center justify-center overflow-hidden', className)}>
        <Logo className="relative z-0 h-12 w-auto" />
        <div className="absolute inset-0 z-10 flex items-center justify-center">
          <div className="font-mono text-[0.45rem] leading-[0.5rem]">
            {lines.map((line, lineIndex) => (
              <div key={lineIndex} className="relative" style={{ height: '0.5rem' }}>
                <span className="invisible whitespace-pre">{line}</span>
                <div
                  className="bg-sidebar absolute left-0"
                  style={{
                    width: `${deconstructProgress[lineIndex] ?? 0}ch`,
                    top: lineIndex === 0 ? '-3rem' : '0',
                    bottom: lineIndex === lines.length - 1 ? '-3rem' : '0',
                  }}
                />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <MatrixReveal
      key={matrixKey}
      lines={lines}
      className={cn('text-[0.45rem] leading-[0.5rem]', className)}
      onComplete={() => setPhase('complete')}
    />
  );
}
