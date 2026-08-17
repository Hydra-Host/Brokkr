import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dispatchContext } from '.././dispatch/context';
import { CommandAborted, CommandOutputTooLarge, CommandTimeout, run } from '.././exec';
import { type BufferedEntry, setLevel, setLogSink } from '.././logger';

describe('run() terminal outcomes', () => {
  it('resolves with the exit code and captured streams on a normal exit', async () => {
    const result = await run('/bin/sh', ['-c', 'echo out; echo err 1>&2; exit 0'], { timeout_ms: 5_000 });
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toBe('out\n');
    expect(result.stderr).toBe('err\n');
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('resolves (does not reject) on a nonzero exit, surfacing exit_code + stderr', async () => {
    const result = await run('/bin/sh', ['-c', 'echo boom 1>&2; exit 3'], { timeout_ms: 5_000 });
    expect(result.exit_code).toBe(3);
    expect(result.stderr).toBe('boom\n');
  });

  it('rejects with CommandTimeout when the command outlives timeout_ms', async () => {
    await expect(run('/bin/sh', ['-c', 'sleep 5'], { timeout_ms: 100 })).rejects.toBeInstanceOf(CommandTimeout);
  });

  it('throws CommandAborted synchronously when the signal is already aborted before spawn', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(run('/bin/sh', ['-c', 'sleep 5'], { signal: ac.signal })).rejects.toBeInstanceOf(CommandAborted);
  });

  it('rejects with CommandAborted when the signal aborts mid-run', async () => {
    const ac = new AbortController();
    const p = run('/bin/sh', ['-c', 'sleep 5'], { signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    await expect(p).rejects.toBeInstanceOf(CommandAborted);
  });

  it('rejects with the raw spawn error (not a Command* subclass) when the binary is missing', async () => {
    await expect(run('/nonexistent/definitely-not-a-real-binary-xyz', [])).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

describe('run() stdout/stderr overflow', () => {
  it('rejects with CommandOutputTooLarge when stdout exceeds the cap', async () => {
    await expect(
      run('/bin/sh', ['-c', "yes 'x' | head -c $((2 * 1024 * 1024))"], {
        max_stdout_chars: 64 * 1024,
        timeout_ms: 10_000,
      }),
    ).rejects.toMatchObject({
      stream: 'stdout',
      cap_chars: 64 * 1024,
    });
  });

  it('surfaces the overflow error as a CommandOutputTooLarge instance', async () => {
    const p = run('/bin/sh', ['-c', "yes 'x' | head -c $((512 * 1024))"], {
      max_stdout_chars: 1024,
      timeout_ms: 10_000,
    });
    await expect(p).rejects.toBeInstanceOf(CommandOutputTooLarge);
  });

  it('rejects with CommandOutputTooLarge when stderr exceeds the cap', async () => {
    await expect(
      run('/bin/sh', ['-c', "yes 'x' | head -c $((2 * 1024 * 1024)) 1>&2"], {
        max_stderr_chars: 64 * 1024,
        timeout_ms: 10_000,
      }),
    ).rejects.toMatchObject({
      stream: 'stderr',
      cap_chars: 64 * 1024,
    });
  });

  it('does not fire the cap on small, in-budget stdout', async () => {
    const result = await run('/bin/sh', ['-c', 'echo hello'], {
      max_stdout_chars: 1024 * 1024,
      timeout_ms: 10_000,
    });
    expect(result.exit_code).toBe(0);
    expect(result.stdout.trim()).toBe('hello');
  });

  it('collects >1 MiB stdout correctly in linear time', async () => {
    const bytes = 2 * 1024 * 1024;
    const start = Date.now();
    const result = await run('/bin/sh', ['-c', `head -c ${bytes} /dev/zero | tr '\\0' 'A'`], {
      max_stdout_chars: 4 * 1024 * 1024,
      timeout_ms: 15_000,
    });
    const elapsed = Date.now() - start;
    expect(result.exit_code).toBe(0);
    expect(result.stdout.length).toBe(bytes);
    expect(result.stdout[0]).toBe('A');
    expect(result.stdout[result.stdout.length - 1]).toBe('A');
    expect(elapsed).toBeLessThan(5_000);
  });
});

describe('run() piped Readable stdin', () => {
  it('does not crash when child exits before source finishes writing', async () => {
    let pushed = 0;
    const source = new Readable({
      read() {
        if (pushed++ < 1000) this.push('x'.repeat(1024));
        else this.push(null);
      },
    });
    const result = await run('/bin/sh', ['-c', 'exit 0'], {
      stdin: source,
      timeout_ms: 5_000,
    });
    expect(result.exit_code).toBe(0);
  });

  it('does not crash when source emits an error mid-pipe', async () => {
    const source = new Readable({
      read() {
        this.destroy(new Error('source explodes'));
      },
    });
    const result = await run('/bin/sh', ['-c', 'cat > /dev/null; exit 0'], {
      stdin: source,
      timeout_ms: 5_000,
    });
    expect(result.exit_code).toBe(0);
  });
});

describe('run() onStdoutLine', () => {
  it('invokes onStdoutLine for each line, no trailing partial line', async () => {
    const lines: string[] = [];
    await run('/bin/sh', ['-c', 'printf "alpha\\nbeta\\ngamma\\n"'], {
      timeout_ms: 5_000,
      onStdoutLine: (line) => lines.push(line),
    });
    expect(lines).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('still returns the full buffered stdout in the result', async () => {
    const lines: string[] = [];
    const result = await run('/bin/sh', ['-c', 'printf "one\\ntwo\\n"'], {
      timeout_ms: 5_000,
      onStdoutLine: (line) => lines.push(line),
    });
    expect(result.stdout).toBe('one\ntwo\n');
    expect(lines).toEqual(['one', 'two']);
  });

  it('treats CR and LF the same as line terminators', async () => {
    const lines: string[] = [];
    await run('/bin/sh', ['-c', 'printf "carriage\\rreturn\\n"'], {
      timeout_ms: 5_000,
      onStdoutLine: (line) => lines.push(line),
    });
    expect(lines).toContain('carriage');
    expect(lines).toContain('return');
  });
});

describe('run() default streaming through the agent logger', () => {
  let captured: BufferedEntry[];
  beforeEach(() => {
    captured = [];
    setLogSink((e) => captured.push(e));
  });
  afterEach(() => {
    setLogSink(null);
  });

  it('stdout streaming defaults to trace — filtered out at the default info threshold', async () => {
    await run('/bin/echo', ['phase=1'], { timeout_ms: 5_000 });
    const fromEcho = captured.filter((e) => e.app_class_name === 'echo');
    expect(fromEcho).toEqual([]);
  });

  it('forwards stdout lines when stdout_level is opted up to info', async () => {
    await run('/bin/echo', ['phase=1'], {
      timeout_ms: 5_000,
      stdout_level: 'info',
    });
    const fromEcho = captured.filter((e) => e.app_class_name === 'echo');
    const messages = fromEcho.map((e) => e.message);
    expect(messages.some((m) => m.startsWith('phase=1'))).toBe(true);
  });

  it('honors an explicit log_class override', async () => {
    await run('/bin/sh', ['-c', 'printf "phase=1\\nphase=2\\n"'], {
      log_class: 'fake-tool',
      stdout_level: 'info',
      timeout_ms: 5_000,
    });
    const fromTool = captured.filter((e) => e.app_class_name === 'fake-tool');
    const messages = fromTool.map((e) => e.message);
    expect(messages.some((m) => m.startsWith('phase=1'))).toBe(true);
    expect(messages.some((m) => m.startsWith('phase=2'))).toBe(true);
    expect(fromTool.every((e) => e.log_level === 'info')).toBe(true);
  });

  it('rendered message body does NOT include a stream= suffix', async () => {
    await run('/bin/sh', ['-c', 'echo out; echo err 1>&2'], {
      log_class: 'fake-tool',
      stdout_level: 'info',
      stderr_level: 'info',
      timeout_ms: 5_000,
    });
    const fromTool = captured.filter((e) => e.app_class_name === 'fake-tool');
    const outEntry = fromTool.find((e) => e.message.startsWith('out'));
    const errEntry = fromTool.find((e) => e.message.startsWith('err'));
    expect(outEntry?.message).not.toContain('stream=');
    expect(errEntry?.message).not.toContain('stream=');
  });

  it('still returns the buffered output for ReportResult', async () => {
    const result = await run('/bin/sh', ['-c', 'echo one; echo two'], {
      log_class: 'fake-tool',
      timeout_ms: 5_000,
    });
    expect(result.stdout).toBe('one\ntwo\n');
    expect(result.exit_code).toBe(0);
  });

  it('invokes a caller-supplied onStdoutLine alongside the logger forwarder', async () => {
    const userLines: string[] = [];
    await run('/bin/sh', ['-c', 'echo first; echo second'], {
      log_class: 'fake-tool',
      timeout_ms: 5_000,
      onStdoutLine: (line: string) => userLines.push(line),
    });
    expect(userLines).toEqual(['first', 'second']);
  });

  it('honors stdout_level override', async () => {
    setLevel('debug');
    try {
      await run('/bin/sh', ['-c', 'echo chatty'], {
        log_class: 'chatty-tool',
        stdout_level: 'debug',
        timeout_ms: 5_000,
      });
      const fromChatty = captured.filter((e) => e.app_class_name === 'chatty-tool');
      expect(fromChatty.some((e) => e.log_level === 'debug' && e.message.startsWith('chatty'))).toBe(true);
    } finally {
      setLevel('info');
    }
  });

  it('trace-level stdout flows through when the threshold is trace', async () => {
    setLevel('trace');
    try {
      await run('/bin/echo', ['trace-line'], { timeout_ms: 5_000 });
      const fromEcho = captured.filter((e) => e.app_class_name === 'echo');
      expect(fromEcho.some((e) => e.log_level === 'trace' && e.message.startsWith('trace-line'))).toBe(true);
    } finally {
      setLevel('info');
    }
  });

  it('quiet: true suppresses logger forwarding entirely', async () => {
    await run('/bin/echo', ['quiet-output'], {
      log_class: 'should-not-appear',
      quiet: true,
      timeout_ms: 5_000,
    });
    const fromQuiet = captured.filter((e) => e.app_class_name === 'should-not-appear');
    expect(fromQuiet).toEqual([]);
  });

  it('quiet: true still fires caller-supplied onStdoutLine', async () => {
    const userLines: string[] = [];
    await run('/bin/echo', ['callback-still-runs'], {
      quiet: true,
      timeout_ms: 5_000,
      onStdoutLine: (line: string) => userLines.push(line),
    });
    expect(userLines).toEqual(['callback-still-runs']);
  });

  it('collection.* operations default to quiet — no journal flood from collectors', async () => {
    setLevel('trace');
    try {
      await dispatchContext.run(
        {
          signal: new AbortController().signal,
          operation: 'collection.collectAll',
          job_id: 'j-1',
          work_id: 'w-1',
        },
        async () => {
          await run('/bin/echo', ['pci-vendor-id-noise'], { timeout_ms: 5_000 });
        },
      );
      const fromEcho = captured.filter((e) => e.app_class_name === 'echo');
      expect(fromEcho).toEqual([]);
    } finally {
      setLevel('info');
    }
  });

  it('non-collection operations still stream when stdout_level is set above the threshold', async () => {
    await dispatchContext.run(
      {
        signal: new AbortController().signal,
        operation: 'deploy.installGrub',
        job_id: 'j-2',
        work_id: 'w-2',
      },
      async () => {
        await run('/bin/echo', ['grub-install-progress'], {
          timeout_ms: 5_000,
          stdout_level: 'info',
        });
      },
    );
    const fromEcho = captured.filter((e) => e.app_class_name === 'echo');
    expect(fromEcho.some((e) => e.message.startsWith('grub-install-progress'))).toBe(true);
  });
});
