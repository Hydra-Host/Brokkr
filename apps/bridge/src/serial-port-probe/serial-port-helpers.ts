export interface BuildResolvedInput {
  detectedPorts: Record<string, unknown>;
  matchedPort: string | null;
  solBaud: unknown;
}

export interface BuildResolvedOutput {
  port: string | null;
  baud: unknown;
  source: 'probed' | 'none';
  confirmed: boolean;
  notes: string[];
}

export function buildResolved(input: BuildResolvedInput): BuildResolvedOutput {
  const { detectedPorts, matchedPort, solBaud } = input;
  const notes: string[] = [];
  let port: string | null = null;
  let source: 'probed' | 'none' = 'none';
  let confirmed = false;

  if (matchedPort !== null && Object.prototype.hasOwnProperty.call(detectedPorts, matchedPort)) {
    port = matchedPort;
    source = 'probed';
    confirmed = true;
  } else if (matchedPort !== null) {
    notes.push(`Probe matched '${matchedPort}' but agent did not report it in detected_ports`);
  } else {
    notes.push('Probe did not identify a port');
  }

  const baud: unknown = port ? solBaud || 115200 : null;

  return { port, baud, source, confirmed, notes };
}
