export interface RedfishConfig {
  timeout: number;
  defaultContentType: string;
}

export function buildRedfishConfig(): RedfishConfig {
  return {
    timeout: 30,
    defaultContentType: 'application/json',
  };
}

let cachedRedfish: RedfishConfig | null = null;

export function getRedfishConfig(): RedfishConfig {
  if (cachedRedfish === null) {
    cachedRedfish = buildRedfishConfig();
  }
  return cachedRedfish;
}

export function resetOobConfigForTests(): void {
  cachedRedfish = null;
}
