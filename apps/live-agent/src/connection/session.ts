import { create } from '@bufbuild/protobuf';
import type { Client } from '@connectrpc/connect';
import { Code, ConnectError } from '@connectrpc/connect';

import { PROTOCOL_VERSION } from '@repo/bridge-agent-protocol';
import type { AgentConfig } from '../config';
import { dispatch } from '../dispatch/dispatcher';
import { getErrorMessage } from '../errors';
import type { AgentService, BridgeEndpoint } from '../gen/brokkr/agent/v1/agent_pb';
import {
  AgentRegistrationSchema,
  Arch,
  BundleRequest_Artifact,
  BundleRequestSchema,
  Readiness,
} from '../gen/brokkr/agent/v1/agent_pb';
import {
  OperationErrorSchema,
  WorkResponseSchema as ProtoWorkResponseSchema,
  WorkResponse_Status,
} from '../gen/brokkr/agent/v1/work_pb';
import { makeLogger } from '../logger';
import { firePhoneHomeOverGrpc, type PhoneHomeClientProvider } from '../phone-home';
import { AGENT_VERSION } from '../version';
import {
  protoToZodWorkRequest,
  zodCollectionResultToPartialResult,
  zodWorkProgressToProto,
  zodWorkResponseToProto,
} from './protocol-adapter';
import type { ResultReporter } from './result-reporter';
const logger = makeLogger('session');

type AgentServiceClient = Client<typeof AgentService>;

// Auth codes deliberately excluded: usually a transient token-expiry race before TokenRenewer fires; permanent eviction would strand a single-bridge zone until restart.
const PERMANENT_GRPC_CODES: ReadonlySet<Code> = new Set([Code.InvalidArgument, Code.NotFound, Code.FailedPrecondition]);

export interface HostsEntryView {
  ip: string;
  hostname: string;
}

export interface SessionCallbacks {
  onRegistered: (bridges: ReadonlyArray<{ address: string; bridge_id: string }>) => void;
  onTopologyUpdate: (
    bridges: ReadonlyArray<{ address: string; bridge_id: string }>,
    hostsEntries: ReadonlyArray<HostsEntryView>,
  ) => void;
}

export interface SessionResult {
  permanent: boolean;
}

function toTopology(endpoints: readonly BridgeEndpoint[]): ReadonlyArray<{ address: string; bridge_id: string }> {
  return endpoints.map((ep) => ({ address: ep.address, bridge_id: ep.bridgeId }));
}

function detectArch(): Arch {
  switch (process.arch) {
    case 'x64':
      return Arch.AMD64;
    case 'arm64':
      return Arch.ARM64;
    default:
      return Arch.UNSPECIFIED;
  }
}

