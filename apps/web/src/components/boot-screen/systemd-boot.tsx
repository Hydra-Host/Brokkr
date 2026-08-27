import { ASCII_LOGOS } from '@repo/ui/ascii-art';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { BRAND_NAME } from '~/lib/branding';

const LOGO_COLORS = [
  'text-accent',
  'text-accent-dim',
  'text-accent/50',
  'text-accent-dim',
  'text-accent',
  'text-accent-dim',
];

function getLogoColor(i: number, total: number): string {
  if (total <= LOGO_COLORS.length) {
    const ratio = i / (total - 1 || 1);
    return LOGO_COLORS[Math.round(ratio * (LOGO_COLORS.length - 1))];
  }
  return LOGO_COLORS[i % LOGO_COLORS.length];
}

const BATCH_SIZE = 3;
const BATCH_DELAY = 50;

function serviceOk(name: string) {
  return (
    <div>
      <span className="text-status-online font-bold">[ OK ]</span>
      <span> Started {name}</span>
    </div>
  );
}

function targetOk(name: string) {
  return (
    <div>
      <span className="text-status-online font-bold">[ OK ]</span>
      <span> Reached target {name}</span>
    </div>
  );
}

function buildLines(logoIndex: number): ReactNode[] {
  const logo = ASCII_LOGOS[logoIndex];
  const logoLines = logo.split('\n');

  return [
    <pre
      key="logo"
      className="overflow-hidden text-[0.35rem] leading-tight whitespace-pre select-none sm:text-[0.5rem] md:text-[0.55rem]"
    >
      {logoLines.map((line, i) => (
        <div key={i} className={getLogoColor(i, logoLines.length)}>
          {line}
        </div>
      ))}
    </pre>,
    <div key="blank1">&nbsp;</div>,
    <div key="title" className="text-accent font-bold">
      {BRAND_NAME} GPU Platform v2.0.0
    </div>,
    <div key="blank2">&nbsp;</div>,
    targetOk('Local File Systems'),
    targetOk('Swap Partition'),
    targetOk('Network Configuration'),
    targetOk('Remote File Systems (Pre)'),
    serviceOk('GPU Cluster Discovery Service'),
    serviceOk('NVMe Storage Array Controller'),
    serviceOk('InfiniBand Fabric Manager'),
    serviceOk('RDMA Communication Manager'),
    serviceOk(`Marketplace Daemon (${BRAND_NAME.toLowerCase()}d)`),
    serviceOk('Deployment Orchestrator'),
    serviceOk('Container Runtime Interface'),
    serviceOk('Bid/Ask Matching Engine'),
    serviceOk('Smart Contract Validator'),
    serviceOk('Pricing Oracle Service'),
    serviceOk('Telemetry & Metrics Collector'),
    serviceOk('Session Authentication Service'),
    serviceOk('Rate Limiter Gateway'),
    serviceOk('API Gateway (port 3000)'),
    serviceOk('WebSocket Notification Service'),
    targetOk(`${BRAND_NAME} Cloud Platform`),
    <div key="blank3">&nbsp;</div>,
    <div key="session" className="text-text-muted">
      {' '}
      Starting User Session...
    </div>,
    <div key="blank4">&nbsp;</div>,
    <div key="welcome" className="text-accent">
      Welcome to {BRAND_NAME} &mdash; All systems nominal.
    </div>,
  ];
}

export function SystemdBootScreen() {
  const [visibleCount, setVisibleCount] = useState(BATCH_SIZE);
  const genRef = useRef(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const logoIndex = useMemo(() => Math.floor(Math.random() * ASCII_LOGOS.length), []);
  const allLines = useMemo(() => buildLines(logoIndex), [logoIndex]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [visibleCount]);

  useEffect(() => {
    const gen = ++genRef.current;
    setVisibleCount(BATCH_SIZE);

    const id = setInterval(() => {
      if (gen !== genRef.current) return;
      setVisibleCount((prev) => {
        const next = prev + BATCH_SIZE;
        if (next >= allLines.length) {
          clearInterval(id);
          return allLines.length;
        }
        return next;
      });
    }, BATCH_DELAY);

    return () => {
      genRef.current++;
      clearInterval(id);
    };
  }, [allLines]);

  return (
    <div className="min-h-full py-4 font-mono">
      <div className="animate-boot-pulse text-text-primary text-xs leading-relaxed sm:text-sm">
        {allLines.slice(0, visibleCount).map((line, i) => (
          <div key={i}>{line}</div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
