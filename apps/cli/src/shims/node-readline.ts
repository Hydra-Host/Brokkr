interface Key {
  sequence: string;
  name: string | undefined;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
}

function parseKey(seq: string): Key {
  let name: string | undefined;
  let ctrl = false;
  const meta = false;
  const shift = false;

  if (seq === '\r' || seq === '\n') {
    name = 'return';
  } else if (seq === '\x7f' || seq === '\b') {
    name = 'backspace';
  } else if (seq === '\t') {
    name = 'tab';
  } else if (seq === ' ') {
    name = 'space';
  } else if (seq === '\x03') {
    ctrl = true;
    name = 'c';
  } else if (seq === '\x1b') {
    name = 'escape';
  } else if (seq.startsWith('\x1b[') || seq.startsWith('\x1bO')) {
    const code = seq.slice(2);
    if (code === 'A' || seq === '\x1bOA') name = 'up';
    else if (code === 'B' || seq === '\x1bOB') name = 'down';
    else if (code === 'C' || seq === '\x1bOC') name = 'right';
    else if (code === 'D' || seq === '\x1bOD') name = 'left';
    else if (code === 'H') name = 'home';
    else if (code === 'F') name = 'end';
    else if (code === '3~') name = 'delete';
    else if (code === '5~') name = 'pageup';
    else if (code === '6~') name = 'pagedown';
  } else if (seq.length === 1) {
    const code = seq.charCodeAt(0);
    if (code >= 1 && code <= 26) {
      ctrl = true;
      name = String.fromCharCode(code + 96);
    } else {
      name = seq;
    }
  }

  return { sequence: seq, name, ctrl, meta, shift };
}

export function emitKeypressEvents(stream: any): void {
  if ((stream as Record<string, unknown>)._keypressPatched) return;
  (stream as Record<string, unknown>)._keypressPatched = true;

  let buffer = '';
  let escTimeout: ReturnType<typeof setTimeout> | null = null;

  const flush = (seq: string) => {
    const key = parseKey(seq);
    const char = !key.ctrl && key.name?.length === 1 ? key.name : undefined;
    stream.emit('keypress', char, key);
  };

  const process = () => {
    while (buffer.length > 0) {
      if (buffer.startsWith('\x1b')) {
        if (buffer.length === 1) {
          if (escTimeout) clearTimeout(escTimeout);
          escTimeout = setTimeout(() => {
            escTimeout = null;
            if (buffer.startsWith('\x1b')) {
              flush('\x1b');
              buffer = buffer.slice(1);
              process();
            }
          }, 50);
          return;
        }

        if (buffer[1] === '[' || buffer[1] === 'O') {
          // eslint-disable-next-line no-control-regex -- intentional ANSI/terminal control sequence
          const match = buffer.match(/^\x1b[[O][0-9;]*[A-Za-z~]/);
          if (match) {
            if (escTimeout) {
              clearTimeout(escTimeout);
              escTimeout = null;
            }
            flush(match[0]);
            buffer = buffer.slice(match[0].length);
            continue;
          } else if (buffer.length < 8) {
            return;
          }
        }

        if (escTimeout) {
          clearTimeout(escTimeout);
          escTimeout = null;
        }
        flush('\x1b');
        buffer = buffer.slice(1);
        continue;
      }

      flush(buffer[0]!);
      buffer = buffer.slice(1);
    }
  };

  stream.on('readable', () => {
    let chunk: string | null;
    while ((chunk = stream.read()) !== null) {
      buffer += chunk;
      process();
    }
  });
}

export function moveCursor(stream: any, dx: number, dy: number, cb?: () => void): boolean {
  if (dx < 0) stream.write(`\x1b[${-dx}D`);
  else if (dx > 0) stream.write(`\x1b[${dx}C`);
  if (dy < 0) stream.write(`\x1b[${-dy}A`);
  else if (dy > 0) stream.write(`\x1b[${dy}B`);
  cb?.();
  return true;
}

export function clearLine(stream: any, dir: number, cb?: () => void): boolean {
  if (dir < 0) stream.write('\x1b[1K');
  else if (dir > 0) stream.write('\x1b[0K');
  else stream.write('\x1b[2K');
  cb?.();
  return true;
}

export function clearScreenDown(stream: any, cb?: () => void): boolean {
  stream.write('\x1b[0J');
  cb?.();
  return true;
}

interface ReadlineInterface {
  line: string;
  cursor: number;
  terminal: boolean;
  write: (data: string | null) => void;
  prompt: () => void;
  close: () => void;
  on: (event: string, fn: (...args: unknown[]) => void) => ReadlineInterface;
  off: (event: string, fn: (...args: unknown[]) => void) => ReadlineInterface;
}

export function createInterface(opts: { input?: any; output?: any } = {}): ReadlineInterface {
  const input = opts.input;
  const output = opts.output;
  const rl: ReadlineInterface = {
    line: '',
    cursor: 0,
    terminal: true,
    write(data) {
      if (data == null) return;
      rl.line = rl.line.slice(0, rl.cursor) + data + rl.line.slice(rl.cursor);
      rl.cursor += data.length;
    },
    prompt() {},
    close() {
      if (input && typeof input.off === 'function') {
        input.off('keypress', onKeypress);
      }
    },
    on: () => rl,
    off: () => rl,
  };

  const onKeypress = (_char: string | undefined, key: Key | undefined) => {
    if (!key) return;
    const name = key.name;
    if (name === 'backspace') {
      if (rl.cursor > 0) {
        rl.line = rl.line.slice(0, rl.cursor - 1) + rl.line.slice(rl.cursor);
        rl.cursor--;
      }
    } else if (name === 'delete') {
      if (rl.cursor < rl.line.length) {
        rl.line = rl.line.slice(0, rl.cursor) + rl.line.slice(rl.cursor + 1);
      }
    } else if (name === 'left') {
      if (rl.cursor > 0) rl.cursor--;
    } else if (name === 'right') {
      if (rl.cursor < rl.line.length) rl.cursor++;
    } else if (name === 'home') {
      rl.cursor = 0;
    } else if (name === 'end') {
      rl.cursor = rl.line.length;
    } else if (
      name !== 'return' &&
      key.sequence &&
      !key.ctrl &&
      !key.meta &&
      key.sequence.length === 1 &&
      key.sequence >= ' ' &&
      key.sequence !== '\x7f'
    ) {
      rl.line = rl.line.slice(0, rl.cursor) + key.sequence + rl.line.slice(rl.cursor);
      rl.cursor++;
    }
    if (output && typeof output._write === 'function') {
      output._write(key.sequence ?? '', 'utf8', () => {});
    }
  };

  if (input && typeof input.on === 'function') {
    input.on('keypress', onKeypress);
  }

  return rl;
}

export default { emitKeypressEvents, moveCursor, clearLine, clearScreenDown, createInterface };
