import type { CcBuild } from '@/contract';
import { useCcBuild } from '@/lib/use-cc-build';

const short = (sha: string | null) => (sha ? sha.slice(0, 7) : '?');

export function ccSkewBannerModel(ccBuild: CcBuild | null): { text: string } | null {
  if (!ccBuild?.stale) return null;
  return {
    text: `control-center build skew — the API is running build ${short(ccBuild.sha)} but the checkout is at ${short(ccBuild.headSha)}, and this UI has hot-reloaded onto the newer contract. Rebuild + restart the lab API (task up) before running destructive ops.`,
  };
}

export function CcSkewBanner() {
  const { ccBuild } = useCcBuild();
  const m = ccSkewBannerModel(ccBuild);
  if (!m) return null;
  return (
    <div className="border-status-offline/30 bg-status-offline/10 text-status-offline mx-4 mt-2 shrink-0 rounded-md border px-3 py-2 font-mono text-xs sm:mx-6">
      {m.text}
    </div>
  );
}
