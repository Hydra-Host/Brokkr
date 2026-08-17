import { BillingFrequency, Deployment, Device, Organization, Reservation, ReservationInvite } from '@repo/database';

export type ReservationUser = {
  id: string;
  name: string | null;
  email: string;
};

export type DeviceAggregate = Device & { supplier: Organization };

type ReservationDeviceType = Device & { supplier: Organization };

export type ReservationAggregate = Reservation & {
  deployments?: Deployment[];
  reserver: ReservationUser;
  customer: Organization;
  devices: ReservationDeviceType[];
  reservationInvite?: ReservationInvite | null;
};

export type CreateReservationInput = {
  reserverId: string;
  customerId: string;
  deviceIds: string[];
  internalProvision: boolean;
  notes: string | null;
  price: number | null;
  billingFrequency: BillingFrequency | null;
  interruptibleNoticePeriod: number | null;
  reservationInviteId?: string | null;
};
