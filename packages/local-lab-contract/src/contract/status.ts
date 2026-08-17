import { StatusSchema } from '../schemas/status';

export const statusRoutes = {
  getStatus: {
    method: 'GET',
    path: '/api/status',
    responses: { 200: StatusSchema },
    summary: 'Get the whole-stack overview',
    description:
      'Aggregates the running version, process/build freshness, repo checkouts, service + datastore health, and fleet node state into a single snapshot for the dashboard landing view.',
  },
} as const;
