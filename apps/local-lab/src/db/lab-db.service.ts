import { Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';

import { closeDb, getDb } from './db';

@Injectable()
export class LabDbService implements OnModuleInit, OnApplicationShutdown {
  // opening from onModuleInit rather than the constructor: `Test.createTestingModule().compile()`
  // instantiates providers without running hooks, so a module-graph test creates no real database.
  onModuleInit(): void {
    getDb();
  }

  onApplicationShutdown(): void {
    closeDb();
  }
}
