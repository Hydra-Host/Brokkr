import {
  BillingFrequency,
  DeliveryStatus,
  Deployment,
  DeploymentLifecycleAction,
  DeploymentLifecycleActionType,
  DeploymentProject,
  DeploymentType,
  Device,
  DeviceNetworkType,
  DeviceRole,
  DeviceStatus,
  DeviceType,
  Member,
  Organization,
  OrganizationApiKey,
  OrganizationMembershipRole,
  RequestSource,
  Reservation,
  ReservationInvite,
  ServersInReservationInvite,
  SshKeys,
  TenantType,
  User,
  Webhook,
  WebhookDelivery,
  WebhookEventType,
} from '@repo/database';

import { randomUUID } from 'crypto';
import { UserWithOrganizations } from 'src/users/users.types';

export const mockUbuntuRescueOS = {
  id: randomUUID(),
  name: 'Ubuntu Rescue OS',
  slug: 'ubuntu-rescue-os',
};

export const mockUsers: User[] = [0, 1].map(
  (userNumber) =>
    ({
      id: randomUUID(),
      auth0Id: randomUUID(),
      firstName: `Test ${userNumber}`,
      lastName: `User ${userNumber}`,
      email: `test${userNumber}@test.com`,
      emailVerified: true,
      phoneNumber: '1234567890',
      phoneNumberVerified: true,
    }) as User,
);
export const mockUser = mockUsers[0];

export const mockDemandOrganization: Organization & {
  members: Member[];
} = {
  id: randomUUID(),
  name: 'Test Demand Organization',
  tenantType: TenantType.DemandCustomer,
  logo: null,
  metadata: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  auth0OrganizationId: randomUUID(),
  email: 'test@test.com',
  country: 'US',
  contactNotes: null,
  deletedAt: null,
  members: [],
  isInstanceOperator: false,
};

export const mockSupplyOrganization: Organization & {
  members: Member[];
} = {
  id: randomUUID(),
  name: 'Test Supply Organization',
  tenantType: TenantType.SupplyCustomer,
  logo: null,
  metadata: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  auth0OrganizationId: randomUUID(),
  email: 'test@test.com',
  country: 'US',
  contactNotes: null,
  deletedAt: null,
  members: [],
  isInstanceOperator: false,
};

export const mockSupplyOrganizationMembership: Member = {
  id: randomUUID(),
  userId: mockUser.id,
  organizationId: mockSupplyOrganization.id,
  role: OrganizationMembershipRole.Admin,
  assignedRoleId: randomUUID(),
  isDefaultOrg: null,
  deletedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};
mockSupplyOrganization.members.push(mockSupplyOrganizationMembership);

export const mockDeploymentProject: DeploymentProject = {
  id: randomUUID(),
  name: 'Test Deployment Project',
  isDefault: false,
  organizationId: mockSupplyOrganization.id,
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
};

export const mockReservation: Reservation = {
  id: randomUUID(),
  endDate: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
  internalProvision: false,
  notes: 'Test Reservation',
  reserverId: randomUUID(),
  customerId: randomUUID(),
  price: 1000,
  billingFrequency: BillingFrequency.MONTHLY,
  interruptibleNoticePeriod: null,
};

export const mockDeployment: Deployment & {
  deployer: User;
  customer: Organization;
  reservation: Reservation;
} = {
  id: randomUUID(),
  nickname: 'Test Deployment',
  customIpxeScript: false,
  startDate: new Date(),
  endDate: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  type: DeploymentType.SELF_SERVICE,
  isInterruptible: false,
  interruptibleNoticePeriod: null,
  serverId: randomUUID(),
  reservationId: mockReservation.id,
  reservation: mockReservation,
  scheduledInterruptionTime: null,
  deployerId: mockUser.id,
  customerId: mockDemandOrganization.id,
  deployer: mockUser,
  customer: mockDemandOrganization,
  baseLayerId: null,
  rescueLayerId: null,
  deploymentProjectId: randomUUID(),
  isLocked: false,
  publicIpAddressId: null,
  privateIpAddressId: null,
  cloudInitStorageBlock: null,
  cloudInitNetworkBlock: null,
  cloudInitLateCommands: null,
  diskEncryptionEnabled: false,
  gpuDriversEnabled: false,
};

