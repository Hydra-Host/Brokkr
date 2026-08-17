interface Spinner {
  start: () => Spinner;
  stop: () => Spinner;
  succeed: (text?: string) => Spinner;
  fail: (text?: string) => Spinner;
  text: string;
  isSpinning: boolean;
}

export default function ora(opts?: string | { text?: string }): Spinner {
  const text = typeof opts === 'string' ? opts : (opts?.text ?? '');
  const spinner: Spinner = {
    text,
    isSpinning: false,
    start() {
      this.isSpinning = true;
      return this;
    },
    stop() {
      this.isSpinning = false;
      return this;
    },
    succeed(t?: string) {
      this.isSpinning = false;
      // eslint-disable-next-line no-console
      console.log(`  \x1b[32m✓\x1b[0m ${t ?? this.text}`);
      return this;
    },
    fail(t?: string) {
      this.isSpinning = false;
      // eslint-disable-next-line no-console
      console.error(`  \x1b[31m✗\x1b[0m ${t ?? this.text}`);
      return this;
    },
  };
  return spinner;
}
