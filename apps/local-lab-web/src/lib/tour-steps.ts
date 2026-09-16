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
const CONFIG = '/config';
const ZONES = '/config/zones';

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
      `The icon rail groups every page by area, top to bottom: ${term('environment', 'Environment')}, ${term('testing', 'Testing')}, ${term('config', 'Configuration')}, <b>Apps</b>, and ${term('reference', 'Reference')}. Apps fills in once the stack is up. ` +
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
    description: `The Fleet page shows the simulated ${term('vm', 'VMs')} as they run: power state, addresses, and a serial console for each one. It does not edit them. Node hardware moved to <b>Configuration → Fleet nodes</b>, and the ${term('fleet-topology', 'live fleet graph')} moved to <b>Configuration → Zones &amp; topology</b>.`,
    side: 'right',
    align: 'center',
  },
  {
    route: '/fleet',
    element: '[data-tour="fleet-machines"]',
    title: 'Driving a machine',
    description: `One card per ${term('vm', 'machine')}, and every action you need on a single row. <b>on</b>, <b>cycle</b> and <b>off</b> go through the simulated ${term('bmc', 'BMC')} first, with a <code>virsh</code> fallback that verifies the state actually changed. <b>console</b> attaches the live serial console — the only way in before an OS exists. <b>exec</b> runs a command over SSH once one does. <b>rediscover</b> re-runs discovery, and <b>reset</b> returns the machine to clean inventory so a ${term('scenario', 'scenario')} can start from a known state.`,
    side: 'right',
    align: 'start',
  },
  {
    route: '/layers',
    element: '[data-tour="sidebar-layers"]',
    title: 'Layers',
    description: `The OS-layer release manifest, read from the asset host. Give it a manifest or release-index URL and press <b>Load</b>: the page draws every layer, its size and the dependency graph between them — and seeds the ${term('hub', 'hub')} database from the same document. Each build has a <b>pull</b> button that primes the layer cache and a <b>nuke</b> button that drops it. A primed layer is what lets a repeat provision skip the CDN. See ${term('layers', 'the Layers entry')}.`,
    side: 'right',
    align: 'center',
  },
  {
    route: '/testing',
    element: '[data-tour="sidebar-testing"]',
    title: 'Scenarios',
    description: `<b>Scenarios</b> is the first page of the ${term('testing', 'Testing')} group. Pick a ${term('scenario', 'scenario')} and launch a ${term('run', 'run')} from here. A run streams its progress live, so you watch each step as it executes.`,
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
    route: CONFIG,
    element: '[data-tour="sidebar-config"]',
    title: 'Configuration',
    description: `Everything this stack can be configured to do, in sidebar order. <b>Summary</b> answers what you changed and where each override came from. <b>Stack knobs</b> holds the ${term('hub', 'hub')} and ${term('spoke', 'spoke')} knobs, the identity, the ports, and this checkout's ${term('stack-slot', 'slot')}. <b>Fleet nodes</b> ${term('fleet-builder', 'composes the simulated machines')}. <b>Zones &amp; topology</b> declares the zones and draws the ${term('fleet-topology', 'live fleet')}. <b>Advanced</b> holds the ${term('config-advanced', 'build-time forks')}, the zone crypto, and the derived ports. A changed value is marked, and says which file or environment pin set it.`,
    side: 'right',
    align: 'center',
  },
  {
    route: CONFIG,
    element: '[data-tour="apply-bar"]',
    title: 'Saving is not applying',
    description: `<b>Summary</b> answers three questions — <b>What this stack changed</b> lists every override with a link to the field that owns it, <b>Sources</b> says which files are in play, and <b>This browser</b> holds your API token. This bar sits at the top of every Configuration page. It counts what is unsaved, what is overridden, and what an apply will cost. A save only writes your <code>stack.local.nix</code> overlay — nothing the running stack reads changes yet. When work is waiting, a <b>saved, not applied</b> panel appears above this bar. It names each outstanding item and offers the one run that clears it: a hub reload, a spoke reload, a redeploy, a fleet apply, or the zone seed. An item that no run performs says so, and shows no button. See ${term('apply', 'the apply entry')}.`,
    side: 'bottom',
    align: 'start',
  },
  {
    route: '/config/stack',
    element: '#HUB',
    title: 'Stack knobs',
    description: `Every ${term('hub', 'hub')} and ${term('spoke', 'spoke')} setting the stack can be given, on one page: six sections down the rail — <b>HUB</b>, <b>SPOKE</b>, <b>IDENTITY</b>, <b>PORTS</b>, <b>TOPOLOGY</b> and <b>STACK</b>. Each field says where its value came from: the Nix default, a file, or an environment pin that outranks the overlay and locks the field. A changed field is marked in the gutter, and <b>changed only</b> hides everything you have not touched — useful here, because there are dozens.`,
    side: 'right',
    align: 'start',
  },
  {
    route: '/config/fleet',
    element: '#NODES',
    title: 'Fleet nodes',
    description: `The ${term('fleet-builder', 'machines themselves')}, grouped by zone. Per node: vCPUs, memory, disks, extra NICs, pinned addresses and its zone. A size field reads <code>inherited</code> until you type a value, and <code>inherit</code> gives it back — so a fleet default stays one edit. Each card also says what applying the change does to that node, how long it takes, and whether it wipes that disk. Above, <b>MODE</b> switches between simulated VMs and real hardware.`,
    side: 'right',
    align: 'start',
  },
  {
    route: '/config/advanced',
    element: '#FORKS',
    title: 'Advanced',
    description: `${term('config-advanced', 'The knobs that change how the stack is built')} — the behavioural forks, the zone crypto, the checkout paths, plus the counts nothing reads and the paths no editor owns yet. Most need a redeploy. A read-only field always says why: it is a secret and shows only its digest, an environment pin outranks it, or no writer owns the path.`,
    side: 'right',
    align: 'start',
  },
  {
    route: ZONES,
    element: '#TOPOLOGY',
    title: 'The fleet, drawn',
    description: `<b>Zones &amp; topology</b> draws the fleet it declares: one lane per zone, the ${term('spoke', 'bridges')} in each zone with their ports and a star on the leader, and the ${term('vm', 'nodes')} below them with their size and power. Color is health, not shape. Click a zone to reach its card; click a node to open its hardware on <b>Fleet nodes</b>. Under the graph, three lanes name what a flat list hides — a node in a zone nothing declares, a machine that runs but the config does not know, and a hub zone the fleet never declared. See ${term('fleet-topology', 'the fleet topology entry')}.`,
    side: 'bottom',
    align: 'start',
  },
  {
    route: ZONES,
    element: '[data-tour="sidebar-apps"]',
    title: 'Apps',
    description: `Once the stack is up, the <b>Apps</b> section lists ${term('web-ui', 'deep links')} to the running ${term('hub', 'hub')} and ${term('spoke', 'spoke')} web UIs — built from the detected LAN IP so they open over the network too.`,
    side: 'right',
    align: 'center',
  },
  {
    route: '/docs',
    element: '[data-tour="sidebar-docs"]',
    title: 'Reference — and the API',
    description: `The last group is ${term('reference', 'Reference')}: the API docs, the ${term('audit', 'audit log')}, the self-hosting guide, and this wiki. <b>API docs</b> is the control center's own OpenAPI in two tabs — ReDoc to read, Swagger to send a real request against this stack. Both follow the skin you picked. Everything the cockpit does is one of these routes, which is how an ${term('mcp', 'agent')} drives the same stack. See ${term('api-docs', 'the API docs entry')}.`,
    side: 'right',
    align: 'center',
  },
  {
    route: '/audit',
    element: '[data-tour="sidebar-audit"]',
    title: 'Audit log',
    description: `The last stop in ${term('reference', 'Reference')}: every mutation this cockpit performed, and every one it refused, with the caller's origin. It is the only record of what an ${term('mcp', 'MCP agent')} did on your behalf. See ${term('audit', 'the Audit log entry')}.`,
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
    description: `You have seen the whole cockpit. Ready to bring it up? Click the <b>Guided Deploy</b> button in the header for a guided ${term('bring-up', 'first bring-up')} of your ${term('hub', 'hub')} and ${term('spoke', 'spoke')}. Once it is up, the ${term('overview', 'Overview')} entry offers a second walkthrough of the inspection pages — ${term('queues', 'queues')}, ${term('hub-page', 'hub')}, ${term('storage', 'storage')} and ${term('audit', 'audit')}. The ${term('fleet-topology', 'fleet graph')} and the ${term('layers', 'Layers')} page are the two you will come back to most. Replay this anytime from the tour button. Happy testing!`,
  },
];

