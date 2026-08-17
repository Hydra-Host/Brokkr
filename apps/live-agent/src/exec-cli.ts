import { getHandler } from './dispatch/registry';
import { ensureError, getErrorMessage } from './errors';
import { registerCoreOperations } from './operations/index';
import { AGENT_VERSION } from './version';

async function main(): Promise<void> {
  const op = process.argv[2];
  const rawInput = process.argv[3] ?? '{}';

  if (!op) {
    process.stderr.write('usage: exec-cli <operation> [input_json]\n');
    process.exit(1);
  }

  registerCoreOperations({ agentVersion: AGENT_VERSION, collectionSnapshotDir: '/tmp/brokkr-harness-snapshots' });

  const reg = getHandler(op);
  if (!reg) {
    process.stderr.write(`unknown operation: ${op}\n`);
    process.exit(1);
  }

  let input: unknown;
  try {
    input = JSON.parse(rawInput);
  } catch (error) {
    process.stderr.write(`invalid input JSON: ${getErrorMessage(error)}\n`);
    process.exit(1);
  }

  const parsedInput = reg.input.safeParse(input);
  if (!parsedInput.success) {
    process.stderr.write(`input validation failed: ${JSON.stringify(parsedInput.error.format())}\n`);
    process.exit(1);
  }

  const abortController = new AbortController();
  const emittedResults: unknown[] = [];
  const ctx = {
    work_id: '00000000-0000-0000-0000-000000000000',
    job_id: 'validation',
    signal: abortController.signal,
    resultDelivered: Promise.resolve(),
    reportProgress: () => {},
    emit: async (msg: unknown) => {
      emittedResults.push(msg);
    },
  };

  try {
    const result = await reg.handler(parsedInput.data, ctx);
    const output = {
      operation: op,
      result,
      emitted: emittedResults.length > 0 ? emittedResults : undefined,
    };
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  } catch (error) {
    process.stderr.write(
      JSON.stringify({
        operation: op,
        error: getErrorMessage(error),
        stack: ensureError(error).stack,
      }) + '\n',
    );
    process.exit(2);
  }
}

main();
