import type { ReprovisionDeploymentRequest, ReprovisionDiskLayout, UpdateDeploymentRequest } from '@repo/api-client';
import {
  DeploymentType,
  Device,
  Interface,
  IpAddress,
  JobType,
  LifecycleJobPhase,
  Organization,
  Prisma,
  ReservationInvite,
  Server,
  ServersInReservationInvite,
} from '@repo/database';
import { hardwareSummaryInclude } from '@repo/device-domain';

export type UpdateDeploymentRecordDTO = UpdateDeploymentRequest;

export type ReprovisionDeploymentInput = Required<
  Pick<ReprovisionDeploymentRequest, 'deploymentName' | 'operatingSystem' | 'sshKeyIds'>
> & {
  projectId?: string;
  diskLayouts: ReprovisionDiskLayout[];
} & Pick<
    ReprovisionDeploymentRequest,
    'cloudInit' | 'cloudInitTemplateId' | 'cloudInitTemplateName' | 'ipxeUrl' | 'customizations' | 'tee'
  >;

export type DeviceAggregate = Device & {
  supplier: Organization;
  interfaces: (Interface & { ipAddresses: IpAddress[] })[];
  server:
    | (Server & {
        serversInReservationInvite: (ServersInReservationInvite & {
          reservationInvite: ReservationInvite & {
            inviteeOrganization: Organization;
          };
        })[];
      })
    | null;
};

export type CreateDeploymentData = {
  nickname: string;
  customIpxeScript: boolean;
  sshKeyIds: string[];
  deviceId: string;
  reservationId?: string;
  baseLayerId: string;
  deployerId: string;
  customerId: string;
  type: DeploymentType;
  projectId?: string;
  diskEncryptionEnabled?: boolean;
  isInterruptible?: boolean;
  interruptibleNoticePeriod?: number | null;
};

export const ExportLogsJobTypeEnum = {
  Provision: JobType.Provision,
  Reprovision: JobType.Reprovision,
} as const;

export type ExportLogsJobType = (typeof ExportLogsJobTypeEnum)[keyof typeof ExportLogsJobTypeEnum];

const deploymentServerInclude = () =>
  ({
    device: {
      include: {
        supplier: true,
        zone: { select: { name: true, region: { select: { name: true } } } },
        interfaces: {
          where: { deletedAt: null },
          include: {
            ipAddresses: {
              where: { deletedAt: null },
              include: { natOutside: { where: { deletedAt: null }, select: { address: true } } },
            },
          },
        },
        ...hardwareSummaryInclude,
      },
    },
    serversInReservationInvite: {
      where: {
        reservationInvite: {
          dateAccepted: null,
          dateDeleted: null,
          dateExpires: { gt: new Date() },
        },
      },
      include: {
        reservationInvite: {
          include: { inviteeOrganization: true },
        },
      },
    },
  }) satisfies Prisma.ServerInclude;

export const deploymentAggregateInclude = () =>
  ({
    deployer: true,
    server: { include: deploymentServerInclude() },
    baseLayer: true,
    rescueLayer: true,
    deploymentKeys: {
      include: {
        // Name-only select: the full User row would leak PII to org members (ts-rest does not strip it).
        sshKey: {
          include: { user: { select: { firstName: true, lastName: true } } },
        },
      },
    },
    lifecycleActions: {
      include: { user: true },
      orderBy: { performedAt: 'desc' as const },
    },
    lifecycleRequests: {
      include: { requestedBy: true },
      orderBy: { createdAt: 'desc' as const },
    },
    lifecycleJobs: {
      where: { phase: LifecycleJobPhase.DEFERRED, jobType: { in: [JobType.Provision, JobType.Reprovision] } },
      select: { id: true },
      take: 1,
    },
    deploymentProject: true,
    deviceDiagnostics: { orderBy: { createdAt: 'desc' as const } },
  }) satisfies Prisma.DeploymentInclude;

export const deploymentListAggregateInclude = () =>
  ({
    deployer: true,
    server: { include: deploymentServerInclude() },
    baseLayer: true,
    rescueLayer: true,
    deploymentKeys: {
      include: {
        sshKey: {
          include: { user: { select: { firstName: true, lastName: true } } },
        },
      },
    },
    lifecycleActions: {
      include: { user: true },
      orderBy: { performedAt: 'desc' as const },
    },
    lifecycleRequests: {
      include: { requestedBy: true },
      orderBy: { createdAt: 'desc' as const },
    },
    lifecycleJobs: {
      where: { phase: LifecycleJobPhase.DEFERRED, jobType: { in: [JobType.Provision, JobType.Reprovision] } },
      select: { id: true },
      take: 1,
    },
    deploymentProject: true,
    deviceDiagnostics: { orderBy: { createdAt: 'desc' as const } },
  }) satisfies Prisma.DeploymentInclude;

export type DeploymentAggregate = Prisma.DeploymentGetPayload<{
  include: ReturnType<typeof deploymentAggregateInclude>;
}>;
