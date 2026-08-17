import type { CcBuild } from '@/contract';
import { useCcBuild } from '@/lib/use-cc-build';

const short = (sha: string | null) => (sha ? sha.slice(0, 7) : '?');

export function ccBuildChipModel(ccBuild: CcBuild | null): { text: string; tone: 'dim' | 'red'; title: string } {
  if (!ccBuild?.sha) return { text: 'cc ?', tone: 'dim', title: 'control-center build stamp unavailable' };
  if (ccBuild.stale) {
    return {
      text: `cc ${short(ccBuild.sha)} stale`,
      tone: 'red',
      title: `running build ${short(ccBuild.sha)} but the checkout is at ${short(ccBuild.headSha)} — rebuild required`,
    };
  }
  const built = ccBuild.builtAt ? new Date(ccBuild.builtAt).toLocaleString() : 'unknown';
  return {
    text: `cc ${short(ccBuild.sha)}`,
    tone: 'dim',
    title: `control-center build ${ccBuild.sha} (built ${built})`,
  };
}

export function CcBuildChip() {
  const { ccBuild } = useCcBuild();
  const m = ccBuildChipModel(ccBuild);
  return (
    <span
      title={m.title}
      className={`hidden items-center text-xs tracking-wide uppercase md:flex ${
        m.tone === 'red' ? 'text-status-offline' : 'text-text-dim'
      }`}
    >
      {m.text}
    </span>
  );
}