export const mockDevice: Device & {
  supplier: Organization;
  deployments: Deployment[];
} = {
  id: randomUUID(),
  name: 'Test Device',
  nickname: 'Test Device Nickname',
  internalName: null,
  serial: null,
  systemSerial: null,
  status: DeviceStatus.PLANNED,
  role: null,
  deviceType: DeviceType.Baremetal,
  networkType: null,
  netplanOverride: null,
  netplanPopulation: null,
  systemUuid: null,
  productSku: null,
  assetTag: null,
  chassisSerial: null,
  baseboardSerial: null,
  secureBootEnabled: null,
  architecture: null,
  uefiBoot: null,
  iommuEnabled: null,
  sriovEnabled: null,
  zoneId: null,
  supplierId: mockSupplyOrganization.id,
  supplier: mockSupplyOrganization,
  skuId: randomUUID(),
  deviceModelId: null,
  configTemplateId: null,
  lastJobId: null,
  ipmiBootDeviceOverride: null,
  ipxeBuildTarget: null,
  bootFilename: null,
  deletedAt: null,
  deployments: [mockDeployment],
  createdAt: new Date(),
  updatedAt: new Date(),
};

export const mockDeviceMetadata = {
  id: 1,
  name: 'Test Device',
  status: 'provisioned',
  powerStatus: 'on',
  serial: '1234567890',
  role: DeviceRole.Baremetal,
  regionName: 'US East - N. Virginia',
  clusterId: 1,
  clusterName: 'Test Cluster',
  primaryIp4: '0.1.1.1',
  primaryIp6: '::1',
  ipmiIpAddress: '0.0.0.0',
  networkType: DeviceNetworkType.Public,
  vpcCapable: false,
  cpuModel: 'Intel Xeon',
  cpuThreadCount: 32,
  cpuCoreCount: 16,
  cpuPhysicalCount: 2,
  ipamConfig: {},
  virtualNetworkConfig: {},
  macAddress: '00:00:00:00:00:00',
  memory: 16,
  nvmeSize: 500,
  nvmeCount: 1,
  ssdSize: 250,
  ssdCount: 1,
  hddSize: 1000,
  hddCount: 1,
  gpuModel: 'NVIDIA Tesla V100',
  gpuCount: 1,
  ecoMode: false,
  createdAt: new Date(),
  updatedAt: new Date(),
  netrisDeviceId: 1,
  ipmiBootDeviceOverride: null,
  instanceId: null,
  serialPorts: null,
  lastJobId: null,
  purgeTtys: null,
  mgmtMac: null,
  teeEnabled: false,
  arch: null,
  ipxeBuildTarget: null,
  bootFilename: null,
  ipxeBuildVersion: null,
};

export const mockDeploymentLifecycleActionWithUser: DeploymentLifecycleAction & {
  user: User;
} = {
  id: randomUUID(),
  deploymentId: mockDeployment.id,
  actionType: DeploymentLifecycleActionType.Provision,
  source: RequestSource.API,
  performedBy: mockUser.id,
  performedAt: new Date(),
  user: mockUser,
};

export const mockDeviceAggregate = {
  ...mockDevice,
  supplier: mockSupplyOrganization,
  deployment: [mockDeployment],
  server: null,
};

export const mockSshKeys: SshKeys[] = [0, 1].map((keyNumber) => ({
  id: randomUUID(),
  name: `Test SSH Key ${keyNumber}`,
  dateCreated: new Date(),
  dateDeleted: null,
  fingerprint: 'test-fingerprint',
  key: `test-key-${keyNumber}`,
  userId: mockUser.id,
}));

export const mockReservationInvite: ReservationInvite = {
  id: randomUUID(),
  inviteeEmail: 'invitee@test.com',
  inviterEmail: 'inviter@test.com',
  dateAccepted: null,
  dateCreated: new Date(),
  dateDeleted: null,
  dateUpdated: new Date(),
  dateExpires: new Date(Date.now() + 7 * 24 * 3.6e6),
  organizationId: mockSupplyOrganization.id,
  reservationId: mockReservation.id,
  price: 100,
  billingFrequency: BillingFrequency.MONTHLY,
  notes: 'Test notes',
  manualBilling: false,
  interruptibleNoticePeriod: null,
  inviteeOrganizationId: mockSupplyOrganization.id,
};

export const mockServersInReservationInvite: ServersInReservationInvite & {
  reservationInvite: ReservationInvite;
} = {
  serverId: 'mock-server-id',
  reservationInviteId: mockReservationInvite.id,
  reservationInvite: mockReservationInvite,
};

export const mockReservationDTO = {
  id: randomUUID(),
  createdAt: new Date(),
  reserverId: randomUUID(),
  customerId: randomUUID(),
  endDate: new Date(),
  updatedAt: new Date(),
  notes: 'Test notes',
  internalProvision: true,
};

export const mockCustomerOrganization: Organization & {
  members: Member[];
} = {
  id: randomUUID(),
  name: 'Test Customer Organization',
  tenantType: TenantType.DemandCustomer,
  logo: null,
  metadata: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  auth0OrganizationId: randomUUID(),
  email: 'customer@test.com',
  country: 'US',
  contactNotes: null,
  deletedAt: null,
  members: [],
  isInstanceOperator: false,
};

