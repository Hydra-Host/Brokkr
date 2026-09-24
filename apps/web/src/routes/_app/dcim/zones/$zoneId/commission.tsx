import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { ArrowDown, ArrowUp, ArrowUpDown, Check, ChevronDown, Loader2, RefreshCw, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import type { CommissioningProgressItem, SagaStep, ScannedDevice } from '@repo/api-client';

import { StepIcon } from '@repo/domain-ui/components/step-icon';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { Checkbox } from '@repo/ui/components/checkbox';
import { Command, CommandEmpty, CommandGroup, CommandItem, CommandList } from '@repo/ui/components/command';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@repo/ui/components/dialog';
import { Input } from '@repo/ui/components/input';
import { Popover, PopoverContent, PopoverTrigger } from '@repo/ui/components/popover';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@repo/ui/components/table';
import { cn } from '@repo/ui/utils';

import { ipv4ToInt, unwrapErrorMessage } from '@repo/utils';
import { ServerCommissionIcon } from '~/components/server-commission-icon';
import { tsr } from '~/lib/api';

const SCAN_POLL_INTERVAL_MS = 3e3;
const ENRICH_POLL_INTERVAL_MS = 12e3;
// Client-side backstop: stop spinning on a dead enrich plan even if the poll never resolves
// (e.g. plan gone from Redis and the server still answers 'pending'). Matches the hub grace.
const ENRICH_TIMEOUT_MS = 20 * 6e4;
const PROGRESS_POLL_INTERVAL_MS = 1e4;
const STALL_INACTIVITY_MS = 20 * 6e4;
const COMMISSIONING_TERMINAL_PHASE = 'deprovision';

type CommissioningStatus = 'Detected' | 'Ready' | 'InProgress' | 'Done' | 'Failed' | 'Stalled';

interface DeviceCredentials {
  bmcUsername: string;
  bmcPassword: string;
  bmcMac: string;
  osIp: string;
}

const EMPTY_CREDS: DeviceCredentials = { bmcUsername: '', bmcPassword: '', bmcMac: '', osIp: '' };

function loadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = typeof window !== 'undefined' ? window.localStorage.getItem(key) : null;
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function saveJSON(key: string, value: unknown): void {
  try {
    if (typeof window !== 'undefined') window.localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.info('Failed to persist commissioning state', error);
  }
}

export function normalizeMac(mac: string | null | undefined): string {
  return (mac ?? '').replace(/[:\-.]/g, '').toLowerCase();
}
export function formatMacInput(raw: string): string {
  const hex = raw
    .replace(/[^0-9a-fA-F]/g, '')
    .toUpperCase()
    .slice(0, 12);
  return hex.match(/.{1,2}/g)?.join(':') ?? '';
}
export function identityKey(mac: string | null | undefined, ip: string | null | undefined): string {
  const normMac = normalizeMac(mac);
  if (normMac) return `mac:${normMac}`;
  const host = (ip ?? '').split('/')[0].trim().toLowerCase();
  return host ? `ip:${host}` : '';
}
export function deviceKey(d: ScannedDevice): string {
  return d.bmcMac || d.nicMac || d.bmcIp;
}

export type EnrichPollStatus = 'pending' | 'complete' | 'failed' | 'expired';
export type EnrichPollAction =
  | { kind: 'keep' }
  | { kind: 'clear' }
  | { kind: 'expired' }
  | { kind: 'failed'; message: string };

// A dead plan times out client-side while still 'pending' so it can never spin forever — but a
// terminal server status (complete/failed/expired) always wins, even past the client timeout.
export function enrichPollOutcome(args: {
  status: EnrichPollStatus;
  startedAt: number | undefined;
  now: number;
  timeoutMs: number;
  error?: string | null;
}): EnrichPollAction {
  switch (args.status) {
    case 'complete':
      return { kind: 'clear' };
    case 'expired':
      return { kind: 'expired' };
    case 'failed':
      return { kind: 'failed', message: args.error ?? 'Enrichment failed' };
    case 'pending':
      if (args.startedAt !== undefined && args.now - args.startedAt >= args.timeoutMs) {
        return { kind: 'expired' };
      }
      return { kind: 'keep' };
  }
}

export function summarizeSubnets(subnets: string[], maxShown = 2): string {
  if (subnets.length <= maxShown) return subnets.join(', ');
  return `${subnets.slice(0, maxShown).join(', ')} +${subnets.length - maxShown}`;
}
// null selection = "all management subnets", so subnets added later join the default selection automatically.
export function effectiveSubnetSelection(selected: string[] | null, available: string[]): string[] {
  return selected === null ? available : selected.filter((s) => available.includes(s));
}
export function toggleSubnet(selected: string[] | null, available: string[], subnet: string): string[] {
  const current = effectiveSubnetSelection(selected, available);
  return current.includes(subnet) ? current.filter((s) => s !== subnet) : [...current, subnet];
}
// A full selection sends the empty scan-all body — the subnets override is capped at 50 entries server-side.
export function buildScanBody(selected: string[], available: string[]): { subnets?: string[] } {
  return selected.length === available.length ? {} : { subnets: selected };
}

function lastSagaActivityMs(sagaSteps: SagaStep[], baselineIso: string): number {
  let latest = Date.parse(baselineIso);
  for (const s of sagaSteps) {
    for (const ts of [s.startedAt, s.completedAt]) {
      if (!ts) continue;
      const t = Date.parse(ts);
      if (!Number.isNaN(t) && t > latest) latest = t;
    }
  }
  return latest;
}
function firstStepError(sagaSteps: SagaStep[]): string | null {
  return sagaSteps.find((s) => s.status === 'failed')?.error ?? null;
}
function isActiveStatus(status: CommissioningStatus): boolean {
  return ['InProgress', 'Stalled'].includes(status);
}
export function deriveCommissioningStatus(item: CommissioningProgressItem): CommissioningStatus {
  // Durable DB lifecycle outlives the Redis saga plan — check both terminal markers before any ephemeral step state, else a qualified device with a stale failed step reads Failed instead of Done.
  if (item.lifecycleFailed) return 'Failed';
  if (item.lifecycleQualified) return 'Done';

  if (item.sagaSteps.some((s: SagaStep) => s.status === 'failed')) return 'Failed';

  const terminal = item.sagaSteps.filter((s: SagaStep) => s.phase === COMMISSIONING_TERMINAL_PHASE);
  if (terminal.length > 0 && terminal.every((s: SagaStep) => s.status === 'complete')) return 'Done';

  if (!item.zoneOnline) return 'Stalled';

  if (Date.now() - lastSagaActivityMs(item.sagaSteps, item.updatedAt) > STALL_INACTIVITY_MS) return 'Stalled';

  return 'InProgress';
}

type UnifiedRow =
  | { kind: 'scanned'; key: string; device: ScannedDevice }
  | { kind: 'progress'; key: string; item: CommissioningProgressItem; status: CommissioningStatus };

function scannedStatus(
  d: ScannedDevice,
  isEnriching: boolean,
  isValidated: boolean,
): { label: string; variant: 'default' | 'secondary' | 'outline' } {
  if (isEnriching) return { label: 'Enriching', variant: 'secondary' };
  if (!d.enriched) return { label: 'Detected', variant: 'secondary' };
  if (!isValidated) return { label: 'Enriched', variant: 'outline' };
  return { label: 'Ready', variant: 'default' };
}

export const Route = createFileRoute('/_app/dcim/zones/$zoneId/commission')({
  staticData: {
    breadcrumb: 'Commission',
    description: 'Scan management subnets and commission discovered devices',
    hideZoneHeader: true,
  },
  component: CommissionZonePage,
});

function CommissionZonePage() {
  const { zoneId } = Route.useParams();
  const queryClient = useQueryClient();

  const scansKey = `commissioning:scans:${zoneId}`;
  const credsKey = `commissioning:creds:${zoneId}`;
  const validatedKey = `commissioning:validated:${zoneId}`;
  const scannedKey = `commissioning:scanned:${zoneId}`;
  const warningKey = `commissioning:warning:${zoneId}`;
  const manufacturerKey = `commissioning:manufacturers:${zoneId}`;
  const capabilitiesKey = `commissioning:capabilities:${zoneId}`;
  const enrichPlanKey = `commissioning:enrich-plans:${zoneId}`;
  const enrichStartedKey = `commissioning:enrich-started:${zoneId}`;

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanWarning, setScanWarning] = useState<string | null>(() => loadJSON<string | null>(warningKey, null));
  const [scanFinished, setScanFinished] = useState<boolean>(() => loadJSON<boolean>(scannedKey, false));

  const [devices, setDevices] = useState<ScannedDevice[]>(() => loadJSON<ScannedDevice[]>(scansKey, []));
  const [credsByKey, setCredsByKey] = useState<Record<string, DeviceCredentials>>(() =>
    loadJSON<Record<string, DeviceCredentials>>(credsKey, {}),
  );
  const [validatedKeys, setValidatedKeys] = useState<string[]>(() => loadJSON<string[]>(validatedKey, []));
  const [enrichingKeys, setEnrichingKeys] = useState<Set<string>>(
    () => new Set(Object.keys(loadJSON<Record<string, string>>(enrichPlanKey, {}))),
  );
  const [enrichPlanByKey, setEnrichPlanByKey] = useState<Record<string, string>>(() =>
    loadJSON<Record<string, string>>(enrichPlanKey, {}),
  );
  const [enrichStartedByKey, setEnrichStartedByKey] = useState<Record<string, number>>(() =>
    loadJSON<Record<string, number>>(enrichStartedKey, {}),
  );
  const [validatingKeys, setValidatingKeys] = useState<Set<string>>(new Set());
  const [commissionErrors, setCommissionErrors] = useState<Record<string, string>>({});
  const [manufacturerByIdentity, setManufacturerByIdentity] = useState<Record<string, string>>(() =>
    loadJSON<Record<string, string>>(manufacturerKey, {}),
  );
  const [capabilitiesByIdentity, setCapabilitiesByIdentity] = useState<
    Record<string, { hasIpmi: boolean; hasRedfish: boolean }>
  >(() => loadJSON<Record<string, { hasIpmi: boolean; hasRedfish: boolean }>>(capabilitiesKey, {}));

  const [customSubnet, setCustomSubnet] = useState('');
  const [selectedSubnets, setSelectedSubnets] = useState<string[] | null>(null);

  const scanMutation = tsr.scanZoneManagementSubnets.useMutation();
  const createPrefixMutation = tsr.createPrefix.useMutation();
  const managementSubnetsQuery = tsr.listZoneManagementSubnets.useQuery({
    queryKey: ['commissioning-mgmt-subnets', zoneId],
    queryData: { params: { zoneId } },
  });
  const managementSubnets = useMemo(
    () => (managementSubnetsQuery.data?.status === 200 ? managementSubnetsQuery.data.body.subnets : []),
    [managementSubnetsQuery.data],
  );
  const enrichMutation = tsr.enrichCommissioningDevice.useMutation();
  const cancelEnrichMutation = tsr.cancelCommissioningEnrichment.useMutation();
  const refreshMutation = tsr.refreshCommissioningEnrichment.useMutation();
  const validateMutation = tsr.validateCommissioning.useMutation();
  const commissionMutation = tsr.commissionDevices.useMutation();
  const acknowledgeMutation = tsr.acknowledgeCommissioning.useMutation();
  const cancelMutation = tsr.cancelCommissioning.useMutation();
  const retryMutation = tsr.retryCommissioning.useMutation();
  const retryStepMutation = tsr.retryCommissioningStep.useMutation();

  useEffect(() => saveJSON(scansKey, devices), [scansKey, devices]);
  useEffect(() => saveJSON(credsKey, credsByKey), [credsKey, credsByKey]);
  useEffect(() => saveJSON(validatedKey, validatedKeys), [validatedKey, validatedKeys]);
  useEffect(() => {
    if (scanFinished) saveJSON(scannedKey, true);
  }, [scannedKey, scanFinished]);
  useEffect(() => saveJSON(warningKey, scanWarning), [warningKey, scanWarning]);
  useEffect(() => saveJSON(enrichPlanKey, enrichPlanByKey), [enrichPlanKey, enrichPlanByKey]);
  useEffect(() => saveJSON(enrichStartedKey, enrichStartedByKey), [enrichStartedKey, enrichStartedByKey]);
  useEffect(() => saveJSON(manufacturerKey, manufacturerByIdentity), [manufacturerKey, manufacturerByIdentity]);
  useEffect(() => saveJSON(capabilitiesKey, capabilitiesByIdentity), [capabilitiesKey, capabilitiesByIdentity]);

  const runScan = useCallback(
    (body: { subnets?: string[] }) => {
      setScanError(null);
      setScanWarning(null);
      setScanFinished(false);
      setSessionId(null);
      scanMutation
        .mutateAsync({ params: { zoneId }, body })
        .then((res) => {
          if (res.status === 200) setSessionId(res.body.sessionId);
          else setScanError(unwrapErrorMessage(res, 'Failed to start scan'));
        })
        .catch((err: unknown) => setScanError(unwrapErrorMessage(err, 'Failed to start scan')));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [zoneId],
  );

  const scanSubnets = effectiveSubnetSelection(selectedSubnets, managementSubnets);

  const startSelectedScan = useCallback(() => {
    runScan(buildScanBody(scanSubnets, managementSubnets));
  }, [scanSubnets, managementSubnets, runScan]);

  const addManagementSubnet = useCallback(async () => {
    const subnet = customSubnet.trim();
    if (!subnet) return;
    try {
      const res = await createPrefixMutation.mutateAsync({
        body: { prefix: subnet, role: 'MANAGEMENT', zoneId, status: 'ACTIVE' },
      });
      if (res.status === 201) {
        toast.success(`Added management subnet ${res.body.prefix}`);
        setCustomSubnet('');
        const prefix = res.body.prefix;
        setSelectedSubnets((prev) => (prev === null || prev.includes(prefix) ? prev : [...prev, prefix]));
        void queryClient.invalidateQueries({ queryKey: ['commissioning-mgmt-subnets', zoneId] });
      } else {
        toast.error(unwrapErrorMessage(res, 'Failed to add management subnet'));
      }
    } catch (err) {
      toast.error(unwrapErrorMessage(err, 'Failed to add management subnet'));
    }
  }, [customSubnet, zoneId, createPrefixMutation, queryClient]);

  const scanDone = scanFinished || scanError !== null;
  // Gate buttons/spinner on this — not !scanDone (would wedge them disabled forever) and not sessionId alone (nulled before the POST resolves; a double-click could start overlapping scans).
  const scanInProgress = scanMutation.isPending || (sessionId !== null && !scanDone);
  const scanDisabledReason =
    managementSubnets.length === 0
      ? 'Add a management subnet first'
      : scanSubnets.length === 0
        ? 'Select at least one subnet to scan'
        : undefined;
  const isCommitting = commissionMutation.isPending;

  const scanPoll = tsr.pollCommissioningScan.useQuery({
    queryKey: ['commissioning-scan', zoneId, sessionId],
    queryData: { params: { zoneId, sessionId: sessionId ?? '' } },
    enabled: !!sessionId && !scanDone,
    refetchInterval: scanDone ? false : SCAN_POLL_INTERVAL_MS,
  });

  useEffect(() => {
    if (scanPoll.isError) {
      setScanError(unwrapErrorMessage(scanPoll.error, 'Scan polling failed'));
      return;
    }
    if (!scanPoll.data) return;
    if (scanPoll.data.status !== 200) {
      setScanError(`Scan polling failed (HTTP ${scanPoll.data.status})`);
      return;
    }
    const body = scanPoll.data.body;
    if (body.status === 'complete') {
      setDevices(body.result?.devices ?? []);
      setScanWarning(
        body.result?.partial
          ? `Partial scan: ${body.result.subnetsFailed} of ${body.result.subnetsTotal} subnets failed — devices on those subnets are not listed. Rescan to retry.`
          : null,
      );
      setScanFinished(true);
    } else if (body.status === 'failed') {
      setScanError(body.error ?? 'Scan failed');
    }
  }, [scanPoll.data, scanPoll.isError, scanPoll.error]);

  const progressQuery = tsr.getCommissioningProgress.useQuery({
    queryKey: ['commissioning-progress', zoneId],
    queryData: { params: { zoneId } },
    refetchInterval: PROGRESS_POLL_INTERVAL_MS,
  });
  const progressItems: CommissioningProgressItem[] = useMemo(
    () => (progressQuery.data?.status === 200 ? (progressQuery.data.body.data ?? []) : []),
    [progressQuery.data],
  );

  const refetchProgress = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['commissioning-progress', zoneId] });
  }, [queryClient, zoneId]);

  const getCreds = useCallback((key: string): DeviceCredentials => credsByKey[key] ?? EMPTY_CREDS, [credsByKey]);
  const setCred = useCallback((key: string, patch: Partial<DeviceCredentials>) => {
    setCredsByKey((prev) => ({ ...prev, [key]: { ...EMPTY_CREDS, ...prev[key], ...patch } }));
    setValidatedKeys((prev) => prev.filter((k) => k !== key));
    setCommissionErrors((prev) => {
      if (!(key in prev)) return prev;
      const { [key]: _removed, ...rest } = prev;
      return rest;
    });
  }, []);

  useEffect(() => {
    setManufacturerByIdentity((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const d of devices) {
        if (!d.manufacturer) continue;
        const id = identityKey(d.bmcMac || getCreds(deviceKey(d)).bmcMac, d.bmcIp);
        if (id && next[id] !== d.manufacturer) {
          next[id] = d.manufacturer;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [devices, getCreds]);

  useEffect(() => {
    setCapabilitiesByIdentity((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const d of devices) {
        const id = identityKey(d.bmcMac || getCreds(deviceKey(d)).bmcMac, d.bmcIp);
        if (!id) continue;
        const existing = next[id];
        if (!existing || existing.hasIpmi !== d.hasIpmi || existing.hasRedfish !== d.hasRedfish) {
          next[id] = { hasIpmi: d.hasIpmi, hasRedfish: d.hasRedfish };
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [devices, getCreds]);

  const progressIdentities = useMemo(
    () => new Set(progressItems.map((p) => identityKey(p.bmcMac, p.bmcIp)).filter(Boolean)),
    [progressItems],
  );
  const scannedRows = useMemo(
    () =>
      devices.filter((d) => {
        const c = getCreds(deviceKey(d));
        const id = identityKey(d.bmcMac || c.bmcMac, d.bmcIp);
        return !id || !progressIdentities.has(id);
      }),
    [devices, getCreds, progressIdentities],
  );

  const unifiedRows = useMemo<UnifiedRow[]>(() => {
    const scanned: UnifiedRow[] = scannedRows.map((d) => ({ kind: 'scanned', key: deviceKey(d), device: d }));
    const progress: UnifiedRow[] = [...progressItems]
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      .map((item) => ({ kind: 'progress', key: item.deviceId, item, status: deriveCommissioningStatus(item) }));
    return [...scanned, ...progress];
  }, [scannedRows, progressItems]);

  const hasActive = progressItems.some((p) => isActiveStatus(deriveCommissioningStatus(p)));
  useEffect(() => {
    if (!hasActive) return;
    const t = setInterval(refetchProgress, PROGRESS_POLL_INTERVAL_MS);
    return () => clearInterval(t);
  }, [hasActive, refetchProgress]);

  const hasUnenriched = devices.some((d) => !d.enriched);
  // Refs keep the poll cadence from resetting every time the device list changes (the poll itself calls setDevices).
  const devicesRef = useRef(devices);
  devicesRef.current = devices;
  const enrichingKeysRef = useRef(enrichingKeys);
  enrichingKeysRef.current = enrichingKeys;
  const enrichPlanByKeyRef = useRef(enrichPlanByKey);
  enrichPlanByKeyRef.current = enrichPlanByKey;
  const enrichStartedByKeyRef = useRef(enrichStartedByKey);
  enrichStartedByKeyRef.current = enrichStartedByKey;

  // Stop tracking an enrich (done, failed, expired, or cancelled): clears the spinner and both
  // localStorage maps so a dead plan cannot re-seed enrichingKeys across reloads/rescans.
  const clearEnrich = useCallback((key: string) => {
    setEnrichingKeys((prev) => new Set([...prev].filter((k) => k !== key)));
    setEnrichPlanByKey((prev) => {
      const { [key]: _plan, ...rest } = prev;
      return rest;
    });
    setEnrichStartedByKey((prev) => {
      const { [key]: _started, ...rest } = prev;
      return rest;
    });
  }, []);
  useEffect(() => {
    if (!hasUnenriched) return;
    const interval = setInterval(() => {
      refreshMutation
        .mutateAsync({ params: { zoneId }, body: { devices: devicesRef.current } })
        .then((res) => {
          if (res.status !== 200) return;
          setDevices(res.body.devices);
          const enrichedViaButton = res.body.devices.filter(
            (d) => d.enriched && enrichingKeysRef.current.has(deviceKey(d)),
          );
          if (enrichedViaButton.length > 0) {
            setValidatedKeys((prev) => {
              const next = new Set(prev);
              for (const d of enrichedViaButton) next.add(deviceKey(d));
              return [...next];
            });
          }
          const enrichedKeys = new Set(res.body.devices.filter((d) => d.enriched).map((d) => deviceKey(d)));
          for (const k of enrichedKeys) clearEnrich(k);
        })
        .catch((err: unknown) => {
          console.error('[commission] background enrichment poll failed:', err);
        });

      // The refresh only clears the spinner when data arrives, never for a failed/expired enrich saga — poll each in-flight plan and surface the outcome (enrichPollOutcome) instead of spinning forever.
      const applyEnrichOutcome = (key: string, action: EnrichPollAction): void => {
        if (action.kind === 'keep') return;
        clearEnrich(key);
        if (action.kind === 'expired') {
          setCommissionErrors((prev) => ({ ...prev, [key]: 'Enrichment expired — rescan' }));
          toast.error('Enrichment expired — rescan');
        } else if (action.kind === 'failed') {
          setCommissionErrors((prev) => ({ ...prev, [key]: `Enrichment failed: ${action.message}` }));
          toast.error(`Enrichment failed: ${action.message}`);
        }
      };

      for (const key of enrichingKeysRef.current) {
        const planId = enrichPlanByKeyRef.current[key];
        if (!planId) continue;
        const startedAt = enrichStartedByKeyRef.current[key];

        // Client-side backstop first: a plan past the grace window is dead even if the server
        // still answers 'pending' (its Redis plan is gone) — don't even bother polling it.
        const timedOut = enrichPollOutcome({
          status: 'pending',
          startedAt,
          now: Date.now(),
          timeoutMs: ENRICH_TIMEOUT_MS,
        });
        if (timedOut.kind !== 'keep') {
          applyEnrichOutcome(key, timedOut);
          continue;
        }

        tsr.pollCommissioningEnrichment
          .query({ params: { zoneId, planId } })
          .then((res) => {
            if (res.status !== 200) return;
            applyEnrichOutcome(
              key,
              enrichPollOutcome({
                status: res.body.status,
                startedAt,
                now: Date.now(),
                timeoutMs: ENRICH_TIMEOUT_MS,
                error: res.body.error,
              }),
            );
          })
          .catch((err: unknown) => console.error('[commission] enrich status poll failed:', err));
      }
    }, ENRICH_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasUnenriched, zoneId]);

  const buildPayload = useCallback(
    (d: ScannedDevice) => {
      const c = getCreds(deviceKey(d));
      return {
        id: deviceKey(d),
        bmcMac: c.bmcMac || d.bmcMac,
        bmcIp: d.bmcIp,
        bmcUsername: c.bmcUsername,
        bmcPassword: c.bmcPassword,
        nicMac: d.nicMac || undefined,
        nicIp: d.nicIp || undefined,
        osIp: c.osIp || undefined,
        serial: d.serial || undefined,
        enriched: d.enriched,
      };
    },
    [getCreds],
  );

  const handleEnrich = async (d: ScannedDevice) => {
    const key = deviceKey(d);
    const c = getCreds(key);
    if (!c.bmcUsername || !c.bmcPassword) return toast.error('Enter BMC username and password before enriching');
    try {
      const res = await enrichMutation.mutateAsync({
        params: { zoneId },
        body: { bmcIp: d.bmcIp, bmcUsername: c.bmcUsername, bmcPassword: c.bmcPassword },
      });
      if (res.status === 200) {
        setEnrichingKeys((prev) => new Set(prev).add(key));
        setEnrichPlanByKey((prev) => ({ ...prev, [key]: res.body.planId }));
        setEnrichStartedByKey((prev) => ({ ...prev, [key]: Date.now() }));
        setCommissionErrors((prev) => {
          if (!(key in prev)) return prev;
          const { [key]: _removed, ...rest } = prev;
          return rest;
        });
        toast.success('Enrichment started — the device will reboot into discovery');
      }
    } catch (err) {
      toast.error(unwrapErrorMessage(err, 'Failed to start enrichment'));
    }
  };

  const handleCancelEnrich = async (d: ScannedDevice) => {
    const key = deviceKey(d);
    const planId = enrichPlanByKey[key];
    clearEnrich(key);
    if (!planId) return;
    try {
      await cancelEnrichMutation.mutateAsync({ params: { zoneId, planId }, body: {} });
      toast.success('Enrichment cancelled');
    } catch (err) {
      toast.error(unwrapErrorMessage(err, 'Failed to cancel enrichment'));
    }
  };

  const handleValidate = async (d: ScannedDevice) => {
    const key = deviceKey(d);
    const c = getCreds(key);
    if (!c.bmcUsername || !c.bmcPassword) return toast.error('Enter BMC username and password before validating');
    setValidatingKeys((prev) => new Set(prev).add(key));
    try {
      const res = await validateMutation.mutateAsync({ params: { zoneId }, body: { devices: [buildPayload(d)] } });
      if (res.status === 200) {
        if (res.body.successfulTests > 0) {
          toast.success('Validation passed — device is ready to commission');
          setValidatedKeys((prev) => (prev.includes(key) ? prev : [...prev, key]));
        } else {
          toast.error(res.body.ipmiTestResults[0]?.message ?? 'Validation failed');
        }
      }
    } catch (err) {
      toast.error(unwrapErrorMessage(err, 'Validation failed'));
    } finally {
      setValidatingKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  const handleCommission = async (d: ScannedDevice) => {
    const key = deviceKey(d);
    const c = getCreds(key);
    if (!c.bmcUsername || !c.bmcPassword) return toast.error('Enter BMC username and password before commissioning');
    try {
      const res = await commissionMutation.mutateAsync({ params: { zoneId }, body: { devices: [buildPayload(d)] } });
      if (res.status === 200 && res.body.success) {
        toast.success(res.body.message);
        setCommissionErrors((prev) => {
          const { [key]: _removed, ...rest } = prev;
          return rest;
        });
        setDevices((prev) => prev.filter((x) => deviceKey(x) !== key));
        setValidatedKeys((prev) => prev.filter((k) => k !== key));
        refetchProgress();
      } else if (res.status === 200) {
        const message = res.body.failedDevices?.[0]?.error ?? res.body.message;
        setCommissionErrors((prev) => ({ ...prev, [key]: message }));
        toast.error(message);
      }
    } catch (err) {
      const message = unwrapErrorMessage(err, 'Commissioning failed');
      setCommissionErrors((prev) => ({ ...prev, [key]: message }));
      toast.error(message);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2">
            <ServerCommissionIcon className="h-5 w-5" />
            Commission Devices
          </CardTitle>
          <CardDescription>Scan management subnets. Enter BMC credentials, validate, then commission.</CardDescription>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={startSelectedScan}
          disabled={scanInProgress || scanDisabledReason !== undefined}
          title={scanDisabledReason}
        >
          <RefreshCw className={cn('mr-2 h-4 w-4', scanInProgress && 'animate-spin')} />
          Rescan
        </Button>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex min-w-[240px] flex-1 flex-col gap-1.5">
            <label htmlFor="commission-scan-target" className="text-sm font-medium">
              Scan subnets
            </label>
            <SubnetMultiSelect
              id="commission-scan-target"
              subnets={managementSubnets}
              selected={scanSubnets}
              onToggle={(subnet) => setSelectedSubnets(toggleSubnet(selectedSubnets, managementSubnets, subnet))}
            />
          </div>
          <Button
            variant="outline"
            onClick={startSelectedScan}
            disabled={scanInProgress || scanDisabledReason !== undefined}
            title={scanDisabledReason}
          >
            Scan
          </Button>
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <div className="flex min-w-[220px] flex-1 flex-col gap-1.5">
            <label htmlFor="commission-add-subnet" className="text-sm font-medium">
              Add a management subnet
            </label>
            <Input
              id="commission-add-subnet"
              placeholder="e.g. 10.99.1.0/24"
              value={customSubnet}
              onChange={(e) => setCustomSubnet(e.target.value)}
            />
          </div>
          <Button
            variant="secondary"
            onClick={addManagementSubnet}
            disabled={createPrefixMutation.isPending || customSubnet.trim() === ''}
          >
            Add management subnet
          </Button>
        </div>

        {scanInProgress && unifiedRows.length === 0 && (
          <div className="text-muted-foreground flex items-center justify-center gap-2 py-12 text-sm">
            <Loader2 className="h-5 w-5 animate-spin" />
            Scanning management subnets…
          </div>
        )}

        {scanError && (
          <div className="text-destructive bg-destructive/10 rounded-md p-4 text-sm">Scan failed: {scanError}</div>
        )}

        {!scanError && scanWarning && (
          <div className="rounded-md bg-amber-500/10 p-4 text-sm text-amber-700 dark:text-amber-400">{scanWarning}</div>
        )}

        {!scanError && (scanDone || unifiedRows.length > 0) && (
          <DevicesTable
            rows={unifiedRows}
            getCreds={getCreds}
            setCred={setCred}
            enrichingKeys={enrichingKeys}
            validatingKeys={validatingKeys}
            validatedKeys={validatedKeys}
            commissionErrors={commissionErrors}
            manufacturerByIdentity={manufacturerByIdentity}
            onEnrich={handleEnrich}
            onCancelEnrich={handleCancelEnrich}
            onValidate={handleValidate}
            onCommission={handleCommission}
            busy={isCommitting}
            onAcknowledge={async (deviceId) => {
              const res = await acknowledgeMutation.mutateAsync({ params: { zoneId, deviceId }, body: {} });
              if (res.status === 200) toast[res.body.success ? 'success' : 'error'](res.body.message);
              refetchProgress();
            }}
            onCancel={async (deviceId) => {
              const item = progressItems.find((p) => p.deviceId === deviceId);
              const res = await cancelMutation.mutateAsync({ params: { zoneId, deviceId }, body: {} });
              if (res.status === 200) toast[res.body.success ? 'success' : 'error'](res.body.message);
              if (item && res.status === 200 && res.body.success) {
                const caps = capabilitiesByIdentity[identityKey(item.bmcMac, item.bmcIp)];
                const restored: ScannedDevice = {
                  id: null,
                  bmcMac: item.bmcMac ?? '',
                  bmcIp: item.bmcIp ?? '',
                  nicMac: item.nicMac ?? '',
                  nicIp: item.nicIp ?? '',
                  hasIpmi: caps?.hasIpmi ?? false,
                  hasRedfish: caps?.hasRedfish ?? false,
                  serial: item.serial ?? '',
                  boardSerial: '',
                  chassisSerial: '',
                  manufacturer: manufacturerByIdentity[identityKey(item.bmcMac, item.bmcIp)] ?? '',
                  enriched: true,
                  commissioningStatus: 'Detected',
                };
                const key = deviceKey(restored);
                const creds = [item.bmcMac, item.nicMac, item.bmcIp]
                  .map((k) => (k ? getCreds(k) : null))
                  .find((c) => c && (c.bmcUsername || c.bmcPassword));
                if (creds) setCred(key, creds);
                setDevices((prev) => (prev.some((d) => deviceKey(d) === key) ? prev : [...prev, restored]));
                setValidatedKeys((prev) => (prev.includes(key) ? prev : [...prev, key]));
              }
              refetchProgress();
            }}
            onRetry={async (deviceId) => {
              const item = progressItems.find((p) => p.deviceId === deviceId);
              if (!item) return;
              const creds = [item.bmcMac, item.nicMac, item.bmcIp]
                .map((k) => (k ? getCreds(k) : null))
                .find((c) => c && c.bmcUsername && c.bmcPassword);
              if (!creds?.bmcUsername || !creds?.bmcPassword) {
                toast.error('No saved BMC credentials for this device — Cancel and commission it again.');
                return;
              }
              const bmcMac = item.bmcMac || creds.bmcMac;
              if (!bmcMac) {
                toast.error('No BMC MAC for this device — Cancel and re-scan before commissioning again.');
                return;
              }
              const res = await retryMutation.mutateAsync({
                params: { zoneId, deviceId },
                body: {
                  device: {
                    bmcMac,
                    bmcIp: item.bmcIp ?? '',
                    bmcUsername: creds.bmcUsername,
                    bmcPassword: creds.bmcPassword,
                    nicMac: item.nicMac ?? undefined,
                    nicIp: item.nicIp ?? undefined,
                    osIp: creds.osIp || undefined,
                    serial: item.serial ?? undefined,
                  },
                },
              });
              if (res.status === 200) toast[res.body.success ? 'success' : 'error'](res.body.message);
              refetchProgress();
            }}
            onRetryStep={async (deviceId) => {
              try {
                const res = await retryStepMutation.mutateAsync({ params: { zoneId, deviceId }, body: {} });
                if (res.status === 200) toast[res.body.success ? 'success' : 'error'](res.body.message);
              } catch (err) {
                toast.error(unwrapErrorMessage(err, 'Failed to retry step'));
              }
              refetchProgress();
            }}
          />
        )}
      </CardContent>
    </Card>
  );
}

function SubnetMultiSelect({
  id,
  subnets,
  selected,
  onToggle,
}: {
  id: string;
  subnets: string[];
  selected: string[];
  onToggle: (subnet: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-label="Select subnets to scan"
          className={cn(
            'group flex h-10 w-full items-center justify-between gap-x-1 px-3 py-2 font-mono text-xs',
            'bg-bg-primary text-text-primary',
            'border-text-muted border-t border-r-0 border-b border-l-0',
            'focus:border-accent focus:outline-none',
            'disabled:cursor-not-allowed disabled:opacity-50',
            'relative cursor-pointer',
          )}
        >
          <span className={cn('truncate text-left', selected.length === 0 && 'text-text-dim')}>
            {subnets.length === 0
              ? 'No management subnets'
              : selected.length === 0
                ? 'No subnets selected'
                : summarizeSubnets(selected)}
          </span>
          <ChevronDown className="text-text-muted h-4 w-4 shrink-0" />
          <span className="border-text-muted group-focus:border-accent pointer-events-none absolute -top-px -left-px h-2 w-2 border-t border-l group-disabled:opacity-50" />
          <span className="border-text-muted group-focus:border-accent pointer-events-none absolute -top-px -right-px h-2 w-2 border-t border-r group-disabled:opacity-50" />
          <span className="border-text-muted group-focus:border-accent pointer-events-none absolute -bottom-px -left-px h-2 w-2 border-b border-l group-disabled:opacity-50" />
          <span className="border-text-muted group-focus:border-accent pointer-events-none absolute -right-px -bottom-px h-2 w-2 border-r border-b group-disabled:opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--anchor-width)] p-0" align="start">
        <Command>
          <CommandList>
            <CommandEmpty>No management subnets.</CommandEmpty>
            <CommandGroup>
              {subnets.map((subnet) => (
                <CommandItem
                  key={subnet}
                  value={subnet}
                  onSelect={() => onToggle(subnet)}
                  className="gap-2 font-mono text-xs"
                >
                  <Checkbox checked={selected.includes(subnet)} tabIndex={-1} className="pointer-events-none" />
                  {subnet}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// Full expected saga step sequence by phase, so un-run steps still render as pending. Must track bridge execution order.
const DEFAULT_SAGA_STEPS: ReadonlyArray<{ name: string; operation: string; phase: string }> = [
  { name: 'ipmi_validation', operation: 'Validate IPMI credentials', phase: 'commission' },
  { name: 'redfish_standardize', operation: 'Standardize BIOS via Redfish', phase: 'commission' },
  { name: 'brokkr_live_check', operation: 'Check Brokkr Live readiness', phase: 'commission' },
  { name: 'disable_os_boot', operation: 'Disable OS boot options', phase: 'commission' },
  { name: 'live_reboot_power_off', operation: 'Power off server', phase: 'commission' },
  { name: 'live_reboot_verify_power_off', operation: 'Verify server powered off', phase: 'commission' },
  { name: 'live_reboot_set_boot_device', operation: 'Set boot device', phase: 'commission' },
  { name: 'live_reboot_verify_boot_device', operation: 'Verify boot device set', phase: 'commission' },
  { name: 'live_reboot_power_on', operation: 'Power on server', phase: 'commission' },
  { name: 'live_reboot_verify_power_on', operation: 'Verify server powered on', phase: 'commission' },
  { name: 'wait_for_brokkr_live', operation: 'Wait for Brokkr Live OS', phase: 'commission' },
  { name: 'disk_wipe', operation: 'Wipe all disks', phase: 'commission' },
  { name: 'collect_hardware', operation: 'Collect hardware facts', phase: 'commission' },
  { name: 'brokkr_live_check', operation: 'Check Brokkr Live readiness', phase: 'provision' },
  { name: 'live_reboot_power_off', operation: 'Power off server', phase: 'provision' },
  { name: 'live_reboot_verify_power_off', operation: 'Verify server powered off', phase: 'provision' },
  { name: 'live_reboot_set_boot_device', operation: 'Set boot device', phase: 'provision' },
  { name: 'live_reboot_verify_boot_device', operation: 'Verify boot device set', phase: 'provision' },
  { name: 'live_reboot_power_on', operation: 'Power on server', phase: 'provision' },
  { name: 'live_reboot_verify_power_on', operation: 'Verify server powered on', phase: 'provision' },
  { name: 'wait_for_brokkr_live', operation: 'Wait for Brokkr Live OS', phase: 'provision' },
  { name: 'disable_os_boot', operation: 'Disable OS boot options', phase: 'provision' },
  { name: 'tee_config', operation: 'Configure TEE via Redfish', phase: 'provision' },
  { name: 'resolve_deploy_target', operation: 'Resolve deploy target IP', phase: 'provision' },
  { name: 'wipe_disks', operation: 'Pre-deployment disk wipe', phase: 'provision' },
  { name: 'prepare_storage', operation: 'Partition and format disks', phase: 'provision' },
  { name: 'deploy_os', operation: 'Deploy operating system', phase: 'provision' },
  { name: 'power_off', operation: 'Power off server', phase: 'provision' },
  { name: 'verify_power_off', operation: 'Verify server powered off', phase: 'provision' },
  { name: 'set_boot_device', operation: 'Set boot device', phase: 'provision' },
  { name: 'verify_boot_device', operation: 'Verify boot device set', phase: 'provision' },
  { name: 'power_on', operation: 'Power on server', phase: 'provision' },
  { name: 'verify_power_on', operation: 'Verify server powered on', phase: 'provision' },
  { name: 'ensure_sol_enabled', operation: 'Ensure SOL is enabled on BMC', phase: 'provision' },
  { name: 'sol_activation', operation: 'Activate SOL monitoring', phase: 'provision' },
  { name: 'provision_complete', operation: 'Finalize provision', phase: 'provision' },
  { name: 'phone_home', operation: 'Wait for phone home', phase: 'provision' },
  { name: 'tee_disable', operation: 'Disable TEE via Redfish', phase: 'deprovision' },
  { name: 'disable_os_boot', operation: 'Disable OS boot options', phase: 'deprovision' },
  { name: 'ensure_sol_enabled', operation: 'Ensure SOL is enabled on BMC', phase: 'deprovision' },
  { name: 'sol_activation', operation: 'Activate SOL monitoring', phase: 'deprovision' },
  { name: 'power_off', operation: 'Power off server', phase: 'deprovision' },
  { name: 'verify_power_off', operation: 'Verify server powered off', phase: 'deprovision' },
  { name: 'set_boot_device', operation: 'Set boot device', phase: 'deprovision' },
  { name: 'verify_boot_device', operation: 'Verify boot device set', phase: 'deprovision' },
  { name: 'power_on', operation: 'Power on server', phase: 'deprovision' },
  { name: 'verify_power_on', operation: 'Verify server powered on', phase: 'deprovision' },
  { name: 'wait_for_brokkr_live', operation: 'Wait for Brokkr Live OS', phase: 'deprovision' },
  { name: 'disk_wipe', operation: 'Wipe all disks (NIST 800)', phase: 'deprovision' },
  { name: 'efi_cleanup', operation: 'Remove EFI boot entries', phase: 'deprovision' },
  { name: 'collect_hardware', operation: 'Collect hardware facts', phase: 'deprovision' },
  { name: 'device_promotion', operation: 'Promote to marketplace', phase: 'deprovision' },
] as const;

type PhaseStatus = 'complete' | 'failed' | 'running' | 'pending';

export function getPhaseStatus(items: Array<{ status: string }>): PhaseStatus {
  if (items.some((s) => s.status === 'failed')) return 'failed';
  if (items.some((s) => s.status === 'running')) return 'running';
  if (items.length > 0 && items.every((s) => s.status === 'complete')) return 'complete';
  return 'pending';
}

export function phaseFraction(items: Array<{ status: string }>): number {
  if (items.length === 0) return 0;
  return items.filter((s) => s.status === 'complete').length / items.length;
}

function RadialProgress({ fraction, status, size = 14 }: { fraction: number; status: PhaseStatus; size?: number }) {
  const strokeWidth = 1;
  const c = size / 2;
  const r = c - strokeWidth / 2;
  const f = Math.max(0, Math.min(1, fraction));
  const fillClass =
    status === 'failed'
      ? 'fill-destructive'
      : status === 'complete'
        ? 'fill-green-500'
        : status === 'running'
          ? 'fill-blue-500'
          : 'fill-transparent';
  const angle = f * 2 * Math.PI;
  const x = c + r * Math.sin(angle);
  const y = c - r * Math.cos(angle);
  const wedge = `M ${c} ${c} L ${c} ${(c - r).toFixed(3)} A ${r} ${r} 0 ${f > 0.5 ? 1 : 0} 1 ${x.toFixed(3)} ${y.toFixed(3)} Z`;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={cn(status === 'running' && 'animate-pulse')}
      aria-hidden
    >
      <circle cx={c} cy={c} r={r} className="fill-muted-foreground/15" />
      {f >= 1 ? (
        <circle cx={c} cy={c} r={r} className={fillClass} />
      ) : (
        f > 0 && <path d={wedge} className={fillClass} />
      )}
      <circle cx={c} cy={c} r={r} strokeWidth={strokeWidth} className="stroke-border fill-none" />
    </svg>
  );
}

function buildPhases(
  item: CommissioningProgressItem,
  status: CommissioningStatus,
): Array<{ title: string; items: Array<{ label: string; status: string }>; progressSteps: Array<{ status: string }> }> {
  const realStepMap = new Map((item.sagaSteps ?? []).map((s) => [`${s.name}:${s.phase}`, s]));
  const done = status === 'Done';
  const sagaItems = (phase: string) =>
    DEFAULT_SAGA_STEPS.filter((s) => s.phase === phase).map((s) => {
      const real = realStepMap.get(`${s.name}:${s.phase}`)?.status;
      return { label: s.operation, status: done ? 'complete' : (real ?? 'pending') };
    });
  const progressFor = (phase: string): Array<{ status: string }> =>
    done
      ? [{ status: 'complete' }]
      : (item.sagaSteps ?? []).filter((s) => s.phase === phase).map((s) => ({ status: s.status }));
  const setup = [
    { label: 'Server created', status: 'complete' },
    { label: 'Credentials saved', status: 'complete' },
  ];
  return [
    { title: 'Setup', items: setup, progressSteps: setup },
    { title: 'Server Prep', items: sagaItems('commission'), progressSteps: progressFor('commission') },
    { title: 'Provision Test', items: sagaItems('provision'), progressSteps: progressFor('provision') },
    { title: 'Deprovision', items: sagaItems('deprovision'), progressSteps: progressFor('deprovision') },
  ];
}

function DeviceProgress({
  item,
  status,
  onRetryStep,
}: {
  item: CommissioningProgressItem;
  status: CommissioningStatus;
  onRetryStep: () => void;
}) {
  const [open, setOpen] = useState(false);
  const phases = useMemo(() => buildPhases(item, status), [item, status]);
  // only surface a step error when Failed; a Done row can carry a stale failed Redis step (see deriveCommissioningStatus).
  const error = status === 'Failed' ? firstStepError(item.sagaSteps) : null;
  const title = item.bmcMac || item.bmcIp || 'Commissioning status';

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={error ?? 'Show step detail'}
        aria-label="Show commissioning step detail"
        className="hover:bg-muted/60 flex items-center gap-1.5 rounded py-1 pr-1.5"
      >
        {phases.map((p) => (
          <RadialProgress
            key={p.title}
            fraction={phaseFraction(p.progressSteps)}
            status={getPhaseStatus(p.progressSteps)}
          />
        ))}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-7xl">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>Per-stage commissioning step detail</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-4 gap-4">
            {phases.map((phase) => (
              <div key={phase.title} className="border-border bg-card rounded-lg border">
                <div className="border-border flex items-center gap-2 border-b px-3 py-2.5">
                  <StepIcon status={getPhaseStatus(phase.progressSteps)} size={18} />
                  <h4 className="text-sm font-semibold">{phase.title}</h4>
                </div>
                <div className="space-y-1.5 px-3 py-3">
                  {phase.items.map((step, idx) => (
                    <div key={idx} className="flex items-start gap-2">
                      <StepIcon status={step.status} size={16} className="mt-0.5 shrink-0" />
                      <span
                        className={cn(
                          'text-muted-foreground text-sm leading-tight',
                          step.status === 'failed' && 'text-destructive',
                        )}
                      >
                        {step.label}
                      </span>
                      {step.status === 'failed' && status === 'Failed' && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive hover:text-destructive ml-auto h-5 px-1.5 text-xs"
                          onClick={(e) => {
                            e.stopPropagation();
                            onRetryStep();
                            setOpen(false);
                          }}
                        >
                          <RefreshCw className="mr-0.5 h-3 w-3" />
                          Retry
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
          {error && <p className="text-destructive mt-2 text-sm">{error}</p>}
        </DialogContent>
      </Dialog>
    </>
  );
}

type DeviceFilterId = 'enriched' | 'reachable' | 'awaiting' | 'failed';

const DEVICE_FILTERS: ReadonlyArray<{
  id: DeviceFilterId;
  label: string;
  title?: string;
  scanned: (d: ScannedDevice, hasCreds: boolean) => boolean;
  progress: (status: CommissioningStatus) => boolean;
}> = [
  { id: 'enriched', label: 'Enriched', scanned: (d) => d.enriched, progress: () => true },
  {
    id: 'reachable',
    label: 'IPMI & Redfish active',
    scanned: (d) => d.hasIpmi && d.hasRedfish,
    progress: () => true,
  },
  { id: 'awaiting', label: 'Awaiting creds', scanned: (_d, hasCreds) => !hasCreds, progress: () => false },
  {
    id: 'failed',
    label: 'Needs attention',
    title: 'Devices that failed commissioning',
    scanned: () => false,
    progress: (status) => status === 'Failed',
  },
];

const DEVICE_FILTERS_BY_ID = Object.fromEntries(DEVICE_FILTERS.map((f) => [f.id, f])) as Record<
  DeviceFilterId,
  (typeof DEVICE_FILTERS)[number]
>;

type SortCol = 'bmcMac' | 'bmcIp' | 'nicMac' | 'serial' | 'manufacturer' | 'status';
type SortDir = 'asc' | 'desc';

const COMMISSION_COLUMNS: ReadonlyArray<{ key: SortCol | null; label: string; align?: 'right' }> = [
  { key: 'bmcMac', label: 'BMC MAC' },
  { key: 'bmcIp', label: 'BMC IP' },
  { key: 'nicMac', label: 'NIC MAC' },
  { key: null, label: 'NIC IP' },
  { key: 'serial', label: 'Serial' },
  { key: 'manufacturer', label: 'Manufacturer' },
  { key: null, label: 'Capabilities' },
  { key: null, label: 'Username' },
  { key: null, label: 'Password' },
  { key: 'status', label: 'Status' },
  { key: null, label: 'Actions', align: 'right' },
];

export function compareSortCell(col: SortCol, dir: SortDir, a: string, b: string): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  let r: number;
  if (col === 'bmcIp') {
    const ai = ipv4ToInt(a);
    const bi = ipv4ToInt(b);
    r = ai !== null && bi !== null ? ai - bi : a.localeCompare(b);
  } else {
    r = a.toLowerCase().localeCompare(b.toLowerCase());
  }
  return dir === 'asc' ? r : -r;
}

function rowSortValue(row: UnifiedRow, col: SortCol, enrichingKeys: Set<string>, validatedKeys: string[]): string {
  if (row.kind === 'scanned') {
    const d = row.device;
    switch (col) {
      case 'bmcMac':
        return d.bmcMac || '';
      case 'bmcIp':
        return d.bmcIp || '';
      case 'nicMac':
        return d.nicMac || '';
      case 'serial':
        return d.serial || '';
      case 'manufacturer':
        return d.manufacturer || '';
      case 'status':
        return scannedStatus(d, enrichingKeys.has(row.key), validatedKeys.includes(row.key)).label;
    }
  }
  const item = row.item;
  switch (col) {
    case 'bmcMac':
      return item.bmcMac || '';
    case 'bmcIp':
      return item.bmcIp || '';
    case 'nicMac':
      return item.nicMac || '';
    case 'serial':
      return item.serial || '';
    case 'manufacturer':
      return '';
    case 'status':
      return row.status;
  }
}

function DevicesTable({
  rows,
  getCreds,
  setCred,
  enrichingKeys,
  validatingKeys,
  validatedKeys,
  commissionErrors,
  manufacturerByIdentity,
  onEnrich,
  onCancelEnrich,
  onValidate,
  onCommission,
  onAcknowledge,
  onCancel,
  onRetry,
  onRetryStep,
  busy,
}: {
  rows: UnifiedRow[];
  getCreds: (key: string) => DeviceCredentials;
  setCred: (key: string, patch: Partial<DeviceCredentials>) => void;
  enrichingKeys: Set<string>;
  validatingKeys: Set<string>;
  validatedKeys: string[];
  commissionErrors: Record<string, string>;
  manufacturerByIdentity: Record<string, string>;
  onEnrich: (d: ScannedDevice) => void;
  onCancelEnrich: (d: ScannedDevice) => void;
  onValidate: (d: ScannedDevice) => void;
  onCommission: (d: ScannedDevice) => void;
  onAcknowledge: (deviceId: string) => void;
  onCancel: (deviceId: string) => void;
  onRetry: (deviceId: string) => void;
  onRetryStep: (deviceId: string) => void;
  busy: boolean;
}) {
  const [sort, setSort] = useState<{ col: SortCol; dir: SortDir } | null>(null);
  const [activeFilters, setActiveFilters] = useState<DeviceFilterId[]>([]);

  const hasRows = rows.length > 0;

  const toggleSort = (col: SortCol) =>
    setSort((prev) => {
      if (!prev || prev.col !== col) return { col, dir: 'asc' };
      if (prev.dir === 'asc') return { col, dir: 'desc' };
      return null;
    });
  const toggleFilter = (id: DeviceFilterId) =>
    setActiveFilters((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const filteredRows = useMemo(
    () =>
      rows.filter((row) =>
        activeFilters.every((id) => {
          const f = DEVICE_FILTERS_BY_ID[id];
          if (row.kind === 'scanned') {
            const c = getCreds(row.key);
            return f.scanned(row.device, c.bmcUsername.trim() !== '' && c.bmcPassword.trim() !== '');
          }
          return f.progress(row.status);
        }),
      ),
    [rows, activeFilters, getCreds],
  );

  const sortedRows = useMemo(() => {
    if (!sort) return filteredRows;
    return [...filteredRows].sort((a, b) =>
      compareSortCell(
        sort.col,
        sort.dir,
        rowSortValue(a, sort.col, enrichingKeys, validatedKeys),
        rowSortValue(b, sort.col, enrichingKeys, validatedKeys),
      ),
    );
  }, [filteredRows, sort, enrichingKeys, validatedKeys]);

  return (
    <div className="space-y-2">
      {hasRows && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-muted-foreground mr-1 text-xs font-medium">Filter:</span>
          {DEVICE_FILTERS.map((f) => {
            const active = activeFilters.includes(f.id);
            return (
              <Button
                key={f.id}
                size="sm"
                variant={active ? 'default' : 'outline'}
                className="h-7 px-2 text-xs"
                aria-pressed={active}
                title={f.title}
                onClick={() => toggleFilter(f.id)}
              >
                {f.label}
              </Button>
            );
          })}
          {activeFilters.length > 0 && (
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setActiveFilters([])}>
              Clear
            </Button>
          )}
          <span className="text-muted-foreground ml-auto text-xs">
            {sortedRows.length} of {rows.length} devices
          </span>
        </div>
      )}
      <Table className="table-auto [&_td]:px-1.5 [&_th]:px-1.5">
        <TableHeader>
          <TableRow>
            {COMMISSION_COLUMNS.map((col) => (
              <TableHead key={col.label} className={cn(col.align === 'right' && 'text-right')}>
                {col.key ? (
                  <button
                    type="button"
                    className="hover:text-accent/80 inline-flex items-center gap-1 uppercase"
                    onClick={() => toggleSort(col.key as SortCol)}
                  >
                    {col.label}
                    {sort?.col === col.key ? (
                      sort.dir === 'asc' ? (
                        <ArrowUp className="h-3 w-3" />
                      ) : (
                        <ArrowDown className="h-3 w-3" />
                      )
                    ) : (
                      <ArrowUpDown className="h-3 w-3 opacity-40" />
                    )}
                  </button>
                ) : (
                  col.label
                )}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {sortedRows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={COMMISSION_COLUMNS.length} className="py-8 text-center">
                {!hasRows ? (
                  <p className="text-muted-foreground text-sm">No devices discovered.</p>
                ) : (
                  <p className="text-muted-foreground text-sm">No devices match the active filters.</p>
                )}
              </TableCell>
            </TableRow>
          ) : (
            sortedRows.map((row) => {
              if (row.kind === 'scanned') {
                const d = row.device;
                const creds = getCreds(row.key);
                const isEnriching = enrichingKeys.has(row.key);
                const isValidating = validatingKeys.has(row.key);
                const isValidated = validatedKeys.includes(row.key);
                const hasCreds = creds.bmcUsername.trim() !== '' && creds.bmcPassword.trim() !== '';
                const st = scannedStatus(d, isEnriching, isValidated);
                const commissionError = commissionErrors[row.key];
                return (
                  <TableRow key={row.key}>
                    <TableCell className="font-mono text-xs">
                      {d.bmcMac || (
                        <div className="w-44">
                          <Input
                            value={creds.bmcMac}
                            onChange={(e) => setCred(row.key, { bmcMac: formatMacInput(e.target.value) })}
                            placeholder="BMC MAC"
                            className="h-8"
                          />
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{d.bmcIp || '-'}</TableCell>
                    <TableCell className="font-mono text-xs">{d.nicMac || (d.enriched ? '-' : '')}</TableCell>
                    <TableCell>
                      <div className="w-36">
                        <Input
                          value={creds.osIp}
                          onChange={(e) => setCred(row.key, { osIp: e.target.value })}
                          placeholder={d.nicIp || 'optional'}
                          className="h-8"
                        />
                      </div>
                    </TableCell>
                    <TableCell className="text-xs">{d.serial || (d.enriched ? '-' : '')}</TableCell>
                    <TableCell className="text-xs">{d.manufacturer || (d.enriched ? '-' : '')}</TableCell>
                    <TableCell className="space-x-1">
                      {d.hasIpmi && <Badge variant="secondary">IPMI</Badge>}
                      {d.hasRedfish && <Badge variant="secondary">Redfish</Badge>}
                    </TableCell>
                    <TableCell>
                      <div className="w-36">
                        <Input
                          value={creds.bmcUsername}
                          onChange={(e) => setCred(row.key, { bmcUsername: e.target.value })}
                          placeholder="root"
                          className="h-8"
                        />
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="w-36">
                        <Input
                          type="password"
                          value={creds.bmcPassword}
                          onChange={(e) => setCred(row.key, { bmcPassword: e.target.value })}
                          placeholder="••••••"
                          className="h-8"
                        />
                      </div>
                    </TableCell>
                    <TableCell className="text-xs">
                      {commissionError ? (
                        <span className="text-destructive" title={commissionError}>
                          Failed
                        </span>
                      ) : (
                        st.label
                      )}
                    </TableCell>
                    <TableCell className="space-x-1 text-right whitespace-nowrap">
                      {!d.enriched ? (
                        <span className="flex items-center gap-1">
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 px-2 text-xs"
                            disabled={busy || isEnriching || !hasCreds}
                            title={hasCreds ? undefined : 'Enter BMC username and password first'}
                            onClick={() => onEnrich(d)}
                          >
                            {isEnriching && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                            {isEnriching ? 'Enriching…' : 'Enrich'}
                          </Button>
                          {isEnriching && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 px-2 text-xs"
                              title="Cancel enrichment (the device never booted brokkr-live)"
                              onClick={() => onCancelEnrich(d)}
                            >
                              <X className="h-3 w-3" />
                            </Button>
                          )}
                        </span>
                      ) : !isValidated ? (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 px-2 text-xs"
                          disabled={busy || isValidating || !hasCreds}
                          title={hasCreds ? undefined : 'Enter BMC username and password first'}
                          onClick={() => onValidate(d)}
                        >
                          {isValidating && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                          {isValidating ? 'Validating…' : 'Validate'}
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant={commissionError ? 'outline' : 'default'}
                          className="h-7 px-2 text-xs"
                          disabled={busy}
                          onClick={() => onCommission(d)}
                        >
                          Commission
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              }

              const item = row.item;
              const status = row.status;
              const progCreds =
                [item.bmcMac, item.nicMac, item.bmcIp]
                  .map((k) => (k ? getCreds(k) : null))
                  .find((c) => c && (c.bmcUsername || c.bmcPassword)) ?? null;
              const manufacturer = manufacturerByIdentity[identityKey(item.bmcMac, item.bmcIp)] ?? '';
              return (
                <TableRow key={row.key}>
                  <TableCell className="font-mono text-xs">{item.bmcMac || '-'}</TableCell>
                  <TableCell className="font-mono text-xs">{item.bmcIp || '-'}</TableCell>
                  <TableCell className="font-mono text-xs">{item.nicMac || '-'}</TableCell>
                  <TableCell className="font-mono text-xs">{item.nicIp || '-'}</TableCell>
                  <TableCell className="text-xs">{item.serial || '-'}</TableCell>
                  <TableCell className="text-xs">{manufacturer || '-'}</TableCell>
                  <TableCell className="space-x-1">
                    <Badge variant="secondary">IPMI</Badge>
                    <Badge variant="secondary">Redfish</Badge>
                  </TableCell>
                  <TableCell className="text-xs">{progCreds?.bmcUsername || '-'}</TableCell>
                  <TableCell className="text-xs">••••••</TableCell>
                  <TableCell>
                    <DeviceProgress item={item} status={status} onRetryStep={() => onRetryStep(item.deviceId)} />
                  </TableCell>
                  <TableCell className="space-x-1 text-right whitespace-nowrap">
                    {status === 'Done' ? (
                      <Button size="sm" className="h-7 px-2 text-xs" onClick={() => onAcknowledge(item.deviceId)}>
                        <Check className="h-3 w-3" />
                        <span className="ml-1">Acknowledge</span>
                      </Button>
                    ) : status === 'Failed' ? (
                      <>
                        <Button size="sm" className="h-7 px-2 text-xs" onClick={() => onRetry(item.deviceId)}>
                          <RefreshCw className="h-3 w-3" />
                          <span className="ml-1">Retry</span>
                        </Button>
                        <Button
                          size="sm"
                          className="h-7 px-2 text-xs"
                          variant="outline"
                          onClick={() => onCancel(item.deviceId)}
                        >
                          <X className="h-3 w-3" />
                          <span className="ml-1">Cancel</span>
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="sm"
                        className="h-7 px-2 text-xs"
                        variant="outline"
                        onClick={() => onCancel(item.deviceId)}
                      >
                        <X className="h-3 w-3" />
                        <span className="ml-1">Cancel</span>
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
    </div>
  );
}
