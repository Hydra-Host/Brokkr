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

function ts(seconds: number): string {
  return `[    ${seconds.toFixed(6)}]`;
}

const BATCH_SIZE = 3;
const BATCH_DELAY = 50;

function kernelLine(timestamp: string, message: string, hasOk?: boolean, color?: string) {
  if (hasOk) {
    return (
      <div className={cn('flex justify-between gap-4', color)}>
        <span>
          <span className="text-text-dim">{timestamp}</span> {message}
        </span>
        <span className="text-status-online shrink-0 font-bold">[ OK ]</span>
      </div>
    );
  }
  return (
    <div className={color}>
      <span className="text-text-dim">{timestamp}</span> {message}
    </div>
  );
}

function buildLines(logoIndex: number): ReactNode[] {
  const logo = ASCII_LOGOS[logoIndex];
  const logoLines = logo.split('\n');

  const k = BRAND_NAME.toLowerCase();

  const lines: ReactNode[] = [
    kernelLine(ts(0.0), `${BRAND_NAME} Kernel 2.0.0-gpu (x86_64) #42 SMP`),
    kernelLine(ts(0.001337), `Command line: BOOT_IMAGE=/${k} quiet gpu_mode=cluster`),
    kernelLine(ts(0.012), 'BIOS-provided physical RAM map: 640 GB'),
    kernelLine(ts(0.024), 'ACPI: Registered 8 GPU thermal zones (toasty but stable)'),
    kernelLine(ts(0.031), 'NUMA: Node 0 CPUs: 0-63'),
    kernelLine(ts(0.035), 'NUMA: Node 1 CPUs: 64-127'),
    kernelLine(ts(0.042), `${k}_gpu: Initializing CUDA runtime v12.4 ...`, true),
    kernelLine(ts(0.0893), `${k}_gpu: 8\u00d7 NVIDIA H100 SXM5 80GB detected`, true),
    kernelLine(ts(0.102), `${k}_gpu: NVLink 4.0 mesh topology verified`, true),
    kernelLine(ts(0.1247), `${k}_nvme: Mounting /dev/nvme0 (15.36 TB array) ...`, true),
    kernelLine(ts(0.156), `${k}_nvme: RAID-0 stripe across 4 devices`, true),
    kernelLine(ts(0.2341), `${k}_net: InfiniBand 400Gbps HDR link established`, true),
    kernelLine(ts(0.278), `${k}_net: IPv4 address 10.0.42.1/24 assigned`, true),
    kernelLine(ts(0.3452), `${k}_net: RDMA fabric initialized`, true),
    kernelLine(ts(0.4567), `${k}d[1]: Starting marketplace daemon v2.0 ...`, true),
    kernelLine(ts(0.512), `${k}d[1]: Loading deployment manifests ...`, true),
    kernelLine(ts(0.5678), `${k}d[1]: Smart contract engine loaded`, true),
    kernelLine(ts(0.6294), `${k}d[1]: 42 active deployments synced`, true),
    kernelLine(ts(0.712), `${k}d[1]: Container runtime interface ready`, true),
    kernelLine(ts(0.789), `${k}d[1]: Bid/ask matching engine ready`, true),
    kernelLine(ts(0.834), `${k}d[1]: Telemetry pipeline connected`, true),
    kernelLine(ts(0.8901), `${k}d[1]: Pricing oracle warmed up (no lowballers pls)`, true),
    kernelLine(ts(0.9234), `${k}_auth: Session authenticated via ${COMPANY_NAME}`, true),
    kernelLine(ts(0.9567), `${k}_ws: WebSocket notification service listening`, true),
    kernelLine(ts(0.9876), `${k}: All subsystems operational`, true),
    <div key="blank1">&nbsp;</div>,
  ];

  for (let i = 0; i < logoLines.length; i++) {
    lines.push(
      <pre
        key={`logo-${i}`}
        className={cn(
          'overflow-hidden text-[0.35rem] leading-tight whitespace-pre select-none sm:text-[0.5rem] md:text-[0.55rem]',
          getLogoColor(i, logoLines.length),
        )}
      >
        {logoLines[i]}
      </pre>,
    );
  }

  lines.push(
    <div key="blank2">&nbsp;</div>,
    <div key="welcome" className="text-accent font-bold">
      Welcome to {BRAND_NAME} v2.0.0 &mdash; GPU Cloud Marketplace
    </div>,
    <div key="entering" className="text-text-muted">
      All systems go. Entering dashboard...
    </div>,
  );

  return lines;
}

export function LinuxBootScreen() {
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
