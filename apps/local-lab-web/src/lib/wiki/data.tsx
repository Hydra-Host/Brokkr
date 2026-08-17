import { WikiLink } from '@/components/wiki-link';

import { Code, H, LI, Note, OL, P, Term, UL } from './prose';
import type { WikiEntry } from './types';

export const DATA_ENTRIES: WikiEntry[] = [
  {
    slug: 'datastore',
    title: 'Datastore',
    brief: 'The Datastore page and concept — the backing stores and queues you can inspect from one place.',
    category: 'Data',
    related: ['postgres', 'redis', 'queues', 'seed-data'],
    body: (
      <>
        <P>
          <Term>Datastore</Term> refers both to the backing stores the stack depends on and to the{' '}
          <Term>Datastore</Term> page that lets you inspect them. The stores are:
        </P>
        <UL>
          <LI>
            <WikiLink slug="postgres">Postgres</WikiLink> — relational, structured state.
          </LI>
          <LI>
            <WikiLink slug="redis">Redis</WikiLink> — in-memory cache, queues, and ephemeral state.
          </LI>
          <LI>
            <Term>Thanos</Term> — the metrics the stack emits, queryable with PromQL.
          </LI>
          <LI>
            <WikiLink slug="queues">Queues</WikiLink> — the BullMQ work the hub and spoke pass between them.
          </LI>
        </UL>
        <P>
          From the page you can check each store's health, browse what's inside it, and (for Postgres) look at tables
          and run queries. It's the place to go when you want to see what state the <WikiLink slug="hub">hub</WikiLink>{' '}
          and <WikiLink slug="spoke">spoke</WikiLink> have actually written.
        </P>
        <P>
          Before they hold anything useful you usually need to <Term>seed</Term> them — see{' '}
          <WikiLink slug="seed-data">seed-data</WikiLink>.
        </P>
      </>
    ),
  },
  {
    slug: 'postgres',
    title: 'Postgres',
    brief: 'The relational SQL database holding the hub and spoke\u2019s structured state.',
    category: 'Data',
    related: ['datastore', 'redis', 'seed-data'],
    body: (
      <>
        <P>
          <Term>Postgres</Term> is the relational SQL database that holds the <WikiLink slug="hub">hub</WikiLink> and{' '}
          <WikiLink slug="spoke">spoke's</WikiLink> structured, long-lived state. If something needs to persist with
          clear relationships — organizations, identities, inventory, fleet and machine records, lifecycle history — it
          generally lives here.
        </P>
        <P>
          From the <WikiLink slug="datastore">Datastore</WikiLink> page you can inspect the tables and run queries
          against Postgres to see exactly what the stack has recorded. That makes it the first place to look when you're
          verifying that an operation actually wrote what you expected.
        </P>
        <P>
          A fresh database starts empty; baseline rows are added by <WikiLink slug="seed-data">seeding</WikiLink>.
        </P>
      </>
    ),
  },
  {
    slug: 'redis',
    title: 'Redis',
    brief: 'The in-memory key/value store used for caching, queues/jobs, and ephemeral state.',
    category: 'Data',
    related: ['datastore', 'postgres'],
    body: (
      <>
        <P>
          <Term>Redis</Term> is an in-memory key/value store. It's fast and meant for data that is short-lived or can be
          regenerated, as opposed to <WikiLink slug="postgres">Postgres</WikiLink> which holds the durable state.
        </P>
        <H>Typical uses</H>
        <UL>
          <LI>
            <Term>Caching</Term> — keeping hot data close at hand to avoid repeated work.
          </LI>
          <LI>
            <Term>Queues / jobs</Term> — coordinating background work between processes.
          </LI>
          <LI>
            <Term>Ephemeral state</Term> — locks, sessions, and other transient bookkeeping.
          </LI>
        </UL>
        <P>Because it's in-memory, treat its contents as disposable — clearing Redis shouldn't lose durable state.</P>
      </>
    ),
  },
  {
    slug: 'seed-data',
    title: 'Seed data',
    brief: 'Pre-populating the datastores with the baseline rows the hub, spoke, and tests expect.',
    category: 'Data',
    related: ['datastore', 'postgres', 'bring-up', 'local-environment'],
    body: (
      <>
        <P>
          <Term>Seeding</Term> means pre-populating the <WikiLink slug="datastore">datastores</WikiLink> with the
          baseline rows the <WikiLink slug="hub">hub</WikiLink>, <WikiLink slug="spoke">spoke</WikiLink>, and tests
          expect to already exist — typically an organization, the identities/users it owns, and assorted fixtures.
          Without seed data the stack comes up technically running but empty, and scenarios that assume those records
          will fail.
        </P>
        <H>How to seed</H>
        <OL>
          <LI>
            Go to the <Term>Stack</Term> page.
          </LI>
          <LI>
            Do a <WikiLink slug="bring-up">bring-up</WikiLink> so the datastores are running.
          </LI>
          <LI>
            Run the <Term>Seed data</Term> operation; it streams its output to the log pane.
          </LI>
        </OL>
        <P>
          Seeding writes the baseline org, identities, and fixtures into the stores (mostly{' '}
          <WikiLink slug="postgres">Postgres</WikiLink>). Re-seed whenever you've reset the datastores or want a
          known-clean baseline.
        </P>
        <Note>
          Changing an identity or org isn't a simple re-seed: those values are baked in at creation time, so an
          identity/org change generally needs a <Term>fresh datastore</Term> (tear down, recreate, then seed again).
        </Note>
      </>
    ),
  },
  {
    slug: 'queues',
    title: 'Queues (Datastore tab)',
    brief: 'The BullMQ inspector — queue health, job state, and the redacted payload behind each job.',
    category: 'Data',
    related: ['saga', 'redis', 'datastore', 'hub-page'],
    body: (
      <>
        <P>
          The <Term>Queues</Term> tab reads the BullMQ state in <WikiLink slug="redis">Redis</WikiLink> directly. It
          shows the same work the <WikiLink slug="hub-page">Hub page</WikiLink> shows, one level lower — raw jobs rather
          than the hub's interpretation of them.
        </P>
        <H>What it shows</H>
        <UL>
          <LI>
            <Term>Queue health</Term> — how many jobs sit in each state: waiting, active, delayed, failed, completed,
            and the rest.
          </LI>
          <LI>
            <Term>The queues themselves</Term> — the per-zone <WikiLink slug="saga">saga</WikiLink> queues, the global{' '}
            <Code>results:inbox</Code>, and the hub's own <Code>bull:*</Code> queues, each labelled by kind.
          </LI>
          <LI>
            <Term>Per job</Term> — its id, its state, and its payload.
          </LI>
        </UL>
        <Note>
          Two guards apply to what you see here. Payloads are <Term>redacted and capped in bytes</Term> before they
          leave the API, so a job that carries a credential cannot print it into your browser. The mutating actions —
          retry, drain, clean, remove — are <Term>loopback-only</Term>, so a cockpit reached over the LAN can read the
          queues but cannot change them.
        </Note>
        <P>
          A saga job id encodes its own device, saga name and plan positionally, which is how the list can label a job
          without opening its payload. See <WikiLink slug="saga">saga</WikiLink>.
        </P>
      </>
    ),
  },
];
