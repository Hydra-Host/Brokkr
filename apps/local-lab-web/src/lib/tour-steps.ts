import type { Side } from 'driver.js';

import { WIKI } from '@/lib/wiki';

export interface TourStep {
  route?: string;
  /** Search params the step's route needs, e.g. a tab selection. Compared and navigated together
   *  with `route` — a query string inside `route` would never match `location.pathname`. */
  search?: Record<string, string>;
  element?: string;
  title: string;
  description: string;
  side?: Side;
  align?: 'start' | 'center' | 'end';
  peekOnClick?: boolean;
}

const STACK = '/stack';
const OVERVIEW = '/';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function term(slug: string, label?: string): string {
  const entry = WIKI[slug];
  const text = label ?? entry?.title ?? slug;
  const brief = entry?.brief ?? '';
  return `<a class="wiki-term" href="/wiki/${esc(slug)}" data-wiki="${esc(slug)}" title="${esc(brief)}" target="_blank" rel="noopener noreferrer">${esc(text)}</a>`;
}

export const ORIENTATION_STEPS: TourStep[] = [
  {
    route: OVERVIEW,
    title: 'Welcome to brokkr·sim',
    description:
      "This is the testing control center for the brokkr fleet. You are on <b>Overview</b>, the page the cockpit opens on. Take ~10 minutes and I'll walk you through the layout — every sidebar section and the controls you'll use most on the Stack page. " +
      'Underlined words are wiki links — <b>hover</b> one for a quick definition, or <b>click</b> it to open the wiki in a new tab. ' +
      'Use <b>Space</b> or <b>→</b> to advance, <b>←</b> to go back, and <b>Esc</b> (or <b>Skip</b>) to leave — it remembers where you stopped.',
  },
  {
    route: OVERVIEW,
    element: '[data-tour="overview-hero"]',
    title: 'Is the stack up?',
    description: `The hero strip walks the control plane's bring-up stages left to right, so one glance tells you how far the stack got. Below it sit the ${term('fleet', 'fleet')}, recent activity, and — once this machine runs more than one stack — a ${term('stack-slot', 'stacks')} panel. Full detail in ${term('overview', 'the Overview entry')}.`,
    side: 'bottom',
    align: 'start',
  },
  {
    route: STACK,
    element: '[data-tour="brand"]',
    title: 'Home — brokkr·sim',
    description:
      'The brand mark anchors the header. Everything you do happens inside this single-page cockpit; there is no page reload as you move between sections.',
    side: 'bottom',
    align: 'start',
  },
  {
    route: STACK,
    element: '[data-tour="sidebar-toggle"]',
    title: 'Collapse the sidebar',
    description:
      'Toggle the left navigation panel to reclaim horizontal space for logs and tables. The icon rail stays visible so you can still jump between sections.',
    side: 'bottom',
    align: 'start',
  },
  {
    route: STACK,
    element: '[data-tour="getting-started-button"]',
    title: 'Get started — self-hosting',
    description:
      'Opens the <b>self-hosting guide</b>: a step-by-step doc for standing up Brokkr on your own infrastructure for real. Think of it as the reading material — "how to deploy for keeps" — separate from this in-app walkthrough.',
    side: 'bottom',
    align: 'start',
  },
  {
    route: STACK,
    element: '[data-tour="wiki-button"]',
    title: 'The wiki',
    description:
      'Every term in this tour — and a glossary of brokkr concepts — lives here. It stays clickable during the tour, so open it anytime for definitions and how-tos.',
    side: 'bottom',
    align: 'end',
  },
  {
    route: STACK,
    element: '[data-tour="tour-controls"]',
    title: 'Resume or restart the tour',
    description:
      'These two controls stay in the header on every page. <b>Tour</b> resumes this walkthrough from where you left off; the <b>restart</b> icon right beside it runs the whole thing again from the top.',
    side: 'bottom',
    align: 'end',
  },
  {
    route: STACK,
    element: '[data-tour="deploy-button"]',
    title: 'Guided Deploy',
    description: `The hands-on counterpart to the guide: a walkthrough that drives the <b>real controls</b> with you — bring up a ${term('hub', 'hub')} and ${term('spoke', 'spoke')}, then provision a machine end to end. Where <b>Get started</b> is a doc you read and this <b>Tour</b> orients you to the UI, <b>Guided Deploy</b> has you actually do it, step by step.`,
    side: 'bottom',
    align: 'end',
  },
  {
    route: STACK,
    element: '[data-tour="skin-picker"]',
    title: 'Pick a skin',
    description:
      'Switch the cockpit theme here — choose from the Hydra dark and light skins. Open it and try one now: it stays clickable mid-tour, and this very tour restyles itself to match whichever skin you choose.',
    side: 'left',
    align: 'start',
  },
  {
    route: STACK,
    element: '[data-tour="sidebar-rail"]',
    title: 'The navigation rail',
    description:
      `The icon rail groups every page by area: ${term('environment', 'Environment')}, ${term('testing', 'Testing')}, ${term('config', 'Config')} and the wiki — plus <b>Apps</b>, which fills in once the stack is up. ` +
      `${term('fleet', 'Fleet')} is a page inside Environment, not a group of its own. ` +
      'Hover an icon for its name, or click to open its panel. Let us walk each section.',
    side: 'right',
    align: 'start',
  },
  {
    route: STACK,
    element: '[data-tour="sidebar-stack"]',
    title: 'Stack',
    description: `The Stack page (where you are now) is mission control for the ${term('local-environment', 'local environment')}: bring services up, ${term('seed-data', 'seed data')}, check status, and tear everything down.`,
    side: 'right',
    align: 'center',
  },
  {
    route: STACK,
    element: '[data-tour="sidebar-datastore"]',
    title: 'Datastore',
    description: `Explore the backing ${term('postgres', 'Postgres')} and ${term('redis', 'Redis')} instances — inspect tables, run quick queries, and confirm the data your tests depend on is actually present. Two more tabs sit here: Thanos for metrics, and ${term('queues', 'Queues')} for the BullMQ work in flight.`,
    side: 'right',
    align: 'center',
  },
  {
    route: '/hub',
    element: '[data-tour="sidebar-hub"]',
    title: 'Hub',
    description: `A read-only window on the ${term('hub', 'hub')} itself: every ${term('saga', 'saga')} it is running, the webhook deliveries it sent, and the device tokens it minted. See ${term('hub-page', 'the Hub page entry')}.`,
    side: 'right',
    align: 'center',
  },
  {
    route: '/storage',
    element: '[data-tour="sidebar-storage"]',
    title: 'Storage',
    description: `What the ${term('spoke', 'spoke')} serves to a booting machine — the discovery image, built initrds, disk overlays and the layer cache — with verify, resync and wipe. When a node loops on <code>vmlinuz … Not found</code>, look here first. See ${term('storage', 'the Storage entry')}.`,
    side: 'right',
    align: 'center',
  },
  {
    route: '/fleet',
    element: '[data-tour="sidebar-fleet"]',
    title: 'Fleet',
    description: `The Fleet section lists the simulated ${term('vm', 'VMs')} (${term('hub', 'hub')} and ${term('spoke', 'spoke')} nodes) and their configuration, so you can see exactly what hardware your scenario is running against.`,
    side: 'right',
    align: 'center',
  },
  {
    route: '/testing',
    element: '[data-tour="sidebar-testing"]',
    title: 'Testing',
    description: `Pick a ${term('scenario', 'scenario')} and launch a test run from here. Runs stream their progress live, so you can watch a scenario execute step by step.`,
    side: 'right',
    align: 'center',
  },
  {
    route: '/results',
    element: '[data-tour="sidebar-results"]',
    title: 'Results',
    description: `The <b>Results</b> page reviews finished ${term('run', 'runs')}: pass/fail outcomes, timings, and the captured logs for each run so you can diagnose a failure after the fact.`,
    side: 'right',
    align: 'center',
  },
  {
    route: '/settings',
    element: '[data-tour="sidebar-settings"]',
    title: 'Config — Stack',
    description: `The environment config editor. It opens on the <b>Stack</b> tab (hub/spoke knobs, and this checkout's ${term('stack-slot', 'slot')}); the <b>Fleet</b> tab composes how many ${term('hub', 'hubs')} and ${term('spoke', 'spokes')} to spin up and how they are wired, and <b>Layers</b> handles image layers. Save a configuration once and reuse it across runs.`,
    side: 'right',
    align: 'center',
  },
  {
    route: '/audit',
    element: '[data-tour="sidebar-audit"]',
    title: 'Audit log',
    description: `Every mutation this cockpit performed, and every one it refused, with the caller's origin. It is the only record of what an ${term('mcp', 'MCP agent')} did on your behalf. See ${term('audit', 'the Audit log entry')}.`,
    side: 'right',
    align: 'center',
  },
  {
    route: STACK,
    element: '[data-tour="sidebar-apps"]',
    title: 'Apps',
    description: `Once the stack is up, the <b>Apps</b> section lists ${term('web-ui', 'deep links')} to the running ${term('hub', 'hub')} and ${term('spoke', 'spoke')} web UIs — built from the detected LAN IP so they open over the network too.`,
    side: 'right',
    align: 'center',
  },
  {
    route: STACK,
    element: '[data-tour="stack-status"]',
    title: 'Status checks',
    description:
      'Run read-only health checks against the stack. Start here to confirm what is already running before you bring anything up or tear it down.',
    side: 'right',
    align: 'start',
  },
  {
    route: STACK,
    element: '[data-tour="stack-bringup"]',
    title: 'Bring up',
    description: `These are the constructive operations: start the ${term('hub', 'hub')}, boot the ${term('datastore', 'datastores')}, and ${term('seed-data', 'seed data')}. Each one streams its output to the log pane on the right.`,
    side: 'right',
    align: 'center',
  },
  {
    route: STACK,
    element: '[data-tour="stack-destructive"]',
    title: 'Destructive operations',
    description:
      'Tear-down and reset actions live in their own group so they are hard to hit by accident. Destructive steps prompt for confirmation before they run.',
    side: 'right',
    align: 'center',
  },
  {
    route: STACK,
    element: '[data-tour="stack-logs"]',
    title: 'Live logs',
    description:
      'Every operation and service streams here in real time. Use the tabs to switch between service logs, and click a service or datastore card to follow its output.',
    side: 'left',
    align: 'start',
  },
  {
    route: STACK,
    element: '[data-tour="stack-recent"]',
    title: 'Recent runs',
    description:
      'A history of recent operations. Click any entry to replay its buffered output in the log pane — handy for revisiting what an earlier command actually did.',
    side: 'right',
    align: 'end',
  },
  {
    route: STACK,
    title: "That's the tour",
    description: `You have seen the whole cockpit. Ready to bring it up? Click the <b>Guided Deploy</b> button in the header for a guided ${term('bring-up', 'first bring-up')} of your ${term('hub', 'hub')} and ${term('spoke', 'spoke')}. Once it is up, the ${term('overview', 'Overview')} entry offers a second walkthrough of the inspection pages — ${term('queues', 'queues')}, ${term('hub-page', 'hub')}, ${term('storage', 'storage')} and ${term('audit', 'audit')}. Replay this anytime from the tour button. Happy testing!`,
  },
];

