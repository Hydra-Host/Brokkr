import { defineFrontendModule } from '@hydrahost/plugin-sdk';

import { GreetingWidget } from './greeting-widget';
import { HelloWorldPage } from './hello-world-page';

export default defineFrontendModule({
  slots: {
    'dashboard-widget': [{ component: GreetingWidget, label: 'Greetings' }],
    'sidebar-nav': [
      { label: 'Overview', to: '/plugins/hello-world', section: 'Reference' },
      { label: 'About', to: '/plugins/hello-world/about', section: 'Reference' },
    ],
  },
  rootRoute: {
    component: HelloWorldPage,
    label: 'Hello World',
    description:
      'Reference plugin demonstrating the full plugin contract — schema, migrations, endpoint, slot widget, sidebar nav, and root route with sub-paths.',
  },
});
