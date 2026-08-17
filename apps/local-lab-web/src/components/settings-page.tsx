import { useBlocker } from '@tanstack/react-router';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { GateModal, SectionHeading } from '@/components/console';
import { ManifestViewer } from '@/components/manifest-viewer';
import { PendingBanner } from '@/components/pending-banner';
import { StackSettings } from '@/components/stack-settings';
import type {
  BareMetalNode,
  BareMetalPowerAction,
  FleetMode,
  FleetNode,
  FleetNodeEffective,
  HostNic,
  NicSpec,
  PciDevice,
} from '@/contract';
import { isIpv4 } from '@/contract';
import { tsr } from '@/lib/api';
import { useApplyPending } from '@/lib/apply-run';
import { errorMessage, thrownBodyError } from '@/lib/errors';
import { derivedIp, derivedIpsStale, nodeIpDisplay, type FleetNet } from '@/lib/fleet-ip';
import { labApiToken, setLabApiToken } from '@/lib/lab-token';
import { saveToastMessage } from '@/lib/pending';
import { useToast } from '@/lib/toast';
import { blocksUnsavedNav, canSaveForm, shouldHydrateForm } from '@/lib/unsaved-nav';
import { useRunTracker } from '@/lib/use-run-tracker';

/** Leaving the route unmounts the fleet editor, so unsaved edits need explicit consent to be dropped. */
function UnsavedNavGate({ dirty }: { dirty: boolean }) {
  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) => blocksUnsavedNav(dirty, current.pathname, next.pathname),
    enableBeforeUnload: dirty,
    withResolver: true,
  });
  if (blocker.status !== 'blocked') return null;
  return (
    <GateModal
      gate={{
        label: 'Leave with unsaved fleet edits',
        destructive: true,
        description: 'Your unsaved fleet edits are dropped when you leave this page.',
        needsPassword: false,
        password: '',
        setPassword: () => {},
        error: '',
        busy: false,
        confirmLabel: 'Discard and leave',
        confirm: blocker.proceed,
        cancel: blocker.reset,
      }}
      fixed
    />
  );
}

// rowId is edit-state only: a React key that survives mid-list removal, never part of the write body.
type EditDisk = FleetNode['disks'][number] & { rowId: string };
type EditNic = NicSpec & { rowId: string };
// effective_* are narrowed to the derived address on the way in, so an override only ever lives in ip/bmc_ip
type EditNode = Omit<FleetNodeEffective, 'disks' | 'nics'> & { rowId: string; disks: EditDisk[]; nics: EditNic[] };
type BmEditNode = BareMetalNode & { rowId: string; bmc_user: string; bmc_pass: string };

let rowSeq = 0;
const nextRowId = (): string => `row-${++rowSeq}`;

const toEditNode = (n: FleetNodeEffective): EditNode => ({
  ...n,
  rowId: nextRowId(),
  effective_ip: derivedIp(n.ip, n.effective_ip),
  effective_bmc_ip: derivedIp(n.bmc_ip, n.effective_bmc_ip),
  disks: n.disks.map((d) => ({ ...d, rowId: nextRowId() })),
  nics: n.nics.map((c) => ({ ...c, rowId: nextRowId() })),
});

const toWireNode = ({ rowId, effective_ip, effective_bmc_ip, disks, nics, ...node }: EditNode): FleetNode => ({
  ...node,
  disks: disks.map(({ rowId: _diskRow, ...disk }) => disk),
  nics: nics.map(({ rowId: _nicRow, ...nic }) => nic),
});

const BM_MAC_RE = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i;
const isMacStr = (s: string): boolean => BM_MAC_RE.test(s);

const PCI_TYPE_LABEL: Record<PciDevice['type'], string> = {
  'nvidia-gpu': 'NVIDIA GPU',
  'amd-gpu': 'AMD GPU',
  gpu: 'GPU',
  mellanox: 'Mellanox / BlueField',
  nic: 'NIC',
};

function randHex(n: number): string {
  return Math.floor(Math.random() * 16 ** n)
    .toString(16)
    .padStart(n, '0');
}
function randMac(octet: string): string {
  return `52:54:00:${octet}:${randHex(2)}:${randHex(2)}`;
}

const TABS = [
  { id: 'stack', label: 'Stack' },
  { id: 'fleet', label: 'Fleet' },
  { id: 'layers', label: 'Layers' },
] as const;

