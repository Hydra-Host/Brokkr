import { createContext, useContext } from 'react';

import type { BannerVariant, RestartBanner } from '@/lib/use-restart-state';

// keyed on the variant union so a banner state added later has to declare whether the API answers under it.
const API_DOWN: Record<BannerVariant, boolean> = {
  pending: true,
  stale: true,
  unreachable: true,
  // the marker was read back over HTTP, so the API is answering — only the recreation it describes failed.
  failed: false,
};

export const apiIsDown = (banner: RestartBanner | null): boolean => banner !== null && API_DOWN[banner.variant];

const ApiDownContext = createContext(false);
export const ApiDownProvider = ApiDownContext.Provider;

export const useApiDown = (): boolean => useContext(ApiDownContext);

/** No interval while the API is knowingly down — an outage the app itself started must not be polled through. */
export const pollInterval = (ms: number | false, apiDown: boolean): number | false => (apiDown ? false : ms);

/** Gate for every live view's poll. The restart-state poll is deliberately NOT gated: it is how the app learns the API is back. */
export const usePoll = (ms: number | false): number | false => pollInterval(ms, useApiDown());
