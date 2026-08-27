import { CommandCheck } from '@/components/command-check';
import { WikiLink } from '@/components/wiki-link';

import { Code, DeployCta, Expand, H, LI, Note, OL, OLA, OpsCta, P, Small, Term, UL } from './prose';
import type { WikiEntry } from './types';

export const HOW_TO_ENTRIES: WikiEntry[] = [
  {
    slug: 'fleet-builder',
    title: 'Fleet nodes (config page)',
    brief: 'The Fleet nodes page \u2014 compose the simulated machines, write the overlay, then apply it.',
    category: 'How-to',
    related: ['fleet', 'vm', 'hub', 'spoke', 'apply', 'fleet-topology', 'config'],
    body: (
      <>
        <P>
          <Term>Fleet nodes</Term>, at <Term>Configuration → Fleet nodes</Term>, composes the{' '}
          <WikiLink slug="fleet">fleet</WikiLink>: which <WikiLink slug="vm">machines</WikiLink> exist, which zone each
          one is in, what hardware it has, and how the two networks are addressed.
        </P>
        <Note>
          This page does not save a named fleet you pick later. It writes one file — your <Code>stack.local.nix</Code>{' '}
          overlay, which is gitignored and leaves the committed defaults alone. That overlay is the fleet. A save is not
          an <WikiLink slug="apply">apply</WikiLink>.
        </Note>
        <H>What the page holds</H>
        <UL>
          <LI>
            <Term>Mode</Term> — VM or bare metal. Bare metal needs a Linux host.
          </LI>
          <LI>
            <Term>Network</Term> — the node CIDR, the BMC CIDR, the domain, DHCP, and rendered netplan. The engine
            refuses rendered netplan on a multi-zone fleet, so the control is disabled with that reason rather than
            failing late.
          </LI>
          <LI>
            <Term>Fleet defaults</Term> — vCPUs, memory, OS disk size and arch.
          </LI>
          <LI>
            <Term>Nodes</Term> — one card per machine, grouped by zone. A node in a zone nothing declares is marked, and
            says to move the node or declare the zone on the zones page.
          </LI>
          <LI>
            <Term>Removed</Term> — tombstones. Tick one to prune it on the next save.
          </LI>
        </UL>
        <H>Own value, or inherited</H>
        <P>
          Each size field shows what the node actually gets. <Code>inherited</Code> means it follows the fleet default.
          Type a value and the node owns it. Press <Code>inherit</Code> to give it back. A new node inherits everything.
        </P>
        <H>What the change costs</H>
        <P>
          <Term>Cost of this change</Term> classifies your draft with the engine planner and changes nothing. Each node
          card then says what applying does to that node, how long it takes, and whether it wipes that disk.{' '}
          <Term>Rebuild fleet</Term> is destructive: it nukes, re-seeds, and rebuilds every machine.
        </P>
        <H>Then apply</H>
        <P>
          Drift this page cannot clear itself is deferred to the shared panel above it — see{' '}
          <WikiLink slug="apply">apply</WikiLink>. To see the same fleet as a picture, open the{' '}
          <WikiLink slug="fleet-topology">fleet graph</WikiLink>. Then run{' '}
          <WikiLink slug="scenario">scenarios</WikiLink> from <WikiLink slug="testing">Testing</WikiLink>.
        </P>
      </>
    ),
  },
  {
    slug: 'custom-sequence',
    title: 'Custom Sequence (build a plan)',
    brief:
      'The builder where you assemble your own plan — clone a preset, then add, reorder, and configure steps before running.',
    category: 'How-to',
    related: ['plan', 'preset', 'scenario', 'testing'],
    body: (
      <>
        <P>
          <Term>Custom Sequence</Term> (the button on the <WikiLink slug="testing">Testing</WikiLink> page) is where you
          assemble your own <WikiLink slug="plan">plan</WikiLink> instead of running a fixed{' '}
          <WikiLink slug="scenario">scenario</WikiLink>.
        </P>
        <H>Assembling a plan</H>
        <OL>
          <LI>
            Optionally start from a <WikiLink slug="preset">preset</WikiLink> or the full suite to pre-fill the steps.
          </LI>
          <LI>Add steps from the picker, and drag (or use the arrows) to reorder them.</LI>
          <LI>
            Set each step's parameters, and tick <Term>always</Term> on any cleanup step that must run even after a
            failure.
          </LI>
          <LI>Pick the target node, then run — the plan executes on that one node, in order.</LI>
        </OL>
        <P>
          The runner validates the assembled plan before it starts, so an invalid step or parameter fails the{' '}
          <WikiLink slug="run">run</WikiLink> loudly rather than misbehaving silently.
        </P>
      </>
    ),
  },
  {
    slug: 'bring-up',
    title: 'Bring up the stack',
    brief: 'What task up already did, and what each Stack-page control is for once the stack is running.',
    category: 'How-to',
    related: ['services', 'seed-data', 'local-environment', 'running-the-stack', 'apply', 'fleet'],
    body: (
      <>
        <Note>
          <Code>task up</Code> already brought the stack up. It started the{' '}
          <WikiLink slug="datastore">datastores</WikiLink>, the <WikiLink slug="hub">hub</WikiLink>, the{' '}
          <WikiLink slug="spoke">spoke</WikiLink>, the <WikiLink slug="seed-data">seed</WikiLink> and the{' '}
          <WikiLink slug="fleet">fleet</WikiLink> — and this control center is one of those processes, so it cannot be
          on screen unless the rest is running. Nothing on the Stack page is a first-run step.
        </Note>
        <P>
          The <Term>Bring up</Term> group holds the constructive operations. You reach for them to recover a process
          that stopped, or to re-run one piece against a stack that is already live.
        </P>
        <H>What each control is for</H>
        <UL>
          <LI>
            <Term>Stack up</Term> — the whole <WikiLink slug="datastore">datastores</WikiLink> →{' '}
            <WikiLink slug="hub">hub</WikiLink>/<WikiLink slug="spoke">spoke</WikiLink> →{' '}
            <WikiLink slug="seed-data">seed</WikiLink> sequence in one action. On a running stack it reconciles, and the
            button says <Term>already up — use Stack restart</Term>.
          </LI>
          <LI>
            <Term>Reconcile / self-heal</Term> — restart every process that stopped or gave up, in dependency order,
            leaving disabled and already-running ones alone. Idempotent, so it is safe anytime.
          </LI>
          <LI>
            <Term>Datastores up</Term> — the datastore processes only. No hub, no spoke.
          </LI>
          <LI>
            <Term>Seed DB</Term> — re-run the sim fixtures (devices, OS catalog, SSH keys) against the running hub.
          </LI>
          <LI>
            <Term>Seed zones</Term> — make a saved zone set live: seed the rows, provision each zone's Redis ACL user,
            mint its registration token, then restart the bridges so they dial the new credentials.
          </LI>
          <LI>
            <Term>DB migrate deploy</Term> — apply pending migrations. Forward-only, and a no-op when current.
          </LI>
        </UL>
        <P>
          Every operation streams its output to the log pane, so a failure explains itself there. A configuration change
          is a separate matter: a save writes your overlay and needs an <WikiLink slug="apply">apply</WikiLink> before
          the stack reads it.
        </P>
        <P>
          With the stack live, the <WikiLink slug="web-ui">Web UIs</WikiLink> links light up and you can move on to{' '}
          <WikiLink slug="testing">Testing</WikiLink>.
        </P>
      </>
    ),
  },
  {
    slug: 'running-the-stack',
    title: 'Running the control center & stack',
    brief: 'How to start the control-center API + web and bring the local stack up so the cockpit\u2019s buttons work.',
    category: 'How-to',
    related: ['local-environment', 'bring-up', 'seed-data', 'hub', 'spoke', 'datastore', 'stack-slot', 'multi-stack'],
    body: (
      <>
        <Note>
          📍 You're reading this <em>inside</em> the running control center (the web UI on <Code>:5175</Code>), so the
          cockpit is already up. To start using it, go to <Term>Bring the stack up</Term> just below. The full
          from-scratch setup (for a new machine or a teammate) follows after — the repo's <Code>README.md</Code> and{' '}
          <Code>devenv/README.md</Code> are the authoritative walkthrough.
        </Note>

        <H>Bring the stack up</H>
        <P>In the cockpit, order matters — control plane before hardware:</P>
        <OLA>
          <LI>
            <Term>Stack → Stack up</Term> — starts the datastores, supervises the hub + spoke, and{' '}
            <WikiLink slug="seed-data">seeds</WikiLink> the hub DB (this is the{' '}
            <WikiLink slug="bring-up">bring-up</WikiLink>). One command does prep → start → seed; wait for ready.
          </LI>
          <LI>
            <Term>Fleet → Fleet up</Term> — starts the simulated <WikiLink slug="vm">VMs</WikiLink>. <b>Needs sudo</b>{' '}
            (socket_vmnet / per-node ipmi_sim + sushy / loopback aliases). If you brought the stack up with{' '}
            <Code>task up</Code> the passwordless drop-in is already installed; otherwise do the one-time sudo step
            below first — on macOS, Fleet up otherwise fails with <Code>socket_vmnet did not create sockets</Code>.
          </LI>
        </OLA>
        <P>
          Now drive a machine: open a node's <Term>console</Term> on the Fleet page — a fresh node is{' '}
          <em>blank bare metal</em> (no OS, so console, not SSH yet) — then run a provision{' '}
          <WikiLink slug="scenario">scenario</WikiLink> under <WikiLink slug="testing">Testing</WikiLink>. After it's
          provisioned the node boots <Code>sshd</Code> with your seeded key, so <Code>ssh ubuntu@&lt;node-ip&gt;</Code>{' '}
          works (its data-plane IP is on the Fleet page; the login user matches the installed OS — e.g.{' '}
          <Code>ubuntu</Code>, not <Code>user</Code>).
        </P>

        <H>Let the fleet use sudo</H>
        <P>
          Fleet up launches privileged daemons <em>detached</em> — <WikiLink slug="bmc">ipmi_sim</WikiLink> binds port
          623, and on macOS <Code>socket_vmnet</Code> runs as root. <Code>task up</Code> installs a scoped passwordless
          sudo drop-in for these on its first run (one prompt, silent after), so bringing the stack up with{' '}
          <Code>task up</Code> already handles it. To install or repair it on its own:
        </P>
        <CommandCheck
          command={'( cd "$(git rev-parse --show-toplevel)" && task sudo:setup )'}
          hint="One prompt, then silent. Remove it again with task sudo:teardown."
        />

        <H>Setting up from scratch — new machine or teammate</H>
        <P>
          Already in the cockpit? You can skip the rest. This is how you (or a teammate) get here from nothing:
          bootstrap the host, point at your checkouts, and bring the whole stack up. The repo's <Code>README.md</Code>{' '}
          and <Code>devenv/README.md</Code> carry the full walkthrough — this is the short version.
        </P>
        <P>
          On a machine with nothing on it, one command does every step below — it installs <Code>git</Code>, Nix,
          direnv, devenv and the virt stack, clones the repo into <Code>./boss</Code>, and brings the stack up. It asks
          once before it needs <Code>sudo</Code>, and it is idempotent, so re-running it resumes after any failure.
        </P>
        <CommandCheck
          command={'curl -fsSL https://raw.githubusercontent.com/Hydra-Host/Brokkr/master/install.sh | sh'}
          hint="Set BROKKR_DIR to clone elsewhere, BROKKR_REPO_URL for a fork, or BROKKR_NO_UP=1 to stop once the environment is ready."
        />
        <P>The three steps below are what that command runs. Do them by hand if you would rather.</P>

        <H>1. Bootstrap the host</H>
        <P>
          The one-time host bootstrap installs the privileged bits Nix can't provide — <Code>direnv</Code>, the
          libvirt/qemu virt stack, and Docker (for the image-build containers) — and wires up direnv for you. The
          Node/pnpm/Python/uv/go-task toolchain (including Node 24) comes from the <Term>devenv</Term>; you don't
          install it by hand. It's idempotent, so re-running is safe.
        </P>
        <CommandCheck
          command={'bash "$(git rev-parse --show-toplevel)/apps/local-sim/provisioning/bootstrap.sh"'}
          hint="Then run exec $SHELL and cd into the repo so direnv loads the devenv (first build is slow; run direnv allow if prompted)."
        />
        <Expand summary="Confirm the VM tooling afterward?">
          <CommandCheck
            command="qemu-system-x86_64 --version; virsh --version"
            hint="Both print versions once the bootstrap has run."
          />
        </Expand>

        <H>2. Point at your checkouts</H>
        <P>
          The <WikiLink slug="hub">hub</WikiLink> (<Code>apps/api</Code>) and <WikiLink slug="spoke">spoke</WikiLink> (
          <Code>apps/bridge</Code>) live in this monorepo, so the default layout needs no wiring.{' '}
          <Code>task setup</Code> creates your SSH key and clones any missing checkout — run it once before your first{' '}
          <Code>task up</Code>.
        </P>
        <CommandCheck command={'( cd "$(git rev-parse --show-toplevel)" && task setup )'} />
        <Expand summary="Hub/spoke checkouts live somewhere else?">
          <Small>
            Point the engine at them with <Code>HUB_REPO_PATH</Code> / <Code>SPOKE_REPO_PATH</Code> in a repo-root{' '}
            <Code>.env</Code> (or <Code>.envrc.local</Code>) — or via <Code>config.polyrepo</Code> in{' '}
            <Code>devenv.local.nix</Code>. Only needed when they aren't the in-repo <Code>apps/api</Code> +{' '}
            <Code>apps/bridge</Code>.
          </Small>
          <CommandCheck
            command={`cat >> "$(git rev-parse --show-toplevel)/.env" <<'EOF'
HUB_REPO_PATH=/absolute/path/to/hub
SPOKE_REPO_PATH=/absolute/path/to/spoke
EOF`}
            hint="Swap in your real paths. The .env at the repo root is read by the devenv."
          />
        </Expand>

        <H>3. Bring up the whole stack</H>
        <P>
          One command brings up everything — the <WikiLink slug="datastore">datastores</WikiLink>, the{' '}
          <WikiLink slug="hub">hub</WikiLink>, the <WikiLink slug="spoke">spoke</WikiLink>, the simulated{' '}
          <WikiLink slug="fleet">fleet</WikiLink>, and <em>this control center</em> (API on <Code>:3002</Code>, web on{' '}
          <Code>:5175</Code>). There's no separate "start the control center" step; it comes up with the rest under
          process-compose, and the first run installs the passwordless sudo drop-in for the fleet's privileged daemons
          (one prompt).
        </P>
        <CommandCheck
          command={'( cd "$(git rev-parse --show-toplevel)" && task up )'}
          hint="Idempotent — re-run to reconcile a wedged stack. Watch with task logs, check task status, stop with task down."
        />
        <Expand summary="Just want to restart the control center on its own?">
          <Small>Bounce only the cockpit processes (leaving the rest of the stack up):</Small>
          <CommandCheck command="devenv processes restart lab lab-web" />
          <Small>
            Running it standalone (two terminals): <Code>pnpm --filter local-lab serve</Code> for the API and{' '}
            <Code>pnpm --filter local-lab-web dev</Code> for the web. Run the API <em>built</em> (<Code>serve</Code>),
            not <Code>dev</Code> (watch) — the watcher tree-kills the sudo grandchildren the supervisor spawns.
          </Small>
        </Expand>

        <H>Running more than one stack</H>
        <P>
          Each checkout claims its own <WikiLink slug="stack-slot">slot</WikiLink> on first bring-up, so a second
          checkout comes up beside this one without any port edits. See{' '}
          <WikiLink slug="multi-stack">running more than one stack</WikiLink> for the commands that stop and move them.
        </P>

        <P>
          With the API running and the web wired to it, you're ready —{' '}
          <DeployCta>open the Stack page and continue the deploy walkthrough →</DeployCta>
        </P>
      </>
    ),
  },
  {
    slug: 'multi-stack',
    title: 'Running more than one stack',
    brief: 'How to bring up a second stack beside this one, read the host stacks table, and stop or move a stack.',
    category: 'How-to',
    related: ['stack-slot', 'running-the-stack', 'overview', 'local-environment'],
    body: (
      <>
        <P>
          Several checkouts can run their stacks at the same time on one machine. Each claims a{' '}
          <WikiLink slug="stack-slot">slot</WikiLink> on its first <Code>task up</Code>, and the slot derives every
          port, subnet and state directory. You do not configure anything.
        </P>
        <H>Bring a second stack up</H>
        <P>Clone or add a second checkout, then bring it up from its own root. It claims the next free slot.</P>
        <CommandCheck command="task up" hint="Run this from the second checkout's root, not this one." />
        <H>See what is running on the host</H>
        <CommandCheck
          command="task local:status"
          hint="Prints the host stacks table: every claimed slot, its checkout, and whether it is up."
        />
        <P>
          The <WikiLink slug="overview">Overview</WikiLink> page shows the same table, but only once a second stack is
          registered.
        </P>
        <H>Stop or move a stack</H>
        <UL>
          <LI>
            <Code>task down:others</Code> — stop the sibling stacks and leave this one running.
          </LI>
          <LI>
            <Code>task down:all</Code> — stop every registered stack.
          </LI>
          <LI>
            <Code>task purge:all</Code> — destructive. Wipe every slot's host-global state.
          </LI>
          <LI>
            <Code>task stack:reslot</Code> — move this checkout to another slot. Destructive: it migrates slot-bound
            state.
          </LI>
          <LI>
            <Code>task stack:release</Code> — return this checkout's slot to the host registry. Destructive: it tears
            the stack down, nukes the fleet, and wipes the slot state. Another checkout can then claim the slot.{' '}
            <Code>task down</Code> stops the processes but keeps the claim.
          </LI>
        </UL>
        <Note>
          <Term>
            Do not run <Code>task down</Code> from inside a worktree
          </Term>{' '}
          while a sibling stack is up. The stack binds fixed ports per slot, and a bare teardown can reach further than
          the slot you meant.
        </Note>
        <P>
          <OpsCta>Take the operations walkthrough → </OpsCta>
          It starts on the stacks panel and then visits the queues, the hub tabs, storage and the audit log.
        </P>
      </>
    ),
  },
  {
    slug: 'mcp',
    title: 'The control-center MCP server',
    brief: 'How to give an AI agent read and write access to this stack, and what stays out of its reach.',
    category: 'How-to',
    related: ['audit', 'queues', 'running-the-stack', 'local-environment', 'stack-slot'],
    body: (
      <>
        <P>
          <Term>brokkr-lab</Term> is an MCP server that exposes this control center to an AI agent. The agent talks to
          the same API the cockpit uses, so it can read the stack, drive the fleet, run scenarios, and query the
          datastores without you pasting output back and forth.
        </P>
        <H>Register it</H>
        <P>
          There is no manual add step. Every checkout gets the <Code>brokkr-lab</Code> entry from tracked devenv. The
          stack must be up, because the server is a client of the running control center, and it resolves its own{' '}
          <WikiLink slug="stack-slot">slot</WikiLink> from the host registry — so a second checkout needs no edits.
        </P>
        <CommandCheck command="claude mcp list" hint="brokkr-lab is listed once the devenv is loaded." />
        <H>What it exposes</H>
        <UL>
          <LI>Status and stack control, service and datastore lifecycle.</LI>
          <LI>Fleet power, console and exec, plus test scenarios with structured results.</LI>
          <LI>
            Postgres, Redis, Thanos and <WikiLink slug="queues">queue</WikiLink> explorers.
          </LI>
          <LI>Hub debug reads: lifecycle jobs, webhooks, device tokens, zone runtime.</LI>
        </UL>
        <Note>
          The destructive tools are <Term>not registered at all</Term> unless you set{' '}
          <Code>LAB_MCP_ALLOW_DESTRUCTIVE=1</Code>. An agent cannot call a tool it cannot see. The control center's own
          guards still apply on top, and every mutation lands in the <WikiLink slug="audit">audit log</WikiLink>.
        </Note>
        <P>
          For the product API — deployments, servers, inventory — register the separate <Code>brokkr-mcp</Code> server
          instead. Register both when a task spans the stack and the product.
        </P>
      </>
    ),
  },
];
