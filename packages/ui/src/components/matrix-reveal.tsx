import { useEffect, useRef, useState } from 'react';
import { cn } from './utils';

const LINE_COLORS = [
  'text-accent',
  'text-accent-dim',
  'text-accent/50',
  'text-accent-dim',
  'text-accent',
  'text-accent-dim',
] as const;

const SPECIAL_CHARS = '░▒▓█▀▄▌▐─═╔╗╚╝╠╣╦╩╬■□◆◇○●';

function getLineColor(lineIndex: number, totalLines: number): string {
  if (totalLines <= LINE_COLORS.length) {
    const ratio = lineIndex / (totalLines - 1 || 1);
    const colorIndex = Math.round(ratio * (LINE_COLORS.length - 1));
    return LINE_COLORS[colorIndex];
  }
  return LINE_COLORS[lineIndex % LINE_COLORS.length];
}

const randChar = () => SPECIAL_CHARS[Math.floor(Math.random() * SPECIAL_CHARS.length)];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface MatrixRevealProps {
  lines: string[];
  className?: string;
  delay?: number;
  onComplete?: () => void;
}

export function MatrixReveal({ lines, className, delay = 0, onComplete }: MatrixRevealProps) {
  const [displayLines, setDisplayLines] = useState<string[]>([]);
  const [done, setDone] = useState(false);
  const generationRef = useRef(0);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  useEffect(() => {
    const gen = ++generationRef.current;

    const run = async () => {
      if (delay > 0) {
        await sleep(delay);
        if (generationRef.current !== gen) return;
      }

      const currentLines = lines.map((line) =>
        line
          .split('')
          .map((c) => (c === ' ' ? ' ' : randChar()))
          .join(''),
      );
      const revealedIndex = lines.map(() => 0);
      const lineDelays = lines.map(() => Math.random() * 80);
      const lineSpeeds = lines.map(() => 8 + Math.random() * 12);

      setDisplayLines([...currentLines]);

      const animateLine = async (lineIndex: number) => {
        await sleep(lineDelays[lineIndex]);
        if (generationRef.current !== gen) return;
        const finalLine = lines[lineIndex];

        while (revealedIndex[lineIndex] < finalLine.length) {
          if (generationRef.current !== gen) return;

          const charsToReveal = 1 + Math.floor(Math.random() * 2);
          for (let i = 0; i < charsToReveal && revealedIndex[lineIndex] < finalLine.length; i++) {
            revealedIndex[lineIndex]++;
          }

          const revealed = finalLine.substring(0, revealedIndex[lineIndex]);
          const rest = finalLine
            .substring(revealedIndex[lineIndex])
            .split('')
            .map((c) => (c === ' ' ? ' ' : randChar()))
            .join('');

          currentLines[lineIndex] = revealed + rest;
          setDisplayLines([...currentLines]);

          await sleep(lineSpeeds[lineIndex]);
        }

        if (generationRef.current !== gen) return;
        currentLines[lineIndex] = finalLine;
        setDisplayLines([...currentLines]);
      };

      await Promise.all(lines.map((_, i) => animateLine(i)));
      if (generationRef.current !== gen) return;
      setDone(true);
      onCompleteRef.current?.();
    };

    run();
  }, [lines, delay]);

  const visibleLines = done ? lines : displayLines.length > 0 ? displayLines : lines;
  const showColors = displayLines.length > 0 || done;

  return (
    <pre className={cn('overflow-hidden font-mono whitespace-pre select-none', className)}>
      {visibleLines.map((line, lineIndex) => (
        <div key={lineIndex} className={showColors ? getLineColor(lineIndex, lines.length) : 'invisible'}>
          {line || '\u00A0'}
        </div>
      ))}
    </pre>
  );
}
