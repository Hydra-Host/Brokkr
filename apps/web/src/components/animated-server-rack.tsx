import { serverRack } from '@repo/ui/ascii-art';
import { Fragment, useEffect, useState } from 'react';
import { BRAND_NAME } from '~/lib/branding';

const INDICATOR_CHARS = ['●', '○'] as const;
type Indicator = (typeof INDICATOR_CHARS)[number];

const SERVER_RACK = serverRack(BRAND_NAME);
const RACK_LINES = SERVER_RACK.split('\n');
const TOTAL_INDICATORS = [...SERVER_RACK].filter((c) => c === '●' || c === '○').length;

const randomIndicator = () => INDICATOR_CHARS[Math.floor(Math.random() * 2)];
const randomIndicators = () => Array.from({ length: TOTAL_INDICATORS }, randomIndicator);

const isIndicator = (char: string): char is Indicator => char === '●' || char === '○';

const INDICATOR_STYLE: React.CSSProperties = {
  color: 'var(--color-accent)',
  display: 'inline-block',
  transform: 'scale(1.45)',
};

function renderLine(line: string, indicators: Indicator[], indexRef: { current: number }) {
  const parts: React.ReactNode[] = [];
  let cursor = 0;

  for (let i = 0; i < line.length; i++) {
    if (!isIndicator(line[i])) continue;

    if (i > cursor) parts.push(line.slice(cursor, i).replace(/ /g, ' '));

    parts.push(
      <span key={i} style={INDICATOR_STYLE}>
        {indicators[indexRef.current++]}
      </span>,
    );

    cursor = i + 1;
  }

  if (cursor < line.length) parts.push(line.slice(cursor).replace(/ /g, ' '));

  return parts;
}

export function AnimatedServerRack() {
  const [indicators, setIndicators] = useState(randomIndicators);

  useEffect(() => {
    const id = setInterval(() => setIndicators(randomIndicators()), 500);
    return () => clearInterval(id);
  }, []);

  const indexRef = { current: 0 };

  return (
    <pre
      className="text-text-muted relative text-[10px] leading-[1.4] whitespace-pre xl:text-[11px]"
      style={{ fontFamily: "'JetBrains Mono', 'Courier New', Courier, monospace" }}
    >
      {RACK_LINES.map((line, i) => (
        <Fragment key={i}>
          {i > 0 && '\n'}
          {renderLine(line, indicators, indexRef)}
        </Fragment>
      ))}
    </pre>
  );
}