export const DEPLOY_STEPS: TourStep[] = [
  {
    route: STACK,
    title: 'Provision your first machine',
    description: `The ${term('local-environment', 'local environment')} is already up. <code>task up</code> started the ${term('datastore', 'datastores')}, the ${term('hub', 'hub')}, the ${term('spoke', 'spoke')}, the ${term('seed-data', 'seed data')} and the ${term('fleet', 'fleet')} — and this cockpit is one of those processes, so it could not be on screen otherwise. Nothing here needs bringing up. This walkthrough drives what comes next: taking a blank machine to a provisioned host you can log into. I'll point at each control and you can <b>click along</b>. Underlined terms open the wiki in a new tab.`,
  },
  {
    route: STACK,
    element: '[data-tour="stack-status"]',
    title: '1 · Read what is already up',
    description:
      'The <b>Status</b> card is live — every stack process with its supervisor state, readiness and restart count. <b>Init DAG</b> beside it counts the one-time bring-up tasks that already completed. Read it, then hit <b>Next</b>.',
    side: 'left',
    align: 'start',
    peekOnClick: true,
  },
  {
    route: STACK,
    element: '[data-tour="stack-bringup"]',
    title: '2 · What the bring-up controls are for',
    description: `None of these is a first-run step — <code>task up</code> already ran them. They are here for recovery and for re-running one piece. <b>Stack up</b> is the whole ${term('datastore', 'datastores')} → ${term('hub', 'hub')}/${term('spoke', 'spoke')} → ${term('seed-data', 'seed')} sequence in one action; on a running stack it reconciles, and the button says so. <b>Reconcile / self-heal</b> restarts whatever stopped, in dependency order, and is safe anytime. <b>Datastores up</b> starts the datastores only. The three you will actually reach for: <b>Seed DB</b> re-runs the sim fixtures, <b>Seed zones</b> makes a saved zone set live and restarts the bridges, and <b>DB migrate deploy</b> applies pending migrations.`,
    side: 'right',
    align: 'center',
    peekOnClick: true,
  },
  {
    route: STACK,
    element: '[data-tour="stack-logs"]',
    title: '3 · Watch the logs',
    description:
      'Every operation you run streams its output here in real time, and the tabs switch between the running services. This is where a failure explains itself.',
    side: 'left',
    align: 'start',
  },
  {
    route: STACK,
    element: '[data-tour="sidebar-apps"]',
    title: '4 · Open the hub',
    description: `The <b>Apps</b> section links straight to the running ${term('hub', 'hub')} web UI, built from the detected LAN IP. Open it and log in — the ${term('seed-data', 'seed')} already created the owner account.`,
    side: 'right',
    align: 'center',
  },
  {
    route: '/fleet',
    element: '[data-tour="sidebar-fleet"]',
    title: '5 · The fleet is already running',
    description: `Your ${term('spoke', 'spoke')} nodes boot as ${term('vm', 'VMs')} here, and they are already up: <code>fleet.autoStart</code> is on, so <code>task up</code> started them. <b>Fleet up</b> is for after a <b>Fleet down</b>, or when you have turned autoStart off. It needs <b>sudo</b> — it starts <code>socket_vmnet</code>, the per-node <code>ipmi_sim</code> and <code>sushy</code> BMC daemons, and loopback aliases. On macOS, do the one-time sudo setup in ${term('running-the-stack', 'Running the control center &amp; stack')} first; otherwise the detached daemons cannot get root and it fails with <code>socket_vmnet did not create sockets</code>.`,
    side: 'right',
    align: 'center',
  },
  {
    route: '/fleet',
    element: '[data-tour="fleet-machines"]',
    title: '6 · These are blank bare metal',
    description: `Once they're up, open a node's <b>console</b> to watch it ${term('bring-up', 'PXE-boot')}. A fresh node has <b>no OS</b> — like a just-racked server — so you watch the <b>serial console</b>; you don't SSH in yet. (<code>ping</code> answers because firmware does, but <code>:22</code> is closed until an OS is provisioned.)<br><br>Do the nodes loop on <code>vmlinuz … Not found</code>? Then one knob is off. The next step opens it.`,
  },
  {
    route: '/config/stack',
    element: '#SPOKE',
    title: '7 · Confirm ISO sync is on',
    description: `This knob is why the nodes can boot at all: <b>Configuration → Stack knobs → SPOKE → ISO download → Sync/update ISO on boot</b> (<code>BRIDGE_SYNC_ENABLED</code>). It defaults to <b>on</b>, and on it the ${term('spoke', 'spoke')} fetches the discovery image at boot so nodes run discovery by themselves. Off, they loop on <code>vmlinuz … Not found</code> — so if you ever see that, this is the field to check. Change it and the bar above applies: a save is not an ${term('apply', 'apply')}, so the spoke needs its reload before the new value is live.`,
    side: 'right',
    align: 'center',
    peekOnClick: true,
  },
  {
    route: '/testing',
    element: '[data-tour="sidebar-testing"]',
    title: '8 · Provision a machine',
    description: `Pick a provision / lifecycle ${term('scenario', 'scenario')} (marked destructive), target one node, and run it — it drives the real saga: power → iPXE → discovery → OS install. Watch it live, then review it under ${term('results', 'Results')}.`,
    side: 'right',
    align: 'center',
  },
  {
    route: '/testing',
    title: '9 · Then SSH in',
    description: `After a node is provisioned it boots with <code>sshd</code> and your seeded SSH key, so <code>ssh ubuntu@&lt;node-ip&gt;</code> works (the node's data-plane IP is on the Fleet page). That's the full loop — <b>blank metal → a provisioned host you can log into</b>.`,
  },
  {
    route: STACK,
    title: "That's the full loop",
    description:
      'You took a blank machine to a provisioned host you can log into. Re-run this anytime from the <b>Guided Deploy</b> button, and open the <b>Wiki</b> (top-right) for the why behind each step. Happy testing!',
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
    route: ZONES,
    element: '#TOPOLOGY',
    title: 'The fleet, live',
    description: `Read the shape first. The graph draws one lane per zone, a dot per bridge — green online, red offline, amber means the presence was not read — and a star on the leader. Each node tile carries its size and its power. Below the graph, a node in an undeclared zone, a machine no config knows, and a hub-only zone each get their own lane instead of being folded into a count. See ${term('fleet-topology', 'the fleet topology entry')}.`,
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
    route: '/fleet',
    element: '[data-tour="fleet-destructive"]',
    title: 'When a machine is wedged',
    description: `The fleet's own repair surface, split by what it costs. <b>Fleet down</b> powers the ${term('vm', 'VMs')} off but keeps them defined and keeps the disk overlays, so a restart is fast. <b>Fleet rebuild</b> applies a saved topology the expensive way: nuke, re-seed, rebuild every machine. <b>Fleet nuke</b> deletes the overlays, sushy configs and NVRAM, so the next bring-up is fully fresh. Above this group, <b>Fleet apply</b> does the cheap version — it diffs desired against applied and runs only the minimal per-node ops.`,
  },
  {
    route: '/layers',
    title: 'Layers — what is already cached',
    description: `The manifest loads by itself. Open a layer and its builds list which ones the cache holds: a <b>nuke</b> button means cached, a <b>pull</b> button means not. A provision that re-pulls a multi-gigabyte layer from the CDN is slow for this reason and no other. A pull streams through the ${term('spoke', 'spoke')}'s nginx cache and prints the transfer. See ${term('layers', 'the Layers entry')}.`,
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
    description: `${term('fleet-topology', 'The graph')} for the shape, ${term('queues', 'Queues')} for the work, ${term('hub-page', 'Hub')} for the hub's account of it, ${term('storage', 'Storage')} for what boots, and the ${term('audit', 'audit log')} for what you changed. Replay this from the ${term('overview', 'Overview')} or ${term('multi-stack', 'multi-stack')} wiki entries anytime.`,
  },
];
