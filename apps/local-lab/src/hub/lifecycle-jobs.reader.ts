import { Injectable, Logger } from '@nestjs/common';

import { getErrorMessage } from '../common/errors';
import { redactPayloadCapped } from '../common/redact';
import type { LifecycleJobDetail, LifecycleJobEventRow, LifecycleJobPage, LifecycleJobRow } from '../contract';
import { PgService } from '../datastore/pg.service';
import {
  EVENT_READ_CAP,
  LIFECYCLE_JOB_BY_ID_SQL,
  LIFECYCLE_JOB_EVENTS_SQL,
  LIFECYCLE_JOBS_SQL,
  LIFECYCLE_PHASE_COUNTS_SQL,
  LifecycleJobEventSqlRowSchema,
  type LifecycleJobSqlRow,
  LifecycleJobSqlRowSchema,
  LifecycleJobWithPayloadSchema,
  LifecyclePhaseCountSqlRowSchema,
} from './hub-sql';

type Timeline = Pick<LifecycleJobDetail, 'events' | 'eventsTruncated' | 'eventsSkipped' | 'eventsReadError'>;

export interface LifecycleJobQuery {
  phases: string[];
  deviceId: string | null;
  limit: number;
  offset: number;
}

/** The lateral join emits a whole event or none of it, so one null column means no event rather
 *  than a half-read one — but requiredText/requiredEpochMs would still reject that row wholesale. */
function toLatestStep(row: LifecycleJobSqlRow): LifecycleJobEventRow | null {
  if (row.stepId === null || row.sagaName === null || row.stepName === null) return null;
  if (row.eventType === null || row.stepStatus === null || row.recordedAt === null) return null;
  return {
    id: row.stepId,
    sagaName: row.sagaName,
    stepName: row.stepName,
    eventType: row.eventType,
    status: row.stepStatus,
    attempt: row.attempt ?? 0,
    error: row.stepError,
    occurredAtMs: row.occurredAt,
    recordedAtMs: row.recordedAt,
  };
}

function toRow(row: LifecycleJobSqlRow): LifecycleJobRow {
  return {
    id: row.id,
    jobType: row.jobType,
    phase: row.phase,
    deviceId: row.deviceId,
    deploymentId: row.deploymentId,
    source: row.source,
    performedBy: row.performedBy,
    error: row.error,
    scheduledAtMs: row.scheduledAt,
    phoneHomeDeadlineMs: row.phoneHomeDeadline,
    linkedJobId: row.linkedJobId,
    createdAtMs: row.createdAt,
    updatedAtMs: row.updatedAt,
    latestStep: toLatestStep(row),
  };
}

@Injectable()
export class LifecycleJobsReaderService {
  private readonly log = new Logger(LifecycleJobsReaderService.name);

  constructor(private readonly pg: PgService) {}

  async list(query: LifecycleJobQuery): Promise<LifecycleJobPage> {
    const census = await this.counts(query.deviceId);
    try {
      const { rows, skipped } = await this.pg.readTyped(
        LIFECYCLE_JOBS_SQL,
        [query.phases, query.deviceId, query.limit, query.offset],
        LifecycleJobSqlRowSchema,
      );
      if (skipped > 0) this.log.warn(`lifecycle jobs: skipped ${skipped} unreadable row(s)`);
      return { rows: rows.map(toRow), skipped, readError: null, ...census };
    } catch (error) {
      const readError = getErrorMessage(error);
      this.log.debug(`lifecycle job read failed: ${readError}`);
      return { rows: [], skipped: 0, readError, ...census };
    }
  }

  /** Counted separately from the page so it survives a failed listing, and reported as its own
   *  error so an unread census is never rendered as a fleet with nothing in it. */
  private async counts(deviceId: string | null): Promise<Pick<LifecycleJobPage, 'counts' | 'countsReadError'>> {
    try {
      const { rows } = await this.pg.readTyped(LIFECYCLE_PHASE_COUNTS_SQL, [deviceId], LifecyclePhaseCountSqlRowSchema);
      return { counts: rows.map((row) => ({ phase: row.phase, count: row.count })), countsReadError: null };
    } catch (error) {
      const countsReadError = getErrorMessage(error);
      this.log.debug(`lifecycle phase census failed: ${countsReadError}`);
      return { counts: [], countsReadError };
    }
  }

  /** A job the caller cannot find is a null job, not a 404: a stale deep link should render as
   *  "no such job" rather than an error page. Only a failed read is an error. */
  async get(jobId: string): Promise<LifecycleJobDetail> {
    const { rows } = await this.pg.readTyped(LIFECYCLE_JOB_BY_ID_SQL, [jobId], LifecycleJobWithPayloadSchema);
    const found = rows[0];
    if (!found) {
      return {
        job: null,
        payload: null,
        payloadTruncated: false,
        events: [],
        eventsTruncated: false,
        eventsSkipped: 0,
        eventsReadError: null,
      };
    }

    const payload = redactPayloadCapped(found.payload);
    const timeline = await this.events(jobId);
    return {
      job: toRow(found),
      payload: payload.value,
      payloadTruncated: payload.truncated,
      ...timeline,
    };
  }

  private async events(jobId: string): Promise<Timeline> {
    try {
      // one past the cap, so a full page is distinguishable from a job that happens to have exactly that many
      const { rows, skipped } = await this.pg.readTyped(
        LIFECYCLE_JOB_EVENTS_SQL,
        [jobId, EVENT_READ_CAP + 1],
        LifecycleJobEventSqlRowSchema,
      );
      const truncated = rows.length > EVENT_READ_CAP;
      const kept = truncated ? rows.slice(0, EVENT_READ_CAP) : rows;
      return {
        events: kept.reverse().map((row) => ({
          id: row.id,
          sagaName: row.sagaName,
          stepName: row.stepName,
          eventType: row.eventType,
          status: row.status,
          attempt: row.attempt,
          error: row.error,
          occurredAtMs: row.occurredAt,
          recordedAtMs: row.recordedAt,
        })),
        eventsTruncated: truncated,
        eventsSkipped: skipped,
        eventsReadError: null,
      };
    } catch (error) {
      const eventsReadError = getErrorMessage(error);
      this.log.debug(`lifecycle job timeline read failed for ${jobId}: ${eventsReadError}`);
      return { events: [], eventsTruncated: false, eventsSkipped: 0, eventsReadError };
    }
  }
}
