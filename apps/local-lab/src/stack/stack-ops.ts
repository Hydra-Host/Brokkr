import type { StackOp } from '../contract';

export interface StackOpDef extends StackOp {
  sections?: StackOp['section'][];
}

// Order is safety-critical: the acl password derives from the zone NAME (spoke.nix), so a bridge
// restart ahead of the seed dials a password the acl user does not hold and dies on WRONGPASS.
export const ZONE_SEED_TASKS = ['sim:seed', 'redis-acl:seed', 'zone-crypto:mint-tokens'] as const;

// the boot-readiness findings tell the operator to run this op by name, so the catalog owns the label
export const UPLINK_PREFIX_OP_LABEL = 'Configure uplink prefix in hub';

export const STACK_OPS: StackOpDef[] = [
  {
    id: 'db-drift',
    label: 'DB drift check',
    task: 'prisma migrate diff (db:drift)',
    description:
      'Read-only: compare the live hub DB schema against the Prisma schema and report drift. Exit 0 = in sync; exit 2 = schema differs (apply DB migrate deploy, or Reinit for a clean rebuild); any other exit = the check itself errored. Changes nothing.',
    section: 'stack',
    group: 'status',
    destructive: false,
    needsSudo: false,
  },
  {
    id: 'up',
    label: 'Stack up',
    task: 'start datastores → hub/spoke → seed',
    description:
      'Bring up the control plane: start the datastore processes (Postgres/Redis/nginx/Thanos), launch hub and spoke, then seed the hub DB. Reconciles an already-initialized stack — does not touch the fleet or the control center itself.',
    section: 'stack',
    group: 'bringup',
    destructive: false,
    needsSudo: false,
  },
  {
    id: 'reconcile',
    label: 'Reconcile / self-heal',
    task: 'stack-reconcile (process-compose)',
    description:
      'Self-heal the control plane: (re)start any datastore/hub/spoke/observability process that has stopped or given up, in dependency order, leaving Disabled (opt-in-off) and already-running ones be. Safe to run anytime — idempotent on a healthy stack. Does not touch the fleet or the control center itself.',
    section: 'stack',
    group: 'bringup',
    destructive: false,
    needsSudo: false,
  },
  {
    id: 'datastores',
    label: 'Datastores up',
    task: 'start datastores (process-compose)',
    description: 'Start just the datastore processes (Postgres/Redis/nginx/Thanos) via process-compose. No hub/spoke.',
    section: 'stack',
    group: 'bringup',
    destructive: false,
    needsSudo: false,
  },
  {
    id: 'seed',
    label: 'Seed DB',
    task: 'seed (sql-seed generators)',
    description:
      'Re-run the generator-driven sim seed against the running hub (devices, OS catalog, SSH keys, listing). Idempotent; needs the hub up.',
    section: 'stack',
    group: 'bringup',
    destructive: false,
    needsSudo: false,
  },
  {
    id: 'zone-seed',
    label: 'Seed zones',
    task: `devenv tasks run ${ZONE_SEED_TASKS.join(' → ')}`,
    description:
      'Make a saved zone set live on the hub: seed the Zone rows, provision each zone’s Redis ACL user, then mint its registration token — in that order — then restart the bridges so they dial the new credentials. Idempotent; re-running against an unchanged zone set is a no-op. Each task runs alone (--mode single), so the running stack is used as-is and nothing re-runs hub:init. Needs the datastores and the hub already up.',
    section: 'stack',
    group: 'bringup',
    destructive: false,
    needsSudo: false,
  },
  {
    id: 'db-migrate-deploy',
    label: 'DB migrate deploy',
    task: 'prisma migrate deploy',
    description:
      'Apply any pending Prisma migrations to the hub DB (forward-only, idempotent — a no-op when the schema is already current). Does not author new migrations or wipe data. Needs the datastores up.',
    section: 'stack',
    group: 'bringup',
    destructive: false,
    needsSudo: false,
  },
  {
    id: 'down',
    label: 'Stack down',
    task: 'stop hub/spoke → datastores down',
    description:
      'Stop hub/spoke and the datastore processes (Postgres/Redis/nginx/Thanos). Data is preserved (use Stack nuke to wipe). Fleet + control center untouched.',
    section: 'stack',
    group: 'destructive',
    destructive: true,
    needsSudo: false,
  },
  {
    id: 'restart',
    label: 'Stack restart (down → up)',
    task: 'down → up',
    description:
      'Stop hub/spoke and the datastore processes, then bring the control plane back up. Data is preserved. Fleet + control center untouched.',
    section: 'stack',
    group: 'destructive',
    destructive: true,
    needsSudo: false,
  },
  {
    id: 'nuke',
    label: 'Stack nuke (down + WIPE data)',
    task: 'stop hub/spoke → wipe datastore data',
    description:
      'DESTRUCTIVE: stop hub/spoke + the datastore processes and wipe their data dirs (hub DB, Redis) for a clean slate — the nginx layer cache is preserved. Does NOT re-initialize: use Reinit for wipe-and-rebuild in one op, or follow this with Stack up → DB migrate deploy → Seed DB. Fleet + control center untouched.',
    section: 'stack',
    group: 'destructive',
    destructive: true,
    needsSudo: false,
  },
  {
    id: 'reinit',
    label: 'Reinit (nuke + rebuild)',
    task: 'stack-down; stack-await-down && stack-wipe-data; stack-up',
    description:
      'DESTRUCTIVE: the full cycle Stack nuke never finished — stop the stack, wipe the datastore data dirs (hub DB, Redis, Thanos/Tempo/Grafana), then bring everything back up through the init DAG (migrate + device seed + zone crypto) so you land on a working stack, not a bare one. KEEPS fleet disk overlays and the nginx layer cache. The wipe is gated on the supervisor actually being gone, so a stack that will not stop is reported as a failed restart rather than having a live data dir deleted under it — and the bring-up still runs, so you are never left without a cockpit. The fleet goes down and comes back with the stack. The control center itself restarts: this API drops and the UI reconnects when the stack is back.',
    section: 'stack',
    sections: ['fleet', 'stack'],
    group: 'destructive',
    destructive: true,
    needsSudo: true,
  },
  {
    id: 'reset',
    label: 'Reset (wipe data + fleet overlays)',
    task: 'stack-reset; stack-up',
    description:
      'DESTRUCTIVE: everything Reinit wipes PLUS the fleet — disk overlays, NVRAM, and sushy configs are deleted (fully fresh VMs), then the whole stack is brought back up through the init DAG. KEEPS the nginx OS-layer cache and build artifacts. The control center itself restarts: this API drops and the UI reconnects when the stack is back.',
    section: 'stack',
    sections: ['fleet', 'stack'],
    group: 'destructive',
    destructive: true,
    needsSudo: true,
  },
  {
    id: 'purge',
    label: 'Purge (pristine devenv state)',
    task: 'stack-purge; stack-up',
    description:
      "DESTRUCTIVE: everything Reset wipes PLUS host-global caches shared by every checkout — synced discovery images and built initrds (/tmp/brokkr-dev), sim boot artifacts, telegraf conf, zone-crypto tokens — plus the nginx OS-layer cache (re-downloads), process-compose logs, and devenv's task-status db, then a full bring-up. REFUSES while another checkout's stack is live, because those caches are not ours alone to delete; that is stricter than terminal `task local:purge`, which stops the siblings for you. The control center itself restarts: this API drops and the UI reconnects when the stack is back.",
    section: 'stack',
    sections: ['fleet', 'stack'],
    group: 'destructive',
    destructive: true,
    needsSudo: true,
  },
  {
    id: 'fleet-status',
    label: 'Fleet status',
    task: 'status (python -m local.status)',
    description: 'Read-only: per-VM libvirt domain, ipmi_sim, and sushy state. Changes nothing.',
    section: 'fleet',
    group: 'status',
    destructive: false,
    needsSudo: false,
  },
  {
    id: 'fleet-up',
    label: 'Fleet up',
    task: 'start fleet (process-compose)',
    description:
      'Start the supervised fleet process: build artifacts (brokkr-live + per-VM iPXE) if needed, then render domains, start ipmi_sim/sushy, and power on the VMs. Needs the control plane running first.',
    section: 'fleet',
    group: 'bringup',
    destructive: false,
    needsSudo: true,
  },
  {
    id: 'fleet-down',
    label: 'Fleet down',
    task: 'stop fleet (process-compose)',
    description:
      'Stop the fleet process — power off the VMs (kept defined for a fast restart) and stop ipmi_sim/sushy. Disk overlays are preserved (use Fleet nuke to destroy + delete them).',
    section: 'fleet',
    group: 'destructive',
    destructive: true,
    needsSudo: true,
  },
  {
    id: 'fleet-rebuild',
    label: 'Fleet rebuild',
    task: 'apply overlay → nuke → seed → build → power on',
    description:
      'DESTRUCTIVE: apply the saved fleet builder config — re-eval the stack overlay so the engine renders the new topology, nuke (delete overlays), re-seed the hub, rebuild artifacts, and bring all VMs back up with the new nodes/disks/passthrough. Needs the control plane running.',
    section: 'fleet',
    group: 'destructive',
    destructive: true,
    needsSudo: true,
  },
  {
    id: 'fleet-apply',
    label: 'Fleet apply (incremental)',
    task: 'diff → minimal per-node ops',
    description:
      'Apply the saved fleet builder config the cheap way: diff desired vs applied topology and run only the minimal ops (hot power-cycle a resized node, recreate one disk, add/remove a tail node), falling back to a full rebuild only when a change shifts node identity. Needs the control plane running.',
    section: 'fleet',
    group: 'bringup',
    destructive: false,
    needsSudo: true,
  },
  {
    id: 'fleet-planes-apply',
    label: 'Apply fleet planes',
    task: 'preflight → force-render → drift guard → cap+bake → stop fleet → project update → health-gate',
    description:
      'Apply a saved fleet plane change (the VM or bare-metal plane turning on or off) — no stack down/up. Preflights the active-saga guard (409 unless forced), force-renders the new config and pre-swap drift-guards it (aborts if the running stack would restart more than {spoke, hub-api, fleet} — this guard is unconditional; force overrides only the active-saga preflight), when the bare-metal plane is on ensures the ambient-cap binary and re-bakes iPXE with the IP-literal chain URL, refreshes the staged fleet.yml, stops the VM fleet, then does the single restart event (process-compose project update) that hard-restarts exactly {spoke, hub-api, fleet} with their new env, re-stops the resurrected fleet, and health-gates the control plane back up. Needs the control plane running.',
    section: 'fleet',
    sections: ['fleet', 'stack'],
    group: 'bringup',
    destructive: false,
    needsSudo: true,
  },
  {
    id: 'fleet-add-commissioning',
    label: 'Add commissioning nodes (+2)',
    task: 'append 2 commissioning nodes → apply (seed + boot)',
    description:
      'Add 2 commissioning-candidate VMs (role=NULL, IPMI-only/DHCP — no seeded OS or server row) to the fleet and apply incrementally: the existing VMs are untouched; the 2 new ones are seeded as discoverable devices and powered on so you can exercise commissioning. Idempotent — a no-op once 2 already exist. Needs the control plane running.',
    section: 'fleet',
    group: 'bringup',
    destructive: false,
    needsSudo: true,
  },
  {
    id: 'baremetal-uplink-prefix',
    label: UPLINK_PREFIX_OP_LABEL,
    task: 'hub: prefix containing the uplink IP → zone → PROXY + SNPONLY + peer + MAC allowlist',
    description:
      "Configure the hub prefix that contains the bare-metal uplink NIC address, which is the prefix the spoke binds its PXE proxy to. Finds it by containment (creating the NIC's network in the first zone when none exists), assigns it to the zone, sets DHCP mode PROXY, iPXE target SNPONLY, declares your router as the authoritative DHCP server, and adds every saved machine's PXE MAC to the proxy allowlist. Already converged = no write, exit 0. Refuses when the containing prefix is one of the simulator's own networks. Needs the hub running.",
    section: 'fleet',
    group: 'bringup',
    destructive: false,
    needsSudo: false,
  },
  {
    id: 'fleet-nuke',
    label: 'Fleet nuke',
    task: 'nuke + stop fleet',
    description:
      'DESTRUCTIVE: Fleet down + delete disk overlays, sushy configs, and NVRAM — fully fresh VMs on the next bring-up.',
    section: 'fleet',
    group: 'destructive',
    destructive: true,
    needsSudo: true,
  },
];
