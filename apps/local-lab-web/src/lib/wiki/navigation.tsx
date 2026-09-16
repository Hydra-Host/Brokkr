import { WikiLink } from '@/components/wiki-link';

import { Code, H, LI, Note, OL, OpsCta, P, Term, UL } from './prose';
import type { WikiEntry } from './types';

export const NAVIGATION_ENTRIES: WikiEntry[] = [
  {
    slug: 'environment',
    title: 'Environment (nav group)',
    brief: 'The Environment group in the nav rail — the pages that manage the local stack\u2019s services and data.',
    category: 'Navigation',
    related: ['local-environment', 'services', 'datastore', 'overview', 'hub-page', 'storage', 'layers'],
    body: (
      <>
        <P>
          <Term>Environment</Term> is a grouping in the navigation rail. It collects the pages you use to manage the
          local stack's <WikiLink slug="services">services</WikiLink> and <Term>data</Term>. It holds seven pages:
        </P>
        <UL>
          <LI>
            <WikiLink slug="overview">Overview</WikiLink> — the landing page: pipeline, health, stacks, recent runs.
          </LI>
          <LI>
            <Term>Stack</Term> — bring services up, seed, tear down, and read the logs.
          </LI>
          <LI>
            <WikiLink slug="datastore">Datastore</WikiLink> — inspect <WikiLink slug="postgres">Postgres</WikiLink>,{' '}
            <WikiLink slug="redis">Redis</WikiLink>, Thanos and the <WikiLink slug="queues">queues</WikiLink>.
          </LI>
          <LI>
            <WikiLink slug="hub-page">Hub</WikiLink> — lifecycle jobs, webhook deliveries and device tokens.
          </LI>
          <LI>
            <WikiLink slug="storage">Storage</WikiLink> — the artifacts the spoke serves, and the ops that repair them.
          </LI>
          <LI>
            <WikiLink slug="fleet">Fleet</WikiLink> — the simulated machines and their consoles.
          </LI>
          <LI>
            <WikiLink slug="layers">Layers</WikiLink> — the OS-layer release manifest, its dependency graph, and the
            cache each build is pulled into.
          </LI>
        </UL>
        <Note>
          Important distinction: <Term>"Environment"</Term> here is just a navigation category — a place in the menu.
          That's different from <WikiLink slug="local-environment">the local environment</WikiLink>, which is the actual
          running simulation. The Environment pages are how you control the local environment.
        </Note>
      </>
    ),
  },
  {
    slug: 'testing',
    title: 'Testing (nav group)',
    brief: 'The Testing nav group — Scenarios launches a run, Results reviews the finished ones.',
    category: 'Navigation',
    related: ['scenario', 'run', 'results', 'custom-sequence', 'plan'],
    body: (
      <>
        <P>
          <Term>Testing</Term> is a group in the navigation rail. It holds two pages: <Term>Scenarios</Term> and{' '}
          <WikiLink slug="results">Results</WikiLink>. From <Term>Scenarios</Term> you:
        </P>
        <OL>
          <LI>
            pick a <WikiLink slug="scenario">scenario</WikiLink> (a repeatable test case),
          </LI>
          <LI>
            launch a <WikiLink slug="run">run</WikiLink> against the current <WikiLink slug="fleet">fleet</WikiLink>,
          </LI>
          <LI>
            and then review what happened on the <WikiLink slug="results">Results</WikiLink> page.
          </LI>
        </OL>
        <P>
          It is the day-to-day loop for verifying that the <WikiLink slug="hub">hub</WikiLink> and{' '}
          <WikiLink slug="spoke">spoke</WikiLink> behave the way you expect.
        </P>
      </>
    ),
  },
  {
    slug: 'config',
    title: 'Configuration (nav group)',
    brief:
      'The Configuration nav group — where you shape the stack before you run it, and where you apply what you saved.',
    category: 'Navigation',
    related: ['apply', 'fleet-builder', 'fleet-topology', 'config-advanced', 'stack-slot', 'audit', 'testing'],
    body: (
      <>
        <P>
          <Term>Configuration</Term> is where you shape the stack <em>before</em> you run anything against it, and where
          you apply what you saved. Five pages sit here. Each one writes the same file — your{' '}
          <Term>stack.local.nix</Term> overlay — and each one keeps its own save control.
        </P>
        <H>What sits here</H>
        <UL>
          <LI>
            <Term>Summary</Term> — every knob whose value differs from the value Nix declares, and which file or
            environment pin set it. Each row opens the field that owns it.
          </LI>
          <LI>
            <Term>Stack knobs</Term> — the hub and spoke knobs, the service identity, the ports, and this checkout's{' '}
            <WikiLink slug="stack-slot">slot</WikiLink>.
          </LI>
          <LI>
            <Term>Fleet nodes</Term> — <WikiLink slug="fleet-builder">the simulated machines</WikiLink>: per-node
            hardware, the two networks, and the fleet mode.
          </LI>
          <LI>
            <Term>Zones &amp; topology</Term> — the declared zones, and the{' '}
            <WikiLink slug="fleet-topology">live fleet drawn as a graph</WikiLink>.
          </LI>
          <LI>
            <Term>Advanced</Term> — the <WikiLink slug="config-advanced">behavioural forks</WikiLink>, zone crypto, and
            the derived ports.
          </LI>
        </UL>
        <H>Saving is not applying</H>
        <P>
          A save writes your <Term>stack.local.nix</Term> overlay. Nothing the running stack reads changes until an{' '}
          <WikiLink slug="apply">apply</WikiLink> runs. The panel at the top of every Configuration page lists what is
          written and not yet applied, and offers the one action that clears each row.
        </P>
        <P>
          Configure here first, then bring the stack up and head to <WikiLink slug="testing">Testing</WikiLink>.
        </P>
      </>
    ),
  },
  {
    slug: 'config-advanced',
    title: 'Advanced (config page)',
    brief: 'The behavioural forks, the zone crypto, the inert counts, and the paths no editor owns yet.',
    category: 'Navigation',
    related: ['config', 'apply', 'stack-slot', 'audit'],
    body: (
      <>
        <P>
          <Term>Configuration → Advanced</Term> holds the knobs that change how the stack is built. Most of them need a
          redeploy. The page says so at the top, and every read-only field states why it is read-only.
        </P>
        <H>The sections</H>
        <UL>
          <LI>
            <Term>FORKS</Term> — the behavioural forks: the fleet node count, the spoke watch mode, the Redis ACL, and
            the VRRP simulation.
          </LI>
          <LI>
            <Term>ZONE CRYPTO</Term> — the enrolment keys.
          </LI>
          <LI>
            <Term>CHECKOUT</Term> — where the hub and spoke checkouts live.
          </LI>
          <LI>
            <Term>INERT</Term> — counts nothing reads. Applying one changes nothing.
          </LI>
          <LI>
            <Term>NOT YET EDITABLE</Term> — the residue: every catalogued path no rule claims. The page lists it instead
            of hiding it, so the gap stays measurable.
          </LI>
        </UL>
        <H>Why a field is read-only</H>
        <UL>
          <LI>It is a secret. The page shows that it is set, and its digest. The value never reaches the page.</LI>
          <LI>An environment pin outranks the overlay. The field is locked and names the variable to unset.</LI>
          <LI>
            No writer owns the path. Set it in <Code>devenv.local.nix</Code>.
          </LI>
        </UL>
        <P>
          A refused save lists each path under <Term>Not written</Term>, with its reason. Then{' '}
          <WikiLink slug="apply">apply</WikiLink>.
        </P>
      </>
    ),
  },
  {
    slug: 'fleet-topology',
    title: 'Fleet topology (the graph)',
    brief: 'The live fleet drawn on Zones & topology \u2014 one lane per zone, its bridges, and its nodes.',
    category: 'Navigation',
    related: ['fleet', 'fleet-builder', 'config', 'apply', 'vm', 'spoke'],
    body: (
      <>
        <P>
          The graph sits on <Term>Configuration → Zones &amp; topology</Term>, above the zone cards. It draws the fleet
          the config declares, with the live state read on top.
        </P>
        <H>How to read it</H>
        <UL>
          <LI>The header says how many bridge ordinals the fleet uses, of the total available.</LI>
          <LI>One lane per zone, with its index. Lane color is zone health, not shape.</LI>
          <LI>
            A dot per bridge, with its process name and its HTTP and gRPC ports. A star marks the leader. Green is
            online, red is offline, and amber means the presence could not be read.
          </LI>
          <LI>
            A tile per <WikiLink slug="vm">node</WikiLink>, with its vCPUs, memory, disk and arch. Its dot is power:
            green is on, grey is off, amber is no answer.
          </LI>
        </UL>
        <H>The lanes below the graph</H>
        <P>Three rows name what a flat grid folded into a count:</P>
        <UL>
          <LI>
            <Term>unassigned</Term> — the node names a zone nothing declares. A rename leaves this behind.
          </LI>
          <LI>
            <Term>not in config</Term> — the machine runs, and a rebuild would adopt it.
          </LI>
          <LI>
            <Term>hub only</Term> — the hub holds a zone row the fleet does not declare. The <Term>Reconcile</Term>{' '}
            section further down the page lists the same rows with a reason.
          </LI>
        </UL>
        <P>
          Click a zone to reach its card. Click a node to open its hardware on{' '}
          <WikiLink slug="fleet-builder">Fleet nodes</WikiLink>.
        </P>
        <Note>
          A read that failed prints <Term>this graph is incomplete</Term> with the reason. An incomplete graph is never
          drawn as a complete one.
        </Note>
        <P>
          Stack already up? <OpsCta>Take the operations walkthrough → </OpsCta>
          It reads the graph, then the queues, the hub tabs, storage and the audit log.
        </P>
      </>
    ),
  },
  {
    slug: 'results',
    title: 'Results (page)',
    brief:
      'The Results page — review finished runs (pass/fail, timings, logs, artifacts) to diagnose failures after the fact.',
    category: 'Navigation',
    related: ['run', 'scenario'],
    body: (
      <>
        <P>
          The <Term>Results</Term> page is where you review finished <WikiLink slug="run">runs</WikiLink> after they
          complete. It's your post-mortem view: pass/fail outcomes, timings, and the logs and artifacts captured during
          each run, so you can diagnose failures once they've happened.
        </P>
        <H>What the page shows</H>
        <UL>
          <LI>
            A filterable run history — by <WikiLink slug="scenario">scenario</WikiLink>, target nodes, status, duration
            and timestamp.
          </LI>
          <LI>A step tree per run, with per-step timings.</LI>
          <LI>The captured artifacts inline: serial console output, timelines, and hub and spoke logs.</LI>
          <LI>Status badges you can scan at a glance, and a link from a failed step straight to its logs.</LI>
        </UL>
        <P>
          Together these turn a red "failed" into an answer about <em>why</em> it failed.
        </P>
      </>
    ),
  },
  {
    slug: 'overview',
    title: 'Overview (page)',
    brief: 'The landing page — the control-plane pipeline, init progress, other stacks, the fleet, and recent runs.',
    category: 'Navigation',
    related: ['environment', 'stack-slot', 'multi-stack', 'run', 'fleet'],
    body: (
      <>
        <P>
          <Term>Overview</Term> is where the cockpit opens. It answers one question without any clicking: is the stack
          up, and what happened last?
        </P>
        <H>What the page shows</H>
        <UL>
          <LI>
            <Term>Control-plane pipeline</Term> — each bring-up stage with its state, so you can see how far the stack
            got.
          </LI>
          <LI>
            <Term>Init progress</Term> — the init-task strip, while the stack is still starting.
          </LI>
          <LI>
            <Term>Stacks</Term> — the other stacks registered on this host, with their{' '}
            <WikiLink slug="stack-slot">slots</WikiLink> and links.
          </LI>
          <LI>
            <Term>Fleet</Term> — the power state of each simulated <WikiLink slug="vm">machine</WikiLink>.
          </LI>
          <LI>
            <Term>Recent activity</Term> — the last operations, each one linking to the page that owns it.
          </LI>
        </UL>
        <Note>
          The <Term>Stacks</Term> panel hides itself when the host has only one stack registered. On a single-stack
          machine you never see it, which is why <WikiLink slug="multi-stack">running more than one stack</WikiLink> is
          documented rather than discovered.
        </Note>
        <P>
          The connection banner is not part of this page. It rides the app shell on every route, and appears when the
          control center restarts underneath you.
        </P>
        <P>
          Stack already up? <OpsCta>Take the operations walkthrough → </OpsCta>
          It visits the queues, the hub tabs, storage and the audit log.
        </P>
      </>
    ),
  },
  {
    slug: 'hub-page',
    title: 'Hub (page)',
    brief: 'The read-only hub inspector — lifecycle jobs and their timeline, webhook deliveries, and device tokens.',
    category: 'Navigation',
    related: ['hub', 'saga', 'queues', 'environment'],
    body: (
      <>
        <P>
          The <Term>Hub</Term> page reads the <WikiLink slug="hub">hub</WikiLink>'s own state directly. Everything on it
          is <Term>read-only</Term>: nothing here changes the hub.
        </P>
        <H>The three tabs</H>
        <UL>
          <LI>
            <Term>Lifecycle jobs</Term> — every <WikiLink slug="saga">saga</WikiLink> the hub is running or has run.
            Select one to see its timeline and its payload.
          </LI>
          <LI>
            <Term>Webhooks</Term> — outbound delivery attempts, filterable by status.
          </LI>
          <LI>
            <Term>Device tokens</Term> — the tokens minted per machine, and the events recorded against each one.
          </LI>
        </UL>
        <Note>
          The selected tab and every filter live in the <Term>URL</Term>. A device filter therefore survives a reload,
          and you can hand someone the link to exactly what you are looking at.
        </Note>
        <P>
          This page reads the hub's view of the work. To see the same work as raw queue state, open{' '}
          <WikiLink slug="queues">Queues</WikiLink>.
        </P>
      </>
    ),
  },
  {
    slug: 'storage',
    title: 'Storage (page)',
    brief: 'The artifacts the spoke serves to booting machines, with the actions that verify and repair them.',
    category: 'Navigation',
    related: ['spoke', 'bring-up', 'environment', 'fleet', 'layers'],
    body: (
      <>
        <P>
          <Term>Storage</Term> lists what the <WikiLink slug="spoke">spoke</WikiLink> serves to a booting machine. Each
          category shows where it lives on disk and how much space it takes. Where a checksum is known, the page shows
          the file's <Code>sha256</Code> too.
        </P>
        <H>The categories</H>
        <UL>
          <LI>
            <Term>Discovery image</Term> — the kernel and initrd a blank machine PXE-boots into.
          </LI>
          <LI>
            <Term>Built initrds</Term> and <Term>sim boot artifacts</Term> — what the stack builds locally.
          </LI>
          <LI>
            <Term>Disk overlays</Term> — the per-machine disks. These are wiped through a Fleet nuke, not from here.
          </LI>
          <LI>
            <Term>OS-layer cache</Term> — the nginx cache that fronts the layer downloads. The{' '}
            <WikiLink slug="layers">Layers</WikiLink> page is what fills and empties it.
          </LI>
        </UL>
        <H>The actions</H>
        <UL>
          <LI>
            <Term>Verify</Term> — re-check what is on disk against what is expected. Read-only.
          </LI>
          <LI>
            <Term>Resync</Term> — fetch whatever is missing or stale.
          </LI>
          <LI>
            <Term>Wipe</Term> — delete a category. Destructive, and it prompts first.
          </LI>
        </UL>
        <Note>
          If nodes loop on <Code>vmlinuz … Not found</Code>, this is the page to check first. It usually means the
          discovery image was never fetched.
        </Note>
      </>
    ),
  },
  {
    slug: 'layers',
    title: 'Layers (page)',
    brief: 'The OS-layer release manifest \u2014 its dependency graph, and the cache each build is pulled into.',
    category: 'Navigation',
    related: ['storage', 'environment', 'hub', 'spoke', 'bring-up'],
    body: (
      <>
        <P>
          <Term>Layers</Term> reads an OS-layer release manifest and draws it. Give it a manifest URL or a release index
          and press <Term>Load</Term>. An index resolves to the versioned manifest. The control center fetches the
          document server-side, because the asset host needs a user agent a browser will not send.
        </P>
        <Note>
          <Term>Load</Term> does two things. It draws the manifest, and it seeds the <WikiLink slug="hub">hub</WikiLink>{' '}
          database from the same document. The seed console opens under the input.
        </Note>
        <H>What the page shows</H>
        <UL>
          <LI>The release header — version, environment, schema version, and the artifact, group and size counts.</LI>
          <LI>
            <Term>arch</Term> and <Term>distro</Term> filters. Every count below them follows the filters.
          </LI>
          <LI>
            One section per layer group. <Code>one</Code> or <Code>multi</Code> says how many layers of that group a
            deploy can select.
          </LI>
          <LI>
            Per layer: kind, version, arch, distro and size. Open one to read what it <Term>requires</Term> and what is{' '}
            <Term>required by</Term> it. Click a dependency to jump to it.
          </LI>
        </UL>
        <H>The cache</H>
        <P>
          Each layer lists its builds. A build the cache does not hold has a <Term>pull</Term> button, which primes the
          nginx layer cache and streams the transfer. A cached build has a <Term>nuke</Term> button, which deletes it. A
          primed layer is what lets a repeat provision skip the CDN.
        </P>
        <Note>
          This is the same cache the <WikiLink slug="storage">Storage</WikiLink> page reports as{' '}
          <Term>OS-layer cache</Term>. Layer blobs are multi-gigabyte, so a pull streams through <Code>curl</Code>. The
          control center never buffers one.
        </Note>
      </>
    ),
  },
  {
    slug: 'audit',
    title: 'Audit log (page)',
    brief: 'Every mutation the cockpit performed and every one it refused, with its origin and parameters.',
    category: 'Navigation',
    related: ['config', 'queues', 'storage', 'mcp'],
    body: (
      <>
        <P>
          The <Term>Audit log</Term> records what the control center did, not what the hub did. Every mutation and every
          console attach lands here, with the caller's origin and the parameters it used. The page itself is read-only.
        </P>
        <H>Why it matters</H>
        <UL>
          <LI>
            It is the record of what an agent did through the <WikiLink slug="mcp">MCP server</WikiLink>, which
            otherwise leaves no trace in your terminal.
          </LI>
          <LI>It records refusals as well as successes, so a blocked call is visible rather than silent.</LI>
        </UL>
        <Note>
          Denied rows keep their <Term>own</Term> retention cap, separate from the successful history. A burst of
          refusals therefore cannot push the record of real work out of the log.
        </Note>
      </>
    ),
  },
  {
    slug: 'api-docs',
    title: 'API docs (page)',
    brief: 'The control center\u2019s own OpenAPI \u2014 a ReDoc tab to read it, a Swagger tab to try a call.',
    category: 'Navigation',
    related: ['reference', 'mcp', 'audit', 'stack-slot'],
    body: (
      <>
        <P>
          The page embeds the control-center API's own OpenAPI document. Two tabs: <Term>ReDoc</Term> to read it, and{' '}
          <Term>Swagger</Term> to send a real request against this stack. Both follow the skin you picked.
        </P>
        <P>
          It is the same API the cockpit uses. Every page you have seen is one of these routes, and the{' '}
          <WikiLink slug="mcp">MCP server</WikiLink> is a second client of them.
        </P>
        <Note>
          The page is an iframe, so it cannot send the API token as a header. On these two routes the token rides the
          query string instead.
        </Note>
        <P>
          The raw document is at <Code>/api/swagger-json</Code> on the control-center port. That port comes from your{' '}
          <WikiLink slug="stack-slot">slot</WikiLink>.
        </P>
      </>
    ),
  },
  {
    slug: 'reference',
    title: 'Reference (nav group)',
    brief: 'The last nav group \u2014 the API docs, the audit log, the self-hosting guide, and this wiki.',
    category: 'Navigation',
    related: ['api-docs', 'audit', 'environment', 'testing', 'config', 'bring-up', 'running-the-stack'],
    body: (
      <>
        <P>
          <Term>Reference</Term> is the last group in the navigation rail. It holds what you read, not what you drive.{' '}
          <Term>Apps</Term> renders above it.
        </P>
        <UL>
          <LI>
            <WikiLink slug="api-docs">API docs</WikiLink> — the control center's own OpenAPI.
          </LI>
          <LI>
            <WikiLink slug="audit">Audit log</WikiLink> — every mutation the cockpit made, and every one it refused.
          </LI>
          <LI>
            <Term>Getting started</Term> — a link out to the self-hosting guide in the hub docs. It covers a Docker
            Compose bring-up of a hub and a bridge, TLS, zones, registration tokens, per-zone Redis ACLs, and the
            hardening checklist.
          </LI>
          <LI>
            <WikiLink slug="bring-up">Bring up the stack</WikiLink> and{' '}
            <WikiLink slug="running-the-stack">Running the control center</WikiLink> — two wiki entries pinned here,
            because they are the two you need first.
          </LI>
          <LI>
            <Term>Browse all</Term> — this wiki.
          </LI>
        </UL>
        <Note>
          Three things here are easy to confuse. <Term>Getting started</Term> is the doc you read to deploy for keeps.
          The <Term>Tour</Term> orients you in this cockpit. <Term>Guided Deploy</Term> drives the real controls with
          you.
        </Note>
      </>
    ),
  },
];
