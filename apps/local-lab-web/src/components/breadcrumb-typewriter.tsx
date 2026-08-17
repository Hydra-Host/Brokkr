import { useEffect, useMemo, useState } from 'react';

import { isLeafActive, SECTIONS } from '@/components/app-sidebar';
import { getWikiEntry } from '@/lib/wiki';

export interface Crumb {
  label: string;
  isSection?: boolean;
}

export function getBreadcrumbCrumbs(pathname: string): Crumb[] | null {
  if (pathname === '/getting-started') {
    return [{ label: 'Get started - self hosting' }];
  }

  if (pathname.startsWith('/wiki/')) {
    const slug = decodeURIComponent(pathname.slice('/wiki/'.length).split('/')[0]);
    const entry = getWikiEntry(slug);
    return [{ label: 'Wiki', isSection: true }, { label: entry?.title ?? slug }];
  }

  for (const section of SECTIONS) {
    for (const leaf of section.leaves) {
      if (isLeafActive(pathname, leaf)) {
        return [{ label: section.title, isSection: true }, { label: leaf.label }];
      }
    }
  }

  return null;
}

export function BreadcrumbTypewriter({ crumbs }: { crumbs: Crumb[] }) {
  const fullText = crumbs.map((c) => `/ ${c.label}`).join(' ');
  const [count, setCount] = useState(0);

  useEffect(() => {
    setCount(0);
  }, [fullText]);

  useEffect(() => {
    if (count < fullText.length) {
      const timer = setTimeout(() => setCount((c) => c + 1), 30);
      return () => clearTimeout(timer);
    }
  }, [count, fullText.length]);

  const segments = useMemo(() => {
    const result: Array<{
      start: number;
      labelStart: number;
      labelEnd: number;
      crumb: Crumb;
      isLast: boolean;
    }> = [];
    let pos = 0;
    crumbs.forEach((crumb, index) => {
      const isLast = index === crumbs.length - 1;
      const segText = `/ ${crumb.label}`;
      const start = pos;
      const labelStart = start + 2;
      const labelEnd = start + segText.length;
      result.push({ start, labelStart, labelEnd, crumb, isLast });
      pos = labelEnd + (isLast ? 0 : 1);
    });
    return result;
  }, [crumbs]);

  const cursor = (
    <span className="bg-accent relative top-[1px] left-[2px] inline-block h-[14px] w-[7px] shadow-[0_0_4px_var(--color-accent-glow)]" />
  );

  if (crumbs.length === 0) return null;

  return (
    <div className="flex items-center overflow-hidden font-mono text-[16px] leading-tight font-medium">
      {segments.map((seg) => {
        const slashVisible = count > seg.start;
        const labelVisible = Math.max(0, Math.min(count - seg.labelStart, seg.crumb.label.length));
        const labelHidden = seg.crumb.label.length - labelVisible;

        const segRangeEnd = seg.isLast ? seg.labelEnd : seg.labelEnd + 1;
        const cursorAfterSlash = count >= seg.start + 1 && count < seg.labelStart;
        const cursorInLabel = count >= seg.labelStart && count <= segRangeEnd;

        const labelColor = seg.crumb.isSection ? 'text-text-muted' : 'text-accent-glow';

        return (
          <span key={`${seg.crumb.label}-${seg.start}`} className="flex items-center">
            <span className="text-accent-glow mx-0.5">{slashVisible ? '/' : <span className="invisible">/</span>}</span>
            {cursorAfterSlash && cursor}
            <span className={labelColor}>
              {seg.crumb.label.slice(0, labelVisible)}
              {cursorInLabel && cursor}
              {labelHidden > 0 && (
                <span className="invisible" aria-hidden="true">
                  {seg.crumb.label.slice(labelVisible)}
                </span>
              )}
            </span>
          </span>
        );
      })}
    </div>
  );
}
