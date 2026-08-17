import { Provider } from '@nestjs/common';
import { vi } from 'vitest';

// Canonical LoggerService test double: the method surface specs spy on, with
// setContext fluent (returns itself). Use this instead of hand-rolling the shape.
export function createLoggerMock() {
  return {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    verbose: vi.fn(),
    setContext: vi.fn().mockReturnThis(),
  };
}

export function createLoggerProvidersForTest(): Provider[] {
  const commonServiceNames = [
    'JobSchedulerService',
    'WebhookService',
    'WebhookDeliveryService',
    'DeploymentsService',
    'InventoryService',
    'OrganizationRoleGuard',
    'WebhookDeliveryService',
    'AdminService',
    'CloudInitTemplatesService',
  ];

  return commonServiceNames.map((serviceName) => ({
    provide: `LoggerService${serviceName}`,
    useValue: createLoggerMock(),
  }));
}