export const mockCustomerOrganizationMembership: Member = {
  id: randomUUID(),
  userId: mockUser.id,
  organizationId: mockCustomerOrganization.id,
  role: OrganizationMembershipRole.Owner,
  assignedRoleId: randomUUID(),
  isDefaultOrg: null,
  deletedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};
mockCustomerOrganization.members.push(mockCustomerOrganizationMembership);

export const mockApiKey: OrganizationApiKey & { createdBy: User } = {
  id: randomUUID(),
  name: 'Test API Key',
  value: 'test-salt:test-hash',
  organizationId: mockCustomerOrganization.id,
  createdById: mockUser.id,
  createdAt: new Date(),
  expiresAt: new Date(Date.now() + 7 * 24 * 3.6e6),
  deletedAt: null,
  createdBy: mockUser,
};

export const mockWebhook: Webhook = {
  id: randomUUID(),
  organizationId: mockSupplyOrganization.id,
  endpoint: 'https://example.com/webhook',
  description: 'Test webhook for device listing events',
  events: [WebhookEventType.DEVICE_LISTING_CREATED, WebhookEventType.DEVICE_LISTING_UPDATED],
  secret: 'webhook-secret-key-123',
  isActive: true,
  failureCount: 0,
  lastFailureAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
};

export const mockInactiveWebhook: Webhook = {
  id: randomUUID(),
  organizationId: mockSupplyOrganization.id,
  endpoint: 'https://example.com/inactive-webhook',
  description: 'Inactive webhook after too many failures',
  events: [WebhookEventType.DEVICE_LISTING_DECOMMISSIONED],
  secret: 'webhook-secret-key-456',
  isActive: false,
  failureCount: 10,
  lastFailureAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
  createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
  updatedAt: new Date(),
  deletedAt: null,
};

export const mockWebhookDelivery: WebhookDelivery = {
  id: randomUUID(),
  webhookId: mockWebhook.id,
  eventType: WebhookEventType.DEVICE_LISTING_CREATED,
  payload: {
    id: mockDevice.id,
    name: mockDevice.name,
    metadata: {
      ...mockDeviceMetadata,
      createdAt: mockDeviceMetadata.createdAt.toISOString(),
      updatedAt: mockDeviceMetadata.updatedAt.toISOString(),
    },
  },
  idempotencyKey: randomUUID(),
  status: DeliveryStatus.SUCCESS,
  httpStatus: 200,
  responseBody: '{"success": true}',
  errorMessage: null,
  attempts: 1,
  nextRetryAt: null,
  processingLockedBy: null,
  processingLockedAt: null,
  processingLockExpires: null,
  createdAt: new Date(),
  deliveredAt: new Date(),
};

export const mockFailedWebhookDelivery: WebhookDelivery = {
  id: randomUUID(),
  webhookId: mockWebhook.id,
  eventType: WebhookEventType.DEVICE_LISTING_UPDATED,
  payload: {
    id: mockDevice.id,
    name: mockDevice.name,
    metadata: {
      ...mockDeviceMetadata,
      createdAt: mockDeviceMetadata.createdAt.toISOString(),
      updatedAt: mockDeviceMetadata.updatedAt.toISOString(),
    },
  },
  idempotencyKey: randomUUID(),
  status: DeliveryStatus.FAILED,
  httpStatus: 500,
  responseBody: '{"error": "Internal Server Error"}',
  errorMessage: 'HTTP 500: Internal Server Error',
  attempts: 5,
  nextRetryAt: null,
  processingLockedBy: null,
  processingLockedAt: null,
  processingLockExpires: null,
  createdAt: new Date(Date.now() - 60 * 60 * 1000),
  deliveredAt: null,
};

export const mockRetryingWebhookDelivery: WebhookDelivery = {
  id: randomUUID(),
  webhookId: mockWebhook.id,
  eventType: WebhookEventType.DEVICE_LISTING_CREATED,
  payload: {
    id: mockDevice.id,
    name: mockDevice.name,
    metadata: {
      ...mockDeviceMetadata,
      createdAt: mockDeviceMetadata.createdAt.toISOString(),
      updatedAt: mockDeviceMetadata.updatedAt.toISOString(),
    },
  },
  idempotencyKey: randomUUID(),
  status: DeliveryStatus.RETRYING,
  httpStatus: 408,
  responseBody: null,
  errorMessage: 'Request Timeout',
  attempts: 3,
  nextRetryAt: new Date(Date.now() + 5 * 60 * 1000),
  processingLockedBy: null,
  processingLockedAt: null,
  processingLockExpires: null,
  createdAt: new Date(Date.now() - 15 * 60 * 1000),
  deliveredAt: null,
};

