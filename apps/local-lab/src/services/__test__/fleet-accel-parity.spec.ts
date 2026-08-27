import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FleetAccelSchema } from '@repo/local-lab-contract';

const ENGINE = join(__dirname, '..', '..', '..', '..', '..', 'apps', 'local-sim', 'scripts', 'local');
const HOST_OS_PY = join(ENGINE, 'host_os.py');
const PROGRESS_PY = join(ENGINE, 'progress.py');

function pythonAccelLiterals(): string[] {
  const src = readFileSync(HOST_OS_PY, 'utf8');
  const decl = /^Accel\s*=\s*Literal\[([^\]]+)\]/m.exec(src);
  if (!decl) return [];
  return [...decl[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]).sort();
}

function contractAccelValues(): string[] {
  return [...FleetAccelSchema.options].sort();
}

describe.runIf(existsSync(HOST_OS_PY) && existsSync(PROGRESS_PY))('fleet accelerator parity', () => {
  it('every accelerator the engine can resolve is a value this schema accepts', () => {
    const engine = pythonAccelLiterals();
    expect(engine.length).toBeGreaterThan(0);
    expect(contractAccelValues()).toEqual(engine);
  });

  it('the engine writes the progress keys this schema reads', () => {
    const src = readFileSync(PROGRESS_PY, 'utf8');
    expect(src).toContain('"accel":');
    expect(src).toContain('"accelForced":');
  });
});
