import { WikiLink } from '@/components/wiki-link';

import { Code, H, LI, Note, OL, P, Term, UL } from './prose';
import type { WikiEntry } from './types';

export const SERVICE_ENTRIES: WikiEntry[] = [
  {
    slug: 'services',
    title: 'Services',
    brief:
      'The processes that make up the local stack — hub api/admin/web, spoke/bridge, plus the Postgres and Redis datastores.',
    category: 'Services',
    related: ['hub', 'spoke', 'postgres', 'redis', 'bmc', 'bring-up'],
    body: (
      <>
        <P>
          <Term>Services</Term> are the individual processes that, together, make up the local stack. The Stack page
          supervises them: you can start, stop, restart, and tail the logs of each one.
        </P>
        <H>What services run</H>
        <UL>
          <LI>
            <WikiLink slug="hub">Hub</WikiLink> — the control-plane API, admin API, and operator web UIs.
          </LI>
          <LI>
            <WikiLink slug="spoke">Spoke / bridge</WikiLink> — executes the hub's intent against the simulated{' '}
            <WikiLink slug="fleet">fleet</WikiLink>, driving each machine's <WikiLink slug="bmc">BMC</WikiLink>.
          </LI>
          <LI>
            <WikiLink slug="postgres">Postgres</WikiLink> — the relational store for structured state.
          </LI>
          <LI>
            <WikiLink slug="redis">Redis</WikiLink> — in-memory cache, <WikiLink slug="queues">queues</WikiLink>, and
            ephemeral state.
          </LI>
        </UL>
        <Note>
          Local dev is <Term>hermetic</Term>: there is no secrets service to run. Every secret resolves from the{' '}
          <Code>local</Code> profile's own defaults, so the stack comes up with no external dependency and no login.
        </Note>
        <H>Adding a new service</H>
        <P>
          Conceptually, adding a service to the simulation follows a repeatable pattern. You teach the sim how to run
          the new process, give it what it needs to start cleanly, and make it visible in the cockpit:
        </P>
        <OL>
          <LI>
            Register the process with the sim's process supervision — a new devenv process in <Code>devenv.nix</Code>{' '}
            (or a <Code>devenv/modules/*.nix</Code> module) so process-compose can start, stop, and restart it like the
            others.
          </LI>
          <LI>
            Wire its <Term>environment</Term> (ports, connection strings, secrets) and define a<Term> readiness</Term>{' '}
            check so the stack knows when it's actually up versus merely launched.
          </LI>
          <LI>
            Surface it on the <Term>Stack</Term> page so it appears as a controllable service card with a logs tab, and
            add any web links it exposes to the Web UIs panel.
          </LI>
        </OL>
        <H>Where a service is actually declared</H>
        <P>
          Nothing about the stack is configured by hand. Each process is declared once, in Nix, and process-compose
          supervises whatever the declaration produces:
        </P>
        <UL>
          <LI>
            <Code>devenv/modules/hub.nix</Code>, <Code>spoke.nix</Code> and <Code>fleet.nix</Code> declare the processes
            themselves, with their environment and their readiness probe.
          </LI>
          <LI>
            <Code>devenv/modules/ports.nix</Code> is the single port map. Change a port there, never per app.
          </LI>
          <LI>
            <Code>devenv/modules/overrides.nix</Code> derives the per-<WikiLink slug="stack-slot">slot</WikiLink> values
            from that map, so a second stack needs no edits at all.
          </LI>
        </UL>
      </>
    ),
  },
];