export const DEPLOY_STEPS: TourStep[] = [
  {
    route: STACK,
    title: 'Deploy your first hub & spoke',
    description: `Let's bring the ${term('local-environment', 'local environment')} up for the first time — I'll point at each control in the right order, and you can <b>click along</b>. One prerequisite first: the cockpit's buttons talk to the control-center API, so it has to be running. Underlined terms open the wiki in a new tab.`,
  },
  {
    route: STACK,
    title: 'Before you start · run the control center',
    description: `The Status and Bring-up controls call the control-center API (port 3002). If clicking them does nothing, it isn't running yet — open ${term('running-the-stack', 'Running the control center & stack')} for the exact steps (in short, <b>from the repo root</b>: <code>task up</code>, which brings the whole stack up — including this control center on :3002/:5175). Once it's up, come back here and continue.`,
  },
  {
    route: STACK,
    element: '[data-tour="stack-status"]',
    title: '1 · Check status first',
    description:
      'The <b>Status</b> card is live — every stack process with its supervisor state, readiness and restart count. Read it to see what is already up before you bring anything else up, then hit <b>Next</b> to continue.',
    side: 'left',
    align: 'start',
    peekOnClick: true,
  },
  {
    route: STACK,
    element: '[data-tour="stack-bringup"]',
    title: '2 · Bring up, in order',
    description: `Run these top-to-bottom: boot the ${term('datastore', 'datastores')}, start the ${term('hub', 'hub')}, start the ${term('spoke', 'spoke')}, then ${term('seed-data', 'seed data')}. Click each one and wait for it to finish before the next — the guide tucks aside while you watch.`,
    side: 'right',
    align: 'center',
    peekOnClick: true,
  },
  {
    route: STACK,
    element: '[data-tour="stack-logs"]',
    title: '3 · Watch the logs',
    description:
      'Each operation streams its output here in real time. Watch for a clean finish before moving on — this is where you will spot anything that fails to come up.',
    side: 'left',
    align: 'start',
  },
  {
    route: STACK,
    element: '[data-tour="sidebar-apps"]',
    title: '4 · Open the hub',
    description: `Once the ${term('hub', 'hub')} is up, the <b>Apps</b> section in the sidebar links straight to its web UI so you can log in and confirm it is alive.`,
    side: 'right',
    align: 'center',
  },
  {
    route: '/fleet',
    element: '[data-tour="sidebar-fleet"]',
    title: '5 · Bring the fleet up (needs root)',
    description: `Your ${term('spoke', 'spoke')} nodes boot as ${term('vm', 'VMs')} here. <b>Fleet up</b> needs <b>sudo</b> — it starts <code>socket_vmnet</code>, the per-node <code>ipmi_sim</code> + <code>sushy</code> BMC daemons, and loopback aliases. On macOS, do the one-time sudo setup in ${term('running-the-stack', 'Running the control center &amp; stack')} first; otherwise the detached daemons can't get root and Fleet up fails with <code>socket_vmnet did not create sockets</code>.`,
    side: 'right',
    align: 'center',
  },
  {
    route: '/fleet',
    title: '6 · These are blank bare metal',
    description: `Once they're up, open a node's <b>console</b> to watch it ${term('bring-up', 'PXE-boot')}. A fresh node has <b>no OS</b> — like a just-racked server — so you watch the <b>serial console</b>; you don't SSH in yet. (<code>ping</code> answers because firmware does, but <code>:22</code> is closed until an OS is provisioned.)<br><br><b>One-time:</b> for nodes to actually boot, turn on <b>Settings → ISO download → Sync/update ISO on boot</b> (<code>BRIDGE_SYNC_ENABLED</code>) and restart the spoke — otherwise they loop on <code>vmlinuz … Not found</code>. With it on, the spoke fetches the discovery image and nodes auto-run discovery.`,
  },
  {
    route: '/testing',
    element: '[data-tour="sidebar-testing"]',
    title: '7 · Provision a machine',
    description: `Pick a provision / lifecycle ${term('scenario', 'scenario')} (marked destructive), target one node, and run it — it drives the real saga: power → iPXE → discovery → OS install. Watch it live, then review it under ${term('results', 'Results')}.`,
    side: 'right',
    align: 'center',
  },
  {
    route: '/testing',
    title: '8 · Then SSH in',
    description: `After a node is provisioned it boots with <code>sshd</code> and your seeded SSH key, so <code>ssh ubuntu@&lt;node-ip&gt;</code> works (the node's data-plane IP is on the Fleet page). That's the full loop — <b>blank metal → a provisioned host you can log into</b>.`,
  },
  {
    route: STACK,
    title: "That's a full bring-up",
    description:
      'You took the local stack from nothing to a provisioned machine. Re-run this anytime from the <b>Guided Deploy</b> button, and open the <b>Wiki</b> (top-right) for the why behind each step. Happy testing!',
  },
];

