export enum Environments {
  Development = 'development',
  Production = 'production',
}

export enum FormNames {
  DEVICES_COMMISSION_FORM = 'dcimDevicesCommission',
  ADMIN_ADD_USER_TO_ORGANIZATION = 'adminAddUserToOrganization',
  ADMIN_REMOVE_USER_FROM_ORGANIZATION = 'adminRemoveUserFromOrganization',
  ADMIN_DELETE_INVITATION = 'adminDeleteInvitation',
  ADMIN_MARK_ORGANIZATION_TRUSTED = 'adminMarkOrganizationTrusted',
  ADMIN_DELETE_ORGANIZATION = 'adminDeleteOrganization',
  ADMIN_EDIT_RESERVATION = 'adminEditReservation',
  ADMIN_CREATE_RESERVATION_INVITATION = 'adminCreateReservationInvitation',
  ADMIN_UPDATE_RESERVATION_INVITATION = 'adminUpdateReservationInvitation',
  ADMIN_LINK_RESERVATION = 'adminLinkReservation',
  ADMIN_LOGS_QUERY_FORM = 'adminLogsQuery',
  BULK_PRICE_UPDATE_FORM = 'bulkPriceUpdate',
  BULK_END_RENTAL_FORM = 'bulkEndRental',
  CHANGE_PRICE_GROUP_FORM = 'changePriceGroup',
  CREATE_SUBSCRIPTION_FORM = 'createSubscription',
  CHANGE_SUBSCRIPTION_FORM = 'changeSubscription',
  DEPLOY_BRIDGES_FORM = 'deployBridges',
  DIAGNOSTICS_JOB_LOGS_FORM = 'diagnosticsJobLogs',
  DIAGNOSTICS_RETRY_JOB_FORM = 'diagnosticsRetryJob',
  DIRECT_PROVISION_CONFIGURE_DEVICE_FORM = 'directProvisionConfigureDevice',
  DEPLOYMENT_REPROVISION_FORM = 'deploymentReprovision',
  DEPLOYMENT_REPROVISION_CONFIRMATION_FORM = 'deploymentReprovisionConfirmation',
  DEVICE_PRICE_FORM = 'devicePrice',
  CREATE_RESERVATION_INVITATION = 'dcimCreateReservationInvitation',
  UPDATE_RESERVATION_INVITATION = 'dcimUpdateReservationInvitation',
  DIRECT_PROVISION_FORM = 'dcimDirectProvision',
  HELPDESK_FORM = 'helpDesk',
  SSH_KEY_FORM = 'sshKey',
  IS_LISTED_FORM = 'isListed',
  InventoryRequest = 'inventoryRequest',
  SET_BILLING_TERMS = 'setBillingTerms',
  WEBHOOK_CREATE = 'webhookCreate',
  WEBHOOK_EDIT = 'webhookEdit',
}

export enum DeviceStatus {
  Active = 'Active',
  Deprovisioned = 'Deprovisioned',
  Deprovisioning = 'Deprovisioning',
  Error = 'Error',
  Failed = 'Failed',
  Inventory = 'Inventory',
  Maintenance = 'Maintenance',
  Offline = 'Offline',
  Planned = 'Planned',
  PoweredOff = 'Powered Off',
  Provisioned = 'Provisioned',
  Provisioning = 'Provisioning',
  Queued = 'Queued',
  Rebooting = 'Rebooting',
  Reprovisioning = 'Reprovisioning',
  ShuttingDown = 'Shutting Down',
  Starting = 'Starting',
  Running = 'Running',
  Staged = 'Staged',
}

export const TRANSITIONAL_POWER_STATUSES: readonly string[] = [
  DeviceStatus.Rebooting,
  DeviceStatus.Starting,
  DeviceStatus.ShuttingDown,
] as const;

export const MAX_INTERRUPTIBLE_NOTICE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;

export enum ContractType {
  ON_DEMAND = 'ON_DEMAND',
  INTERRUPTIBLE = 'INTERRUPTIBLE',
  RESERVED_ROLLING = 'RESERVED_ROLLING',
  RESERVED = 'RESERVED',
}

export enum BillingFrequency {
  HOURLY = 'HOURLY',
  WEEKLY = 'WEEKLY',
  MONTHLY = 'MONTHLY',
}

export enum CollectionMethod {
  CHARGED_AUTOMATICALLY = 'CHARGED_AUTOMATICALLY',
  SEND_INVOICE = 'SEND_INVOICE',
}

export enum SubscriptionItemType {
  DEVICE = 'DEVICE',
  OFF_BROKKR_DEVICE = 'OFF_BROKKR_DEVICE',
  DOWN_PAYMENT = 'DOWN_PAYMENT',
}

export enum SubscriptionStatus {
  ACTIVE = 'ACTIVE',
  CANCELLED = 'CANCELLED',
  NEW = 'NEW',
}

export enum WebhookEvent {
  DEVICE_LISTING_UPDATED = 'DEVICE_LISTING_UPDATED',
  DEVICE_LISTING_CREATED = 'DEVICE_LISTING_CREATED',
  DEVICE_LISTING_DECOMMISSIONED = 'DEVICE_LISTING_DECOMMISSIONED',
  DEPLOYMENT_INTERRUPTED = 'DEPLOYMENT_INTERRUPTED',
  DEPLOYMENT_INTERRUPTION_COMPLETED = 'DEPLOYMENT_INTERRUPTION_COMPLETED',
}

export const availableWebhookEvents = [
  {
    id: WebhookEvent.DEVICE_LISTING_UPDATED,
    name: 'Device Listing Updated',
    value: WebhookEvent.DEVICE_LISTING_UPDATED,
  },
  {
    id: WebhookEvent.DEVICE_LISTING_CREATED,
    name: 'Device Listing Created',
    value: WebhookEvent.DEVICE_LISTING_CREATED,
  },
  {
    id: WebhookEvent.DEVICE_LISTING_DECOMMISSIONED,
    name: 'Device Listing Decommissioned',
    value: WebhookEvent.DEVICE_LISTING_DECOMMISSIONED,
  },
  {
    id: WebhookEvent.DEPLOYMENT_INTERRUPTED,
    name: 'Deployment Interrupted',
    value: WebhookEvent.DEPLOYMENT_INTERRUPTED,
  },
  {
    id: WebhookEvent.DEPLOYMENT_INTERRUPTION_COMPLETED,
    name: 'Deployment Interruption Completed',
    value: WebhookEvent.DEPLOYMENT_INTERRUPTION_COMPLETED,
  },
];

export enum TransactionType {
  PAYMENT = 'PAYMENT',
  REFUND = 'REFUND',
  CREDIT = 'CREDIT',
}

export enum TransactionStatus {
  PENDING = 'PENDING',
  SETTLED = 'SETTLED',
  FAILED = 'FAILED',
}

export enum TenantType {
  DemandCustomer = 'DemandCustomer',
  SupplyCustomer = 'SupplyCustomer',
}

export enum NetTerms {
  P7D = 'P7D',
  P15D = 'P15D',
  P30D = 'P30D',
}

export enum InvoiceStatus {
  GATHERING = 'gathering',
  DRAFT = 'draft',
  ISSUING = 'issuing',
  ISSUED = 'issued',
  PAYMENT_PROCESSING = 'payment_processing',
  OVERDUE = 'overdue',
  PAID = 'paid',
  UNCOLLECTIBLE = 'uncollectible',
  VOIDED = 'voided',
}
