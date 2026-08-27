import { WikiLink } from '@/components/wiki-link';

import { Code, H, LI, Note, P, Term, UL } from './prose';
import type { WikiEntry } from './types';

export const CONCEPT_ENTRIES: WikiEntry[] = [
  {
    slug: 'local-environment',
    title: 'The local environment',
    brief:
      'The whole brokkr·sim simulation running on your machine — every service, datastore, and the simulated fleet together.',
    category: 'Concepts',
    related: ['environment', 'services', 'fleet', 'bring-up', 'running-the-stack'],
    body: (
      <>
        <P>
          The <Term>local environment</Term> is the entire brokkr·sim simulation as it runs on your own machine: the
          control-plane <WikiLink slug="services">services</WikiLink> (<WikiLink slug="hub">hub</WikiLink>,{' '}
          <WikiLink slug="spoke">spoke</WikiLink>/bridge), the backing <WikiLink slug="datastore">datastores</WikiLink>{' '}
          (<WikiLink slug="postgres">Postgres</WikiLink> and <WikiLink slug="redis">Redis</WikiLink>), and the simulated{' '}
          <WikiLink slug="fleet">fleet</WikiLink> of <WikiLink slug="vm">VMs</WikiLink> — all wired together so you can
          exercise Hydra's bare-metal orchestration flow without any real hardware.
        </P>
        <P>
          Everything here is a stand-in for production. The hub and spoke are the real applications, but the "metal"
          they act on is faked: each server is a libvirt/qemu <Term>VM</Term> with a simulated IPMI/Redfish{' '}
          <WikiLink slug="bmc">BMC</WikiLink>. That lets you provision, power-cycle, and tear down machines safely on a
          laptop.
        </P>
        <Note>
          Don't confuse this with the <WikiLink slug="environment">"Environment"</WikiLink> group in the nav rail.
          "Environment" is just a UI grouping of pages; <Term>the local environment</Term> is the actual running
          simulation those pages manage.
        </Note>
        <P>
          You bring the local environment up from the Stack page — see <WikiLink slug="bring-up">bring-up</WikiLink>,
          and <WikiLink slug="running-the-stack">running the stack</WikiLink> for the full start-up walkthrough.
        </P>
      </>
    ),
  },
  {
    slug: 'fleet',
    title: 'Fleet',
    brief: 'The set of simulated machines your scenario runs against — the hub node(s) and spoke node(s).',
    category: 'Concepts',
    related: ['hub', 'spoke', 'vm', 'fleet-builder', 'fleet-topology'],
    body: (
      <>
        <P>
          A <Term>fleet</Term> is the collection of simulated machines a test{' '}
          <WikiLink slug="scenario">scenario</WikiLink> runs against. In brokkr·sim that means one or more{' '}
          <WikiLink slug="hub">hub</WikiLink> nodes (the control plane) and one or more{' '}
          <WikiLink slug="spoke">spoke</WikiLink> nodes (the bridges that act on the hardware), plus the simulated
          servers the spoke manages.
        </P>
        <P>
          Each machine is a <WikiLink slug="vm">VM</WikiLink> rather than physical metal, so a fleet is cheap to create,
          reshape, and throw away. The size and wiring of a fleet — how many nodes, which zone each is in, how they are
          addressed — is what you compose on the <WikiLink slug="fleet-builder">Fleet nodes</WikiLink> page, and what
          the <WikiLink slug="fleet-topology">fleet graph</WikiLink> draws back to you.
        </P>
        <P>Think of the fleet as the "test bench" your scenarios are executed on.</P>
      </>
    ),
  },
  {
    slug: 'hub',
    title: 'Hub',
    brief: 'The brokkr control plane — the central app and API operators use to orchestrate the spokes.',
    category: 'Concepts',
    related: ['spoke', 'fleet', 'services'],
    body: (
      <>
        <P>
          The <Term>hub</Term> is brokkr's control plane: the central application (API + web UIs) that operators
          interact with and that orchestrates the <WikiLink slug="spoke">spokes</WikiLink>. In the real product this is
          the flagship — it holds the desired state of the <WikiLink slug="fleet">fleet</WikiLink> and tells the spokes
          what to do.
        </P>
        <H>What the hub does</H>
        <UL>
          <LI>Exposes the operator-facing web UI and API.</LI>
          <LI>
            Stores fleet, inventory, and lifecycle state (mostly in <WikiLink slug="postgres">Postgres</WikiLink>).
          </LI>
          <LI>Hands work down to spokes and tracks their progress.</LI>
        </UL>
        <P>
          Locally the hub runs as a normal service in the stack; once it's up you can open its web UIs from the Stack
          page (see <WikiLink slug="web-ui">web UIs</WikiLink>).
        </P>
      </>
    ),
  },
  {
    slug: 'spoke',
    title: 'Spoke (bridge)',
    brief:
      'The bridge that sits next to the hardware and executes the hub\u2019s intent on bare metal — simulated locally.',
    category: 'Concepts',
    related: ['hub', 'fleet', 'vm'],
    body: (
      <>
        <P>
          The <Term>spoke</Term> (also called the bridge) is the component that lives next to the hardware and carries
          out the <WikiLink slug="hub">hub's</WikiLink> intent on bare metal: PXE-booting machines, deploying operating
          systems, driving out-of-band controllers over <WikiLink slug="bmc">IPMI/Redfish</WikiLink>, and managing the
          rest of a machine's lifecycle.
        </P>
        <P>
          In production a spoke talks to real servers. In brokkr·sim it talks to simulated ones instead — the BMCs and
          power controls are faked against libvirt/qemu <WikiLink slug="vm">VMs</WikiLink> — but the spoke software
          itself is real, so the orchestration paths you exercise are genuine.
        </P>
        <P>
          A <WikiLink slug="fleet">fleet</WikiLink> can have multiple spokes, each responsible for a slice of the
          simulated hardware.
        </P>
      </>
    ),
  },
  {
    slug: 'vm',
    title: 'VM (virtual machine)',
    brief:
      'Software that emulates a physical computer; here each simulated server is a libvirt/qemu VM with a fake BMC.',
    category: 'Concepts',
    related: ['fleet', 'hub', 'spoke', 'bmc'],
    body: (
      <>
        <P>
          A <Term>virtual machine (VM)</Term> is software that pretends to be a whole physical computer. It has its own
          virtual CPU, memory, disk, and network, and it runs a real operating system — but it's just a program running
          on a host machine, so you can create and destroy as many as you like.
        </P>
        <P>
          In brokkr·sim, every "server" in your <WikiLink slug="fleet">fleet</WikiLink> is a VM managed by{' '}
          <Term>libvirt/qemu</Term> (common open-source virtualization tools). On top of each VM we attach a{' '}
          <WikiLink slug="bmc">fake IPMI/Redfish BMC</WikiLink> — a simulated "baseboard management controller", the
          little always-on chip real servers use for remote power and console control. To the{' '}
          <WikiLink slug="spoke">spoke</WikiLink>, these VMs look and behave like real metal.
        </P>
        <Note>
          New to this? The short version: a VM is a "computer inside your computer". We use VMs so the whole simulation
          runs on one laptop instead of a rack of physical servers.
        </Note>
      </>
    ),
  },
  {
    slug: 'bmc',
    title: 'BMC (Baseboard Management Controller)',
    brief:
      'The always-on out-of-band controller on a server motherboard that powers, monitors, and remote-consoles the machine independently of its OS.',
    category: 'Concepts',
    related: ['vm', 'spoke', 'fleet'],
    body: (
      <>
        <P>
          A <Term>BMC (baseboard management controller)</Term> is the small, always-on management processor built into a
          server's motherboard. It runs independently of the machine's main CPU and operating system, so you can reach
          it even when the server is powered off or its OS has crashed.
        </P>
        <H>What a BMC lets you do</H>
        <UL>
          <LI>Power the machine on, off, or power-cycle it remotely.</LI>
          <LI>Read sensors and hardware/health status.</LI>
          <LI>Open a remote serial console to watch boot and interact with the machine.</LI>
        </UL>
        <P>
          Operators talk to a BMC over <Term>IPMI</Term> and/or <Term>Redfish</Term> — the standard out-of-band
          management protocols. This "out-of-band" path is exactly how a <WikiLink slug="spoke">spoke</WikiLink> drives
          bare metal: PXE-booting, power control, and lifecycle operations all flow through the BMC rather than the host
          OS.
        </P>
        <P>
          In brokkr·sim the BMC is simulated. Each <WikiLink slug="vm">VM</WikiLink> in the{' '}
          <WikiLink slug="fleet">fleet</WikiLink> gets a fake IPMI endpoint (via OpenIPMI's <Term>ipmi_sim</Term>) and a
          fake Redfish endpoint (via <Term>sushy</Term>), so the spoke can drive it exactly like real hardware — without
          any real servers involved.
        </P>
      </>
    ),
  },
  {
    slug: 'scenario',
    title: 'Scenario',
    brief:
      'A defined, repeatable test case the suite runs against the fleet, like provision then power-cycle then deprovision.',
    category: 'Concepts',
    related: ['run', 'results', 'testing', 'plan'],
    body: (
      <>
        <P>
          A <Term>scenario</Term> is a defined, repeatable test case the suite runs against your{' '}
          <WikiLink slug="fleet">fleet</WikiLink>. It describes a sequence of operations to perform and what the
          expected outcome is — for example:
          <Term> provision → power-cycle → reprovision → deprovision</Term>.
        </P>
        <P>
          Scenarios are how you check that the <WikiLink slug="hub">hub</WikiLink> and{' '}
          <WikiLink slug="spoke">spoke</WikiLink> behave correctly end to end. You pick one on the{' '}
          <WikiLink slug="testing">Testing</WikiLink> page and launch it; each execution is a{' '}
          <WikiLink slug="run">run</WikiLink>.
        </P>
        <P>Because they're repeatable, scenarios give you a consistent way to reproduce and verify behaviour.</P>
      </>
    ),
  },
  {
    slug: 'run',
    title: 'Run',
    brief: 'A single execution of a scenario, with a status, timing, and captured logs and artifacts.',
    category: 'Concepts',
    related: ['scenario', 'results'],
    body: (
      <>
        <P>
          A <Term>run</Term> is one execution of a <WikiLink slug="scenario">scenario</WikiLink>. Each run records:
        </P>
        <UL>
          <LI>
            a <Term>status</Term> (passed / failed / running / broken / skipped),
          </LI>
          <LI>timing (when it started and how long each step took),</LI>
          <LI>captured logs and artifacts (serial console output, timelines, hub/spoke logs).</LI>
        </UL>
        <P>
          You launch runs from the <WikiLink slug="testing">Testing</WikiLink> page and review finished ones on the{' '}
          <WikiLink slug="results">Results</WikiLink> page, where you can drill into the step tree and open the captured
          artifacts to diagnose what happened.
        </P>
      </>
    ),
  },
  {
    slug: 'plan',
    title: 'Plan',
    brief: 'An ordered list of steps the runner executes on one node, top to bottom — the shape a scenario takes.',
    category: 'Concepts',
    related: ['scenario', 'preset', 'custom-sequence', 'run'],
    body: (
      <>
        <P>
          A <Term>plan</Term> is an ordered list of <Term>steps</Term> the runner executes against one node, top to
          bottom. Each step is a named operation — <Code>provision</Code>, <Code>verify-os</Code>,{' '}
          <Code>power-cycle</Code>, <Code>end-rental</Code>, and so on — and some take parameters (an OS slug, a
          deployment name, cloud-init).
        </P>
        <P>
          A <WikiLink slug="scenario">scenario</WikiLink> is just a named, saved plan; each execution of one is a{' '}
          <WikiLink slug="run">run</WikiLink>.
        </P>
        <H>Cleanup steps</H>
        <P>
          A step marked <Term>always</Term> runs as cleanup even if an earlier step failed — typically a final{' '}
          <Code>end-rental</Code> so the node is returned to inventory whatever the outcome.
        </P>
      </>
    ),
  },
  {
    slug: 'preset',
    title: 'Preset & full suite',
    brief:
      'Ready-made plans you can run as-is or clone as a starting point, including the full suite that chains every scenario.',
    category: 'Concepts',
    related: ['plan', 'custom-sequence', 'scenario'],
    body: (
      <>
        <P>
          <Term>Presets</Term> are built-in <WikiLink slug="plan">plans</WikiLink> covering the common cases — quick
          lifecycle, base-OS checks, disk layout, rescue boot, custom iPXE. Run one directly, or load it into the{' '}
          <WikiLink slug="custom-sequence">Custom Sequence</WikiLink> builder as a starting point.
        </P>
        <P>
          The <Term>full suite</Term> is one large plan that chains every non-HA scenario on a single node, in a
          deliberate order (fresh provisions follow each end-rental), for one comprehensive — and long — run.
        </P>
        <Note>
          The high-availability scenarios (<Code>spoke-failover</Code>, <Code>spoke-resume</Code>) are not in the full
          suite: they need a two-spoke <WikiLink slug="fleet">fleet</WikiLink>, so they run as their own scenarios.
        </Note>
      </>
    ),
  },
  {
    slug: 'web-ui',
    title: 'Web UIs (hub & spoke)',
    brief:
      'The deep links on the Stack page to the running hub and spoke web apps and APIs, available once the stack is up.',
    category: 'Concepts',
    related: ['hub', 'spoke', 'bring-up'],
    body: (
      <>
        <P>
          The <Term>Web UIs</Term> panel on the Stack page is a set of deep links to the running{' '}
          <WikiLink slug="hub">hub</WikiLink> and <WikiLink slug="spoke">spoke</WikiLink> applications and APIs. The
          cockpit builds these links from the detected LAN IP of the host, so they work even when you're driving a
          headless box over the network.
        </P>
        <H>What you'll find</H>
        <UL>
          <LI>The hub's operator web UI and admin UI.</LI>
          <LI>Each hub instance's API and admin API.</LI>
          <LI>Each spoke's HTTP endpoint.</LI>
        </UL>
        <P>
          The links only work once the relevant service is up and ready, so do a{' '}
          <WikiLink slug="bring-up">bring-up</WikiLink> first. Until a service is ready its link is shown dimmed.
        </P>
      </>
    ),
  },
  {
    slug: 'stack-slot',
    title: 'Stack slot',
    brief:
      'The number (0–46) a checkout claims, which derives its whole port block, subnets, node names and state dirs.',
    category: 'Concepts',
    related: ['local-environment', 'multi-stack', 'running-the-stack', 'fleet'],
    body: (
      <>
        <P>
          A <Term>slot</Term> is the one number that separates one stack from another on the same machine. Each checkout
          claims a slot from the host registry the first time you run <Code>task up</Code>, and keeps it. Everything
          else about the stack is derived from it, so two checkouts never collide.
        </P>
        <H>What the slot derives</H>
        <UL>
          <LI>
            <Term>Port block</Term> — <Code>20000 + 500 × slot</Code>, carved into 20-port bands.
          </LI>
          <LI>
            <Term>Data-plane subnet</Term> — <Code>192.168.(200 + slot).0/24</Code>.
          </LI>
          <LI>
            <Term>Node names</Term> — slots 1 and up generate <Code>s&lt;slot&gt;-cpu-&lt;n&gt;</Code>.
          </LI>
          <LI>
            <Term>Host state directory</Term> — slots 1 and up get their own tree, so a reset never touches a sibling.
          </LI>
        </UL>
        <Note>
          <Term>Slot 0 is the legacy layout.</Term> It keeps the familiar ports — hub <Code>:3000</Code>, spoke{' '}
          <Code>:8000</Code>, control center <Code>:3002</Code> and <Code>:5175</Code> — and the literal four-node
          fleet, so a machine that only ever runs one stack sees no change.
        </Note>
        <P>
          Slots 1 and up come up with a <Term>single-node fleet</Term> by default, because a second stack is usually
          there to test one thing. To run several stacks at once, see{' '}
          <WikiLink slug="multi-stack">running more than one stack</WikiLink>.
        </P>
      </>
    ),
  },
  {
    slug: 'saga',
    title: 'Saga',
    brief: 'A hub-driven lifecycle job that the spoke executes step by step — what the Hub and Queues pages inspect.',
    category: 'Concepts',
    related: ['hub', 'spoke', 'queues', 'hub-page', 'run'],
    body: (
      <>
        <P>
          A <Term>saga</Term> is the <WikiLink slug="hub">hub</WikiLink>'s unit of work against one machine: provision
          it, deprovision it, collect its hardware, or change its power state. The hub enqueues the saga, the{' '}
          <WikiLink slug="spoke">spoke</WikiLink> executes it step by step, and each step reports back.
        </P>
        <H>How the work moves</H>
        <UL>
          <LI>
            The hub enqueues onto the <Code>lifecycle</Code> and <Code>collection</Code> queues. Those queues are
            prefixed with the <Term>zone UUID</Term>, so each zone has its own pair.
          </LI>
          <LI>
            Every zone writes its results back into one global <Code>results:inbox</Code> queue.
          </LI>
          <LI>
            The hub's own background queues sit under the <Code>bull</Code> prefix, separate from the saga queues.
          </LI>
        </UL>
        <P>
          A saga job id carries its own context <Term>positionally</Term>: the device id, the saga name, and the plan
          id. That is why the cockpit can label a raw queue job without reading its payload.
        </P>
        <P>
          The <WikiLink slug="hub-page">Hub page</WikiLink> lists lifecycle jobs and draws each one's timeline. The{' '}
          <WikiLink slug="queues">Queues tab</WikiLink> shows the same work as raw BullMQ state.
        </P>
      </>
    ),
  },
  {
    slug: 'apply',
    title: 'Apply (saving is not applying)',
    brief: 'A save writes your overlay; an apply is the run that makes the stack read it.',
    category: 'Concepts',
    related: ['config', 'fleet-builder', 'config-advanced', 'stack-slot', 'audit'],
    body: (
      <>
        <P>
          It is two steps, always. A <Term>save</Term> writes your <Code>stack.local.nix</Code> overlay. An{' '}
          <Term>apply</Term> is the run that makes the stack read it. Nothing the running stack reads changes on a save.
        </P>
        <H>The apply panel</H>
        <P>
          The panel sits at the top of every Configuration page, above that page's own bar. It holds one row per
          outstanding item: what is waiting, what it costs, and the one action that clears it. Expand a row to read the
          ordered steps that action performs, and why each step is there.
        </P>
        <H>What an apply costs</H>
        <UL>
          <LI>Nothing — the value is already applied on save, because the stack reads it live.</LI>
          <LI>Nothing — the path is inert. No process reads it.</LI>
          <LI>A hub reload, or a spoke reload.</LI>
          <LI>A redeploy, which rebuilds the process.</LI>
          <LI>A fleet apply, which reconciles the VMs.</LI>
          <LI>The zone seed, which also restarts the bridges.</LI>
          <LI>
            A full recreation. A reload cannot pick up a re-bind, and a new <WikiLink slug="stack-slot">slot</WikiLink>{' '}
            recreates everything on a new port band.
          </LI>
          <LI>A datastore reset, which wipes the hub database and Redis. No button performs this one.</LI>
        </UL>
        <Note>
          A row that no run performs shows no button, and says so. A disabled button would read as "try again later".
        </Note>
        <P>
          A dirty form blocks only its own domain. Editing a stack knob does not make a fleet apply unsafe, so that row
          alone asks you to save first.
        </P>
        <P>
          Every apply the cockpit runs lands in the <WikiLink slug="audit">audit log</WikiLink>, with its parameters.
        </P>
      </>
    ),
  },
];
