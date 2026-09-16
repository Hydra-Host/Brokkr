import { EventEmitter } from 'node:events';

export function fakeVirshChild(stdout: string) {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter() });
  setImmediate(() => {
    child.stdout.emit('data', Buffer.from(stdout));
    child.emit('close', 0);
  });
  return child;
}
