import { Injectable } from '@nestjs/common';
import { ReservationRecord } from './reservation.record';
import { CreateReservationInput } from './types/reservations.types';

@Injectable()
export class ReservationsService {
  async createReservation(data: CreateReservationInput) {
    return ReservationRecord.createReservation(data);
  }

  async endReservation(id: string) {
    return ReservationRecord.endByIdUnscoped(id);
  }

  async endReservationByDeviceId(deviceId: string) {
    return ReservationRecord.endByDeviceIdUnscoped(deviceId);
  }
}
