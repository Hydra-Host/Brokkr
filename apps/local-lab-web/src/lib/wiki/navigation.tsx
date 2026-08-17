import { WikiLink } from '@/components/wiki-link';

import { Code, H, LI, Note, OL, OpsCta, P, Term, UL } from './prose';
import type { WikiEntry } from './types';

export const NAVIGATION_ENTRIES: WikiEntry[] = [
  {
    slug: 'environment',
    title: 'Environment (nav group)',
    brief: 'The Environment group in the nav rail — the pages that manage the local stack\u2019s services and data.',
    category: 'Navigation',
    related: ['local-environment', 'services', 'datastore', 'overview', 'hub-page', 'storage'],
    body: (
      <>
        <P>
          <Term>Environment</Term> is a grouping in the navigation rail. It collects the pages you use to manage the
          local stack's <WikiLink slug="services">services</WikiLink> and <Term>data</Term>. It holds six pages:
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
    title: 'Testing (nav area)',
    brief: 'The Testing nav area — pick a scenario, launch a run, and review the results.',
    category: 'Navigation',
    related: ['scenario', 'run', 'results', 'custom-sequence', 'plan'],
    body: (
      <>
        <P>
          The <Term>Testing</Term> area is where you exercise the environment. From here you:
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
          It's the day-to-day loop for verifying that the <WikiLink slug="hub">hub</WikiLink> and{' '}
          <WikiLink slug="spoke">spoke</WikiLink> behave the way you expect.
        </P>
      </>
    ),
  },
  {
    slug: 'config',
    title: 'Config (nav area)',
    brief: 'The Config nav area — where you shape the environment before running it, such as the Fleet Builder.',
    category: 'Navigation',
    related: ['fleet-builder', 'audit', 'stack-slot'],
    body: (
      <>
        <P>
          The <Term>Config</Term> area is where you shape the environment <em>before</em> you run anything against it.
          The main tool here is the <WikiLink slug="fleet-builder">Fleet Builder</WikiLink>, which lets you compose the
          shape of your <WikiLink slug="fleet">fleet</WikiLink> (how many <WikiLink slug="hub">hubs</WikiLink> and{' '}
          <WikiLink slug="spoke">spokes</WikiLink>, how they're wired) and save it as a reusable configuration.
        </P>
        <H>What sits here</H>
        <UL>
          <LI>
            <Term>Stack</Term> — the environment settings: hub and spoke knobs, the Fleet Builder, image layers, and
            this checkout's <WikiLink slug="stack-slot">slot</WikiLink>.
          </LI>
          <LI>
            <Term>API docs</Term> — the control-center API's own reference, served by the running stack.
          </LI>
          <LI>
            <WikiLink slug="audit">Audit log</WikiLink> — every mutation the cockpit made, and every one it refused.
          </LI>
        </UL>
        <P>
          Configure here first, then bring the stack up and head to <WikiLink slug="testing">Testing</WikiLink>.
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
    related: ['spoke', 'bring-up', 'environment', 'fleet'],
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
            <Term>OS-layer cache</Term> — the nginx cache that fronts the layer downloads.
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
];