export function SettingsPage() {
  const cfg = tsr.getFleetConfig.useQuery({ queryKey: ['fleet-config'] });
  const host = tsr.getHost.useQuery({ queryKey: ['host'] });
  const pci = tsr.listPci.useQuery({ queryKey: ['pci'] });
  const hostNics = tsr.listHostNics.useQuery({ queryKey: ['host-nics'] });
  const put = tsr.putFleetConfig.useMutation();
  const bmPower = tsr.baremetalPower.useMutation();
  const toast = useToast();

  const [tab, setTab] = useState<string>(TABS[0].id);
  const [nodes, setNodes] = useState<EditNode[]>([]);
  const [bmcDefaults, setBmcDefaults] = useState<{ username: string; password: string }>({
    username: 'admin',
    password: 'admin',
  });
  const [mode, setMode] = useState<FleetMode>('vm');
  const [bmNic, setBmNic] = useState('');
  const [bmArch, setBmArch] = useState<'amd64' | 'arm64'>('amd64');
  const [bmDefaults, setBmDefaults] = useState<{ username: string; password: string }>({ username: '', password: '' });
  const [bmNodes, setBmNodes] = useState<BmEditNode[]>([]);
  const [powerBusy, setPowerBusy] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const hydratedNet = useRef<FleetNet>({ cidr: '', bmcCidr: '' });
  const [error, setError] = useState('');

  const { active: rebuildBusy, track: trackRebuild } = useRunTracker({
    // cfg has no refetchInterval — refetch or the pending banner stays stale until reload.
    onTerminal: () => void cfg.refetch(),
  });

  useEffect(() => {
    if (cfg.data?.status !== 200) return;
    const body = cfg.data.body;
    const net = { cidr: body.network.cidr, bmcCidr: body.network.bmcCidr };
    if (shouldHydrateForm(hydrated, dirty)) {
      setNodes(body.nodes.map(toEditNode));
      setBmcDefaults(body.bmcDefaults);
      setMode(body.mode);
      setBmNic(body.baremetal.nics[0] ?? '');
      setBmArch(body.baremetal.arch);
      setBmNodes(body.baremetal.nodes.map((n) => ({ ...n, rowId: nextRowId(), bmc_user: '', bmc_pass: '' })));
      hydratedNet.current = net;
      setHydrated(true);
      // the form now mirrors the response, so any edit made while it was loading is already gone
      setDirty(false);
    } else if (derivedIpsStale(hydratedNet.current, net)) {
      // an unsaved form keeps its rows, but the cidr rendered beside them is live; the display
      // short-circuits on effective_*, so drop them and let the shared offset rule recompute
      hydratedNet.current = net;
      setNodes((ns) => ns.map((n) => ({ ...n, effective_ip: null, effective_bmc_ip: null })));
    }
    // dirty/hydrated are read but not deps: the save-success flip to false must not rehydrate the pre-save body.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg.data]);

  const source = cfg.data?.status === 200 ? cfg.data.body.source : null;
  const activePending =
    put.data?.status === 200 && put.submittedAt >= cfg.dataUpdatedAt
      ? put.data.body.pending
      : cfg.data?.status === 200
        ? cfg.data.body.pending
        : undefined;
  const isModeChange = activePending?.severity === 'mode-change';
  const passthroughOk = host.data?.status === 200 ? host.data.body.passthroughSupported : false;
  const hostLabel = host.data?.status === 200 ? `${host.data.body.os}/${host.data.body.arch}` : '';
  const isLinux = hostLabel.startsWith('linux');
  const pciList = pci.data?.status === 200 ? pci.data.body : [];
  const nicList: HostNic[] = hostNics.data?.status === 200 ? hostNics.data.body : [];
  const network = cfg.data?.status === 200 ? cfg.data.body.network : { cidr: '', bmcCidr: '' };
  const zones = (cfg.data?.status === 200 ? cfg.data.body.zones : []) ?? [];
  const readError =
    errorMessage(cfg.error) ?? errorMessage(host.error) ?? errorMessage(pci.error) ?? errorMessage(hostNics.error);

  const patch = (i: number, p: Partial<EditNode>) => {
    setNodes((ns) => ns.map((n, k) => (k === i ? { ...n, ...p } : n)));
    setDirty(true);
  };
  const addNode = () => {
    setNodes((ns) => [
      ...ns,
      {
        rowId: nextRowId(),
        name: `cpu-${ns.length + 1}`,
        zone: zones[0] ?? 'sim-zone',
        ipmi_mac: randMac('bc'),
        data_mac: randMac('da'),
        cpus: 2,
        memory_mb: 4096,
        disk_gb: 40,
        disks: [],
        passthrough: [],
        nics: [],
        data_mtu: null,
        ip: null,
        bmc_ip: null,
        bmc: null,
        effective_ip: null,
        effective_bmc_ip: null,
      },
    ]);
    setDirty(true);
  };
  const removeNode = (i: number) => {
    // a removal re-indexes the rest, so the server's index-derived effective IPs no longer describe them
    setNodes((ns) => ns.filter((_, k) => k !== i).map((n) => ({ ...n, effective_ip: null, effective_bmc_ip: null })));
    setDirty(true);
  };
  const togglePassthrough = (i: number, addr: string) =>
    patch(i, {
      passthrough: nodes[i].passthrough.includes(addr)
        ? nodes[i].passthrough.filter((a) => a !== addr)
        : [...nodes[i].passthrough, addr],
    });

  const patchBm = (i: number, p: Partial<BmEditNode>) => {
    setBmNodes((ns) => ns.map((n, k) => (k === i ? { ...n, ...p } : n)));
    setDirty(true);
  };
  const addBmNode = () => {
    setBmNodes((ns) => {
      // First free metal-N so a remove+add cannot mint a duplicate name (save rejects non-unique).
      const taken = new Set(ns.map((n) => n.name));
      let k = ns.length + 1;
      while (taken.has(`metal-${k}`)) k++;
      return [
        ...ns,
        {
          rowId: nextRowId(),
          name: `metal-${k}`,
          bmc_ip: '',
          bmc_mac: '',
          pxe_mac: '',
          arch: null,
          system_id: null,
          bmc_user: '',
          bmc_pass: '',
        },
      ];
    });
    setDirty(true);
  };
  const removeBmNode = (i: number) => {
    setBmNodes((ns) => ns.filter((_, k) => k !== i));
    setDirty(true);
  };
  const selectMode = (next: FleetMode) => {
    if (next === mode) return;
    if (next === 'baremetal' && !isLinux) return;
    const msg =
      next === 'baremetal'
        ? 'Switch to bare-metal fleet mode? The VM config is kept and restored when you switch back. Nothing applies until you Save then rebuild.'
        : 'Switch back to VM fleet mode? The bare-metal config is kept. Nothing applies until you Save then rebuild.';
    if (!window.confirm(msg)) return;
    setMode(next);
    setDirty(true);
  };

  const bmValidationError = (): string | null => {
    if (mode !== 'baremetal') return null;
    if (!isLinux) return 'bare-metal mode requires a Linux host';
    if (!bmNic) return 'select an uplink NIC';
    if (bmNodes.length === 0) return 'add at least one machine';
    const names = new Set<string>();
    const macs = new Set<string>();
    const ips = new Set<string>();
    for (const n of bmNodes) {
      if (!n.name) return 'every machine needs a name';
      if (names.has(n.name)) return `duplicate machine name: ${n.name}`;
      names.add(n.name);
      if (!isIpv4(n.bmc_ip)) return `${n.name}: invalid BMC IP`;
      if (ips.has(n.bmc_ip)) return `duplicate BMC IP: ${n.bmc_ip}`;
      ips.add(n.bmc_ip);
      for (const [label, mac] of [
        ['BMC MAC', n.bmc_mac],
        ['PXE MAC', n.pxe_mac],
      ] as const) {
        if (!isMacStr(mac)) return `${n.name}: invalid ${label}`;
        if (macs.has(mac.toLowerCase())) return `duplicate MAC: ${mac}`;
        macs.add(mac.toLowerCase());
      }
      if ((n.bmc_user && !n.bmc_pass) || (!n.bmc_user && n.bmc_pass))
        return `${n.name}: BMC username and password must both be set`;
    }
    return null;
  };

  const powerAction = (node: BmEditNode, action: BareMetalPowerAction) => {
    if (dirty) {
      toast.error('save your fleet edits first — power targets the saved machine');
      return;
    }
    if (action !== 'on') {
      const verb = action === 'off' ? 'power off' : action === 'reset' ? 'reset' : 'power-cycle';
      if (!window.confirm(`${verb} ${node.name}? This interrupts anything running on the machine.`)) return;
    }
    setPowerBusy(node.name);
    bmPower.mutate(
      { params: { name: node.name }, body: { action } },
      {
        onSuccess: (r) => {
          setPowerBusy(null);
          toast.ok(`${node.name}: ${r.body.resetType} → ${r.body.powerState}`);
        },
        onError: (err: unknown) => {
          setPowerBusy(null);
          toast.error(thrownBodyError(err) ?? `power ${action} failed`);
        },
      },
    );
  };

  const buildPutBody = () => ({
    mode,
    nodes: nodes.map(toWireNode),
    bmcDefaults,
    baremetal: {
      nics: bmNic ? [bmNic] : [],
      arch: bmArch,
      bmcDefaults: bmDefaults,
      nodes: bmNodes.map((n) => ({
        name: n.name,
        bmc_ip: n.bmc_ip,
        bmc_mac: n.bmc_mac,
        pxe_mac: n.pxe_mac,
        arch: n.arch,
        system_id: n.system_id,
        bmc_user: n.bmc_user || null,
        bmc_pass: n.bmc_pass || null,
      })),
    },
  });

  const saveable = canSaveForm(hydrated, dirty, put.isPending);
  const save = () => {
    if (!saveable) return;
    setError('');
    const bmErr = bmValidationError();
    if (bmErr) {
      setError(bmErr);
      return;
    }
    put.mutate(
      { body: buildPutBody() },
      {
        onSuccess: (res) => {
          setDirty(false);
          void cfg.refetch();
          toast.ok(saveToastMessage(res.body.pending ?? null));
        },
        onError: (err: unknown) => {
          setError(thrownBodyError(err) ?? 'failed to save (check VM names + MACs are unique)');
        },
      },
    );
  };

  const {
    apply: applyPending,
    launchRun,
    isPending: applyBusy,
  } = useApplyPending(trackRebuild, (msg) => toast.error(msg));
  const apply = () => void applyPending(isModeChange);
  const rebuild = () => launchRun({ opId: 'fleet-rebuild' });

  return (
    <div className="space-y-5">
      <div className="border-border-dim flex items-center gap-1 border-b">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={[
              '-mb-px border-b-2 px-3 py-2 text-sm transition',
              tab === t.id
                ? 'border-accent text-text-primary'
                : 'text-text-dim hover:text-text-muted border-transparent',
            ].join(' ')}
          >
            {t.label}
            {dirty && t.id === 'fleet' && (
              <span
                title="unsaved fleet edits — Save config to keep them"
                className="bg-accent ml-1.5 inline-block size-1.5 rounded-full align-middle"
              />
            )}
          </button>
        ))}
      </div>

      {/* the stack editor owns its unsaved form state — hide it on a tab switch, since unmounting drops those edits */}
      <div className={tab === 'stack' ? '' : 'hidden'}>
        <StackSettings />
      </div>

      {tab === 'fleet' && (
        <div className="space-y-5">
          {readError && <div className="text-status-offline text-sm">failed to load fleet settings — {readError}</div>}
          {activePending && (
            <PendingBanner
              pending={activePending}
              busy={applyBusy || rebuildBusy}
              blocked={dirty}
              blockedReason="save first"
              onApply={apply}
            />
          )}
          <div className="flex flex-wrap items-center gap-3">
            {source && (
              <span className="border-border-dim text-text-muted rounded-full border px-2 py-0.5 text-[11px]">
                config: {source === 'local' ? 'personal (fleet.local.yml)' : 'default (unsaved → forks on save)'}
              </span>
            )}
            <span className="text-text-dim text-[11px]">host: {hostLabel}</span>
            <div className="ml-auto flex gap-2">
              <button
                onClick={save}
                disabled={!saveable}
                title={hydrated ? undefined : 'waiting for the saved fleet config to load'}
                className="bg-accent/20 text-accent hover:bg-accent/30 rounded-md px-3 py-1.5 text-sm disabled:opacity-40"
              >
                {put.isPending ? 'saving…' : dirty ? 'Save config' : 'Saved'}
              </button>
              <button
                onClick={rebuild}
                disabled={dirty || isModeChange || applyBusy || rebuildBusy}
                title={
                  dirty
                    ? 'save first'
                    : isModeChange
                      ? 'apply the pending fleet-mode change first'
                      : 'nuke + re-seed + rebuild all VMs with this config'
                }
                className="bg-status-offline/20 text-status-offline hover:bg-status-offline/30 rounded-md px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-40"
              >
                {rebuildBusy ? 'Rebuilding…' : 'Rebuild fleet'}
              </button>
            </div>
          </div>
          {mode === 'vm' && (
            <>
              <p className="text-text-dim max-w-3xl text-[11px]">
                Per-VM hardware. Saving writes your personal <span className="font-mono">fleet.local.yml</span>{' '}
                (gitignored; leaves the committed defaults alone). <b>Rebuild fleet</b> applies it (destructive: nuke →
                re-seed → rebuild all VMs). Extra disks are blank — discovery picks them up on brokkr-live boot.
              </p>
              <div className="border-border-dim bg-bg-secondary flex flex-wrap items-center gap-3 rounded-md border px-3 py-2">
                <span className="text-text-muted text-[11px]">Default BMC creds</span>
                <input
                  value={bmcDefaults.username}
                  onChange={(e) => {
                    setBmcDefaults((b) => ({ ...b, username: e.target.value }));
                    setDirty(true);
                  }}
                  placeholder="username"
                  title="Default IPMI/Redfish username — applies on Rebuild / re-seed."
                  className="border-border-dim bg-bg-primary text-text-primary focus:border-accent/50 w-32 rounded border px-1.5 py-1 font-mono text-[11px] outline-none"
                />
                <input
                  type="password"
                  value={bmcDefaults.password}
                  onChange={(e) => {
                    setBmcDefaults((b) => ({ ...b, password: e.target.value }));
                    setDirty(true);
                  }}
                  placeholder="password"
                  title="Default IPMI/Redfish password — applies on Rebuild / re-seed."
                  className="border-border-dim bg-bg-primary text-text-primary focus:border-accent/50 w-32 rounded border px-1.5 py-1 font-mono text-[11px] outline-none"
                />
                <span className="text-text-dim text-[10px]">applies on Rebuild</span>
              </div>
            </>
          )}
          {error && <div className="text-status-offline text-sm">{error}</div>}

          {mode === 'vm' && (
            <>
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                {nodes.map((node, i) => (
                  <NodeCard
                    key={node.rowId}
                    node={node}
                    index={i}
                    zones={zones}
                    cidr={network.cidr}
                    bmcCidr={network.bmcCidr}
                    pciList={pciList}
                    passthroughOk={passthroughOk}
                    hostLabel={hostLabel}
                    claimedElsewhere={Object.fromEntries(
                      nodes.flatMap((n, j) => (j === i ? [] : n.passthrough.map((a) => [a, n.name] as const))),
                    )}
                    onPatch={(p) => patch(i, p)}
                    onRemove={() => removeNode(i)}
                    onTogglePci={(addr) => togglePassthrough(i, addr)}
                  />
                ))}
              </div>
              <button
                onClick={addNode}
                className="border-border-dim text-text-muted hover:bg-hover-bg w-full rounded-md border border-dashed px-3 py-2 text-sm lg:w-auto"
              >
                + Add VM
              </button>
            </>
          )}

          <div className="border-border-dim border-t" />

          <FleetModeSection
            mode={mode}
            isLinux={isLinux}
            nodeCount={nodes.length}
            bmCount={bmNodes.length}
            onSelect={selectMode}
          />

          {mode === 'baremetal' && (
            <BareMetalEditor
              isLinux={isLinux}
              nicList={nicList}
              bmNic={bmNic}
              onNic={(v) => {
                setBmNic(v);
                setDirty(true);
              }}
              bmArch={bmArch}
              onArch={(v) => {
                setBmArch(v);
                setDirty(true);
              }}
              bmDefaults={bmDefaults}
              onDefaults={(d) => {
                setBmDefaults(d);
                setDirty(true);
              }}
              nodes={bmNodes}
              onPatch={patchBm}
              onAdd={addBmNode}
              onRemove={removeBmNode}
              onPower={powerAction}
              powerBusy={powerBusy}
              bakedChainUrl={cfg.data?.status === 200 ? cfg.data.body.bakedChainUrl : null}
            />
          )}
        </div>
      )}

      {tab === 'layers' && <ManifestViewer />}

      <ApiTokenCard />
      <UnsavedNavGate dirty={dirty} />
    </div>
  );
}