export const mockPendingWebhookDelivery: WebhookDelivery = {
  id: randomUUID(),
  webhookId: mockWebhook.id,
  eventType: WebhookEventType.DEVICE_LISTING_CREATED,
  payload: {
    id: mockDevice.id,
    name: mockDevice.name,
    metadata: {
      ...mockDeviceMetadata,
      createdAt: mockDeviceMetadata.createdAt.toISOString(),
      updatedAt: mockDeviceMetadata.updatedAt.toISOString(),
    },
    eventType: WebhookEventType.DEVICE_LISTING_CREATED,
    timestamp: new Date().toISOString(),
  },
  idempotencyKey: randomUUID(),
  status: DeliveryStatus.PENDING,
  httpStatus: null,
  responseBody: null,
  errorMessage: null,
  attempts: 0,
  nextRetryAt: null,
  processingLockedBy: null,
  processingLockedAt: null,
  processingLockExpires: null,
  createdAt: new Date(),
  deliveredAt: null,
};

export const mockIntegrationSshKey: SshKeys = {
  id: randomUUID(),
  name: 'Integration Test SSH Key',
  dateCreated: new Date(),
  dateDeleted: null,
  fingerprint: 'integration-test-fingerprint',
  key: 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQC7vbqajDVdU... integration-test-key',
  userId: mockUser.id,
};

export const mockDeploymentInterruptedWebhook: Webhook = {
  id: randomUUID(),
  organizationId: mockSupplyOrganization.id,
  endpoint: 'https://example.com/webhook/deployment-interrupted',
  description: 'Webhook for deployment interruption notifications',
  events: [WebhookEventType.DEPLOYMENT_INTERRUPTED],
  secret: 'webhook-secret-deployment-interrupted',
  isActive: true,
  failureCount: 0,
  lastFailureAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
};

export const mockMultiEventWebhook: Webhook = {
  id: randomUUID(),
  organizationId: mockSupplyOrganization.id,
  endpoint: 'https://example.com/webhook/all-events',
  description: 'Webhook for multiple event types',
  events: [
    WebhookEventType.DEVICE_LISTING_CREATED,
    WebhookEventType.DEPLOYMENT_INTERRUPTED,
    WebhookEventType.DEVICE_LISTING_UPDATED,
  ],
  secret: 'webhook-secret-multi-event',
  isActive: true,
  failureCount: 0,
  lastFailureAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
};

export const mockDeploymentInterruptedDelivery: WebhookDelivery = {
  id: randomUUID(),
  webhookId: mockDeploymentInterruptedWebhook.id,
  eventType: WebhookEventType.DEPLOYMENT_INTERRUPTED,
  payload: {
    eventType: WebhookEventType.DEPLOYMENT_INTERRUPTED,
    data: {
      id: 999,
      location: 'US East - New York',
      status: { value: 'provisioned', label: 'Provisioned' },
      powerStatus: { value: 'on', label: 'on' },
      isInterruptible: true,
      scheduledInterruptionTime: new Date().toISOString(),
      role: { slug: 'compute' },
      customer: {
        deviceName: 'Test Deployment',
        organizationId: mockSupplyOrganization.id,
        provisionedDate: new Date().toISOString(),
        sshPubKeys: '',
        sshPubKeysIds: '',
        userId: mockUser.id,
      },
      listing: {
        price: {
          per_month: 720000,
          per_week: 168000,
          per_hour: 1000,
          gpu_per_hour: null,
        },
      },
      networking: {
        ipv4: '10.0.0.1',
        ipv6: '2001:db8::1',
        mac: null,
      },
      sshKeys: [],
      specs: {
        operating_system: 'Ubuntu 22.04',
        cpu: {
          coresPerCpu: 16,
          count: 1,
          model: null,
          threadsPerCore: 2,
          threadsPerCpu: 32,
          totalCores: 16,
          totalThreads: 32,
        },
        gpu: {
          count: 0,
          model: null,
        },
        memory: { total: 64 },
        storage: {
          hddCount: 0,
          hddSize: 0,
          nvmeCount: 0,
          nvmeSize: 0,
          ssdCount: 1,
          ssdSize: 1000,
          total: 1000,
        },
      },
      storageLayouts: null,
      defaultDiskLayouts: [],
      lifecycleActions: [],
    },
    timestamp: new Date().toISOString(),
  },
  status: DeliveryStatus.PENDING,
  attempts: 0,
  idempotencyKey: `deployment-interrupted-${randomUUID()}`,
  httpStatus: null,
  responseBody: null,
  errorMessage: null,
  nextRetryAt: null,
  processingLockedBy: null,
  processingLockedAt: null,
  processingLockExpires: null,
  createdAt: new Date(),
  deliveredAt: null,
};

export const mockUserWithOrganizations: UserWithOrganizations = {
  ...mockUser,
  members: [
    {
      ...mockSupplyOrganizationMembership,
      organization: mockSupplyOrganization,
    },
  ],
};

export const mockProjectWithDeployments = {
  ...mockDeploymentProject,
  deployments: [],
};
