import { Injectable } from '@nestjs/common';
import type { Prisma } from '@repo/database';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { LoggerService } from 'src/logger/logger.service';
import { PrismaClient } from 'src/prisma/prisma.client';

export type DiscoveryIssuePhase = 'INGRESS' | 'SCHEMA' | 'HANDLER' | 'COMPOSER' | 'COMMIT';
export type DiscoveryIssueSeverity = 'INFO' | 'WARN' | 'ERROR';

export interface DiscoveryRunIssueInput {
  runId: string;
  deviceId?: string;
  phase: DiscoveryIssuePhase;
  collector?: string | null;
  composer?: string | null;
  code: string;
  severity: DiscoveryIssueSeverity;
  detail?: Prisma.InputJsonValue;
}

@Injectable()
export class DiscoveryRunIssueRecorder {
  constructor(
    private readonly prisma: PrismaClient,
    @Logger(DiscoveryRunIssueRecorder.name) private readonly logger: LoggerService,
  ) {}

  async record(issue: DiscoveryRunIssueInput): Promise<void> {
    const identifier = issue.collector ?? issue.composer ?? null;
    const logLine = this.formatLogLine(issue, identifier);

    switch (issue.severity) {
      case 'ERROR':
        this.logger.error(logLine);
        break;
      case 'WARN':
        this.logger.warn(logLine);
        break;
      case 'INFO':
      default:
        this.logger.log(logLine);
        break;
    }

    try {
      await this.prisma.discoveryRunIssue.create({
        data: {
          runId: issue.runId,
          phase: issue.phase,
          collector: identifier,
          code: issue.code,
          severity: issue.severity,
          detail: issue.detail,
        },
      });
    } catch (error) {
      this.logger.error(
        `DiscoveryRunIssueRecorder: failed to persist issue row (runId=${issue.runId}, code=${issue.code}): ${getErrorMessage(error)}`,
      );
    }
  }

  async recordMany(issues: DiscoveryRunIssueInput[]): Promise<void> {
    await Promise.all(issues.map((i) => this.record(i)));
  }

  private formatLogLine(issue: DiscoveryRunIssueInput, identifier: string | null): string {
    const parts = [
      'discovery.issue',
      `phase=${issue.phase}`,
      `severity=${issue.severity}`,
      `code=${issue.code}`,
      `runId=${issue.runId}`,
    ];
    if (issue.deviceId) parts.push(`deviceId=${issue.deviceId}`);
    if (identifier) parts.push(`collector=${identifier}`);
    const detailStr = issue.detail ? ` — ${safeStringify(issue.detail)}` : '';
    return parts.join(' ') + detailStr;
  }
}

function safeStringify(value: unknown): string {
  try {
    const s = JSON.stringify(value);
    return s.length > 1024 ? `${s.slice(0, 1024)}…` : s;
  } catch {
    return String(value);
  }
}
