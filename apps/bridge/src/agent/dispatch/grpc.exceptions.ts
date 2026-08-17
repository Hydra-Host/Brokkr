import type { ProgressSnapshot } from '../result-publisher/result-publisher.service';

export class AgentNotConnected extends Error {
  readonly device_id: string;

  constructor(device_id: string) {
    super(`no local gRPC session for device ${device_id}`);
    this.name = 'AgentNotConnected';
    this.device_id = device_id;
  }
}

export class AgentNotResponsive extends Error {
  readonly device_id: string;
  readonly queue_depth: number;

  constructor(device_id: string, queue_depth: number) {
    super(`agent session for device ${device_id} is not draining (queue_depth=${queue_depth})`);
    this.name = 'AgentNotResponsive';
    this.device_id = device_id;
    this.queue_depth = queue_depth;
  }
}

export class DispatchTimeout extends Error {
  constructor(message?: string) {
    super(message ?? 'dispatch timeout');
    this.name = 'DispatchTimeout';
  }
}

export class DispatchStalled extends DispatchTimeout {
  readonly work_id: string;
  readonly last_progress: ProgressSnapshot | null;
  readonly stall_seconds: number;

  constructor(
    work_id: string,
    last_progress: ProgressSnapshot | null,
    stall_seconds: number,
    message = `dispatch stalled for work ${work_id} after ${stall_seconds}s without progress`,
  ) {
    super(message);
    this.name = 'DispatchStalled';
    this.work_id = work_id;
    this.last_progress = last_progress;
    this.stall_seconds = stall_seconds;
  }
}

export class DispatchCancelled extends Error {
  constructor(message?: string) {
    super(message ?? 'dispatch cancelled');
    this.name = 'DispatchCancelled';
  }
}

export class DispatchFailed extends Error {
  readonly code: string;
  readonly inner_message: string;
  readonly details: string | null;

  constructor(code: string, message: string, details: string | null = null) {
    super(`${code}: ${message}`);
    this.name = 'DispatchFailed';
    this.code = code;
    this.inner_message = message;
    this.details = details;
  }
}

export class AgentVersionMismatch extends Error {
  readonly device_id: string;
  readonly actual: string;
  readonly expected: string;

  constructor(device_id: string, actual: string, expected: string) {
    super(
      `agent on device ${device_id} reports version ${JSON.stringify(actual)}; bridge expects ${JSON.stringify(expected)}`,
    );
    this.name = 'AgentVersionMismatch';
    this.device_id = device_id;
    this.actual = actual;
    this.expected = expected;
  }
}
