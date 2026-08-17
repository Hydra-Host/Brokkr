import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { DiscoveryEventName, DiscoveryEventPayloads } from './discovery.events';

@Injectable()
export class DiscoveryEventsService {
  constructor(private readonly emitter: EventEmitter2) {}

  emit<E extends DiscoveryEventName>(name: E, payload: DiscoveryEventPayloads[E]): void {
    this.emitter.emit(name, payload);
  }
}
