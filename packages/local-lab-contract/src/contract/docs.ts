import { GettingStartedSchema } from '../schemas/docs';

export const docsRoutes = {
  getGettingStarted: {
    method: 'GET',
    path: '/api/docs/getting-started',
    responses: { 200: GettingStartedSchema },
    summary: 'Get the getting-started guide',
    description:
      'Reads $HUB_REPO_PATH/wiki/getting-started.md and returns it as raw markdown for the cockpit to render. Falls back to a bundled placeholder (found=false) when HUB_REPO_PATH is unset or the file is missing.',
  },
} as const;
