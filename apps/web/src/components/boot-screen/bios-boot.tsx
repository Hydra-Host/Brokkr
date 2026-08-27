import { ASCII_LOGOS } from '@repo/ui/ascii-art';
import { cn } from '@repo/ui/utils';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { BRAND_NAME, COMPANY_NAME } from '~/lib/branding';

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

function withStatus(text: string, statusText: string, statusClass = 'text-status-online') {
  return (
    <div className="flex justify-between gap-4">
      <span>{text}</span>
      <span className={cn('font-bold', statusClass)}>{statusText}</span>
    </div>
  );
}

function buildLines(logoIndex: number): ReactNode[] {
  const logo = ASCII_LOGOS[logoIndex];
  const logoLines = logo.split('\n');

  return [
    <pre
      key="logo"
      className="mb-2 overflow-hidden text-[0.35rem] leading-tight whitespace-pre select-none sm:text-[0.5rem] md:text-[0.55rem]"
    >
      {logoLines.map((line, i) => (
        <div key={i} className={getLogoColor(i, logoLines.length)}>
          {line}
        </div>
      ))}
    </pre>,
    <div key="title" className="text-accent font-bold">
      {BRAND_NAME.toUpperCase()} BIOS v2.0.0
    </div>,
    <div key="copyright" className="text-text-muted">
      Copyright (C) 2025 {COMPANY_NAME}
    </div>,
    <div key="blank1">&nbsp;</div>,
    <div key="cpu">Main Processor : {BRAND_NAME} Orchestration Engine v2.0</div>,
    <div key="cpu2">CPU Topology : 2x AMD EPYC 9654 (128C/256T)</div>,
    <div key="gpu">GPU Subsystem : NVIDIA H100 SXM5 80GB ({'\u00d7'}8)</div>,
    <div key="nvlink">GPU Interconnect : NVLink 4.0 Mesh (900 GB/s)</div>,
    <div key="mem">
      Memory Test : {(655360).toLocaleString()} MB <span className="text-status-online">OK</span>
    </div>,
    <div key="nvme">NVMe Storage : 4 {'\u00d7'} 3.84 TB NVMe SSD (RAID-0)</div>,
    <div key="net">Network Fabric : InfiniBand 400Gbps HDR ...... Connected</div>,
    <div key="net2">Ethernet : 2x 25GbE Management LAN ..... Connected</div>,
    <div key="blank2">&nbsp;</div>,
    <div key="check1">Checking for rogue crypto miners .............. None found</div>,
    <div key="check2">Verifying GPUs have not achieved sentience ..... All clear</div>,
    <div key="check3">Confirming nobody unplugged the rack again ..... Verified</div>,
    <div key="check4">Ensuring the coffee machine is operational ..... Brewing</div>,
    <div key="blank3">&nbsp;</div>,
    withStatus('Initializing marketplace engine ...............', '[ DONE ]'),
    withStatus('Loading deployment manifests ..................', '[ DONE ]'),
    withStatus('Starting container runtime interface .........', '[ DONE ]'),
    withStatus('Starting bid/ask matching engine ..............', '[ DONE ]'),
    withStatus('Syncing cluster state .........................', '[ DONE ]'),
    withStatus('Warming up pricing oracle .....................', '[ DONE ]'),
    withStatus('Connecting telemetry pipeline .................', '[ DONE ]'),
    withStatus('Starting WebSocket notification service ......', '[ DONE ]'),
    withStatus('Authenticating session ........................', '[ DONE ]'),
    <div key="blank4">&nbsp;</div>,
    <div key="done" className="text-accent font-bold">
      All systems operational. 0 errors detected.
    </div>,
    <div key="entering" className="text-text-muted">
      Entering {BRAND_NAME} Dashboard...
    </div>,
  ];
}

export function BiosBootScreen() {
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