export async function runSession(
  client: AgentServiceClient,
  bridgeAddr: string,
  config: AgentConfig,
  reporter: ResultReporter,
  callbacks: SessionCallbacks,
  signal: AbortSignal,
  getPhoneHomeClient: PhoneHomeClientProvider = () => client,
): Promise<SessionResult> {
  const registration = create(AgentRegistrationSchema, {
    protocolVersion: PROTOCOL_VERSION,
    deviceId: config.device_id,
    agentVersion: AGENT_VERSION,
    arch: detectArch(),
    readiness: Readiness.READY,
  });

  const sessionAbort = new AbortController();
  const onExternalAbort = () => sessionAbort.abort();
  if (signal.aborted) {
    return { permanent: false };
  }
  signal.addEventListener('abort', onExternalAbort, { once: true });

  const inflightAborts = new Map<string, AbortController>();

  let activeDispatches = 0;

  try {
    logger.info('opening gRPC session', { address: bridgeAddr });

    const stream = client.openSession(registration, {
      signal: sessionAbort.signal,
    });

    let registered = false;

    for await (const msg of stream) {
      switch (msg.kind.case) {
        case 'sessionAccepted': {
          const accepted = msg.kind.value;
          logger.info('gRPC session accepted', {
            address: bridgeAddr,
            bridge_id: accepted.bridgeId,
          });
          // Don't fail the session on version mismatch — staying alive lets the upgrade dispatch land.
          if (accepted.agentVersion && accepted.agentVersion !== AGENT_VERSION) {
            logger.warn('agent version drift detected', {
              address: bridgeAddr,
              bridge_id: accepted.bridgeId,
              agent_version: AGENT_VERSION,
              bridge_expected_version: accepted.agentVersion,
            });
          }
          registered = true;
          callbacks.onRegistered(toTopology(accepted.topology));
          void firePhoneHomeOverGrpc(getPhoneHomeClient, config);
          break;
        }

        case 'workRequest': {
          if (!registered) {
            logger.warn('received work_request before session_accepted, ignoring', {
              address: bridgeAddr,
            });
            break;
          }
          const protoReq = msg.kind.value;
          const parsed = protoToZodWorkRequest(protoReq);
          if (!parsed.ok) {
            logger.warn('work_request has invalid input bytes, replying with failure', {
              address: bridgeAddr,
              work_id: protoReq.workId,
              operation: protoReq.operation,
              error: parsed.response.error?.message,
            });
            reporter
              .reportResult(zodWorkResponseToProto(parsed.response), {
                preferredBridge: bridgeAddr,
              })
              .catch((err: unknown) =>
                logger.warn('reportResult failed for invalid-input response', {
                  work_id: protoReq.workId,
                  err: getErrorMessage(err),
                }),
              );
            break;
          }
          const zodReq = parsed.request;
          if (!zodReq.timeout_ms || zodReq.timeout_ms <= 0) {
            zodReq.timeout_ms = config.agent.work_timeout_default_ms;
          }
          logger.info('work received', {
            address: bridgeAddr,
            operation: zodReq.operation,
            work_id: zodReq.work_id,
            job_id: zodReq.job_id,
          });

          const reportErr = (rpc: string) => (err: unknown) =>
            logger.warn(`${rpc} failed after all bridge attempts`, {
              work_id: zodReq.work_id,
              err: getErrorMessage(err),
            });

          const sendFn = (
            outMsg:
              | import('@repo/bridge-agent-protocol').WorkResponse
              | import('@repo/bridge-agent-protocol').WorkProgress
              | import('@repo/bridge-agent-protocol').CollectionResult,
          ): void | Promise<void> => {
            const opts = { preferredBridge: bridgeAddr };
            switch (outMsg.type) {
              case 'work.response':
                return reporter.reportResult(zodWorkResponseToProto(outMsg), opts).catch((err: unknown) => {
                  reportErr('reportResult')(err);
                  throw err;
                });
              case 'work.progress':
                reporter.reportProgress(zodWorkProgressToProto(outMsg), opts).catch(reportErr('reportProgress'));
                break;
              case 'collection.result':
                return reporter
                  .reportPartialResult(zodCollectionResultToPartialResult(outMsg), opts)
                  .catch((err: unknown) => {
                    reportErr('reportPartialResult')(err);
                    throw err;
                  });
            }
          };

          const fetchArtifact = (sha256: string, artifact: 'bundle' | 'unit' | 'config'): AsyncIterable<Uint8Array> => {
            const artifactEnum =
              artifact === 'unit'
                ? BundleRequest_Artifact.UNIT
                : artifact === 'config'
                  ? BundleRequest_Artifact.CONFIG
                  : BundleRequest_Artifact.BUNDLE;
            const request = create(BundleRequestSchema, { sha256, artifact: artifactEnum });
            const bundleStream = client.fetchBundle(request, { signal: sessionAbort.signal });
            return (async function* () {
              for await (const chunk of bundleStream) {
                yield chunk.data;
              }
            })();
          };

          if (inflightAborts.has(zodReq.work_id)) {
            logger.warn('duplicate work_id while prior dispatch still in-flight', {
              address: bridgeAddr,
              work_id: zodReq.work_id,
              operation: zodReq.operation,
            });
            const alreadyInProgress = create(ProtoWorkResponseSchema, {
              workId: zodReq.work_id,
              status: WorkResponse_Status.ALREADY_IN_PROGRESS,
            });
            reporter.reportResult(alreadyInProgress, { preferredBridge: bridgeAddr }).catch(reportErr('reportResult'));
            break;
          }

          if (activeDispatches >= config.agent.max_concurrent_dispatches) {
            logger.warn('dispatch concurrency cap reached; throttling work', {
              address: bridgeAddr,
              work_id: zodReq.work_id,
              operation: zodReq.operation,
              inflight: activeDispatches,
              cap: config.agent.max_concurrent_dispatches,
            });
            const throttled = create(ProtoWorkResponseSchema, {
              workId: zodReq.work_id,
              status: WorkResponse_Status.FAILURE,
              error: create(OperationErrorSchema, {
                code: 'THROTTLED',
                message: `agent at dispatch capacity (${config.agent.max_concurrent_dispatches}); retry`,
              }),
            });
            reporter.reportResult(throttled, { preferredBridge: bridgeAddr }).catch(reportErr('reportResult'));
            break;
          }

          const workCtrl = new AbortController();
          const onSessionAbortForWork = () => workCtrl.abort();
          if (sessionAbort.signal.aborted) {
            workCtrl.abort();
          } else {
            sessionAbort.signal.addEventListener('abort', onSessionAbortForWork, { once: true });
          }
          inflightAborts.set(zodReq.work_id, workCtrl);
          activeDispatches += 1;
          let released = false;
          const releaseDispatch = (): void => {
            if (released) return;
            released = true;
            activeDispatches -= 1;
            // Don't evict a retried dispatch that replaced us.
            if (inflightAborts.get(zodReq.work_id) === workCtrl) {
              inflightAborts.delete(zodReq.work_id);
            }
            sessionAbort.signal.removeEventListener('abort', onSessionAbortForWork);
          };

          void dispatch(zodReq, sendFn, {
            parentSignal: workCtrl.signal,
            onCancellationSettled: releaseDispatch,
            fetchArtifact,
          })
            .finally(releaseDispatch)
            .catch((err) => {
              logger.error('dispatch promise escaped', {
                work_id: zodReq.work_id,
                err: getErrorMessage(err),
              });
            });
          break;
        }

        case 'topologyUpdate': {
          const update = msg.kind.value;
          logger.debug('gRPC topology update', {
            address: bridgeAddr,
            bridges: update.bridges.length,
            hosts_entries: update.hostsEntries.length,
          });
          callbacks.onTopologyUpdate(
            toTopology(update.bridges),
            update.hostsEntries.map((e) => ({ ip: e.ip, hostname: e.hostname })),
          );
          break;
        }

        case 'cancelWork': {
          const cancel = msg.kind.value;
          const ctrl = inflightAborts.get(cancel.workId);
          if (ctrl) {
            logger.info('cancel_work: aborting in-flight dispatch', {
              address: bridgeAddr,
              work_id: cancel.workId,
              reason: cancel.reason,
            });
            ctrl.abort();
          } else {
            logger.debug('cancel_work: no in-flight dispatch matches; already finished or never received', {
              address: bridgeAddr,
              work_id: cancel.workId,
              reason: cancel.reason,
            });
          }
          break;
        }

        default:
          logger.debug('ignoring unknown ServerMessage kind', {
            address: bridgeAddr,
            kind: msg.kind.case,
          });
      }
    }

    logger.info('gRPC session stream ended', { address: bridgeAddr });
    return { permanent: false };
  } catch (error) {
    if (sessionAbort.signal.aborted) {
      logger.info('gRPC session aborted', { address: bridgeAddr });
      return { permanent: false };
    }

    if (error instanceof ConnectError) {
      const permanent = PERMANENT_GRPC_CODES.has(error.code);
      logger.error('gRPC session error', {
        address: bridgeAddr,
        code: Code[error.code],
        message: error.message,
        permanent,
      });
      return { permanent };
    }

    logger.error('gRPC session unexpected error', {
      address: bridgeAddr,
      err: getErrorMessage(error),
    });
    return { permanent: false };
  } finally {
    signal.removeEventListener('abort', onExternalAbort);
    // Abort in-flight dispatches on session exit so subprocesses don't linger.
    if (!sessionAbort.signal.aborted) {
      sessionAbort.abort();
    }
  }
}