// the container steps deliberately omit side/align: each anchors a full-width panel, so driver.js
// places the popover better than a fixed side would.
export const OPS_STEPS: TourStep[] = [
  {
    route: OVERVIEW,
    title: 'Inspecting a running stack',
    description: `The orientation tour showed you where things are. This one shows you how to <b>read</b> a stack that is already up: the work in flight, what the ${term('hub', 'hub')} thinks happened, what the ${term('spoke', 'spoke')} is serving, and what this cockpit changed. Bring the stack up first — these pages are empty otherwise.`,
  },
  {
    route: OVERVIEW,
    title: 'One machine, several stacks',
    description: `Each checkout claims a ${term('stack-slot', 'slot')}, and the slot derives its whole port block, subnet and state directory — so a second checkout comes up beside this one with no edits at all. A <b>Stacks</b> panel appears on this page once a second stack is registered. On a single-stack machine it stays hidden, which is why ${term('multi-stack', 'the how-to')} exists.`,
  },
  {
    route: '/datastore',
    search: { tab: 'queues' },
    element: '[data-tour="datastore-queues"]',
    title: 'Queues — the work in flight',
    description: `The raw BullMQ state: how many jobs wait, run, fail or stall, across the per-zone ${term('saga', 'saga')} queues, the global <code>results:inbox</code>, and the hub's own <code>bull:*</code> queues. Payloads are redacted and byte-capped before they leave the API, and the mutating actions are loopback-only. See ${term('queues', 'the Queues entry')}.`,
  },
  {
    route: '/hub',
    search: { tab: 'lifecycle' },
    element: '[data-tour="hub-lifecycle"]',
    title: "Lifecycle jobs — the hub's view",
    description: `The same work one level up: each ${term('saga', 'saga')} with its phase and its device. <b>Select a job</b> and the pane on the right draws its saga timeline and payload — that is where you find the step a provision actually died on. The tab and every filter live in the URL, so you can hand someone the link.`,
  },
  {
    route: '/hub',
    search: { tab: 'webhooks' },
    element: '[data-tour="hub-webhooks"]',
    title: 'Webhooks',
    description:
      'Outbound delivery attempts with their status. A webhook that never left, or that retried and gave up, shows here rather than buried in the hub logs.',
  },
  {
    route: '/hub',
    search: { tab: 'tokens' },
    element: '[data-tour="hub-tokens"]',
    title: 'Device tokens',
    description: `The bearer tokens minted per machine, with the events recorded against each one. A machine stuck at <b>provisioning</b> while the ${term('spoke', 'spoke')} logs look clean usually means its phone-home never reached the hub. This is where you confirm that.`,
  },
  {
    route: '/storage',
    element: '[data-tour="storage-categories"]',
    title: 'Storage — what the spoke serves',
    description: `The discovery image, built initrds, disk overlays and the layer cache, each with its path and size. <b>Verify</b> re-checks what is on disk, <b>resync</b> fetches what is missing, and <b>wipe</b> deletes a category. See ${term('storage', 'the Storage entry')}.`,
  },
  {
    route: '/audit',
    element: '[data-tour="audit-log"]',
    title: 'Audit log — what changed, and who asked',
    description: `Every mutation this cockpit made and every one it refused, with the caller's origin and parameters. Denied rows keep their own retention cap, so a burst of refusals cannot push the record of real work out. See ${term('audit', 'the Audit log entry')}.`,
  },
  {
    route: OVERVIEW,
    title: "That's the operations deck",
    description: `${term('queues', 'Queues')} for the work, ${term('hub-page', 'Hub')} for the hub's account of it, ${term('storage', 'Storage')} for what boots, and the ${term('audit', 'audit log')} for what you changed. Replay this from the ${term('overview', 'Overview')} or ${term('multi-stack', 'multi-stack')} wiki entries anytime.`,
  },
];
