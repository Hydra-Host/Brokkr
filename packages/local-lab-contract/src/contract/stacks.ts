import { StacksListSchema } from '../schemas/stacks';

export const stacksRoutes = {
  listStacks: {
    method: 'GET',
    path: '/api/stacks',
    responses: { 200: StacksListSchema },
    summary: 'List the stacks registered on this host',
    description:
      'Read-only dashboard backing of every local stack with a slot-registry entry: slot, owning checkout, recorded state, liveness probed on its process-compose socket (the registry entry is a hint — the socket is truth, so a dead or checkout-less entry reports live: false rather than vanishing), hub/web/lab URLs denormalized at bring-up, and a running/total process rollup from its own GET /processes. The responding stack’s own slot rides along as selfSlot so a caller can identify its own row without a second request. Loopback-only (it leaks host filesystem paths): a valid LAB_API_TOKEN is not sufficient and a remote caller gets 403.',
  },
} as const;