function ApiTokenCard() {
  const toast = useToast();
  const [token, setToken] = useState(labApiToken());

  const saved = labApiToken();
  const dirty = token.trim() !== saved;

  const save = () => {
    if (!dirty) return;
    setLabApiToken(token);
    const persisted = labApiToken();
    setToken(persisted);
    if (persisted !== token.trim()) {
      toast.error('Could not save API token (browser storage unavailable)');
      return;
    }
    toast.ok(persisted ? 'API token saved' : 'API token cleared');
  };

  return (
    <div className="border-border-dim bg-bg-secondary flex flex-wrap items-center gap-3 rounded-md border px-3 py-2">
      <span className="text-text-muted text-[11px]">API token</span>
      <input
        type="password"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && save()}
        placeholder="LAB_API_TOKEN (only for off-loopback access)"
        title="Sent as x-lab-token on API calls and ?token= on console/log stream URLs (so it appears in WS/SSE request logs — treat as rotatable). Required when the lab API is exposed off-loopback."
        className="border-border-dim bg-bg-primary text-text-primary focus:border-accent/50 w-72 rounded border px-1.5 py-1 font-mono text-[11px] outline-none"
      />
      <button
        onClick={save}
        disabled={!dirty}
        className="bg-accent/20 text-accent hover:bg-accent/30 rounded-md px-3 py-1 text-[11px] disabled:opacity-40"
      >
        Save token
      </button>
    </div>
  );
}

function NodeCard({
  node,
  index,
  zones,
  cidr,
  bmcCidr,
  pciList,
  passthroughOk,
  hostLabel,
  claimedElsewhere,
  onPatch,
  onRemove,
  onTogglePci,
}: {
  node: EditNode;
  index: number;
  zones: string[];
  cidr: string;
  bmcCidr: string;
  pciList: PciDevice[];
  passthroughOk: boolean;
  hostLabel: string;
  claimedElsewhere: Record<string, string>;
  onPatch: (p: Partial<EditNode>) => void;
  onRemove: () => void;
  onTogglePci: (addr: string) => void;
}) {
  const setDisk = (j: number, p: Partial<FleetNode['disks'][number]>) =>
    onPatch({ disks: node.disks.map((d, k) => (k === j ? { ...d, ...p } : d)) });
  const setNic = (j: number, p: Partial<NicSpec>) =>
    onPatch({ nics: node.nics.map((n, k) => (k === j ? { ...n, ...p } : n)) });
  const addDisk = () => onPatch({ disks: [...node.disks, { rowId: nextRowId(), size_gb: 100, type: 'ssd' }] });
  const addNic = () =>
    onPatch({
      nics: [...node.nics, { rowId: nextRowId(), mac: randMac('ee'), model: 'virtio', mtu: null, link: 'up' }],
    });
  const isLinux = hostLabel.startsWith('linux');
  const dataIp = nodeIpDisplay(node.ip, node.effective_ip, cidr, index);
  const bmcIp = nodeIpDisplay(node.bmc_ip, node.effective_bmc_ip, bmcCidr, index);

  return (
    <div className="border-border-dim bg-text-dim/[0.02] space-y-3 rounded-lg border p-3">
      <div className="flex items-center gap-2">
        <input
          value={node.name}
          onChange={(e) => onPatch({ name: e.target.value })}
          className="border-border-dim bg-bg-primary text-text-primary focus:border-accent/50 w-32 rounded border px-2 py-1 font-mono text-sm outline-none"
        />
        <select
          value={node.zone}
          onChange={(e) => onPatch({ zone: e.target.value })}
          title="Zone this VM belongs to (Hub Zone.name)"
          className="border-border-dim bg-bg-primary text-text-primary focus:border-accent/50 rounded border px-2 py-1 text-xs outline-none"
        >
          {(zones.includes(node.zone) ? zones : [node.zone, ...zones]).map((z) => (
            <option key={z} value={z}>
              {z}
            </option>
          ))}
        </select>
        <button
          onClick={onRemove}
          title="Remove this VM from the fleet (applies on Save → Rebuild)"
          className="border-status-offline/30 text-status-offline/80 hover:bg-status-offline/10 ml-auto rounded-md border px-2 py-1 text-xs"
        >
          ✕ remove VM
        </button>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <NumField label="vCPUs" value={node.cpus} onChange={(v) => onPatch({ cpus: v })} min={1} />
        <NumField
          label="RAM (MiB)"
          value={node.memory_mb}
          onChange={(v) => onPatch({ memory_mb: v })}
          step={512}
          min={2048}
        />
        <NumField label="OS disk (GB)" value={node.disk_gb} onChange={(v) => onPatch({ disk_gb: v })} min={1} />
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <label className="text-text-muted text-[11px] tracking-wide uppercase">Extra disks</label>
          <button onClick={addDisk} className="text-accent/80 hover:text-accent text-[11px]">
            + disk
          </button>
        </div>
        {node.disks.length === 0 && <div className="text-text-dim text-[11px]">none (OS disk only)</div>}
        {node.disks.map((d, j) => (
          <div key={d.rowId} className="flex items-center gap-2 text-xs">
            <span className="text-text-dim w-7 font-mono">sd{String.fromCharCode(98 + j)}</span>
            <input
              type="number"
              value={d.size_gb ?? 40}
              onChange={(e) => setDisk(j, { size_gb: Number(e.target.value) })}
              className="border-border-dim bg-bg-primary text-text-primary focus:border-accent/50 w-20 rounded border px-2 py-1 outline-none"
            />
            <span className="text-text-dim">GB</span>
            <select
              value={d.type ?? 'ssd'}
              onChange={(e) => setDisk(j, { type: e.target.value as 'ssd' | 'hdd' | 'nvme' })}
              className="border-border-dim bg-bg-primary text-text-primary rounded border px-1.5 py-1 outline-none"
            >
              <option value="ssd">SSD</option>
              <option value="hdd">HDD</option>
              <option value="nvme">NVMe</option>
            </select>
            <button
              onClick={() => onPatch({ disks: node.disks.filter((_, k) => k !== j) })}
              className="text-status-offline/60 hover:text-status-offline ml-auto"
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      <div className="space-y-1.5">
        <label className="text-text-muted text-[11px] tracking-wide uppercase">Network</label>
        <MacRow
          label="BMC NIC"
          hint="ipmi · identity (Redfish UUID, disk serial/WWN)"
          mac={node.ipmi_mac}
          onMac={(v) => onPatch({ ipmi_mac: v })}
          onRand={() => onPatch({ ipmi_mac: randMac('bc') })}
        >
          <input
            value={bmcIp.value}
            placeholder="no BMC CIDR"
            title="Static BMC-plane IP — defaults to the derived .1x; type to override. Applies on Rebuild (vbmc re-registers). Must be in the BMC CIDR."
            onChange={(e) => onPatch({ bmc_ip: e.target.value || null })}
            className={`bg-bg-primary focus:border-accent/50 w-32 rounded border px-1.5 py-1 font-mono text-[11px] outline-none ${bmcIp.isOverride ? 'border-accent/40 text-accent/90' : 'border-border-dim text-text-primary'}`}
          />
        </MacRow>
        <MacRow
          label="Data NIC"
          hint="eth0 · virtio (PXE) · static IP"
          mac={node.data_mac}
          onMac={(v) => onPatch({ data_mac: v })}
          onRand={() => onPatch({ data_mac: randMac('da') })}
        >
          <input
            value={dataIp.value}
            placeholder="no data CIDR"
            title="Static data-plane IP — defaults to the derived .1x; type to override. Must be in the data CIDR."
            onChange={(e) => onPatch({ ip: e.target.value || null })}
            className={`bg-bg-primary focus:border-accent/50 w-32 rounded border px-1.5 py-1 font-mono text-[11px] outline-none ${dataIp.isOverride ? 'border-accent/40 text-accent/90' : 'border-border-dim text-text-primary'}`}
          />
          <input
            type="number"
            value={node.data_mtu ?? ''}
            placeholder="MTU"
            min={1280}
            max={9000}
            onChange={(e) => onPatch({ data_mtu: e.target.value ? Number(e.target.value) : null })}
            className="border-border-dim bg-bg-primary text-text-primary focus:border-accent/50 w-16 rounded border px-1.5 py-1 text-[11px] outline-none"
          />
        </MacRow>

        <div className="flex items-center justify-between pt-1">
          <span className="text-text-dim text-[11px]">Extra NICs {isLinux ? '' : '(Linux only)'}</span>
          {isLinux && (
            <button onClick={addNic} className="text-accent/80 hover:text-accent text-[11px]">
              + NIC
            </button>
          )}
        </div>
        {!isLinux ? (
          <div className="text-status-warning/70 text-[11px] leading-snug">
            Multi-NIC needs a Linux host (macOS fronts one socket_vmnet NIC). MACs above are still editable.
          </div>
        ) : node.nics.length === 0 ? (
          <div className="text-text-dim text-[11px]">none — add NICs for guest-side bonds / VLANs</div>
        ) : (
          node.nics.map((nic, j) => (
            <div key={nic.rowId} className="flex flex-wrap items-center gap-1.5 text-[11px]">
              <span className="text-text-dim w-7 font-mono">eth{j + 1}</span>
              <input
                value={nic.mac}
                onChange={(e) => setNic(j, { mac: e.target.value })}
                className="border-border-dim bg-bg-primary text-text-primary focus:border-accent/50 w-36 rounded border px-1.5 py-1 font-mono outline-none"
              />
              <button
                onClick={() => setNic(j, { mac: randMac('ee') })}
                title="randomize MAC"
                className="text-text-dim hover:text-text-primary"
              >
                🎲
              </button>
              <select
                value={nic.model}
                onChange={(e) => setNic(j, { model: e.target.value as NicSpec['model'] })}
                className="border-border-dim bg-bg-primary text-text-primary rounded border px-1 py-1 outline-none"
              >
                {(['virtio', 'e1000e', 'e1000', 'rtl8139', 'vmxnet3'] as const).map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
              <input
                type="number"
                value={nic.mtu ?? ''}
                placeholder="MTU"
                min={1280}
                max={9000}
                onChange={(e) => setNic(j, { mtu: e.target.value ? Number(e.target.value) : null })}
                className="border-border-dim bg-bg-primary text-text-primary focus:border-accent/50 w-14 rounded border px-1.5 py-1 outline-none"
              />
              <button
                onClick={() => setNic(j, { link: nic.link === 'up' ? 'down' : 'up' })}
                title="link state"
                className={`rounded border px-1.5 py-1 ${nic.link === 'up' ? 'border-status-online/40 text-status-online/80' : 'border-border-dim text-text-dim'}`}
              >
                {nic.link}
              </button>
              <button
                onClick={() => onPatch({ nics: node.nics.filter((_, k) => k !== j) })}
                className="text-status-offline/60 hover:text-status-offline ml-auto"
              >
                ✕
              </button>
            </div>
          ))
        )}
      </div>

      <div className="space-y-1.5">
        <label className="text-text-muted text-[11px] tracking-wide uppercase">PCI passthrough</label>
        {!passthroughOk ? (
          <div className="text-status-warning/70 text-[11px] leading-snug">
            Unavailable on <span className="font-mono">{hostLabel}</span> — needs an amd64 Linux host with IOMMU + a
            vfio-bound device.
          </div>
        ) : pciList.length === 0 ? (
          <div className="text-text-dim text-[11px]">no passthroughable PCI devices found on this host</div>
        ) : (
          <div className="space-y-1">
            {pciList.map((p) => {
              const takenBy = claimedElsewhere[p.addr];
              return (
                <label
                  key={p.addr}
                  className={`flex items-start gap-2 text-[11px] ${takenBy ? 'cursor-not-allowed opacity-40' : 'cursor-pointer'}`}
                  title={takenBy ? `Already passed through to ${takenBy} — a PCI device can only go to one VM` : ''}
                >
                  <input
                    type="checkbox"
                    checked={node.passthrough.includes(p.addr)}
                    disabled={!!takenBy}
                    onChange={() => onTogglePci(p.addr)}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="text-accent/80">{PCI_TYPE_LABEL[p.type]}</span>{' '}
                    <span className="text-text-dim font-mono">{p.addr}</span>
                    {takenBy && <span className="text-status-warning/70"> · in use by {takenBy}</span>}
                    <span className="text-text-muted block max-w-[18rem] truncate">{p.label}</span>
                  </span>
                </label>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function MacRow({
  label,
  hint,
  mac,
  onMac,
  onRand,
  children,
}: {
  label: string;
  hint: string;
  mac: string;
  onMac: (v: string) => void;
  onRand: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
      <span className="text-text-muted w-16" title={hint}>
        {label}
      </span>
      <input
        value={mac}
        onChange={(e) => onMac(e.target.value)}
        className="border-border-dim bg-bg-primary text-text-primary focus:border-accent/50 w-36 rounded border px-1.5 py-1 font-mono outline-none"
      />
      <button onClick={onRand} title="randomize MAC" className="text-text-dim hover:text-text-primary">
        🎲
      </button>
      {children}
    </div>
  );
}

function NumField({
  label,
  value,
  onChange,
  step = 1,
  min,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
}) {
  return (
    <label className="text-text-muted text-[11px]">
      <span className="mb-0.5 block">{label}</span>
      <input
        type="number"
        value={value}
        step={step}
        min={min}
        onChange={(e) => onChange(Number(e.target.value))}
        className="border-border-dim bg-bg-primary text-text-primary focus:border-accent/50 w-full rounded border px-2 py-1 text-sm outline-none"
      />
    </label>
  );
}

function FleetModeSection({
  mode,
  isLinux,
  nodeCount,
  bmCount,
  onSelect,
}: {
  mode: FleetMode;
  isLinux: boolean;
  nodeCount: number;
  bmCount: number;
  onSelect: (m: FleetMode) => void;
}) {
  const card = ({
    id,
    title,
    desc,
    inactiveSummary,
    disabled,
    disabledHint,
  }: {
    id: FleetMode;
    title: string;
    desc: string;
    inactiveSummary: string;
    disabled: boolean;
    disabledHint: string;
  }) => {
    const selected = mode === id;
    return (
      <button
        key={id}
        onClick={() => onSelect(id)}
        disabled={disabled}
        title={disabled ? disabledHint : ''}
        className={[
          'flex-1 rounded-lg border p-3 text-left transition',
          selected ? 'border-accent bg-accent/10' : 'border-border-dim hover:bg-hover-bg',
          disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer',
        ].join(' ')}
      >
        <div className="flex items-center gap-2">
          <span
            className={`inline-block size-3 rounded-full border ${selected ? 'border-accent bg-accent' : 'border-border-dim'}`}
          />
          <span className="text-text-primary text-sm font-medium">{title}</span>
          {!selected && (
            <span className="border-border-dim text-text-dim ml-auto rounded-full border px-1.5 py-0.5 text-[10px]">
              {inactiveSummary} · inactive
            </span>
          )}
        </div>
        <p className="text-text-dim mt-1 text-[11px] leading-snug">{disabled ? disabledHint : desc}</p>
      </button>
    );
  };
  return (
    <div className="space-y-2">
      <SectionHeading>Fleet mode</SectionHeading>
      <div className="flex flex-col gap-3 sm:flex-row">
        {card({
          id: 'vm',
          title: 'VM fleet',
          desc: 'libvirt/qemu simulated machines — current behavior.',
          inactiveSummary: `${nodeCount} VMs saved`,
          disabled: false,
          disabledHint: '',
        })}
        {card({
          id: 'baremetal',
          title: 'Bare metal fleet',
          desc: 'PXE-boot real machines on a host NIC via DHCP proxy; your router stays the DHCP server.',
          inactiveSummary: `${bmCount} machines saved`,
          disabled: !isLinux,
          disabledHint: 'Bare metal mode needs a Linux host',
        })}
      </div>
      <p className="text-text-dim text-[11px]">
        Both configurations are kept — switching only changes which one runs. Nothing applies until you Save then
        rebuild.
      </p>
    </div>
  );
}

function BareMetalEditor({
  isLinux,
  nicList,
  bmNic,
  onNic,
  bmArch,
  onArch,
  bmDefaults,
  onDefaults,
  nodes,
  onPatch,
  onAdd,
  onRemove,
  onPower,
  powerBusy,
  bakedChainUrl,
}: {
  isLinux: boolean;
  nicList: HostNic[];
  bmNic: string;
  onNic: (v: string) => void;
  bmArch: 'amd64' | 'arm64';
  onArch: (v: 'amd64' | 'arm64') => void;
  bmDefaults: { username: string; password: string };
  onDefaults: (d: { username: string; password: string }) => void;
  nodes: BmEditNode[];
  onPatch: (i: number, p: Partial<BmEditNode>) => void;
  onAdd: () => void;
  onRemove: (i: number) => void;
  onPower: (node: BmEditNode, action: BareMetalPowerAction) => void;
  powerBusy: string | null;
  bakedChainUrl: string | null;
}) {
  if (!isLinux) {
    return (
      <div className="text-status-warning/80 text-sm">Bare-metal mode needs a Linux host. Switch back to VM fleet.</div>
    );
  }
  const selectedNic = nicList.find((n) => n.name === bmNic);
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <SectionHeading>Uplink NIC</SectionHeading>
        <select
          value={bmNic}
          onChange={(e) => onNic(e.target.value)}
          className="border-border-dim bg-bg-primary text-text-primary focus:border-accent/50 w-full max-w-md rounded border px-2 py-1.5 text-sm outline-none"
        >
          <option value="">— select a NIC —</option>
          {nicList.map((n) => (
            <option key={n.name} value={n.name} disabled={!n.ipv4}>
              {n.name}
              {n.ipv4 ? ` — ${n.ipv4}` : ' — no IPv4'}
              {n.up ? '' : ' (down)'}
            </option>
          ))}
        </select>
        {nicList.length === 0 && <div className="text-text-dim text-[11px]">no candidate NICs found on this host</div>}
        <p className="text-text-dim max-w-3xl text-[11px]">
          This NIC must be on the same L2 as the machines; your router keeps handing out IPs — the bridge only answers
          PXE boot requests (DHCP proxy). Give this host a static IP or a DHCP reservation on your router — the boot
          binaries embed this address.
        </p>
        {bakedChainUrl && (
          <span className="border-border-dim text-text-dim inline-block rounded-full border px-2 py-0.5 text-[10px]">
            baked chain URL: {bakedChainUrl}
            {selectedNic?.ipv4 && !bakedChainUrl.includes(selectedNic.ipv4.split('/')[0])
              ? ' · stale — re-apply to rebake'
              : ''}
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label className="text-text-muted text-[11px]">Fleet arch</label>
        <select
          value={bmArch}
          onChange={(e) => onArch(e.target.value === 'arm64' ? 'arm64' : 'amd64')}
          className="border-border-dim bg-bg-primary text-text-primary rounded border px-2 py-1 text-xs outline-none"
        >
          <option value="amd64">amd64</option>
          <option value="arm64">arm64</option>
        </select>
        <span className="text-text-dim text-[10px]">
          architecture of your machines; drives which discovery images sync
        </span>
      </div>

      <div className="border-border-dim bg-bg-secondary flex flex-wrap items-center gap-3 rounded-md border px-3 py-2">
        <span className="text-text-muted text-[11px]">Default BMC creds</span>
        <input
          value={bmDefaults.username}
          onChange={(e) => onDefaults({ ...bmDefaults, username: e.target.value })}
          placeholder="username"
          title="Default BMC username — applies to any machine that leaves its own creds blank."
          className="border-border-dim bg-bg-primary text-text-primary focus:border-accent/50 w-32 rounded border px-1.5 py-1 font-mono text-[11px] outline-none"
        />
        <input
          type="password"
          value={bmDefaults.password}
          onChange={(e) => onDefaults({ ...bmDefaults, password: e.target.value })}
          placeholder="password"
          title="Default BMC password — stored in a 0600 secrets file, never in git."
          className="border-border-dim bg-bg-primary text-text-primary focus:border-accent/50 w-32 rounded border px-1.5 py-1 font-mono text-[11px] outline-none"
        />
        <span className="text-text-dim text-[10px]">applies on Apply</span>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {nodes.map((node, i) => (
          <BareMetalCard
            key={node.rowId}
            node={node}
            onPatch={(p) => onPatch(i, p)}
            onRemove={() => onRemove(i)}
            onPower={(action) => onPower(node, action)}
            powerBusy={powerBusy === node.name}
          />
        ))}
      </div>
      <button
        onClick={onAdd}
        className="border-border-dim text-text-muted hover:bg-hover-bg w-full rounded-md border border-dashed px-3 py-2 text-sm lg:w-auto"
      >
        + Add server
      </button>

      <p className="text-text-dim max-w-3xl text-[11px]">
        Mode: DHCP proxy on <span className="font-mono">{bmNic || '—'}</span> · TFTP + iPXE from the bridge · your
        router remains the DHCP server · only the machines listed here (by PXE MAC) receive our boot offer.
      </p>
    </div>
  );
}

function BareMetalCard({
  node,
  onPatch,
  onRemove,
  onPower,
  powerBusy,
}: {
  node: BmEditNode;
  onPatch: (p: Partial<BmEditNode>) => void;
  onRemove: () => void;
  onPower: (action: BareMetalPowerAction) => void;
  powerBusy: boolean;
}) {
  const [advanced, setAdvanced] = useState(false);
  const macClass = (v: string) =>
    `bg-bg-primary focus:border-accent/50 w-40 rounded border px-1.5 py-1 font-mono text-[11px] outline-none ${
      v && !isMacStr(v) ? 'border-status-offline/60' : 'border-border-dim text-text-primary'
    }`;
  const ipClass = (v: string) =>
    `bg-bg-primary focus:border-accent/50 w-32 rounded border px-1.5 py-1 font-mono text-[11px] outline-none ${
      v && !isIpv4(v) ? 'border-status-offline/60' : 'border-border-dim text-text-primary'
    }`;
  const powerBtn = (action: BareMetalPowerAction, label: string, cls: string) => (
    <button
      onClick={() => onPower(action)}
      disabled={powerBusy}
      title={`${label} via BMC (Redfish)`}
      className={`rounded border px-2 py-1 text-[11px] disabled:opacity-40 ${cls}`}
    >
      {label}
    </button>
  );
  return (
    <div className="border-border-dim bg-text-dim/[0.02] space-y-3 rounded-lg border p-3">
      <div className="flex items-center gap-2">
        <input
          value={node.name}
          onChange={(e) => onPatch({ name: e.target.value })}
          placeholder="name"
          className="border-border-dim bg-bg-primary text-text-primary focus:border-accent/50 w-40 rounded border px-2 py-1 font-mono text-sm outline-none"
        />
        <button
          onClick={onRemove}
          title="Remove this machine (applies on Save)"
          className="border-status-offline/30 text-status-offline/80 hover:bg-status-offline/10 ml-auto rounded-md border px-2 py-1 text-xs"
        >
          ✕ remove machine
        </button>
      </div>

      <div className="space-y-1.5">
        <label className="text-text-muted text-[11px] tracking-wide uppercase">BMC</label>
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          <span className="text-text-muted w-16">BMC IP</span>
          <input
            value={node.bmc_ip}
            onChange={(e) => onPatch({ bmc_ip: e.target.value })}
            placeholder="192.168.1.50"
            className={ipClass(node.bmc_ip)}
          />
          <span className="text-text-muted w-16">BMC MAC</span>
          <input
            value={node.bmc_mac}
            onChange={(e) => onPatch({ bmc_mac: e.target.value })}
            placeholder="aa:bb:cc:dd:ee:ff"
            className={macClass(node.bmc_mac)}
          />
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          <span className="text-text-muted w-16">BMC user</span>
          <input
            value={node.bmc_user}
            onChange={(e) => onPatch({ bmc_user: e.target.value })}
            placeholder="inherit default"
            className="border-border-dim bg-bg-primary text-text-primary focus:border-accent/50 w-40 rounded border px-1.5 py-1 font-mono outline-none"
          />
          <span className="text-text-muted w-16">BMC pass</span>
          <input
            type="password"
            value={node.bmc_pass}
            onChange={(e) => onPatch({ bmc_pass: e.target.value })}
            placeholder="inherit default"
            className="border-border-dim bg-bg-primary text-text-primary focus:border-accent/50 w-40 rounded border px-1.5 py-1 font-mono outline-none"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <label className="text-text-muted text-[11px] tracking-wide uppercase">PXE</label>
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          <span className="text-text-muted w-16">PXE MAC</span>
          <input
            value={node.pxe_mac}
            onChange={(e) => onPatch({ pxe_mac: e.target.value })}
            placeholder="aa:bb:cc:dd:ee:ff"
            title="the NIC that firmware-PXE-boots"
            className={macClass(node.pxe_mac)}
          />
        </div>
      </div>

      <button onClick={() => setAdvanced((a) => !a)} className="text-accent/80 hover:text-accent text-[11px]">
        {advanced ? '− advanced' : '+ advanced'}
      </button>
      {advanced && (
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          <span className="text-text-muted w-16">Arch</span>
          <select
            value={node.arch ?? ''}
            onChange={(e) =>
              onPatch({ arch: e.target.value === '' ? null : e.target.value === 'arm64' ? 'arm64' : 'amd64' })
            }
            className="border-border-dim bg-bg-primary text-text-primary rounded border px-1.5 py-1 outline-none"
          >
            <option value="">fleet default</option>
            <option value="amd64">amd64</option>
            <option value="arm64">arm64</option>
          </select>
          <span className="text-text-muted w-16">System id</span>
          <input
            value={node.system_id ?? ''}
            onChange={(e) => onPatch({ system_id: e.target.value || null })}
            placeholder="Members[0]"
            title="Optional Redfish System id — set only for multi-System/blade chassis."
            className="border-border-dim bg-bg-primary text-text-primary focus:border-accent/50 w-40 rounded border px-1.5 py-1 font-mono outline-none"
          />
        </div>
      )}

      <div className="border-border-dim flex flex-wrap items-center gap-1.5 border-t pt-2">
        <span className="text-text-muted mr-1 text-[11px]">Power</span>
        {powerBtn('on', 'On', 'border-status-online/40 text-status-online/90 hover:bg-status-online/10')}
        {powerBtn('off', 'Off', 'border-status-offline/40 text-status-offline/90 hover:bg-status-offline/10')}
        {powerBtn('reset', 'Reset', 'border-border-dim text-text-muted hover:bg-hover-bg')}
        {powerBtn('powercycle', 'Power cycle', 'border-border-dim text-text-muted hover:bg-hover-bg')}
      </div>
    </div>
  );
}
